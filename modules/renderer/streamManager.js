// modules/renderer/streamManager.js

// --- Stream State ---
const streamingChunkQueues = new Map(); // messageId -> array of original chunk strings
const streamingTimers = new Map();      // messageId -> intervalId
const accumulatedStreamText = new Map(); // messageId -> string
let activeStreamingMessageId = null; // Track the currently active streaming message

// --- 新增：预缓冲系统 ---
const preBufferedChunks = new Map(); // messageId -> array of chunks waiting for initialization
const messageInitializationStatus = new Map(); // messageId -> 'pending' | 'ready' | 'finalized'

// --- 新增：消息上下文映射 ---
const messageContextMap = new Map(); // messageId -> {agentId, groupId, topicId, isGroupMessage}

// --- Local Reference Store ---
let refs = {};

/**
 * Initializes the Stream Manager with necessary dependencies from the main renderer.
 * @param {object} dependencies - An object containing all required functions and references.
 */
export function initStreamManager(dependencies) {
    refs = dependencies;
}

function shouldEnableSmoothStreaming() {
    const globalSettings = refs.globalSettingsRef.get();
    return globalSettings.enableSmoothStreaming === true;
}

function messageIsFinalized(messageId) {
    // Don't rely on current history, check accumulated state
    const initStatus = messageInitializationStatus.get(messageId);
    return initStatus === 'finalized';
}

// Helper function to determine if a message is for the current view
function isMessageForCurrentView(context) {
    if (!context) return false;
    const currentSelectedItem = refs.currentSelectedItemRef.get();
    const currentTopicId = refs.currentTopicIdRef.get();
    
    if (!currentSelectedItem || !currentTopicId) return false;
    
    const itemId = context.groupId || context.agentId;
    return itemId === currentSelectedItem.id && context.topicId === currentTopicId;
}

async function getHistoryForContext(context) {
    const { electronAPI } = refs;
    if (!context) return null;
    
    const { agentId, groupId, topicId, isGroupMessage } = context;
    const itemId = groupId || agentId;
    
    if (!itemId || !topicId) return null;
    
    try {
        const historyResult = isGroupMessage
            ? await electronAPI.getGroupChatHistory(itemId, topicId)
            : await electronAPI.getChatHistory(itemId, topicId);
        
        if (historyResult && !historyResult.error) {
            return historyResult;
        }
    } catch (e) {
        console.error(`[StreamManager] Failed to get history for context`, context, e);
    }
    
    return null;
}

async function saveHistoryForContext(context, history) {
    const { electronAPI } = refs;
    if (!context || context.isGroupMessage) {
        // For group messages, the main process (groupchat.js) is the single source of truth for history.
        // The renderer avoids saving to prevent race conditions and overwriting the correct history.
        return;
    }
    
    const { agentId, topicId } = context;
    
    if (!agentId || !topicId) return;
    
    const historyToSave = history.filter(msg => !msg.isThinking);
    
    try {
        await electronAPI.saveChatHistory(agentId, topicId, historyToSave);
    } catch (e) {
        console.error(`[StreamManager] Failed to save history for context`, context, e);
    }
}

function processAndRenderSmoothChunk(messageId) {
    const context = messageContextMap.get(messageId);
    const isForCurrentView = isMessageForCurrentView(context);
    
    if (!isForCurrentView) {
        // For background messages, just process the queue without DOM operations
        const queue = streamingChunkQueues.get(messageId);
        if (queue && queue.length > 0) {
            const globalSettings = refs.globalSettingsRef.get();
            const minChunkSize = globalSettings.minChunkBufferSize !== undefined && globalSettings.minChunkBufferSize >= 1 ? globalSettings.minChunkBufferSize : 1;
            
            let textBatchToProcess = "";
            while (queue.length > 0 && textBatchToProcess.length < minChunkSize) {
                textBatchToProcess += queue.shift();
            }
            // Just accumulate the text, don't render
            // The text is already accumulated in appendStreamChunk
        }
        return;
    }
    
    // For current view messages, render to DOM
    const { chatMessagesDiv, markedInstance } = refs;
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem || !document.body.contains(messageItem)) return;
    
    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;
    
    const queue = streamingChunkQueues.get(messageId);
    if (!queue || queue.length === 0) return;
    
    let textBatchToRender = "";
    const globalSettings = refs.globalSettingsRef.get();
    const minChunkSize = globalSettings.minChunkBufferSize !== undefined && globalSettings.minChunkBufferSize >= 1 ? globalSettings.minChunkBufferSize : 1;
    
    while (queue.length > 0 && textBatchToRender.length < minChunkSize) {
        textBatchToRender += queue.shift();
    }
    
    if (!textBatchToRender) return;
    
    const textForRendering = accumulatedStreamText.get(messageId) || "";
    
    const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
    if (streamingIndicator) streamingIndicator.remove();
    
    let processedTextForParse = refs.removeSpeakerTags(textForRendering);
    processedTextForParse = refs.ensureNewlineAfterCodeBlock(processedTextForParse);
    processedTextForParse = refs.ensureSpaceAfterTilde(processedTextForParse);
    processedTextForParse = refs.removeIndentationFromCodeBlockMarkers(processedTextForParse);
    processedTextForParse = refs.ensureSeparatorBetweenImgAndCode(processedTextForParse);
    
    const rawHtml = markedInstance.parse(processedTextForParse);
    refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
    refs.processRenderedContent(contentDiv);
    refs.uiHelper.scrollToBottom();
}

function renderChunkDirectlyToDOM(messageId, textToAppend) {
    const context = messageContextMap.get(messageId);
    const isForCurrentView = isMessageForCurrentView(context);
    
    if (!isForCurrentView) {
        // For background messages, don't render to DOM
        return;
    }
    
    const { chatMessagesDiv, markedInstance } = refs;
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) return;
    
    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;
    
    const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
    if (streamingIndicator) streamingIndicator.remove();
    
    const fullCurrentText = accumulatedStreamText.get(messageId) || "";
    
    let processedFullCurrentTextForParse = refs.removeSpeakerTags(fullCurrentText);
    processedFullCurrentTextForParse = refs.ensureNewlineAfterCodeBlock(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.ensureSpaceAfterTilde(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.removeIndentationFromCodeBlockMarkers(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.ensureSeparatorBetweenImgAndCode(processedFullCurrentTextForParse);
    
    const rawHtml = markedInstance.parse(processedFullCurrentTextForParse);
    refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
    refs.processRenderedContent(contentDiv);
}

export async function startStreamingMessage(message, passedMessageItem = null) {
    const messageId = message.id;
    
    // Store the context for this message - ensure proper context structure
    const context = {
        agentId: message.agentId || message.context?.agentId || (message.isGroupMessage ? undefined : refs.currentSelectedItemRef.get()?.id),
        groupId: message.groupId || message.context?.groupId || (message.isGroupMessage ? refs.currentSelectedItemRef.get()?.id : undefined),
        topicId: message.topicId || message.context?.topicId || refs.currentTopicIdRef.get(),
        isGroupMessage: message.isGroupMessage || message.context?.isGroupMessage || false,
        agentName: message.name || message.context?.agentName,
        avatarUrl: message.avatarUrl || message.context?.avatarUrl,
        avatarColor: message.avatarColor || message.context?.avatarColor,
    };
    
    // Validate context
    if (!context.topicId || (!context.agentId && !context.groupId)) {
        console.error(`[StreamManager] Invalid context for message ${messageId}`, context);
        return null;
    }
    
    messageContextMap.set(messageId, context);
    messageInitializationStatus.set(messageId, 'pending');
    activeStreamingMessageId = messageId;
    
    const { chatMessagesDiv, electronAPI, currentChatHistoryRef, uiHelper } = refs;
    const isForCurrentView = isMessageForCurrentView(context);
    
    // Get the correct history for this message's context
    let historyForThisMessage;
    // For assistant chat, always use a temporary in-memory history
    if (context.topicId === 'assistant_chat') {
        historyForThisMessage = currentChatHistoryRef.get();
    } else if (isForCurrentView) {
        // For current view, use in-memory history
        historyForThisMessage = currentChatHistoryRef.get();
    } else {
        // For background chats, load from disk
        historyForThisMessage = await getHistoryForContext(context);
        if (!historyForThisMessage) {
            console.error(`[StreamManager] Could not load history for background message ${messageId}`, context);
            messageInitializationStatus.set(messageId, 'finalized');
            return null;
        }
    }
    
    // Only manipulate DOM for current view
    let messageItem = null;
    if (isForCurrentView) {
        messageItem = passedMessageItem || chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
        if (!messageItem) {
            const placeholderMessage = { 
                ...message, 
                content: message.content || '思考中...', // Show thinking text initially
                isThinking: true, // Mark as thinking
                timestamp: message.timestamp || Date.now(), 
                isGroupMessage: message.isGroupMessage || false 
            };
            messageItem = refs.renderMessage(placeholderMessage, false);
            if (!messageItem) {
                console.error(`[StreamManager] Failed to render message item for ${message.id}`);
                messageInitializationStatus.set(messageId, 'finalized');
                return null;
            }
        }
        // Add streaming class and remove thinking class when we have a valid messageItem
        if (messageItem && messageItem.classList) {
            messageItem.classList.add('streaming');
            messageItem.classList.remove('thinking');
        }
    }
    
    // Initialize streaming state
    if (shouldEnableSmoothStreaming()) {
        streamingChunkQueues.set(messageId, []);
    }
    accumulatedStreamText.set(messageId, '');
    
    // Prepare placeholder for history
    const placeholderForHistory = {
        ...message,
        content: '',
        isThinking: false,
        timestamp: message.timestamp || Date.now(),
        isGroupMessage: context.isGroupMessage,
        name: context.agentName,
        agentId: context.agentId
    };
    
    // Update the appropriate history
    const historyIndex = historyForThisMessage.findIndex(m => m.id === message.id);
    if (historyIndex === -1) {
        historyForThisMessage.push(placeholderForHistory);
    } else {
        historyForThisMessage[historyIndex] = { ...historyForThisMessage[historyIndex], ...placeholderForHistory };
    }
    
    // Save the history
    if (isForCurrentView) {
        // Update in-memory reference for current view
        currentChatHistoryRef.set([...historyForThisMessage]);
    }
    
    // Only save history for persistent chats (not temporary assistant/voice chats)
    if (context.topicId !== 'assistant_chat' && !context.topicId.startsWith('voicechat_')) {
        await saveHistoryForContext(context, historyForThisMessage);
    }
    
    // Initialization is complete, message is ready to process chunks.
    messageInitializationStatus.set(messageId, 'ready');
    
    // Process any chunks that were pre-buffered during initialization.
    const bufferedChunks = preBufferedChunks.get(messageId);
    if (bufferedChunks && bufferedChunks.length > 0) {
        console.log(`[StreamManager] Processing ${bufferedChunks.length} pre-buffered chunks for message ${messageId}`);
        for (const chunkData of bufferedChunks) {
            appendStreamChunk(messageId, chunkData.chunk, chunkData.context);
        }
        preBufferedChunks.delete(messageId);
    }
    
    if (isForCurrentView) {
        uiHelper.scrollToBottom();
    }
    
    return messageItem;
}

export function appendStreamChunk(messageId, chunkData, context) {
    const initStatus = messageInitializationStatus.get(messageId);
    
    if (!initStatus || initStatus === 'pending') {
        if (!preBufferedChunks.has(messageId)) {
            preBufferedChunks.set(messageId, []);
            // 只在第一次创建缓冲区时打印日志
            console.log(`[StreamManager] Started pre-buffering for message ${messageId}`);
        }
        const buffer = preBufferedChunks.get(messageId);
        buffer.push({ chunk: chunkData, context });
        
        // 防止缓冲区无限增长 - 如果超过1000个chunks，可能有问题
        if (buffer.length > 1000) {
            console.error(`[StreamManager] Pre-buffer overflow for message ${messageId}! Forcing initialization...`);
            // 强制设置为ready状态以开始处理
            messageInitializationStatus.set(messageId, 'ready');
            // 处理缓冲的chunks
            for (const bufferedData of buffer) {
                appendStreamChunk(messageId, bufferedData.chunk, bufferedData.context);
            }
            preBufferedChunks.delete(messageId);
        }
        return;
    }
    
    if (initStatus === 'finalized') {
        console.warn(`[StreamManager] Received chunk for already finalized message ${messageId}. Ignoring.`);
        return;
    }
    
    // Extract text from chunk
    let textToAppend = "";
    if (chunkData?.choices?.[0]?.delta?.content) {
        textToAppend = chunkData.choices[0].delta.content;
    } else if (chunkData?.delta?.content) {
        textToAppend = chunkData.delta.content;
    } else if (typeof chunkData?.content === 'string') {
        textToAppend = chunkData.content;
    } else if (typeof chunkData === 'string') {
        textToAppend = chunkData;
    } else if (chunkData?.raw) {
        textToAppend = chunkData.raw + (chunkData.error ? ` (解析错误)` : "");
    }
    
    if (!textToAppend) return;
    
    // Always maintain accumulated text
    let currentAccumulated = accumulatedStreamText.get(messageId) || "";
    currentAccumulated += textToAppend;
    accumulatedStreamText.set(messageId, currentAccumulated);
    
    // Update context if provided
    if (context) {
        const storedContext = messageContextMap.get(messageId);
        if (storedContext) {
            if (context.agentName) storedContext.agentName = context.agentName;
            if (context.agentId) storedContext.agentId = context.agentId;
            messageContextMap.set(messageId, storedContext);
        }
    }
    
    if (shouldEnableSmoothStreaming()) {
        const queue = streamingChunkQueues.get(messageId);
        if (queue) {
            const chars = textToAppend.split('');
            for (const char of chars) queue.push(char);
        } else {
            renderChunkDirectlyToDOM(messageId, textToAppend);
            return;
        }
        
        if (!streamingTimers.has(messageId)) {
            const globalSettings = refs.globalSettingsRef.get();
            const timerId = setInterval(() => {
                processAndRenderSmoothChunk(messageId);
                
                const currentQueue = streamingChunkQueues.get(messageId);
                if ((!currentQueue || currentQueue.length === 0) && messageIsFinalized(messageId)) {
                    clearInterval(streamingTimers.get(messageId));
                    streamingTimers.delete(messageId);
                    
                    const storedContext = messageContextMap.get(messageId);
                    if (isMessageForCurrentView(storedContext)) {
                        const finalMessageItem = refs.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
                        if (finalMessageItem) finalMessageItem.classList.remove('streaming');
                    }
                    
                    streamingChunkQueues.delete(messageId);
                }
            }, globalSettings.smoothStreamIntervalMs !== undefined && globalSettings.smoothStreamIntervalMs >= 1 ? globalSettings.smoothStreamIntervalMs : 25);
            streamingTimers.set(messageId, timerId);
        }
    } else {
        renderChunkDirectlyToDOM(messageId, textToAppend);
    }
}

export async function finalizeStreamedMessage(messageId, finishReason, context) {
    // Process remaining chunks
    if (shouldEnableSmoothStreaming()) {
        const queue = streamingChunkQueues.get(messageId);
        if (queue && queue.length > 0) {
            console.log(`[StreamManager] Processing ${queue.length} remaining chunks before finalization`);
            while (queue.length > 0) {
                processAndRenderSmoothChunk(messageId);
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    
    // Stop timers
    if (streamingTimers.has(messageId)) {
        clearInterval(streamingTimers.get(messageId));
        streamingTimers.delete(messageId);
    }
    if (activeStreamingMessageId === messageId) {
        activeStreamingMessageId = null;
    }
    
    messageInitializationStatus.set(messageId, 'finalized');
    
    // Get the stored context for this message
    const storedContext = messageContextMap.get(messageId) || context;
    if (!storedContext) {
        console.error(`[StreamManager] No context available for message ${messageId}`);
        return;
    }
    
    const { chatMessagesDiv, markedInstance, uiHelper } = refs;
    const isForCurrentView = isMessageForCurrentView(storedContext);
    
    // Get the correct history
    let historyForThisMessage;
    // For assistant chat, always use the in-memory history from the ref
    if (storedContext.topicId === 'assistant_chat') {
        historyForThisMessage = refs.currentChatHistoryRef.get();
    } else {
        // For all other chats, always fetch the latest history from the source of truth
        // to avoid race conditions with the UI state (currentChatHistoryRef).
        historyForThisMessage = await getHistoryForContext(storedContext);
        if (!historyForThisMessage) {
            console.error(`[StreamManager] Could not load history for finalization`, storedContext);
            return;
        }
    }
    
    // Find and update the message
    const finalFullText = accumulatedStreamText.get(messageId) || "";
    const messageIndex = historyForThisMessage.findIndex(msg => msg.id === messageId);
    
    if (messageIndex === -1) {
        // If it's an assistant chat and the message is not found,
        // it's likely the window was reset. Ignore gracefully.
        if (storedContext && storedContext.topicId === 'assistant_chat') {
            console.warn(`[StreamManager] Message ${messageId} not found in assistant history, likely due to reset. Ignoring.`);
            // Clean up just in case
            streamingChunkQueues.delete(messageId);
            accumulatedStreamText.delete(messageId);
            return;
        }
        console.error(`[StreamManager] Message ${messageId} not found in history`, storedContext);
        return;
    }
    
    const message = historyForThisMessage[messageIndex];
    message.content = finalFullText;
    message.finishReason = finishReason;
    message.isThinking = false;
    if (message.isGroupMessage && storedContext) {
        message.name = storedContext.agentName || message.name;
        message.agentId = storedContext.agentId || message.agentId;
    }
    
    // Update UI if it's the current view
    if (isForCurrentView) {
        refs.currentChatHistoryRef.set([...historyForThisMessage]);
        
        const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (messageItem) {
            messageItem.classList.remove('streaming', 'thinking');
            
            const contentDiv = messageItem.querySelector('.md-content');
            if (contentDiv) {
                const globalSettings = refs.globalSettingsRef.get();
                const processedFinalText = refs.preprocessFullContent(finalFullText, globalSettings);
                const rawHtml = markedInstance.parse(processedFinalText);
                refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
                refs.processRenderedContent(contentDiv);
                if (globalSettings.enableAgentBubbleTheme && refs.processAnimationsInContent) {
                    refs.processAnimationsInContent(contentDiv);
                }
            }
            
            const nameTimeBlock = messageItem.querySelector('.name-time-block');
            if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
                const timestampDiv = document.createElement('div');
                timestampDiv.classList.add('message-timestamp');
                timestampDiv.textContent = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                nameTimeBlock.appendChild(timestampDiv);
            }
            
            messageItem.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                refs.showContextMenu(e, messageItem, message);
            });
            
            uiHelper.scrollToBottom();
        }
    }
    
    // Only save history if it's not a temporary assistant chat
    if (storedContext.topicId !== 'assistant_chat') {
        await saveHistoryForContext(storedContext, historyForThisMessage);
    }
    
    // Cleanup
    streamingChunkQueues.delete(messageId);
    accumulatedStreamText.delete(messageId);
    
    // Delayed cleanup
    setTimeout(() => {
        messageInitializationStatus.delete(messageId);
        preBufferedChunks.delete(messageId);
        messageContextMap.delete(messageId);
    }, 5000);
}

// Expose to global scope for classic scripts
window.streamManager = {
    initStreamManager,
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage,
    getActiveStreamingMessageId: () => activeStreamingMessageId,
    isMessageInitialized: (messageId) => {
        // Check if message is being tracked by streamManager
        return messageInitializationStatus.has(messageId);
    }
};
