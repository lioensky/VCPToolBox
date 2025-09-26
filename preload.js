// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronPath', {
    dirname: (p) => ipcRenderer.invoke('path:dirname', p),
    extname: (p) => ipcRenderer.invoke('path:extname', p),
    basename: (p) => ipcRenderer.invoke('path:basename', p)
});

contextBridge.exposeInMainWorld('electron', {
    send: (channel, data) => {
        // whitelist channels
        let validChannels = [
            'open-music-folder', 'open-music-window', 'save-music-playlist',
            'music-track-changed', 'music-renderer-ready', 'share-file-to-main'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    invoke: (channel, data) => {
        let validChannels = [
            'get-music-playlist',
            // 新增的HIFI引擎控制通道
            'music-load',
            'music-play',
            'music-pause',
            'music-seek',
            'music-get-state',
            'music-set-volume',
            // --- New channels for WASAPI and device selection ---
            'music-get-devices',
            'music-configure-output',
            'music-set-eq',
            'music-configure-upsampling', // 新增：升频配置通道
            'music-get-lyrics', // 新增：获取歌词
            'music-fetch-lyrics' // 新增：从网络获取歌词
        ];
        if (validChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, data);
        }
    },
    on: (channel, func) => {
        let validChannels = [
            'music-files', 'scan-started', 'scan-progress', 'scan-finished',
            'audio-engine-error', // 用于接收来自主进程的引擎错误通知
            'music-set-track' // 用于从主进程设置当前曲目
        ];
        if (validChannels.includes(channel)) {
            // Deliberately strip event as it includes `sender`
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    }
});

contextBridge.exposeInMainWorld('electronAPI', {
    // Settings
    loadSettings: () => ipcRenderer.invoke('load-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    saveUserAvatar: (avatarData) => ipcRenderer.invoke('save-user-avatar', avatarData), // New for user avatar
    saveAvatarColor: (data) => ipcRenderer.invoke('save-avatar-color', data), // {type, id, color}

    // Agents
    getAgents: () => ipcRenderer.invoke('get-agents'),
    getAgentConfig: (agentId) => ipcRenderer.invoke('get-agent-config', agentId),
    saveAgentConfig: (agentId, config) => ipcRenderer.invoke('save-agent-config', agentId, config),
    selectAvatar: () => ipcRenderer.invoke('select-avatar'), // This can be used for both, or make a specific one for user
    saveAvatar: (agentId, avatarData) => ipcRenderer.invoke('save-avatar', agentId, avatarData), // For agent avatar
    createAgent: (agentName, initialConfig) => ipcRenderer.invoke('create-agent', agentName, initialConfig),
    deleteAgent: (agentId) => ipcRenderer.invoke('delete-agent', agentId),
    getCachedModels: () => ipcRenderer.invoke('get-cached-models'),
    refreshModels: () => ipcRenderer.send('refresh-models'),
    onModelsUpdated: (callback) => ipcRenderer.on('models-updated', (_event, models) => callback(models)),
    getAllItems: () => ipcRenderer.invoke('get-all-items'),
    importRegexRules: (agentId) => ipcRenderer.invoke('import-regex-rules', agentId),

    // Topic related
    getAgentTopics: (agentId) => ipcRenderer.invoke('get-agent-topics', agentId),
    createNewTopicForAgent: (agentId, topicName, refreshTimestamp) => ipcRenderer.invoke('create-new-topic-for-agent', agentId, topicName, refreshTimestamp),
    saveAgentTopicTitle: (agentId, topicId, newTitle) => ipcRenderer.invoke('save-agent-topic-title', agentId, topicId, newTitle),
    deleteTopic: (agentId, topicId) => ipcRenderer.invoke('delete-topic', agentId, topicId),

    // Chat History
    getChatHistory: (agentId, topicId) => ipcRenderer.invoke('get-chat-history', agentId, topicId),
    saveChatHistory: (agentId, topicId, history) => ipcRenderer.invoke('save-chat-history', agentId, topicId, history),

    getOriginalMessageContent: (itemId, itemType, topicId, messageId) => ipcRenderer.invoke('get-original-message-content', itemId, itemType, topicId, messageId),

    // File Handling
    handleFilePaste: (agentId, topicId, fileData) => ipcRenderer.invoke('handle-file-paste', agentId, topicId, fileData),
    selectFilesToSend: (agentId, topicId) => ipcRenderer.invoke('select-files-to-send', agentId, topicId),
    getFileAsBase64: (filePath) => ipcRenderer.invoke('get-file-as-base64', filePath),
    getTextContent: (filePath, fileType) => ipcRenderer.invoke('get-text-content', filePath, fileType),
    handleTextPasteAsFile: (agentId, topicId, textContent) => ipcRenderer.invoke('handle-text-paste-as-file', agentId, topicId, textContent),
    handleFileDrop: (agentId, topicId, droppedFilesData) => ipcRenderer.invoke('handle-file-drop', agentId, topicId, droppedFilesData),
    onAddFileToInput: (callback) => ipcRenderer.on('add-file-to-input', (_event, filePath) => callback(filePath)),

    // Notes
    // --- Notes (New Tree Structure) ---
    readNotesTree: () => ipcRenderer.invoke('read-notes-tree'),
    writeTxtNote: (noteData) => ipcRenderer.invoke('write-txt-note', noteData), // Re-used for saving notes
    deleteItem: (itemPath) => ipcRenderer.invoke('delete-item', itemPath),
    createNoteFolder: (data) => ipcRenderer.invoke('create-note-folder', data), // { parentPath, folderName }
    renameItem: (data) => ipcRenderer.invoke('rename-item', data), // { oldPath, newName }
    'notes:move-items': (data) => ipcRenderer.invoke('notes:move-items', data), // Corrected name
    savePastedImageToFile: (imageData, noteId) => ipcRenderer.invoke('save-pasted-image-to-file', imageData, noteId),
    getNotesRootDir: () => ipcRenderer.invoke('get-notes-root-dir'),
    copyNoteContent: (filePath) => ipcRenderer.invoke('copy-note-content', filePath),
    scanNetworkNotes: () => ipcRenderer.send('scan-network-notes'),
    onNetworkNotesScanned: (callback) => ipcRenderer.on('network-notes-scanned', (_event, networkTree) => callback(networkTree)),
    getCachedNetworkNotes: () => ipcRenderer.invoke('get-cached-network-notes'), // Added for getting cached notes
    searchNotes: (query) => ipcRenderer.invoke('search-notes', query), // For @note functionality


    // Open Notes Window
    openNotesWindow: (theme) => ipcRenderer.invoke('open-notes-window', theme),
    // For sharing content to a new notes window
    openNotesWithContent: (data) => ipcRenderer.invoke('open-notes-with-content', data), // data: { title, content, theme }
    onSharedNoteData: (callback) => ipcRenderer.on('shared-note-data', (_event, data) => callback(data)), // New listener for shared data
    sendNotesWindowReady: () => ipcRenderer.send('notes-window-ready'), // DEPRECATED, but kept for now
    notesRendererReady: () => ipcRenderer.send('notes-renderer-ready'), // New, more reliable signal
    // Open Translator Window
    openTranslatorWindow: (theme) => ipcRenderer.invoke('open-translator-window', theme),
 
    // Agent and Topic Order
    saveAgentOrder: (orderedAgentIds) => ipcRenderer.invoke('save-agent-order', orderedAgentIds),
    saveTopicOrder: (agentId, orderedTopicIds) => ipcRenderer.invoke('save-topic-order', agentId, orderedTopicIds),
    saveCombinedItemOrder: (orderedItemsWithTypes) => ipcRenderer.invoke('save-combined-item-order', orderedItemsWithTypes), // Added for combined list

    // VCP Communication
    sendToVCP: (vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall, context) => ipcRenderer.invoke('send-to-vcp', vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall, context),
    onVCPStreamEvent: (callback) => ipcRenderer.on('vcp-stream-event', (_event, eventData) => callback(eventData)),
    interruptVcpRequest: (data) => ipcRenderer.invoke('interrupt-vcp-request', data),
    // Group Chat
    createAgentGroup: (groupName, initialConfig) => ipcRenderer.invoke('create-agent-group', groupName, initialConfig),
    getAgentGroups: () => ipcRenderer.invoke('get-agent-groups'),
    getAgentGroupConfig: (groupId) => ipcRenderer.invoke('get-agent-group-config', groupId),
    saveAgentGroupConfig: (groupId, configData) => ipcRenderer.invoke('save-agent-group-config', groupId, configData),
    deleteAgentGroup: (groupId) => ipcRenderer.invoke('delete-agent-group', groupId),
    saveAgentGroupAvatar: (groupId, avatarData) => ipcRenderer.invoke('save-agent-group-avatar', groupId, avatarData),
    getGroupTopics: (groupId, searchTerm) => ipcRenderer.invoke('get-group-topics', groupId, searchTerm),
    createNewTopicForGroup: (groupId, topicName) => ipcRenderer.invoke('create-new-topic-for-group', groupId, topicName),
    deleteGroupTopic: (groupId, topicId) => ipcRenderer.invoke('delete-group-topic', groupId, topicId),
    saveGroupTopicTitle: (groupId, topicId, newTitle) => ipcRenderer.invoke('save-group-topic-title', groupId, topicId, newTitle),
    getGroupChatHistory: (groupId, topicId) => ipcRenderer.invoke('get-group-chat-history', groupId, topicId),
    saveGroupChatHistory: (groupId, topicId, history) => ipcRenderer.invoke('save-group-chat-history', groupId, topicId, history), // Added for saving group chat history
    sendGroupChatMessage: (groupId, topicId, userMessage) => ipcRenderer.invoke('send-group-chat-message', groupId, topicId, userMessage),
    onVCPGroupTopicUpdated: (callback) => ipcRenderer.on('vcp-group-topic-updated', (_event, eventData) => callback(eventData)), // Added for topic title updates
    onHistoryFileUpdated: (callback) => ipcRenderer.on('history-file-updated', (_event, data) => callback(data)), // For file watcher
    saveGroupTopicOrder: (groupId, orderedTopicIds) => ipcRenderer.invoke('save-group-topic-order', groupId, orderedTopicIds), // Added for group topic order
    searchTopicsByContent: (itemId, itemType, searchTerm) => ipcRenderer.invoke('search-topics-by-content', itemId, itemType, searchTerm), // Added for content search
    inviteAgentToSpeak: (groupId, topicId, invitedAgentId) => ipcRenderer.invoke('inviteAgentToSpeak', groupId, topicId, invitedAgentId), // 新增：邀请Agent发言
    redoGroupChatMessage: (groupId, topicId, messageId, agentId) => ipcRenderer.invoke('redo-group-chat-message', groupId, topicId, messageId, agentId), // 新增：重新生成群聊消息

    exportTopicAsMarkdown: (exportData) => ipcRenderer.invoke('export-topic-as-markdown', exportData), // 新增：导出话题功能
    // VCPLog Notifications
    connectVCPLog: (url, key) => ipcRenderer.send('connect-vcplog', { url, key }),
    disconnectVCPLog: () => ipcRenderer.send('disconnect-vcplog'),
    onVCPLogMessage: (callback) => ipcRenderer.on('vcp-log-message', (_event, value) => callback(value)),
    onVCPLogStatus: (callback) => ipcRenderer.on('vcp-log-status', (_event, value) => callback(value)),

    // Clipboard functions
    readImageFromClipboard: async () => {
        console.log('[Preload - readImageFromClipboard] Function called. Invoking main process handler.');
        try {
            const result = await ipcRenderer.invoke('read-image-from-clipboard-main');
            if (result && result.success) {
                console.log('[Preload - readImageFromClipboard] Received image data from main process.');
                return { data: result.data, extension: result.extension }; // Pass along data and extension
            } else {
                console.error('[Preload - readImageFromClipboard] Main process failed to read image:', result ? result.error : 'Unknown error from main');
                return null;
            }
        } catch (error) {
            console.error('[Preload - readImageFromClipboard] Error invoking "read-image-from-clipboard-main":', error);
            return null;
        }
    },

    readTextFromClipboard: async () => {
        console.log('[Preload - readTextFromClipboard] Function called.');
        console.log('[Preload - readTextFromClipboard] Function called. Invoking main process handler.');
        try {
            const result = await ipcRenderer.invoke('read-text-from-clipboard-main');
            if (result && result.success) {
                console.log('[Preload - readTextFromClipboard] Received text from main process.');
                return result.text;
            } else {
                console.error('[Preload - readTextFromClipboard] Main process failed to read text:', result ? result.error : 'Unknown error from main');
                return ""; // Return empty string on failure
            }
        } catch (error) {
            console.error('[Preload - readTextFromClipboard] Error invoking "read-text-from-clipboard-main":', error);
            return ""; // Return empty string on error
        }
    },

    // Window Controls
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    unmaximizeWindow: () => ipcRenderer.send('unmaximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),
    openDevTools: () => ipcRenderer.send('open-dev-tools'),
    sendToggleNotificationsSidebar: () => ipcRenderer.send('toggle-notifications-sidebar'), 
    onDoToggleNotificationsSidebar: (callback) => ipcRenderer.on('do-toggle-notifications-sidebar', (_event) => callback()), 
    openAdminPanel: () => ipcRenderer.invoke('open-admin-panel'), 
    onWindowMaximized: (callback) => ipcRenderer.on('window-maximized', (_event) => callback()),
    onWindowUnmaximized: (callback) => ipcRenderer.on('window-unmaximized', (_event) => callback()),

    // Image Context Menu
    showImageContextMenu: (imageUrl) => ipcRenderer.send('show-image-context-menu', imageUrl),
    // Open Image in New Window
    openImageViewer: (data) => ipcRenderer.send('open-image-viewer', data), // { src, title, theme }
    // Open Text in New Window (Read Mode)
    openTextInNewWindow: async (textContent, windowTitle, theme) => {
        console.log('[Preload] openTextInNewWindow called (invoke with new channel). Title:', windowTitle, 'Content length:', textContent.length, 'Theme:', theme);
        try {
            await ipcRenderer.invoke('display-text-content-in-viewer', textContent, windowTitle, theme);
            console.log('[Preload] ipcRenderer.invoke("display-text-content-in-viewer") was CALLED and awaited.');
        } catch (e) {
            console.error('[Preload] Error during ipcRenderer.invoke("display-text-content-in-viewer"):', e);
        }
    },

    // Open External Link
    sendOpenExternalLink: (url) => ipcRenderer.send('open-external-link', url),

    // Assistant specific
    toggleSelectionListener: (enable) => ipcRenderer.send('toggle-selection-listener', enable),
    assistantAction: (action) => ipcRenderer.send('assistant-action', action),
    closeAssistantBar: () => ipcRenderer.send('close-assistant-bar'),
    onAssistantBarData: (callback) => ipcRenderer.on('assistant-bar-data', (_event, data) => callback(data)),
    getAssistantBarInitialData: () => ipcRenderer.invoke('get-assistant-bar-initial-data'), // New: For renderer to request data
    onAssistantData: (callback) => ipcRenderer.on('assistant-data', (_event, data) => callback(data)),
    onThemeUpdated: (callback) => {
        const subscription = (_event, theme) => callback(theme);
        ipcRenderer.on('theme-updated', subscription);
        // Return an unsubscribe function
        return () => {
            ipcRenderer.removeListener('theme-updated', subscription);
        };
    },
    getCurrentTheme: () => ipcRenderer.invoke('get-current-theme'),
    setTheme: (theme) => ipcRenderer.send('set-theme', theme),

    // Themes
    openThemesWindow: () => ipcRenderer.send('open-themes-window'),
    getThemes: () => ipcRenderer.invoke('get-themes'),
    applyTheme: (fileName) => ipcRenderer.send('apply-theme', fileName),
   getWallpaperThumbnail: (path) => ipcRenderer.invoke('get-wallpaper-thumbnail', path),

    removeVcpStreamChunkListener: (callback) => ipcRenderer.removeListener('vcp-stream-chunk', callback),

    // Music Player Control
    onMusicCommand: (callback) => ipcRenderer.on('music-command', (_event, command) => callback(command)),

    // Local Python Execution
    executePythonCode: (code) => ipcRenderer.invoke('execute-python-code', code),

    // Dice Module Control
    openDiceWindow: () => ipcRenderer.invoke('open-dice-window'),
    onRollDice: (callback) => ipcRenderer.on('roll-dice', (_event, notation, options) => callback(notation, options)),
    sendDiceModuleReady: () => ipcRenderer.send('dice-module-ready'),
    sendDiceRollComplete: (results) => ipcRenderer.send('dice-roll-complete', results),

    // Sovits TTS
    sovitsGetModels: (forceRefresh = false) => ipcRenderer.invoke('sovits-get-models', forceRefresh),
    sovitsSpeak: (options) => ipcRenderer.send('sovits-speak', options), // { text, voice, speed, msgId }
    sovitsStop: () => ipcRenderer.send('sovits-stop'),
    onPlayTtsAudio: (callback) => ipcRenderer.on('play-tts-audio', (_event, data) => callback(data)), // { audioData }
    onStopTtsAudio: (callback) => ipcRenderer.on('stop-tts-audio', (_event) => callback()),

    // Emoticons
    getEmoticonLibrary: () => ipcRenderer.invoke('get-emoticon-library'),

    // Voice Chat
    openVoiceChatWindow: (data) => ipcRenderer.send('open-voice-chat-window', data),
    onVoiceChatData: (callback) => ipcRenderer.on('voice-chat-data', (_event, data) => callback(data)),

    // --- Speech Recognition via Puppeteer ---
    startSpeechRecognition: () => ipcRenderer.send('start-speech-recognition'),
    stopSpeechRecognition: () => ipcRenderer.send('stop-speech-recognition'),
    onSpeechRecognitionResult: (callback) => ipcRenderer.on('speech-recognition-result', (_event, text) => callback(text)),

    // Canvas Module
    openCanvasWindow: () => ipcRenderer.invoke('open-canvas-window'),
    canvasReady: () => ipcRenderer.send('canvas-ready'),
    createNewCanvas: () => ipcRenderer.send('create-new-canvas'),
    loadCanvasFile: (filePath) => ipcRenderer.send('load-canvas-file', filePath),
    saveCanvasFile: (file) => ipcRenderer.send('save-canvas-file', file),
    onCanvasLoadData: (callback) => ipcRenderer.on('canvas-load-data', (_event, data) => callback(data)),
    onCanvasFileChanged: (callback) => ipcRenderer.on('canvas-file-changed', (_event, file) => callback(file)),
    onCanvasContentUpdate: (callback) => ipcRenderer.on('canvas-content-update', (_event, data) => callback(data)),
    onLoadCanvasFileByPath: (callback) => ipcRenderer.on('load-canvas-file-by-path', (_event, filePath) => callback(filePath)),
    onCanvasWindowClosed: (callback) => ipcRenderer.on('canvas-window-closed', (_event) => callback()),
    renameCanvasFile: (data) => ipcRenderer.invoke('rename-canvas-file', data), // { oldPath, newTitle }
    copyCanvasFile: (filePath) => ipcRenderer.send('copy-canvas-file', filePath),
    deleteCanvasFile: (filePath) => ipcRenderer.send('delete-canvas-file', filePath),
    getLatestCanvasContent: () => ipcRenderer.invoke('get-latest-canvas-content'),
    // Watcher controls
    watcherStart: (filePath, agentId, topicId) => ipcRenderer.invoke('watcher:start', filePath, agentId, topicId),
    watcherStop: () => ipcRenderer.invoke('watcher:stop'),
});

// Log the electronAPI object as it's defined in preload.js right after exposing it
const electronAPIForLogging = {
    loadSettings: "function", saveSettings: "function", getAgents: "function", getAgentConfig: "function",
    saveAgentConfig: "function", selectAvatar: "function", saveAvatar: "function", createAgent: "function",
    deleteAgent: "function", getAgentTopics: "function", createNewTopicForAgent: "function",
    saveAgentTopicTitle: "function", deleteTopic: "function", getChatHistory: "function",
    saveChatHistory: "function", handleFilePaste: "function", selectFilesToSend: "function",
    getFileAsBase64: "function", getTextContent: "function", handleTextPasteAsFile: "function",
    handleFileDrop: "function",
    readTxtNotes: "function", 
    writeTxtNote: "function", 
    deleteTxtNote: "function", 
    openNotesWindow: "function",
    openNotesWithContent: "function", 
    saveAgentOrder: "function", 
    saveTopicOrder: "function", 
    sendToVCP: "function", onVCPStreamChunk: "function",
    connectVCPLog: "function", disconnectVCPLog: "function", onVCPLogMessage: "function",
    onVCPLogStatus: "function", readImageFromClipboard: "function", readTextFromClipboard: "function",
    minimizeWindow: "function", maximizeWindow: "function", unmaximizeWindow: "function", closeWindow: "function",
    openDevTools: "function",
    openAdminPanel: "function",
    onWindowMaximized: "function", onWindowUnmaximized: "function",
    showImageContextMenu: "function",
    openImageInNewWindow: "function", saveAvatarColor: "function",
    saveUserAvatar: "function" // Added
};
console.log('[Preload] electronAPI object that *should* be exposed (structure check):', electronAPIForLogging);
console.log('preload.js loaded and contextBridge exposure attempted.');