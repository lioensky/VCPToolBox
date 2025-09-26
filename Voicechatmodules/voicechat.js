// Voicechatmodules/voicechat.js

document.addEventListener('DOMContentLoaded', () => {
    const chatMessagesDiv = document.getElementById('chatMessages');
    const messageInput = document.getElementById('messageInput');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const agentAvatarImg = document.getElementById('agentAvatar');
    const agentNameSpan = document.getElementById('currentChatAgentName');
    const closeBtn = document.getElementById('close-btn-voicechat');
    const toggleInputModeBtn = document.getElementById('toggleInputModeBtn');
    const keyboardIcon = document.getElementById('keyboard-icon');
    const micIcon = document.getElementById('mic-icon');

    let agentConfig = null;
    let agentId = null;
    let globalSettings = {};
    let currentChatHistory = [];
    let activeStreamingMessageId = null;
    let inputMode = 'text'; // 'text' or 'voice'
    const markedInstance = new window.marked.Marked({ gfm: true, breaks: true });
    let speechRecognitionTimeout = null;
    const SPEECH_TIMEOUT_DURATION = 3000; // 3 seconds

    // Local UI Helper for this window
    const uiHelperFunctions = {
        scrollToBottom: () => {
            chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
        },
        autoResizeTextarea: (textarea) => {
            textarea.style.height = 'auto';
            const scrollHeight = textarea.scrollHeight;
            const maxHeight = parseInt(getComputedStyle(textarea).maxHeight, 10) || Infinity;
            textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
        }
    };

    // --- Event Listeners ---
    closeBtn.addEventListener('click', () => window.close());
    sendMessageBtn.addEventListener('click', () => sendMessage(messageInput.value));
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(messageInput.value);
        }
    });
    toggleInputModeBtn.addEventListener('click', toggleMode);

    // --- Initialization ---
    window.electronAPI.onVoiceChatData(async (data) => {
        console.log('Received voice chat data:', data);
        const { agentId: receivedAgentId, theme } = data;
        
        agentId = receivedAgentId;
        globalSettings = await window.electronAPI.loadSettings();
        agentConfig = await window.electronAPI.getAgentConfig(agentId);

        if (!agentConfig || agentConfig.error) {
            agentNameSpan.textContent = "错误";
            chatMessagesDiv.innerHTML = `<div class="message-item system"><p style="color: var(--danger-color);">加载助手配置失败: ${agentConfig?.error || '未知错误'}</p></div>`;
            return;
        }

        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme === 'dark');
        agentAvatarImg.src = agentConfig.avatarUrl || '../assets/default_avatar.png';
        agentNameSpan.textContent = `${agentConfig.name} - 语音模式`;

        initializeRenderer();
    });

    function initializeRenderer() {
        if (window.messageRenderer) {
            const chatHistoryRef = {
                get: () => currentChatHistory,
                set: (newHistory) => { currentChatHistory = newHistory; }
            };
            const selectedItemRef = {
                get: () => ({
                    id: agentId,
                    type: 'agent',
                    name: agentConfig.name,
                    avatarUrl: agentConfig.avatarUrl,
                    config: agentConfig
                }),
                set: () => {}
            };
            const globalSettingsRef = {
                get: () => globalSettings,
                set: (newSettings) => { globalSettings = newSettings; }
            };
            const topicIdRef = {
                get: () => `voicechat_${agentId}`,
                set: () => {}
            };
            window.messageRenderer.initializeMessageRenderer({
                currentChatHistoryRef: chatHistoryRef,
                currentSelectedItemRef: selectedItemRef,
                currentTopicIdRef: topicIdRef,
                globalSettingsRef: globalSettingsRef,
                chatMessagesDiv: chatMessagesDiv,
                electronAPI: window.electronAPI,
                markedInstance: markedInstance,
                uiHelper: uiHelperFunctions, // Pass the local helper
                summarizeTopicFromMessages: async () => "", // Stub
                handleCreateBranch: () => {} // Stub
            });
            console.log('[VoiceChat] Shared messageRenderer initialized.');
        } else {
            console.error('[VoiceChat] window.messageRenderer is not available.');
        }
    }

    function toggleMode() {
        if (inputMode === 'text') {
            inputMode = 'voice';
            keyboardIcon.style.display = 'none';
            micIcon.style.display = 'block';
            messageInput.placeholder = '正在聆听...';
            messageInput.value = '';
            window.electronAPI.startSpeechRecognition();
        } else {
            inputMode = 'text';
            keyboardIcon.style.display = 'block';
            micIcon.style.display = 'none';
            messageInput.placeholder = '输入消息...';
            window.electronAPI.stopSpeechRecognition();
            clearTimeout(speechRecognitionTimeout);
        }
    }

    const sendMessage = async (messageContent) => {
        clearTimeout(speechRecognitionTimeout); // Stop any pending auto-send
        if (!messageContent.trim() || !agentConfig || !window.messageRenderer) return;

        const userMessage = { role: 'user', content: messageContent, timestamp: Date.now(), id: `user_msg_${Date.now()}` };
        await window.messageRenderer.renderMessage(userMessage);
        currentChatHistory.push(userMessage);

        messageInput.value = '';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;

        const thinkingMessageId = `assistant_msg_${Date.now()}`;
        activeStreamingMessageId = thinkingMessageId;

        const assistantMessagePlaceholder = {
            id: thinkingMessageId,
            role: 'assistant',
            content: '思考中',
            timestamp: Date.now(),
            isThinking: true,
            name: agentConfig.name,
            avatarUrl: agentConfig.avatarUrl
        };
        await window.messageRenderer.renderMessage(assistantMessagePlaceholder);

        const context = {
            agentId: agentId,
            topicId: `voicechat_${agentId}`
        };

        try {
            const voiceModePromptInjection = "\n\n当前处于语音模式中，你的回复应当口语化，内容简短直白。由于用户输入同样是语音识别模型构成，注意自主判断、理解其中的同音错别字或者错误语义识别。";
            const systemPrompt = (agentConfig.systemPrompt || '').replace(/\{\{AgentName\}\}/g, agentConfig.name) + voiceModePromptInjection;
            
            const messagesForVCP = [];
            if (systemPrompt) {
                messagesForVCP.push({ role: 'system', content: [{ type: 'text', text: systemPrompt }] });
            }

            const historyForVCP = currentChatHistory.filter(msg => !msg.isThinking).map(msg => {
                const contentPayload = (typeof msg.content === 'string')
                    ? [{ type: 'text', text: msg.content }]
                    : msg.content;
                return { role: msg.role, content: contentPayload };
            });
            messagesForVCP.push(...historyForVCP);

            const modelConfig = {
                model: agentConfig.model,
                temperature: agentConfig.temperature,
                stream: true,
                ...(agentConfig.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens, 10) }),
                ...(agentConfig.top_p && { top_p: parseFloat(agentConfig.top_p) }),
                ...(agentConfig.top_k && { top_k: parseInt(agentConfig.top_k, 10) })
            };

            await window.electronAPI.sendToVCP(globalSettings.vcpServerUrl, globalSettings.vcpApiKey, messagesForVCP, modelConfig, thinkingMessageId, false, context);

        } catch (error) {
            console.error('Error sending message to VCP:', error);
            if (window.messageRenderer) {
                window.messageRenderer.finalizeStreamedMessage(thinkingMessageId, 'error');
                const messageItemContent = document.querySelector(`.message-item[data-message-id="${thinkingMessageId}"] .md-content`);
                if (messageItemContent) {
                    messageItemContent.innerHTML = `<p style="color: var(--danger-color);">请求失败: ${error.message}</p>`;
                }
            }
            activeStreamingMessageId = null;
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            messageInput.focus();
        }
    };

    const activeStreams = new Set();
    window.electronAPI.onVCPStreamEvent((eventData) => {
        if (!window.messageRenderer || eventData.messageId !== activeStreamingMessageId) return;

        const { messageId, type, chunk, error, context } = eventData;

        if (!activeStreams.has(messageId) && type === 'data') {
            window.messageRenderer.startStreamingMessage({
                id: messageId,
                role: 'assistant',
                name: agentConfig.name,
                avatarUrl: agentConfig.avatarUrl,
                context: context,
            });
            activeStreams.add(messageId);
        }

        if (type === 'data') {
            window.messageRenderer.appendStreamChunk(messageId, chunk, context);
        } else if (type === 'end') {
            window.messageRenderer.finalizeStreamedMessage(messageId, 'completed', context).then(() => {
                const messageElement = document.getElementById(`message-item-${messageId}`);
                let textToSpeak = '';
                if (messageElement) {
                    const contentElement = messageElement.querySelector('.md-content');
                    if (contentElement) {
                        const contentClone = contentElement.cloneNode(true);
                        contentClone.querySelectorAll('.vcp-tool-use-bubble').forEach(el => el.remove());
                        textToSpeak = contentClone.innerText || '';
                    } else {
                        textToSpeak = messageElement.textContent || messageElement.innerText;
                    }
                }
                playTTS(textToSpeak.trim(), messageId);
            });

            activeStreams.delete(messageId);
            activeStreamingMessageId = null;
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            messageInput.focus();
        } else if (type === 'error') {
            window.messageRenderer.finalizeStreamedMessage(messageId, 'error', context);
            const messageItemContent = document.querySelector(`.message-item[data-message-id="${messageId}"] .md-content`);
            if (messageItemContent) {
                messageItemContent.innerHTML = `<p style="color: var(--danger-color);">${error || '未知流错误'}</p>`;
            }
            activeStreams.delete(messageId);
            activeStreamingMessageId = null;
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            messageInput.focus();
        }
    });
    
    function playTTS(text, msgId) {
        if (!text || !agentConfig.ttsVoicePrimary) return;
        
        console.log(`[VoiceChat] Requesting TTS for message ${msgId}`);
        window.electronAPI.sovitsSpeak({
            text: text,
            voice: agentConfig.ttsVoicePrimary,
            speed: agentConfig.ttsSpeed,
            msgId: msgId,
            ttsRegex: agentConfig.ttsRegexPrimary,
            voiceSecondary: agentConfig.ttsVoiceSecondary,
            ttsRegexSecondary: agentConfig.ttsRegexSecondary
        });
    }

    // --- TTS Audio Playback Logic ---
    let currentAudio = null;
    let audioQueue = []; // Queue for pending audio clips
    let isPlaying = false;

    function processAudioQueue() {
        if (isPlaying || audioQueue.length === 0) {
            return; // Don't start a new audio if one is already playing or queue is empty
        }

        isPlaying = true;
        const { audioData, msgId } = audioQueue.shift(); // Get the next audio from the queue

        console.log(`[VoiceChat] Playing audio from queue for msgId ${msgId}`);

        const byteCharacters = atob(audioData);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const audioBlob = new Blob([byteArray], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);

        currentAudio = new Audio(audioUrl);

        currentAudio.play().catch(e => {
            console.error("Audio playback failed:", e);
            isPlaying = false; // Reset flag on error
            processAudioQueue(); // Try to play the next one
        });

        currentAudio.onended = () => {
            console.log(`[VoiceChat] Audio for msgId ${msgId} finished playing.`);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            isPlaying = false;
            processAudioQueue(); // Play the next item in the queue
        };
    }

    window.electronAPI.onPlayTtsAudio((data) => {
        const { audioData, msgId } = data;
        console.log(`[VoiceChat] Queued audio for msgId ${msgId}`);
        audioQueue.push({ audioData, msgId });
        processAudioQueue(); // Attempt to process the queue
    });

    // Listen for stop command from main process
    window.electronAPI.onStopTtsAudio(() => {
        console.log('[VoiceChat] Received stop TTS command. Clearing queue and stopping current audio.');
        audioQueue = []; // Clear the pending audio queue
        if (currentAudio) {
            currentAudio.pause();
            URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        isPlaying = false;
    });


    // Listen for theme updates from the main process
    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[VoiceChat Window] Theme updated to: ${theme}`);
        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme !== 'light');
    });

    // --- Speech Recognition IPC Listener ---
    window.electronAPI.onSpeechRecognitionResult((text) => {
        messageInput.value = text;

        // Reset the timeout every time new text is received
        clearTimeout(speechRecognitionTimeout);
        if (messageInput.value.trim() !== '') {
            speechRecognitionTimeout = setTimeout(() => {
                if (messageInput.value.trim()) {
                    console.log('Speech unchanged for 3 seconds, sending message.');
                    sendMessage(messageInput.value);
                }
            }, SPEECH_TIMEOUT_DURATION);
        }
    });
});