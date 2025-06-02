console.log('renderer.js script execution started'); // DEBUG
// --- Globals ---
let globalSettings = {};
let currentAgentId = null;
let currentTopicId = null; // Added to track the current active topic ID
let currentChatHistory = []; // Array of message objects { role: 'user'/'assistant', content: '...', timestamp: ... }
let attachedFiles = []; // Array of { file: File, localPath: 'file://...', originalName: '...' } for current message
let activeStreamingMessageId = null; // To track the ID of the message being streamed

// --- Topic Search Functionality ---
async function filterTopicList() {
    const topicSearchInputElement = document.getElementById('topicSearchInput'); // Get it fresh
    if (!topicSearchInputElement) {
        console.error("[filterTopicList] topicSearchInput element not found.");
        return;
    }
    const searchTerm = topicSearchInputElement.value.toLowerCase();
    const topicListUl = document.getElementById('topicList'); 
    const topicItems = topicListUl ? topicListUl.querySelectorAll('.topic-item') : [];

    console.log(`[filterTopicList] Searching for: "${searchTerm}"`);
    // console.log(`[filterTopicList] Number of topic items found: ${topicItems.length}`);

    if (!currentAgentId) {
        console.log("[filterTopicList] No agent selected. Showing all topics if search term is empty, else hiding all.");
        topicItems.forEach(item => item.style.display = searchTerm.length === 0 ? '' : 'none');
        return;
    }

    const agentConfig = await window.electronAPI.getAgentConfig(currentAgentId);
    if (!agentConfig || agentConfig.error) {
        console.error("[filterTopicList] Failed to get agent config for topic search:", agentConfig?.error);
        return;
    }
    const allTopics = agentConfig.topics || [];
    // console.log(`[filterTopicList] All topics for current agent (${currentAgentId}):`, allTopics.map(t => t.name));

    for (const item of topicItems) {
        const topicId = item.dataset.topicId;
        const topic = allTopics.find(t => t.id === topicId);
        if (!topic) {
            // console.warn(`[filterTopicList] Topic data not found for ID: ${topicId}. Hiding item.`);
            item.style.display = 'none';
            continue;
        }

        const topicTitle = (topic.name || '').toLowerCase();
        let contentMatches = false;
        let dateMatches = false;

        // console.log(`[filterTopicList] Processing topic: "${topicTitle}" (ID: ${topicId})`);

        if (searchTerm.length > 0) {
            // Date matching
            if (topic.createdAt) {
                const date = new Date(topic.createdAt);
                const year = date.getFullYear().toString();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');

                const fullDateTime = `${year}-${month}-${day} ${hours}:${minutes}`;
                const justDate = `${year}-${month}-${day}`;
                const monthDay = `${month}-${day}`;
                
                const dateStringsToSearch = [
                    fullDateTime,
                    justDate,
                    monthDay,
                    year,
                    hours,
                    minutes,
                    `${hours}:${minutes}`
                ];

                dateMatches = dateStringsToSearch.some(ds => ds.toLowerCase().includes(searchTerm));
            }

            // Content matching (only if not already matched by date or title for performance)
            if (!topicTitle.includes(searchTerm) && !dateMatches) {
                const history = await window.electronAPI.getChatHistory(currentAgentId, topicId);
                if (history && !history.error) {
                    contentMatches = history.some(msg => {
                        const messageContent = msg.content && typeof msg.content === 'string' ? msg.content.toLowerCase() : '';
                        const attachmentsText = msg.attachments ? msg.attachments.some(att =>
                            att.extractedText && typeof att.extractedText === 'string' && att.extractedText.toLowerCase().includes(searchTerm)
                        ) : false;
                        return messageContent.includes(searchTerm) || attachmentsText;
                    });
                } else {
                    // console.error(`[filterTopicList] Error getting history for topic ${topicId}:`, history?.error);
                }
            }
        }

        if (topicTitle.includes(searchTerm) || contentMatches || dateMatches) {
            item.style.display = ''; // Show
            // console.log(`[filterTopicList] Showing topic: "${topicTitle}" (ID: ${topicId}) due to title, content or date match.`);
        } else {
            item.style.display = 'none'; // Hide
            // console.log(`[filterTopicList] Hiding topic: "${topicTitle}" (ID: ${topicId})`);
        }
    }
}

function setupTopicSearch() {
    // Ensure topicSearchInput is defined at the top of the script
    const topicSearchInputElement = document.getElementById('topicSearchInput'); 
    if (topicSearchInputElement) {
        topicSearchInputElement.addEventListener('input', filterTopicList); // Keep for live filtering
        topicSearchInputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault(); 
                filterTopicList();
            }
        });
        console.log('[Renderer] Global Topic search event listeners (input and Enter key) set up.');
    } else {
        // This might be called before DOM is fully ready if not careful,
        // but DOMContentLoaded should handle it. If it still fails,
        // it means topicSearchInput is not in main.html or ID is wrong.
        console.error('[Renderer] Global Topic search input element (topicSearchInput) not found during setup.');
    }
}
// --- DOM Elements ---
const agentListUl = document.getElementById('agentList');
const currentChatAgentNameH3 = document.getElementById('currentChatAgentName');
const chatMessagesDiv = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const attachFileBtn = document.getElementById('attachFileBtn');
const attachmentPreviewArea = document.getElementById('attachmentPreviewArea');

const globalSettingsBtn = document.getElementById('globalSettingsBtn');
const globalSettingsModal = document.getElementById('globalSettingsModal');
const globalSettingsForm = document.getElementById('globalSettingsForm');

const createNewAgentBtn = document.getElementById('createNewAgentBtn');

// const agentSettingsModal = document.getElementById('agentSettingsModal'); // No longer a modal
const agentSettingsContainerTitle = document.getElementById('agentSettingsContainerTitle'); // New title element in tab
const selectedAgentNameForSettingsSpan = document.getElementById('selectedAgentNameForSettings');
const agentSettingsForm = document.getElementById('agentSettingsForm'); // Form is now directly in tabContentSettings
const agentSettingsContainer = document.getElementById('agentSettingsContainer');
const selectAgentPromptForSettings = document.getElementById('selectAgentPromptForSettings');
const editingAgentIdInput = document.getElementById('editingAgentId');
const agentNameInput = document.getElementById('agentNameInput');
const agentAvatarInput = document.getElementById('agentAvatarInput');
const agentAvatarPreview = document.getElementById('agentAvatarPreview');
const agentSystemPromptTextarea = document.getElementById('agentSystemPrompt');
const agentModelInput = document.getElementById('agentModel');
const agentTemperatureInput = document.getElementById('agentTemperature');
const agentContextTokenLimitInput = document.getElementById('agentContextTokenLimit');
const agentMaxOutputTokensInput = document.getElementById('agentMaxOutputTokens');
const deleteAgentBtn = document.getElementById('deleteAgentBtn');
const currentAgentSettingsBtn = document.getElementById('currentAgentSettingsBtn');
const clearCurrentChatBtn = document.getElementById('clearCurrentChatBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');


const notificationsSidebar = document.getElementById('notificationsSidebar');
const vcpLogConnectionStatusDiv = document.getElementById('vcpLogConnectionStatus');
const notificationsListUl = document.getElementById('notificationsList');
const clearNotificationsBtn = document.getElementById('clearNotificationsBtn');

// Sidebar Tabs Elements
const sidebarTabButtons = document.querySelectorAll('.sidebar-tab-button');
const sidebarTabContents = document.querySelectorAll('.sidebar-tab-content');
const tabContentTopics = document.getElementById('tabContentTopics');

// New elements for topic search
const topicSearchInput = document.getElementById('topicSearchInput');
const topicSearchBtn = document.getElementById('topicSearchBtn');

// Resizer Elements
const leftSidebar = document.querySelector('.sidebar');
const rightNotificationsSidebar = document.getElementById('notificationsSidebar');
const resizerLeft = document.getElementById('resizerLeft');
const resizerRight = document.getElementById('resizerRight');

// Title Bar Controls
const minimizeBtn = document.getElementById('minimize-btn');
const maximizeBtn = document.getElementById('maximize-btn');
const restoreBtn = document.getElementById('restore-btn');
const closeBtn = document.getElementById('close-btn');
const settingsBtn = document.getElementById('settings-btn'); // Add this line
const notificationTitleElement = document.getElementById('notificationTitle');
const digitalClockElement = document.getElementById('digitalClock');
const dateDisplayElement = document.getElementById('dateDisplay');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOMContentLoaded event fired.'); // DEBUG
    // Register VCPLog listeners
    window.electronAPI.onVCPLogStatus((statusUpdate) => {
        if (window.notificationRenderer) {
            window.notificationRenderer.updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv);
        }
    });
    window.electronAPI.onVCPLogMessage((logData, originalRawMessage) => {
        if (window.notificationRenderer) {
            const computedStyle = getComputedStyle(document.body);
            const themeColors = {
                notificationBg: computedStyle.getPropertyValue('--notification-bg').trim(),
                accentBg: computedStyle.getPropertyValue('--accent-bg').trim(),
                highlightText: computedStyle.getPropertyValue('--highlight-text').trim(),
                borderColor: computedStyle.getPropertyValue('--border-color').trim(),
                primaryText: computedStyle.getPropertyValue('--primary-text').trim(),
                secondaryText: computedStyle.getPropertyValue('--secondary-text').trim()
            };
            window.notificationRenderer.renderVCPLogNotification(logData, originalRawMessage, notificationsListUl, themeColors);
        }
    });
    console.log('[RENDERER_INIT] VCPLog listeners registered.');
 
    // Listener for VCP stream chunks
    window.electronAPI.onVCPStreamChunk(async (eventData) => { // Renamed data to eventData for clarity, and made async
        if (!window.messageRenderer) {
            console.error("VCPStreamChunk: messageRenderer not available.");
            return;
        }
        // console.log('Received VCP stream chunk:', eventData); // DEBUG
 
        // IMPORTANT: We now expect eventData to contain the messageId from main.js
        const streamMessageId = eventData.messageId;
 
        if (!streamMessageId) {
            console.error("VCPStreamChunk: Received chunk/event without a messageId. Cannot process.", eventData);
            // If there's an active stream, we might want to terminate it with an error.
            if (activeStreamingMessageId) {
                window.messageRenderer.finalizeStreamedMessage(activeStreamingMessageId, 'error_missing_id');
                const errorMsgItem = document.querySelector(`.message-item[data-message-id="${activeStreamingMessageId}"] .md-content`);
                if (errorMsgItem) errorMsgItem.innerHTML += `<p><strong style="color: red;">流错误: 响应中缺少messageId</strong></p>`;
                activeStreamingMessageId = null;
            }
            return;
        }
 
        if (eventData.type === 'data') {
            // We use streamMessageId from the event, not the global activeStreamingMessageId directly for append/finalize
            window.messageRenderer.appendStreamChunk(streamMessageId, eventData.chunk);
        } else if (eventData.type === 'end') {
            window.messageRenderer.finalizeStreamedMessage(streamMessageId, eventData.finish_reason || 'completed');
            // Attempt summarization after stream ends
            await attemptTopicSummarizationIfNeeded();
            if (activeStreamingMessageId === streamMessageId) {
                activeStreamingMessageId = null; // Clear global active stream ID only if it matches
            } else {
                console.warn(`VCPStreamChunk: Finalized stream ${streamMessageId}, but global activeStreamingMessageId was ${activeStreamingMessageId}.`);
            }
        } else if (eventData.type === 'error') {
            console.error('VCP Stream Error on ID', streamMessageId, ':', eventData.error);
            window.messageRenderer.finalizeStreamedMessage(streamMessageId, 'error');
            const errorMsgItem = document.querySelector(`.message-item[data-message-id="${streamMessageId}"] .md-content`);
            if (errorMsgItem) {
                errorMsgItem.innerHTML += `<p><strong style="color: red;">流错误: ${eventData.error}</strong></p>`;
            } else {
                 window.messageRenderer.renderMessage({
                    role: 'system',
                    content: `流处理错误 (ID: ${streamMessageId}): ${eventData.error}`,
                    timestamp: Date.now(),
                    id: `err_${streamMessageId}` // Give error message a related ID
                });
            }
            if (activeStreamingMessageId === streamMessageId) {
                activeStreamingMessageId = null;
            }
        }
    });
    console.log('[RENDERER_INIT] VCP stream chunk listener registered (now expects messageId in eventData).');
  
    try {
        await loadAndApplyGlobalSettings();
        await loadAgentList();
 
        if (window.messageRenderer) {
            window.messageRenderer.initializeMessageRenderer({
                currentChatHistory: currentChatHistory,
                currentAgentId: currentAgentId,
                currentTopicId: currentTopicId, // Pass currentTopicId
                globalSettings: globalSettings,
                chatMessagesDiv: chatMessagesDiv,
                electronAPI: window.electronAPI,
                markedInstance: markedInstance,
                scrollToBottom: scrollToBottom,
                summarizeTopicFromMessages: summarizeTopicFromMessages,
                openModal: openModal, // Generic modal opener
                // openImagePreviewModal: openImagePreviewModal, // Specific for image preview - REMOVED
                autoResizeTextarea: autoResizeTextarea
            });
            console.log('[RENDERER_INIT] messageRenderer module initialized.');
        } else {
            console.error('[RENDERER_INIT] messageRenderer module not found!');
        }

        if (window.inputEnhancer) {
            window.inputEnhancer.initializeInputEnhancer({
                messageInput: messageInput,
                electronAPI: window.electronAPI,
                attachedFiles: attachedFiles,
                updateAttachmentPreview: updateAttachmentPreview,
                getCurrentAgentId: () => currentAgentId,
                getCurrentTopicId: () => currentTopicId
            });
            console.log('[RENDERER_INIT] inputEnhancer module initialized.');
        } else {
            console.error('[RENDERER_INIT] inputEnhancer module not found! Drag/drop and enhanced paste might not work.');
        }
 
        setupEventListeners(); // This will now have some paste logic potentially overridden or complemented by inputEnhancer
        setupSidebarTabs();
        initializeResizers();
        setupTitleBarControls(); // Add this call
        setupTopicSearch(); // New: Setup topic search event listeners
        autoResizeTextarea(messageInput);
        loadAndApplyThemePreference();
        initializeDigitalClock(); // Initialize the digital clock

    } catch (error) {
        console.error('Error during DOMContentLoaded initialization:', error);
    }
});

function initializeDigitalClock() {
    if (digitalClockElement && notificationTitleElement && dateDisplayElement) {
        notificationTitleElement.style.display = 'none'; // Hide the original title
        updateDateTimeDisplay(); // Initial call to display time and date immediately
        setInterval(updateDateTimeDisplay, 1000); // Update every second
    } else {
        console.error('Digital clock, notification title, or date display element not found.');
    }
}

function updateDateTimeDisplay() {
    const now = new Date();
    if (digitalClockElement) {
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        
        // Check if the structure is already set up
        if (!digitalClockElement.querySelector('.colon')) {
            // First time setup, or if structure was cleared
            digitalClockElement.innerHTML = `<span class="hours">${hours}</span><span class="colon">:</span><span class="minutes">${minutes}</span>`;
        } else {
            // Only update text content of existing spans
            const hoursSpan = digitalClockElement.querySelector('.hours');
            const minutesSpan = digitalClockElement.querySelector('.minutes');
            if (hoursSpan) hoursSpan.textContent = hours;
            if (minutesSpan) minutesSpan.textContent = minutes;
        }
    }
    if (dateDisplayElement) {
        const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
        const day = String(now.getDate()).padStart(2, '0');
        const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
        dateDisplayElement.textContent = `${month}-${day} ${dayOfWeek}`;
    }
}

function loadAndApplyThemePreference() {
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme === 'light') {
        document.body.classList.add('light-theme');
        if(themeToggleBtn) themeToggleBtn.textContent = '🌙'; // Moon for light theme
    } else {
        document.body.classList.remove('light-theme'); // Default to dark
        if(themeToggleBtn) themeToggleBtn.textContent = '☀️'; // Sun for dark theme
    }
}

async function loadAndApplyGlobalSettings() {
    const settings = await window.electronAPI.loadSettings();
    if (settings && !settings.error) {
        globalSettings = settings;
        // Populate global settings form
        document.getElementById('vcpServerUrl').value = globalSettings.vcpServerUrl || '';
        document.getElementById('vcpApiKey').value = globalSettings.vcpApiKey || '';
        document.getElementById('vcpLogUrl').value = globalSettings.vcpLogUrl || '';
        document.getElementById('vcpLogKey').value = globalSettings.vcpLogKey || '';

        // Attempt to connect VCPLog if configured
        if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey) {
            if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'connecting', message: '连接中...' }, vcpLogConnectionStatusDiv);
            window.electronAPI.connectVCPLog(globalSettings.vcpLogUrl, globalSettings.vcpLogKey);
        } else {
            if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
        }
    } else {
        console.warn('加载全局设置失败或无设置:', settings?.error);
        if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
    }
}

// --- Agent Management ---
async function loadAgentList() {
    agentListUl.innerHTML = '<li>加载中...</li>';
    const result = await window.electronAPI.getAgents();
    agentListUl.innerHTML = ''; // Clear loading/previous
    if (result.error) {
        agentListUl.innerHTML = `<li>加载Agent失败: ${result.error}</li>`;
        return;
    }
    if (result.length === 0) {
        agentListUl.innerHTML = '<li>没有找到Agent。请创建一个。</li>';
    } else {
        result.forEach(agent => {
            const li = document.createElement('li');
            li.dataset.agentId = agent.id;
            
            const avatarImg = document.createElement('img');
            avatarImg.classList.add('avatar');
            avatarImg.src = agent.avatarUrl || 'assets/default_avatar.png'; // Provide a default avatar
            avatarImg.alt = `${agent.name} 头像`;
            avatarImg.onerror = () => { avatarImg.src = 'assets/default_avatar.png'; }; // Fallback for broken links

            const nameSpan = document.createElement('span');
            nameSpan.classList.add('agent-name');
            nameSpan.textContent = agent.name;

            li.appendChild(avatarImg);
            li.appendChild(nameSpan);
            li.addEventListener('click', () => selectAgent(agent.id, agent.name));
            agentListUl.appendChild(li);
        });
        // Optionally, select the first agent or last active agent
        if (!currentAgentId && result.length > 0) {
            // selectAgent(result[0].id, result[0].name); 
            // Let user click to select initially
        } else if (currentAgentId) {
            highlightActiveAgent(currentAgentId);
        }
    }
}
 
async function selectAgent(agentId, agentName) {
    // Prevent reloading if the same agent is clicked and a topic is already loaded.
    // If currentTopicId is null (e.g., after app start or error), proceed to load topics.
    if (currentAgentId === agentId && currentTopicId) {
        return;
    }
 
    console.log(`选择 Agent: ${agentName} (ID: ${agentId})`);
    currentAgentId = agentId;
    currentTopicId = null;
    currentChatHistory = [];

    if (window.messageRenderer) {
        window.messageRenderer.setCurrentAgentId(currentAgentId);
        window.messageRenderer.setCurrentTopicId(null); // Reset topic in messageRenderer
    }
    currentChatAgentNameH3.textContent = `与 ${agentName} 聊天中`;
    
    currentAgentSettingsBtn.textContent = '新建上下文';
    currentAgentSettingsBtn.title = `为 ${agentName} 新建聊天上下文(话题)`;
    currentAgentSettingsBtn.style.display = 'inline-block';
    clearCurrentChatBtn.style.display = 'inline-block';
 
    highlightActiveAgent(agentId);

    try {
        const topics = await window.electronAPI.getAgentTopics(agentId);
        if (topics && !topics.error && topics.length > 0) {
            let topicToLoadId = topics[0].id; // Default to the first topic
            try {
                const rememberedTopicId = localStorage.getItem(`lastActiveTopic_${agentId}`);
                if (rememberedTopicId && topics.some(t => t.id === rememberedTopicId)) {
                    topicToLoadId = rememberedTopicId;
                }
            } catch (e) {
                console.warn("Failed to read last active topic from localStorage:", e);
            }
            currentTopicId = topicToLoadId;
            if (window.messageRenderer) {
                window.messageRenderer.setCurrentTopicId(currentTopicId);
            }
            console.log(`Agent ${agentId} - 选择话题: ${currentTopicId}`);
            await loadChatHistory(currentAgentId, currentTopicId);
        } else if (topics.error) {
            console.error(`加载Agent ${agentId} 的话题列表失败:`, topics.error);
            chatMessagesDiv.innerHTML = `<div class="message-item system"><div class="sender-name">系统</div><div>加载话题列表失败: ${topics.error}</div></div>`;
        } else {
            console.warn(`Agent ${agentId} 没有找到话题。将尝试加载一个空的聊天记录。`);
            await loadChatHistory(currentAgentId, null);
        }
    } catch (e) {
        console.error(`选择 Agent ${agentId} 时发生错误: `, e);
        chatMessagesDiv.innerHTML = `<div class="message-item system"><div class="sender-name">系统</div><div>选择助手时出错: ${e.message}</div></div>`;
    }
    
    messageInput.disabled = false;
    sendMessageBtn.disabled = false;
    attachFileBtn.disabled = false;
    messageInput.focus();
}
 
function highlightActiveAgent(agentId) {
    document.querySelectorAll('.agent-list li').forEach(item => {
        item.classList.toggle('active', item.dataset.agentId === agentId);
    });
}

// --- Chat Functionality ---
async function loadChatHistory(agentId, topicId) {
    chatMessagesDiv.innerHTML = '';
    currentChatHistory = [];

    if (window.messageRenderer) {
        window.messageRenderer.setCurrentTopicId(topicId);
    }

    if (!agentId || !topicId) {
        const errorMsg = `错误：无法加载聊天记录，助手ID (${agentId}) 或话题ID (${topicId}) 缺失。`;
        console.error(errorMsg);
        if (window.messageRenderer) {
             window.messageRenderer.initializeMessageRenderer({ currentChatHistory, currentAgentId, currentTopicId: topicId, globalSettings, chatMessagesDiv, electronAPI, markedInstance, scrollToBottom, summarizeTopicFromMessages, openModal, autoResizeTextarea });
            window.messageRenderer.renderMessage({ role: 'system', content: errorMsg, timestamp: Date.now() });
        } else {
            chatMessagesDiv.innerHTML = `<div class="message-item system"><div class="sender-name">系统</div><div>${errorMsg}</div></div>`;
        }
        return;
    }

    const loadingMessageDiv = document.createElement('div');
    loadingMessageDiv.className = 'message-item assistant';
    loadingMessageDiv.innerHTML = '<div class="sender-name">系统</div><div>加载聊天记录中...</div>';
    chatMessagesDiv.appendChild(loadingMessageDiv);

    const result = await window.electronAPI.getChatHistory(agentId, topicId);
    loadingMessageDiv.remove();

    // Display topic creation timestamp
    await displayTopicTimestampBubble(agentId, topicId);

    if (result.error) {
        if (window.messageRenderer) {
            window.messageRenderer.initializeMessageRenderer({ currentChatHistory, currentAgentId, currentTopicId: topicId, globalSettings, chatMessagesDiv, electronAPI, markedInstance, scrollToBottom, summarizeTopicFromMessages, openModal, autoResizeTextarea });
            window.messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录失败: ${result.error}`, timestamp: Date.now() });
        }
    } else {
        currentChatHistory = result;
        if (window.messageRenderer) {
             window.messageRenderer.initializeMessageRenderer({ currentChatHistory, currentAgentId, currentTopicId: topicId, globalSettings, chatMessagesDiv, electronAPI, markedInstance, scrollToBottom, summarizeTopicFromMessages, openModal, autoResizeTextarea });
            currentChatHistory.forEach(msg => window.messageRenderer.renderMessage(msg, true));
        }
    }
    scrollToBottom();
    if (agentId && topicId && !result.error) {
        localStorage.setItem(`lastActiveTopic_${agentId}`, topicId);
    }
}
 
// renderMessage, showContextMenu, closeContextMenu, closeContextMenuOnClickOutside, toggleEditMode, handleRegenerateResponse
// have been moved to modules/messageRenderer.js
 
function scrollToBottom() {
    // With flex-direction: column-reverse, scrolling to top shows latest messages
    chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight; // This should scroll to the "end" which is visually the bottom
    // Actually, for column-reverse, to see the newest message (which is added as the last child, but appears at the bottom),
    // we need to scroll to the bottom of the container.
    const parentContainer = document.querySelector('.chat-messages-container');
    if (parentContainer) {
        parentContainer.scrollTop = parentContainer.scrollHeight;
    }
}

async function displayTopicTimestampBubble(agentId, topicId) {
    const chatMessagesContainer = document.querySelector('.chat-messages-container'); // Parent of chatMessagesDiv
    const chatMessagesDivElement = document.getElementById('chatMessages'); // The direct container for messages and this bubble

    if (!chatMessagesDivElement || !chatMessagesContainer) {
        console.warn('[displayTopicTimestampBubble] Missing chatMessagesDivElement or chatMessagesContainer.');
        const existingBubble = document.getElementById('topicTimestampBubble');
        if (existingBubble) existingBubble.style.display = 'none';
        return;
    }

    let timestampBubble = document.getElementById('topicTimestampBubble');
    if (!timestampBubble) {
        timestampBubble = document.createElement('div');
        timestampBubble.id = 'topicTimestampBubble';
        timestampBubble.className = 'topic-timestamp-bubble';
        // Insert as the first child of chatMessagesDiv, so it scrolls with messages
        // and appears at the "top" due to column-reverse on parent
        if (chatMessagesDivElement.firstChild) {
            chatMessagesDivElement.insertBefore(timestampBubble, chatMessagesDivElement.firstChild);
        } else {
            chatMessagesDivElement.appendChild(timestampBubble);
        }
    } else {
        // Ensure it's the first child if it already exists
        if (chatMessagesDivElement.firstChild !== timestampBubble) {
            chatMessagesDivElement.insertBefore(timestampBubble, chatMessagesDivElement.firstChild);
        }
    }


    if (!agentId || !topicId) {
        // If no agent or topic, hide the bubble
        timestampBubble.style.display = 'none';
        return;
    }

    try {
        const agentConfig = await window.electronAPI.getAgentConfig(agentId);
        if (agentConfig && !agentConfig.error && agentConfig.topics) {
            const currentTopic = agentConfig.topics.find(t => t.id === topicId);
            if (currentTopic && currentTopic.createdAt) {
                const date = new Date(currentTopic.createdAt);
                const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                timestampBubble.textContent = `话题创建于: ${formattedDate}`;
                timestampBubble.style.display = 'block'; // Or 'flex' based on CSS, 'block' is fine for center alignment with margin auto
            } else {
                console.warn(`[displayTopicTimestampBubble] Topic ${topicId} not found or has no createdAt timestamp for agent ${agentId}.`);
                timestampBubble.style.display = 'none';
            }
        } else {
            console.error('[displayTopicTimestampBubble] Could not load agent config or topics for agent', agentId, 'Error:', agentConfig?.error);
            timestampBubble.style.display = 'none';
        }
    } catch (error) {
        console.error('[displayTopicTimestampBubble] Error fetching topic creation time for agent', agentId, 'topic', topicId, ':', error);
        timestampBubble.style.display = 'none';
    }
}


// Helper function to attempt topic summarization
async function attemptTopicSummarizationIfNeeded() {
    if (currentChatHistory.length >= 4 && currentTopicId) {
        try {
            const agentConfigForSummary = await window.electronAPI.getAgentConfig(currentAgentId);
            if (!agentConfigForSummary || agentConfigForSummary.error) {
                console.error('[TopicSummary] Failed to get agent config for summarization:', agentConfigForSummary?.error);
                return;
            }
            const topics = agentConfigForSummary.topics || [];
            const currentTopicObject = topics.find(t => t.id === currentTopicId);
            const existingTopicTitle = currentTopicObject ? currentTopicObject.name : "主要对话";
            const currentAgentName = agentConfigForSummary.name || 'AI';

            if (existingTopicTitle === "主要对话" || existingTopicTitle.startsWith("新话题")) {
                // Ensure summarizeTopicFromMessages is available
                if (typeof summarizeTopicFromMessages === 'function') {
                    const summarizedTitle = await summarizeTopicFromMessages(currentChatHistory.filter(m => !m.isThinking), currentAgentName);
                    if (summarizedTitle) {
                        const saveResult = await window.electronAPI.saveAgentTopicTitle(currentAgentId, currentTopicId, summarizedTitle);
                        if (saveResult.success) {
                            console.log(`AI 自动总结并保存话题 "${currentTopicId}" 标题: "${summarizedTitle}" for agent ${currentAgentId}`);
                            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                                loadTopicList();
                            }
                        } else {
                            console.error(`[TopicSummary] Failed to save new topic title "${summarizedTitle}":`, saveResult.error);
                        }
                    } else {
                        console.log('[TopicSummary] summarizeTopicFromMessages returned null, no title generated.');
                    }
                } else {
                    console.error('[TopicSummary] summarizeTopicFromMessages function is not defined or not accessible.');
                }
            } else {
                // console.log('[TopicSummary] Topic title is already custom, skipping summarization.');
            }
        } catch (error) {
            console.error('[TopicSummary] Error during attemptTopicSummarizationIfNeeded:', error);
        }
    }
}

async function handleSendMessage() {
    const content = messageInput.value.trim();
    if (!content && attachedFiles.length === 0) return;
    if (!currentAgentId || !currentTopicId) { // Also check for currentTopicId
        alert('请先选择一个Agent和话题！');
        return;
    }
    if (!globalSettings.vcpServerUrl) {
        alert('请先在全局设置中配置VCP服务器URL！');
        openModal('globalSettingsModal');
        return;
    }
 
    const userMessage = {
        role: 'user',
        content: content,
        timestamp: Date.now(),
        id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`, // Ensure user message also has an ID
        attachments: []
    };
    
    if (attachedFiles.length > 0) {
        // Now attachedFiles contains objects with internalPath
        // and potentially other data from fileManager.
        // The structure for userMessage.attachments should align with what
        // messageRenderer and the VCP preparation logic expect.
        userMessage.attachments = attachedFiles.map(af => ({
            type: af.file.type, // MIME type
            src: af.localPath,   // This is now the internal file:// URL to AppData
            name: af.originalName,
            size: af.file.size,
            // Potentially include other fields from af._fileManagerData if needed by VCP prep
            // For example, if base64 was pre-generated by fileManager and stored in _fileManagerData:
            // base64Data: af._fileManagerData.base64Data
        }));
    }
 
    if (window.messageRenderer) {
        window.messageRenderer.renderMessage(userMessage); // This adds to history and saves
    }

    messageInput.value = '';
    attachedFiles.length = 0; // Clear the array without reassigning
    updateAttachmentPreview();
    autoResizeTextarea(messageInput);
    messageInput.focus();

    const thinkingMessageId = `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`;
    const thinkingMessage = {
        role: 'assistant',
        content: '思考中...',
        timestamp: Date.now(),
        id: thinkingMessageId,
        isThinking: true
    };

    if (window.messageRenderer) {
        window.messageRenderer.renderMessage(thinkingMessage); // Render thinking message (won't save to history yet)
    }
 
    try {
        const agentConfig = await window.electronAPI.getAgentConfig(currentAgentId);
        // Prepare messages for VCP: take a snapshot of history *before* the thinking message
        // The thinking message itself is not sent to VCP.
        const historySnapshotForVCP = currentChatHistory.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);
        
        const messagesForVCP = await Promise.all(historySnapshotForVCP.map(async msg => {
            let vcpAttachments = [];
            if (msg.attachments && msg.attachments.length > 0) {
                vcpAttachments = await Promise.all(msg.attachments.map(async att => {
                    console.log('[Renderer - handleSendMessage] Processing attachment for VCP:', JSON.stringify(att, (key, value) => {
                        if (key === 'data' && typeof value === 'string' && value.length > 200) {
                            return `${value.substring(0, 50)}...[Base64, length: ${value.length}]...${value.substring(value.length - 50)}`;
                        }
                        return value;
                    }, 2)); // Log each attachment being processed
                    if (att.type.startsWith('image/')) {
                        try {
                            // 'att.src' is now the internal file:// URL from AppData
                            const internalPath = att.src;
                            console.log(`[Renderer - handleSendMessage] Attachment is image/audio. Calling getFileAsBase64 for internal path: ${internalPath}`);
                            const base64Result = await window.electronAPI.getFileAsBase64(internalPath); // No need for .replace('file://', '') if main.js handles it
                            
                            if (base64Result && base64Result.error) {
                                console.error(`[Renderer - handleSendMessage] Error from getFileAsBase64 for ${att.name} (internal: ${internalPath}):`, base64Result.error);
                                return { type: att.type, name: att.name, error: `Failed to load image/audio data: ${base64Result.error}` };
                            } else if (typeof base64Result === 'string' && base64Result.length > 0) {
                                console.log(`[Renderer - handleSendMessage] Successfully got Base64 for ${att.name} (internal: ${internalPath}), length: ${base64Result.length}`);
                                return { type: att.type, name: att.name, data: base64Result, internalPath: internalPath }; // Keep internalPath for reference
                            } else {
                                console.warn(`[Renderer - handleSendMessage] getFileAsBase64 returned unexpected data for ${att.name} (internal: ${internalPath}):`,
                                    (typeof base64Result === 'string' && base64Result.length > 200)
                                        ? `${base64Result.substring(0,50)}...[String, length: ${base64Result.length}]`
                                        : base64Result
                                );
                                return { type: att.type, name: att.name, error: "Failed to load image/audio data: Unexpected return" };
                            }
                        } catch (error) {
                            console.error(`[Renderer - handleSendMessage] Exception during getBase64 for ${att.name} (internal: ${att.src}):`, error);
                            return { type: att.type, name: att.name, error: `Failed to load image/audio data: ${error.message}` };
                        }
                    } else if (att.type.startsWith('text/') ||
                                 ['application/pdf',
                                  'application/msword',
                                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                  'application/javascript',
                                  'application/json',
                                  // Add other script/document MIME types that should be text-extracted
                                 ].includes(att.type) ||
                                 /\.(txt|md|log|js|json|html|css|py|java|c|cpp|cs|go|rb|php|swift|kt|ts|sh|xml|yaml|toml)$/i.test(att.name) // Check extension as fallback
                                ) {
                        try {
                            const internalPath = att.src; // This is the internal file:// URL
                            console.log(`[Renderer - handleSendMessage] Attachment is text-based. Calling getTextContent for: ${internalPath}, type: ${att.type}`);
                            const textResult = await window.electronAPI.getTextContent(internalPath, att.type);

                            if (textResult && textResult.error) {
                                console.error(`[Renderer - handleSendMessage] Error from getTextContent for ${att.name} (internal: ${internalPath}):`, textResult.error);
                                return { ...att, error: `Failed to extract text: ${textResult.error}` };
                            } else if (typeof textResult.textContent === 'string') {
                                console.log(`[Renderer - handleSendMessage] Successfully got text for ${att.name}, length: ${textResult.textContent.length}`);
                                return { ...att, extractedText: textResult.textContent }; // Add extractedText to the object
                            } else {
                                console.warn(`[Renderer - handleSendMessage] getTextContent returned unexpected data for ${att.name} (internal: ${internalPath}):`, textResult);
                                return { ...att, error: "Failed to extract text: Unexpected return" };
                            }
                        } catch (error) {
                            console.error(`[Renderer - handleSendMessage] Exception during getTextContent for ${att.name} (internal: ${att.src}):`, error);
                            return { ...att, error: `Failed to extract text: ${error.message}` };
                        }
                    } else {
                        console.log(`[Renderer - handleSendMessage] Other attachment type ${att.name} (${att.type}), sending metadata only.`);
                        return { type: att.type, name: att.name, internalPath: att.src };
                    }
                }));
                
                // Temporarily commenting out this log as it might be the source of full Base64 in renderer console.
                // Main process log for sent data is more critical and already abbreviates.
                // console.log('[Renderer - handleSendMessage] Constructed vcpAttachments (after base64/text processing):', JSON.stringify(vcpAttachments, (key, value) => {
                //     if (key === 'data' && typeof value === 'string' && value.length > 200) {
                //         return `${value.substring(0, 100)}...[Base64, length: ${value.length}]...${value.substring(value.length - 100)}`;
                //     }
                //     // if (key === 'text_content' && typeof value === 'string' && value.length > 200) {
                //     //    return `${value.substring(0,100)}...[Text, length: ${value.length}]`;
                //     // }
                //     return value;
                // }, 2));
            } // End of: if (msg.attachments && msg.attachments.length > 0)
            
            // --- Structure content for VCP ---
            if (msg.role === 'user') {
                let userPrimaryText = msg.content || ""; // Start with the user's typed text
                const mediaParts = []; // For image_url, audio_url objects
                const documentStrings = []; // To collect formatted document text strings
                let documentIndex = 1;    // To number the documents in the output

                if (vcpAttachments.length > 0) {
                    vcpAttachments.forEach(att => {
                        if (att.error) {
                             console.warn(`[Renderer - handleSendMessage] Skipping attachment ${att.name} for VCP processing due to error: ${att.error}`);
                             return;
                        }

                        if (att.type.startsWith('image/') && att.data) {
                            const dataUrl = `data:${att.type};base64,${att.data}`;
                            mediaParts.push({ type: 'image_url', image_url: { url: dataUrl } });
                            console.log(`[Renderer - handleSendMessage] Prepared image part for VCP: ${att.name}`);
                        } else if (att.type.startsWith('audio/') && att.data) {
                            const dataUrl = `data:${att.type};base64,${att.data}`;
                            mediaParts.push({ type: 'audio_url', audio_url: { url: dataUrl } });
                            console.log(`[Renderer - handleSendMessage] Prepared audio part for VCP: ${att.name}`);
                        } else if (att.extractedText !== undefined && att.extractedText !== null) {
                            // Format and collect extracted text
                            documentStrings.push(`[文档${documentIndex}-${att.name}：${att.extractedText}]`);
                            documentIndex++;
                            console.log(`[Renderer - handleSendMessage] Formatted and collected extracted text of ${att.name}.`);
                        }
                    });
                }
                
                // Combine user's primary text with the collected document strings
                let combinedTextContent = userPrimaryText;
                if (documentStrings.length > 0) {
                    if (combinedTextContent.length > 0) { // Add separation if there's primary text
                        combinedTextContent += "\n\n";
                    }
                    combinedTextContent += documentStrings.join("\n"); // Join multiple documents with a newline
                }

                const finalContentForVCP = [{ type: 'text', text: combinedTextContent }];
                finalContentForVCP.push(...mediaParts);

                return { role: msg.role, content: finalContentForVCP };
            } else { // For system or assistant messages
                return {
                    role: msg.role,
                    content: msg.content
                    // If assistant messages could have attachments to *send back* to VCP (unlikely), handle here.
                };
            }
        }));


        if (agentConfig.systemPrompt) {
            const systemPromptContent = agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name || currentAgentId);
            messagesForVCP.unshift({ role: 'system', content: systemPromptContent });
        }
        
        const useStreaming = agentConfig.streamOutput === true || agentConfig.streamOutput === 'true';
        const modelConfigForVCP = {
            model: agentConfig.model,
            temperature: parseFloat(agentConfig.temperature),
            ...(agentConfig.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens) }),
            stream: useStreaming
        };
        
        if (useStreaming) {
            activeStreamingMessageId = thinkingMessage.id; // Set active stream ID
            if (window.messageRenderer) {
                window.messageRenderer.startStreamingMessage({ ...thinkingMessage, content: "" });
            }
        }

        const vcpResponse = await window.electronAPI.sendToVCP(
            globalSettings.vcpServerUrl,
            globalSettings.vcpApiKey,
            messagesForVCP,
            modelConfigForVCP,
            thinkingMessage.id // Pass the thinkingMessage.id here
        );

        if (!useStreaming) {
            const thinkingMsgDom = chatMessagesDiv.querySelector(`.message-item[data-message-id="${thinkingMessage.id}"]`);
            if (thinkingMsgDom) thinkingMsgDom.remove();
            const thinkingMsgIndexHist = currentChatHistory.findIndex(msg => msg.id === thinkingMessage.id);
            if (thinkingMsgIndexHist > -1) currentChatHistory.splice(thinkingMsgIndexHist, 1);

            if (vcpResponse.error) {
                if (window.messageRenderer) {
                    window.messageRenderer.renderMessage({ role: 'system', content: `VCP错误: ${vcpResponse.error}`, timestamp: Date.now() });
                }
            } else if (vcpResponse.choices && vcpResponse.choices.length > 0) {
                const assistantMessageContent = vcpResponse.choices[0].message.content;
                if (window.messageRenderer) {
                    window.messageRenderer.renderMessage({ role: 'assistant', content: assistantMessageContent, timestamp: Date.now() });
                }
            } else {
                if (window.messageRenderer) {
                    window.messageRenderer.renderMessage({ role: 'system', content: 'VCP返回了未知格式的响应。', timestamp: Date.now() });
                }
            }
            await window.electronAPI.saveChatHistory(currentAgentId, currentTopicId, currentChatHistory.filter(msg => !msg.isThinking));
            // Attempt summarization after non-streamed response is processed
            await attemptTopicSummarizationIfNeeded();
        } else { // Handling for streaming responses (vcpResponse.streamError or !vcpResponse.streamingStarted)
            if (vcpResponse && vcpResponse.streamError) {
                console.error("Streaming setup failed in main process:", vcpResponse.errorDetail || vcpResponse.error);
                // Note: attemptTopicSummarizationIfNeeded will be called by onVCPStreamChunk 'end' or 'error' event for streams
            } else if (vcpResponse && !vcpResponse.streamingStarted && !vcpResponse.streamError) {
                console.warn("Expected streaming to start, but main process returned non-streaming or error:", vcpResponse);
                activeStreamingMessageId = null;
                const thinkingMsgDom = chatMessagesDiv.querySelector(`.message-item[data-message-id="${thinkingMessage.id}"]`);
                if (thinkingMsgDom) thinkingMsgDom.remove();
                const thinkingMsgIndexHist = currentChatHistory.findIndex(msg => msg.id === thinkingMessage.id);
                if (thinkingMsgIndexHist > -1) currentChatHistory.splice(thinkingMsgIndexHist, 1);
                
                if (window.messageRenderer) {
                    window.messageRenderer.renderMessage({ role: 'system', content: '请求流式回复失败，收到非流式响应或错误。', timestamp: Date.now() });
                }
                // Save history here as the stream didn't start as expected.
                await window.electronAPI.saveChatHistory(currentAgentId, currentTopicId, currentChatHistory.filter(msg => !msg.isThinking));
                // Attempt summarization as this path is effectively a non-stream completion (or failure)
                await attemptTopicSummarizationIfNeeded();
            }
            // For successful streaming, summarization is handled in onVCPStreamChunk 'end' event
        }

    } catch (error) {
        console.error('发送消息或处理VCP响应时出错:', error);
        activeStreamingMessageId = null;
        const thinkingMsgDom = chatMessagesDiv.querySelector(`.message-item[data-message-id="${thinkingMessage.id}"]`);
        if (thinkingMsgDom) thinkingMsgDom.remove();
        const thinkingMsgIndexHist = currentChatHistory.findIndex(msg => msg.id === thinkingMessage.id);
        if (thinkingMsgIndexHist > -1) currentChatHistory.splice(thinkingMsgIndexHist, 1);

        if (window.messageRenderer) {
            window.messageRenderer.renderMessage({ role: 'system', content: `错误: ${error.message}`, timestamp: Date.now() });
        }
        if(currentAgentId && currentTopicId) {
            await window.electronAPI.saveChatHistory(currentAgentId, currentTopicId, currentChatHistory.filter(msg => !msg.isThinking));
        }
    }
}
 
// handleRegenerateResponse has been moved to modules/messageRenderer.js
 
// --- Sidebar Tab Functionality ---
function setupSidebarTabs() {
    sidebarTabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.dataset.tab;

            // Update button active states
            sidebarTabButtons.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === targetTab);
            });

            // Update content active states
            sidebarTabContents.forEach(content => {
                const isActive = content.id === `tabContent${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`;
                content.classList.toggle('active', isActive);
                if (isActive) {
                    if (targetTab === 'topics') {
                        loadTopicList(); // Load topics when this tab becomes active
                    } else if (targetTab === 'settings') {
                        displayAgentSettingsInTab(); // New function to handle display in tab
                    }
                }
            });
        });
    });
}

// --- Topic/Chat History Summary Functionality ---
async function loadTopicList() {
    // Preserve the topics-header content (which includes the search bar)
    const topicsHeader = tabContentTopics.querySelector('.topics-header');
    const existingTopicListUl = tabContentTopics.querySelector('.topic-list');

    // Clear only the dynamic topic list, not the entire tabContentTopics
    if (existingTopicListUl) {
        existingTopicListUl.remove();
    }
    
    // If topicsHeader doesn't exist (first load), create it
    if (!topicsHeader) {
        // This scenario should ideally not happen after main.html is updated,
        // but as a fallback or for initial setup, we can re-create the structure.
        // However, it's better to assume main.html provides the base structure.
        // For now, we'll rely on the HTML being present.
        console.error("topics-header not found in tabContentTopics. HTML structure might be missing.");
        tabContentTopics.innerHTML = `
            <div class="topics-header">
                <h2>话题</h2>
                <div class="topic-search-container">
                    <input type="text" id="topicSearchInput" placeholder="搜索话题..." class="topic-search-input">
                    <button id="topicSearchBtn" class="topic-search-button">🔍</button>
                </div>
            </div>
            <ul class="topic-list" id="topicList"></ul>
        `;
        // Re-select elements after re-creating them
        // topicSearchInput = document.getElementById('topicSearchInput'); // Re-assign if needed
        // topicSearchBtn = document.getElementById('topicSearchBtn');     // Re-assign if needed
        // topicListUl = document.getElementById('topicList');            // Re-assign if needed
    }

    const topicListUl = document.createElement('ul');
    topicListUl.classList.add('topic-list');
    topicListUl.id = 'topicList'; // Ensure it has the ID for later selection
    tabContentTopics.appendChild(topicListUl); // Append the new ul after the header

    if (currentAgentId) {
        const agentNameForLoading = document.querySelector(`.agent-list li[data-agent-id="${currentAgentId}"] .agent-name`)?.textContent || '当前助手';
        topicListUl.innerHTML = `<li><p>正在加载 ${agentNameForLoading} 的话题...</p></li>`; // Use li for loading message

        const agentConfig = await window.electronAPI.getAgentConfig(currentAgentId);
        if (!agentConfig || agentConfig.error) {
            topicListUl.innerHTML = `<li><p>无法加载助手 ${agentNameForLoading} 的配置信息: ${agentConfig?.error || '未知错误'}</p></li>`;
            return;
        }

        let topics = agentConfig.topics || [{ id: "default", name: "主要对话", createdAt: Date.now() }];

        // Sort topics by createdAt in descending order (newest first)
        topics.sort((a, b) => {
            const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return dateB - dateA;
        });

        if (topics.length === 0) {
            topicListUl.innerHTML = `<li><p>助手 ${agentNameForLoading} 还没有任何话题。您可以点击上方的“新建上下文”按钮创建一个。</p></li>`;
            return;
        }

        topicListUl.innerHTML = ''; // Clear loading message before populating actual topics

        for (const topic of topics) {
            const li = document.createElement('li');
            li.classList.add('topic-item');
            li.dataset.agentId = currentAgentId;
            li.dataset.topicId = topic.id;
            li.classList.toggle('active', topic.id === currentTopicId);

            const avatarImg = document.createElement('img');
            avatarImg.classList.add('avatar');
            const agentForAvatar = (await window.electronAPI.getAgents()).find(a => a.id === currentAgentId);
            avatarImg.src = agentForAvatar?.avatarUrl || 'assets/default_avatar.png';
            avatarImg.alt = `${agentConfig.name} - ${topic.name}`;
            avatarImg.onerror = () => { avatarImg.src = 'assets/default_avatar.png'; };

            const topicTitleDisplay = document.createElement('span');
            topicTitleDisplay.classList.add('topic-title-display');
            topicTitleDisplay.textContent = topic.name || `话题 ${topic.id}`;
            
            const messageCountSpan = document.createElement('span');
            messageCountSpan.classList.add('message-count');
            messageCountSpan.textContent = '...';

            li.appendChild(avatarImg);
            li.appendChild(topicTitleDisplay);
            li.appendChild(messageCountSpan);

            window.electronAPI.getChatHistory(currentAgentId, topic.id).then(historyResult => {
                if (historyResult && !historyResult.error) {
                    messageCountSpan.textContent = `${historyResult.length}`;
                } else {
                    messageCountSpan.textContent = 'N/A';
                    console.error(`Error fetching history for topic ${topic.id} to count messages:`, historyResult?.error);
                }
            }).catch(err => {
                 messageCountSpan.textContent = 'ERR';
                 console.error(`Exception fetching history for topic ${topic.id}:`, err);
            });

            li.addEventListener('click', async () => {
                if (currentTopicId !== topic.id) {
                    currentTopicId = topic.id;
                    if (window.messageRenderer) {
                        window.messageRenderer.setCurrentTopicId(currentTopicId);
                    }
                    // Removed setupTopicSearch and filterTopicList definitions from here.
                    // They should be defined globally or at a higher scope and called from DOMContentLoaded.
                    
                    document.querySelectorAll('#topicList .topic-item').forEach(item => { // Use #topicList
                        item.classList.toggle('active', item.dataset.topicId === currentTopicId);
                    });
                    await loadChatHistory(currentAgentId, currentTopicId);
                    localStorage.setItem(`lastActiveTopic_${currentAgentId}`, currentTopicId);
                }
            });
            
            li.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showTopicContextMenu(e, li, agentConfig, topic);
            });
            topicListUl.appendChild(li);
        }

    } else {
        topicListUl.innerHTML = '<li><p>请先在“助手”标签页选择一个Agent，以查看其相关话题。</p></li>';
    }
}

// Updated context menu function for topics
function showTopicContextMenu(event, topicItemElement, agentConfig, topic) { // agentConfig and specific topic object
    console.log(`Right-clicked on topic: ${topic.name} (ID: ${topic.id}) for agent: ${agentConfig.name}`);
    closeContextMenu(); // Close any existing chat message context menu
    closeTopicContextMenu(); // Close any existing topic context menu first

    const menu = document.createElement('div');
    menu.id = 'topicContextMenu';
    menu.classList.add('context-menu');
    menu.style.top = `${event.clientY}px`;
    menu.style.left = `${event.clientX}px`;

    // Option 1: Edit Topic Title
    const editTitleOption = document.createElement('div');
    editTitleOption.classList.add('context-menu-item');
    editTitleOption.textContent = '编辑话题标题';
    editTitleOption.onclick = () => {
        closeTopicContextMenu();
        const titleDisplayElement = topicItemElement.querySelector('.topic-title-display');
        if (!titleDisplayElement) return;

        const originalTitle = topic.name;
        titleDisplayElement.style.display = 'none';

        const inputWrapper = document.createElement('div');
        inputWrapper.classList.add('topic-edit-input-wrapper', 'inline-edit-active');
        
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.value = originalTitle;
        titleInput.classList.add('topic-title-input');
        
        const saveButton = document.createElement('button');
        saveButton.textContent = '保存';
        saveButton.classList.add('topic-edit-save', 'inline-action-button');

        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.classList.add('topic-edit-cancel', 'inline-action-button');

        const restoreView = () => {
            inputWrapper.remove();
            titleDisplayElement.style.display = '';
        };

        saveButton.onclick = async () => {
            const newTitle = titleInput.value.trim();
            if (newTitle && newTitle !== originalTitle) {
                // Call updated saveAgentTopicTitle with agentId, topicId, newTitle
                const result = await window.electronAPI.saveAgentTopicTitle(agentConfig.id || currentAgentId, topic.id, newTitle);
                if (result && result.success) {
                    titleDisplayElement.textContent = newTitle;
                    topic.name = newTitle; // Update local topic object name
                    // If this was the current topic, maybe update chat header if it shows topic name
                } else {
                    alert(`更新话题标题失败: ${result ? result.error : '未知错误'}`);
                }
            }
            restoreView();
        };
        cancelButton.onclick = restoreView;
        titleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveButton.click(); }
            else if (e.key === 'Escape') { cancelButton.click(); }
        });
        inputWrapper.appendChild(titleInput);
        inputWrapper.appendChild(saveButton);
        inputWrapper.appendChild(cancelButton);
        topicItemElement.appendChild(inputWrapper); // Append to the li itself
        titleInput.focus();
        titleInput.select();
    };
    menu.appendChild(editTitleOption);

    // Option 2: Delete Topic (Clear chat history for this specific topic)
    // We need a new IPC for "delete-topic" which would remove the topic from config.topics and delete its history folder.
    // For now, let's just clear its history and rename it.
    const clearTopicHistoryOption = document.createElement('div');
    clearTopicHistoryOption.classList.add('context-menu-item', 'danger-text');
    clearTopicHistoryOption.textContent = '清空此话题聊天记录';
    clearTopicHistoryOption.onclick = async () => {
        closeTopicContextMenu();
        if (confirm(`确定要清空话题 "${topic.name}" 的所有聊天记录吗？此操作不可撤销。`)) {
            await window.electronAPI.saveChatHistory(currentAgentId, topic.id, []); // Save empty history
            if (currentTopicId === topic.id) { // If it's the currently active topic
                currentChatHistory = [];
                chatMessagesDiv.innerHTML = '';
                if (window.messageRenderer) {
                    window.messageRenderer.initializeMessageRenderer({ currentChatHistory, currentAgentId, currentTopicId, globalSettings, chatMessagesDiv, electronAPI, markedInstance, scrollToBottom, summarizeTopicFromMessages, openModal, autoResizeTextarea });
                    window.messageRenderer.renderMessage({ role: 'system', content: `话题 "${topic.name}" 的聊天记录已清空。`, timestamp: Date.now() });
                }
                // Ensure timestamp bubble is still displayed correctly as topic itself hasn't changed
                await displayTopicTimestampBubble(currentAgentId, topic.id);
            }
            // Optionally, rename the topic to indicate it's cleared, or just leave as is.
            // For example: await window.electronAPI.saveAgentTopicTitle(currentAgentId, topic.id, `${topic.name} (已清空)`);
            alert(`话题 "${topic.name}" 的聊天记录已清空。`);
            loadTopicList(); // Refresh topic list (e.g., if message counts were displayed)
        }
    };
    menu.appendChild(clearTopicHistoryOption);

    // Option 3: Delete Topic Permanently
    const deleteTopicPermanentlyOption = document.createElement('div');
    deleteTopicPermanentlyOption.classList.add('context-menu-item', 'danger-text'); // Style as danger
    deleteTopicPermanentlyOption.textContent = '永久删除此话题';
    deleteTopicPermanentlyOption.onclick = async () => {
        closeTopicContextMenu();
        if (confirm(`您确定要永久删除话题 "${topic.name}" 吗？\n此操作将删除话题本身及其所有聊天记录，且不可撤销！`)) {
            const result = await window.electronAPI.deleteTopic(currentAgentId, topic.id);
            if (result && result.success) {
                // alert(`话题 "${topic.name}" 已被永久删除。`);
                loadTopicList(); // Refresh the topic list in the UI

                // If the deleted topic was the current active one, select the new first topic (usually "default")
                if (currentTopicId === topic.id) {
                    const updatedTopics = result.remainingTopics || await window.electronAPI.getAgentTopics(currentAgentId);
                    if (updatedTopics && updatedTopics.length > 0) {
                        currentTopicId = updatedTopics[0].id;
                        await loadChatHistory(currentAgentId, currentTopicId);
                    } else { // Should not happen if main.js ensures a default topic
                        currentTopicId = null;
                        chatMessagesDiv.innerHTML = '<div class="message-item system"><div class="sender-name">系统</div><div>所有话题均已删除。</div></div>';
                        await displayTopicTimestampBubble(currentAgentId, null); // Hide bubble if all topics gone
                    }
                }
            } else {
                alert(`删除话题 "${topic.name}" 失败: ${result ? result.error : '未知错误'}`);
            }
        }
    };
    menu.appendChild(deleteTopicPermanentlyOption);
    

    document.body.appendChild(menu);
    document.addEventListener('click', closeTopicContextMenuOnClickOutside, true);
}

function closeTopicContextMenu() {
    const existingMenu = document.getElementById('topicContextMenu');
    if (existingMenu) {
        existingMenu.remove();
        document.removeEventListener('click', closeTopicContextMenuOnClickOutside, true);
    }
}

function closeTopicContextMenuOnClickOutside(event) {
    const menu = document.getElementById('topicContextMenu');
    if (menu && !menu.contains(event.target)) {
        closeTopicContextMenu();
    }
}


// --- UI Event Listeners & Helpers ---
function setupEventListeners() {
    sendMessageBtn.addEventListener('click', handleSendMessage);
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
    messageInput.addEventListener('input', () => autoResizeTextarea(messageInput));

    // File attachment
    attachFileBtn.addEventListener('click', async () => {
        if (!currentAgentId || !currentTopicId) {
            alert("请先选择一个Agent和话题以上传附件。");
            return;
        }
        // Pass currentAgentId and currentTopicId to the IPC call
        const result = await window.electronAPI.selectFilesToSend(currentAgentId, currentTopicId);

        if (result && result.success && result.attachments && result.attachments.length > 0) {
            result.attachments.forEach(att => {
                if (att.error) {
                    console.error(`Error processing selected file ${att.name || 'unknown'}: ${att.error}`);
                    alert(`处理文件 ${att.name || '未知文件'} 失败: ${att.error}`);
                } else {
                    // att is the full attachment object from fileManager.storeFile
                    attachedFiles.push({
                        file: { name: att.name, type: att.type, size: att.size },
                        localPath: att.internalPath, // This is now the internal AppData path
                        originalName: att.name,
                        _fileManagerData: att
                    });
                }
            });
            updateAttachmentPreview();
        } else if (result && !result.success && result.attachments && result.attachments.length === 0) {
            // Dialog was cancelled or no files selected, do nothing.
            console.log('[Renderer] File selection cancelled or no files selected.');
        } else if (result && result.error) {
            alert(`选择文件时出错: ${result.error}`);
        }
    });
    
    // The original 'paste' event listener on messageInput is now largely handled by inputEnhancer.js.
    // We can remove or comment out the old one to avoid conflicts if inputEnhancer.js covers all cases.
    // For now, let's comment it out. If specific text-only paste scenarios were uniquely handled here
    // and NOT by inputEnhancer's logic (e.g., non-long-text, non-file, non-image pastes),
    // that part might need to be preserved or merged. However, inputEnhancer aims to be comprehensive.
    /*
    messageInput.addEventListener('paste', async (event) => {
        // ... original paste logic from renderer.js ...
        // This is now superseded by modules/inputEnhancer.js
    });
    */
 
    // Global Settings Modal
    globalSettingsBtn.addEventListener('click', () => openModal('globalSettingsModal'));
    globalSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newSettings = {
            vcpServerUrl: document.getElementById('vcpServerUrl').value.trim(),
            vcpApiKey: document.getElementById('vcpApiKey').value, // Don't trim API key
            vcpLogUrl: document.getElementById('vcpLogUrl').value.trim(),
            vcpLogKey: document.getElementById('vcpLogKey').value.trim(),
            // userName: '莱恩' // Example, could be a setting
        };
        const result = await window.electronAPI.saveSettings(newSettings);
        if (result.success) {
            globalSettings = newSettings; // Update in-memory settings
            alert('全局设置已保存！部分设置（如通知URL/Key）可能需要重新连接生效。');
            closeModal('globalSettingsModal');
            // Re-connect VCPLog if settings changed
            if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey) {
                 window.electronAPI.connectVCPLog(globalSettings.vcpLogUrl, globalSettings.vcpLogKey);
            } else {
                 window.electronAPI.disconnectVCPLog();
                 // 调用模块中的函数
                 if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
            }
       } else {
           alert(`保存全局设置失败: ${result.error}`);
        }
    });

    // Create New Agent
    console.log('Attempting to add click listener to createNewAgentBtn'); // DEBUG
    createNewAgentBtn.addEventListener('click', async () => {
        console.log('createNewAgentBtn clicked. Bypassing prompt and alert.'); // DEBUG
        // const agentName = prompt("请输入新Agent的名称:", "新Agent"); // prompt() is not supported in Electron renderer with contextIsolation
        const defaultAgentName = `新Agent_${Date.now()}`;
        // alert(`由于 prompt() 不被支持，将使用默认名称创建Agent: ${defaultAgentName}\n您稍后可以在Agent设置中修改它。`); // Removed alert
        
        if (defaultAgentName) { // Always true with this temp fix
            const result = await window.electronAPI.createAgent(defaultAgentName);
            if (result.success) {
                await loadAgentList();
                selectAgent(result.agentId, result.agentName); // Automatically select the new agent
                openAgentSettingsModal(result.agentId); // Open settings for the new agent
            } else {
                alert(`创建Agent失败: ${result.error}`);
            }
        }
    });
    
    // "New Context from Current Agent" Button (formerly Agent Settings)
    currentAgentSettingsBtn.addEventListener('click', async () => {
        if (currentAgentId) {
            await createNewContextFromCurrentAgent();
        } else {
            alert("请先选择一个Agent作为上下文的基础。");
        }
    });

    agentSettingsForm.addEventListener('submit', saveCurrentAgentSettings);
    deleteAgentBtn.addEventListener('click', deleteCurrentAgent);
    agentAvatarInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                agentAvatarPreview.src = e.target.result;
                agentAvatarPreview.style.display = 'block';
            }
            reader.readAsDataURL(file);
        } else {
            agentAvatarPreview.style.display = 'none';
        }
    });

    // Clear Current Chat (now clears current topic for the current agent)
    clearCurrentChatBtn.addEventListener('click', async () => {
        if (currentAgentId && currentTopicId && confirm(`确定要清空当前话题的聊天记录吗（助手: ${currentChatAgentNameH3.textContent.replace('与 ','').replace(' 聊天中','')}）？此操作不可撤销。`)) {
            currentChatHistory = [];
            await window.electronAPI.saveChatHistory(currentAgentId, currentTopicId, []); // Save empty history for current topic
            chatMessagesDiv.innerHTML = '';
            if (window.messageRenderer) {
                 window.messageRenderer.initializeMessageRenderer({ currentChatHistory, currentAgentId, currentTopicId, globalSettings, chatMessagesDiv, electronAPI, markedInstance, scrollToBottom, summarizeTopicFromMessages, openModal, autoResizeTextarea });
                 window.messageRenderer.renderMessage({ role: 'system', content: '当前话题聊天记录已清空。', timestamp: Date.now() });
            }
            
            // Also reset the topic title for this specific topic to a generic name
            const clearedTopicName = `话题 ${currentTopicId.substring(0,8)}...`; // Or a more descriptive "已清空话题"
            const titleSaveResult = await window.electronAPI.saveAgentTopicTitle(currentAgentId, currentTopicId, clearedTopicName);
            if (titleSaveResult.success) {
                console.log(`Topic ${currentTopicId} title reset to "${clearedTopicName}" after clearing chat.`);
                if (document.getElementById('tabContentTopics').classList.contains('active')) {
                    loadTopicList(); // Refresh topic list to show new title
                }
            }
            alert('当前话题聊天记录已清空，话题标题已重置。');
        } else if (!currentTopicId) {
            alert("没有选中的话题可清空。");
        }
    });

    // VCPLog Notification Handlers (clearNotificationsBtn listener is still here)
    clearNotificationsBtn.addEventListener('click', () => {
        notificationsListUl.innerHTML = '';
    });

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            document.body.classList.toggle('light-theme');
            if (document.body.classList.contains('light-theme')) {
                localStorage.setItem('theme', 'light');
                themeToggleBtn.textContent = '🌙'; // Moon icon for light theme
            } else {
                localStorage.setItem('theme', 'dark');
                themeToggleBtn.textContent = '☀️'; // Sun icon for dark theme
            }
        });
    }
}


// --- Resizer Functionality ---
function initializeResizers() {
    let isResizingLeft = false;
    let isResizingRight = false;
    let initialLeftWidth = 0;
    let initialRightWidth = 0;
    let startX = 0;

    if (resizerLeft && leftSidebar) {
        resizerLeft.addEventListener('mousedown', (e) => {
            isResizingLeft = true;
            startX = e.clientX;
            initialLeftWidth = leftSidebar.offsetWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            leftSidebar.style.transition = 'none'; // 拖动开始时移除过渡
        });
    }

    if (resizerRight && rightNotificationsSidebar) {
        resizerRight.addEventListener('mousedown', (e) => {
            isResizingRight = true;
            startX = e.clientX;
            initialRightWidth = rightNotificationsSidebar.offsetWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });
    }

    document.addEventListener('mousemove', (e) => {
        if (isResizingLeft && leftSidebar) {
            const deltaX = e.clientX - startX;
            let newWidth = initialLeftWidth + deltaX;
            // Add min/max width constraints if necessary
            newWidth = Math.max(100, Math.min(newWidth, 700)); // 调整最小/最大宽度
            leftSidebar.style.width = `${newWidth}px`;
        }
        if (isResizingRight && rightNotificationsSidebar) {
            const deltaX = e.clientX - startX;
            let newWidth = initialRightWidth - deltaX; // Subtract because dragging right should decrease right sidebar width
            newWidth = Math.max(100, Math.min(newWidth, 700)); // 调整最小/最大宽度
            rightNotificationsSidebar.style.width = `${newWidth}px`;
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizingLeft || isResizingRight) {
            if (isResizingLeft) {
                leftSidebar.style.transition = ''; // 拖动结束时恢复过渡
            }
            isResizingLeft = false;
            isResizingRight = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}


function updateAttachmentPreview() {
    console.log('[Renderer] updateAttachmentPreview called. Current attachedFiles:', JSON.stringify(attachedFiles.map(f => ({ name: f.originalName, type: f.file.type, size: f.file.size, localPath: f.localPath }))));
    if (!attachmentPreviewArea) {
        console.error('[Renderer] updateAttachmentPreview: attachmentPreviewArea is null or undefined!');
        return;
    }
    console.log('[Renderer] updateAttachmentPreview: attachmentPreviewArea display style before change:', attachmentPreviewArea.style.display);

    attachmentPreviewArea.innerHTML = ''; // Clear previous previews
    if (attachedFiles.length === 0) {
        attachmentPreviewArea.style.display = 'none';
        console.log('[Renderer] updateAttachmentPreview: No files, hiding preview area.');
        return;
    }
    attachmentPreviewArea.style.display = 'flex'; // Ensure it's visible
    console.log('[Renderer] updateAttachmentPreview: Displaying preview area for', attachedFiles.length, 'files.');

    attachedFiles.forEach((af, index) => {
        console.log(`[Renderer] updateAttachmentPreview: Processing file ${index + 1}: ${af.originalName}`);
        const prevDiv = document.createElement('div');
        prevDiv.className = 'attachment-preview-item'; // New class for better styling
        prevDiv.title = af.originalName; // Show full name on hover

        const iconSpan = document.createElement('span');
        iconSpan.className = 'file-preview-icon';
        // Basic icon based on type - can be enhanced with SVGs or more specific icons
        if (af.file.type.startsWith('image/')) {
            iconSpan.textContent = '🖼️'; // Image icon
        } else if (af.file.type.startsWith('audio/')) {
            iconSpan.textContent = '🎵'; // Audio icon
        } else if (af.file.type.startsWith('video/')) {
            iconSpan.textContent = '🎞️'; // Video icon
        } else if (af.file.type.includes('pdf')) {
            iconSpan.textContent = '📄'; // PDF icon (generic file)
        } else {
            iconSpan.textContent = '📎'; // Generic attachment icon
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-preview-name';
        nameSpan.textContent = af.originalName.length > 20 ? af.originalName.substring(0, 17) + '...' : af.originalName;
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'file-preview-remove-btn';
        removeBtn.innerHTML = '&times;'; // Keep the times symbol, but styled as a button
        removeBtn.title = '移除此附件';
        removeBtn.onclick = () => {
            attachedFiles.splice(index, 1);
            updateAttachmentPreview();
        };

        prevDiv.appendChild(iconSpan);
        prevDiv.appendChild(nameSpan);
        prevDiv.appendChild(removeBtn);
        attachmentPreviewArea.appendChild(prevDiv);
    });
}


function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto'; // Reset height
    textarea.style.height = textarea.scrollHeight + 'px';
}

function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}
function closeModal(modalId) { // This function is still used for globalSettingsModal
    document.getElementById(modalId).classList.remove('active');
    // Removed agentSettingsModal specific logic from here as it's no longer a modal
    // Avatar preview and input clearing should be handled by displayAgentSettingsInTab or when an agent is deselected/changed.
}

// --- Image Preview Modal Functions (Removed as per new strategy) ---
// function openImagePreviewModal(src, caption = '') { ... }
// function closeImagePreviewModal() { ... }

async function displayAgentSettingsInTab() {
    if (currentAgentId) {
        agentSettingsContainer.style.display = 'block';
        selectAgentPromptForSettings.style.display = 'none';

        const config = await window.electronAPI.getAgentConfig(currentAgentId);
        if (config.error) {
            alert(`加载Agent配置失败: ${config.error}`);
            agentSettingsContainer.style.display = 'none';
            selectAgentPromptForSettings.textContent = `加载 ${currentChatAgentNameH3.textContent.replace('与 ','').replace(' 聊天中','')} 配置失败。`;
            selectAgentPromptForSettings.style.display = 'block';
            return;
        }
        const agents = await window.electronAPI.getAgents();
        const agent = agents.find(a => a.id === currentAgentId);

        if (!agent) {
            agentSettingsContainer.style.display = 'none';
            selectAgentPromptForSettings.textContent = `未找到ID为 ${currentAgentId} 的Agent。`;
            selectAgentPromptForSettings.style.display = 'block';
            return;
        }
        
        if(selectedAgentNameForSettingsSpan) selectedAgentNameForSettingsSpan.textContent = agent.name || currentAgentId;
        
        editingAgentIdInput.value = currentAgentId;
        agentNameInput.value = agent.name || currentAgentId;
        agentSystemPromptTextarea.value = config.systemPrompt || '';
        agentModelInput.value = config.model || '';
        agentTemperatureInput.value = config.temperature !== undefined ? config.temperature : 0.7;
        agentContextTokenLimitInput.value = config.contextTokenLimit !== undefined ? config.contextTokenLimit : 4000;
        agentMaxOutputTokensInput.value = config.maxOutputTokens !== undefined ? config.maxOutputTokens : 1000;

        // Set stream output radio buttons
        const streamOutput = config.streamOutput !== undefined ? config.streamOutput : true; // Default to true (streaming)
        document.getElementById('agentStreamOutputTrue').checked = streamOutput === true || streamOutput === 'true';
        document.getElementById('agentStreamOutputFalse').checked = streamOutput === false || streamOutput === 'false';
        
        if (agent.avatarUrl) {
            agentAvatarPreview.src = agent.avatarUrl + `?t=${Date.now()}`; // Cache buster
            agentAvatarPreview.style.display = 'block';
        } else {
            agentAvatarPreview.src = '#';
            agentAvatarPreview.style.display = 'none';
        }
        agentAvatarInput.value = ''; // Clear file input each time settings are displayed for an agent
    } else {
        agentSettingsContainer.style.display = 'none';
        selectAgentPromptForSettings.textContent = '请先在“助手”标签页选择一个Agent以查看或修改其设置。';
        selectAgentPromptForSettings.style.display = 'block';
        if(selectedAgentNameForSettingsSpan) selectedAgentNameForSettingsSpan.textContent = ''; // Clear agent name in title
    }
}

// Old openAgentSettingsModal function is now removed.

async function saveCurrentAgentSettings(event) {
    event.preventDefault();
    const agentId = editingAgentIdInput.value;
    const newConfig = {
        name: agentNameInput.value.trim(),
        systemPrompt: agentSystemPromptTextarea.value.trim(),
        model: agentModelInput.value.trim(),
        temperature: parseFloat(agentTemperatureInput.value),
        contextTokenLimit: parseInt(agentContextTokenLimitInput.value),
        maxOutputTokens: parseInt(agentMaxOutputTokensInput.value),
        streamOutput: document.getElementById('agentStreamOutputTrue').checked // true for streaming, false for non-streaming
    };

    if (!newConfig.name) {
        alert("Agent名称不能为空！");
        return;
    }

    // Save avatar if a new one was selected
    const avatarFile = agentAvatarInput.files[0];
    if (avatarFile) {
        try {
            const arrayBuffer = await avatarFile.arrayBuffer(); // Read file as ArrayBuffer
            const avatarResult = await window.electronAPI.saveAvatar(agentId, {
                name: avatarFile.name,
                type: avatarFile.type,
                buffer: arrayBuffer // Send ArrayBuffer
            });

            if (avatarResult.error) {
                alert(`保存头像失败: ${avatarResult.error}`);
            }
            // Avatar URL should be updated by main process if successful,
            // and loadAgentList will refresh it.
        } catch (readError) {
            console.error("读取头像文件失败:", readError);
            alert(`读取头像文件失败: ${readError.message}`);
        }
    }

    const result = await window.electronAPI.saveAgentConfig(agentId, newConfig);
    if (result.success) {
        alert(result.message || 'Agent设置已保存！');
        // No modal to close. Settings are in-tab.
        await loadAgentList(); // Refresh list to show new name/avatar
        // If current agent was edited, update header and settings tab title
        if (currentAgentId === agentId) {
            currentChatAgentNameH3.textContent = `与 ${newConfig.name} 聊天中`;
            if(selectedAgentNameForSettingsSpan) selectedAgentNameForSettingsSpan.textContent = newConfig.name;
        }
    } else {
        alert(`保存Agent设置失败: ${result.error}`);
    }
}

async function deleteCurrentAgent() {
    const agentId = editingAgentIdInput.value; // This ID should still be correct from the form
    // It's better to get the name from the input field in case it was changed but not saved
    const agentNameToConfirm = agentNameInput.value || '当前选中的Agent';

    if (confirm(`您确定要删除 Agent "${agentNameToConfirm}" 吗？其聊天记录也将被删除，此操作不可撤销！`)) {
        const result = await window.electronAPI.deleteAgent(agentId);
        if (result.success) {
            alert(result.message || `Agent ${agentNameToConfirm} 已删除。`);
            // No modal to close. Clear the settings view.
            const deletedAgentId = currentAgentId; // Store it before resetting
            currentAgentId = null;
            
            // If the deleted agent was the currently active one, update UI
            if (deletedAgentId === agentId) {
                currentChatAgentNameH3.textContent = '选择一个Agent开始聊天';
                chatMessagesDiv.innerHTML = '';
                currentAgentSettingsBtn.style.display = 'none';
                clearCurrentChatBtn.style.display = 'none';
                messageInput.disabled = true;
                sendMessageBtn.disabled = true;
                attachFileBtn.disabled = true;
                await displayTopicTimestampBubble(null, null); // Hide bubble as no agent/topic selected
            }
            
            await loadAgentList(); // Refresh agent list
            displayAgentSettingsInTab(); // Update settings tab to show prompt or another agent's settings if one gets auto-selected
        } else {
            alert(`删除Agent失败: ${result.error}`);
        }
    }
}

async function createNewContextFromCurrentAgent() {
    if (!currentAgentId) {
        alert("请先选择一个助手。");
        return;
    }

    const agentName = (document.querySelector(`.agent-list li[data-agent-id="${currentAgentId}"] .agent-name`)?.textContent || "当前助手");
    // Temporary fix: Use a default name instead of prompt()
    const newTopicName = `新话题 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    console.log(`使用默认话题名称: ${newTopicName}`); // Log the default name

    // Original prompt logic commented out:
    // const newTopicNameInput = prompt(`为助手 "${agentName}" 输入新话题的名称:`, `新话题 ${new Date().toLocaleDateString()}`);
    // if (!newTopicNameInput || newTopicNameInput.trim() === "") {
    //     alert("话题名称不能为空。");
    //     return;
    // }
    // const newTopicName = newTopicNameInput.trim();

    try {
        const result = await window.electronAPI.createNewTopicForAgent(currentAgentId, newTopicName);

        if (result && result.success && result.topicId) {
            currentTopicId = result.topicId;
            currentChatHistory = [];
            chatMessagesDiv.innerHTML = '';

            if (window.messageRenderer) {
                window.messageRenderer.setCurrentTopicId(currentTopicId);
                window.messageRenderer.initializeMessageRenderer({
                    currentChatHistory, currentAgentId, currentTopicId,
                    globalSettings, chatMessagesDiv, electronAPI, markedInstance,
                    scrollToBottom, summarizeTopicFromMessages, openModal, autoResizeTextarea
                });
                window.messageRenderer.renderMessage({ role: 'system', content: `新话题 "${result.topicName}" 已开始。`, timestamp: Date.now() });
            }
            localStorage.setItem(`lastActiveTopic_${currentAgentId}`, currentTopicId);
            
            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                loadTopicList();
            }
            await displayTopicTimestampBubble(currentAgentId, currentTopicId); // Display for new topic
            console.log(`已为助手 "${agentName}" 创建并切换到新话题: "${result.topicName}" (ID: ${result.topicId})`);
            messageInput.focus();
        } else {
            alert(`创建新话题失败: ${result ? result.error : '未知错误'}`);
        }
    } catch (error) {
        console.error(`创建新话题时出错:`, error);
        alert(`创建新话题时出错: ${error.message}`);
    }
}



// VCPLog Notification Rendering functions (updateVCPLogStatus, renderVCPLogNotification)
// have been moved to modules/notificationRenderer.js
 
// --- Markdown Rendering (using a library like 'marked') ---
// Ensure 'marked.min.js' is available or install 'marked' via npm and require it in main/preload.
// For this example, let's assume 'marked' is globally available in renderer (e.g. via <script> tag)
// If using npm: const { marked } = require('marked'); in preload and expose it.
// For simplicity, I'll assume it's available.
// In a real Electron app, you'd typically bundle 'marked' or load it.

let markedInstance;
if (window.marked) {
    try {
        // Attempt to configure marked to allow HTML.
        // The exact option might vary based on the version of marked.js.
        // For older versions, 'sanitize: false' or 'sanitize: true' with a custom sanitizer might be used.
        // For newer versions (like from v4.x.x onwards), HTML is rendered by default unless a sanitizer is explicitly set.
        // If using a version that sanitizes by default, you might need to override the sanitizer or use a specific option.
        // Let's assume for now that if `marked` is present, we want to ensure HTML isn't overly sanitized.
        // A common, albeit potentially unsafe if not further processed, way is to disable sanitization.
        markedInstance = new window.marked.Marked({
            sanitize: false, // Important: This allows all HTML. Consider DOMPurify for safety.
            gfm: true, // Enable GitHub Flavored Markdown
            breaks: true // Enable GFM line breaks
        });
        console.log("Marked library initialized with custom options (sanitize: false).");

        // Wrap the original parse method to add custom quote handling
        const originalParse = markedInstance.parse.bind(markedInstance);
        markedInstance.parse = (text) => {
            if (typeof text !== 'string') {
                return originalParse(text); // Pass non-strings directly
            }

            // Step 1: Get the initial HTML from marked
            const html = originalParse(text);

            // Step 2: Process the HTML string to add spans for quotes
            const applyQuoteSpansToHtml = (inputHtml) => {
                let resultHtml = inputHtml;

                // Process Chinese quotes: “content” -> “<span class='quoted-text'>content</span>”
                // The content [^”<>]* allows empty content and avoids crossing HTML tags or our own spans.
                resultHtml = resultHtml.replace(/(“)([^”<>]*?)(”)/g, (_match, openQuote, innerContent, closeQuote) => {
                    if (innerContent.includes('class="quoted-text"')) { // Avoid double wrapping
                        return _match;
                    }
                    return `<span class="quoted-text">${openQuote}${innerContent}${closeQuote}</span>`;
                });

                // Process English quotes: "content" -> "<span class='quoted-text'>content</span>"
                // This is applied carefully to avoid breaking HTML attributes.
                // Split the HTML by tags, process text segments, and rejoin.
                const parts = resultHtml.split(/(<[^>]+>)/); // Split by tags, keeping tags as delimiters
                for (let i = 0; i < parts.length; i++) {
                    if (i % 2 === 0) { // This is a text segment (even indices)
                        // Apply to English quotes. Content [^"<>]*? is non-greedy.
                        parts[i] = parts[i].replace(/(")([^"<>]*?)(")/g, (_match, openQuote, innerContent, closeQuote) => {
                            if (innerContent.includes('class="quoted-text"')) { // Avoid double wrapping
                                return _match;
                            }
                            // Avoid wrapping if it looks like an empty attribute value e.g. alt=""
                            // This check is heuristic. A more robust solution would require full HTML parsing.
                            if (innerContent.length === 0 && _match.length === 2) { // e.g. ""
                                // Check context in parts[i] if this is part of an attribute
                                // For now, we allow empty quoted spans if they are not attributes.
                                }
                                return `<span class="quoted-text">${openQuote}${innerContent}${closeQuote}</span>`;
                            });
                        }
                    }
                resultHtml = parts.join('');
                return resultHtml;
            };

            return applyQuoteSpansToHtml(html);
        };
        console.log("Marked library's parse method wrapped for custom quote handling (after initial parse).");

    } catch (err) {
        console.warn("Failed to initialize marked with custom options, using default or basic fallback.", err);
        // Fallback to default marked if custom init fails, or our basic one if marked itself is missing.
        markedInstance = window.marked || { parse: (text) => `<p>${text.replace(/\n/g, '<br>')}</p>` };
    }
} else {
    console.warn("Marked library not found, Markdown rendering will be basic.");
    markedInstance = { parse: (text) => `<p>${text.replace(/\n/g, '<br>')}</p>` }; // Basic fallback
}
// Use markedInstance.parse(text) instead of marked.parse(text)
// We need to replace all instances of marked.parse with markedInstance.parse

// Add a context menu (basic example)
window.addEventListener('contextmenu', (e) => {
    // Example: only show for textareas or inputs
    if (e.target.closest('textarea, input[type="text"]')) {
        // In a real app, you'd use Electron's Menu module via IPC
        // For simplicity, this is just a placeholder.
        // window.electronAPI.showContextMenu(); // You'd define this in preload/main
        console.log("Context menu triggered on input/textarea");
    }
}, false);

// --- Custom Title Bar Controls ---
function setupTitleBarControls() {
    console.log('[Renderer] setupTitleBarControls called.');
    console.log('[Renderer] minimizeBtn:', minimizeBtn);
    console.log('[Renderer] maximizeBtn:', maximizeBtn);
    console.log('[Renderer] restoreBtn:', restoreBtn);
    console.log('[Renderer] closeBtn:', closeBtn);
    console.log('[Renderer] window.electronAPI:', window.electronAPI);
    if (window.electronAPI) {
        console.log('[Renderer] typeof window.electronAPI.minimizeWindow:', typeof window.electronAPI.minimizeWindow);
        console.log('[Renderer] typeof window.electronAPI.maximizeWindow:', typeof window.electronAPI.maximizeWindow);
        console.log('[Renderer] typeof window.electronAPI.unmaximizeWindow:', typeof window.electronAPI.unmaximizeWindow);
        console.log('[Renderer] typeof window.electronAPI.closeWindow:', typeof window.electronAPI.closeWindow);
        console.log('[Renderer] typeof window.electronAPI.onWindowMaximized:', typeof window.electronAPI.onWindowMaximized);
        console.log('[Renderer] typeof window.electronAPI.onWindowUnmaximized:', typeof window.electronAPI.onWindowUnmaximized);
    }

    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            window.electronAPI.minimizeWindow();
        });
    }
    if (maximizeBtn) {
        maximizeBtn.addEventListener('click', () => {
            window.electronAPI.maximizeWindow();
        });
    }
    if (restoreBtn) {
        restoreBtn.addEventListener('click', () => {
            window.electronAPI.unmaximizeWindow();
        });
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.electronAPI.closeWindow();
        });
    }
    if (settingsBtn) { // Add this block
        settingsBtn.addEventListener('click', () => {
            console.log('Settings button clicked, attempting to open dev tools.'); // DEBUG
            window.electronAPI.openDevTools();
        });
    }

    // Listen for maximize/unmaximize events to toggle buttons
    if (window.electronAPI && typeof window.electronAPI.onWindowMaximized === 'function') {
        window.electronAPI.onWindowMaximized(() => {
            if (maximizeBtn) maximizeBtn.style.display = 'none';
            if (restoreBtn) restoreBtn.style.display = 'flex'; // Use flex as buttons are display:flex
        });
    }

    if (window.electronAPI && typeof window.electronAPI.onWindowUnmaximized === 'function') {
        window.electronAPI.onWindowUnmaximized(() => {
            if (maximizeBtn) maximizeBtn.style.display = 'flex';
            if (restoreBtn) restoreBtn.style.display = 'none';
        });
    }
}
