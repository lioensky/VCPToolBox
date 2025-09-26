// modules/ipc/agentHandlers.js
const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');

let AGENT_DIR_CACHE; // Cache the agent directory path

async function getAgentConfigById(agentId) {
    if (!AGENT_DIR_CACHE) {
        console.error("agentHandlers not initialized with AGENT_DIR. Cannot get agent config.");
        return { error: "Agent handler not initialized." };
    }
    const agentDir = path.join(AGENT_DIR_CACHE, agentId);
    const configPath = path.join(agentDir, 'config.json');
    const regexPath = path.join(agentDir, 'regex_rules.json');

    if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);

        // Check for external regex rules file
        if (await fs.pathExists(regexPath)) {
            try {
                config.stripRegexes = await fs.readJson(regexPath);
            } catch (e) {
                console.error(`Error reading regex_rules.json for agent ${agentId}:`, e);
                // Keep stripRegexes from config.json as a fallback
            }
        }

        const avatarPathPng = path.join(agentDir, 'avatar.png');
        const avatarPathJpg = path.join(agentDir, 'avatar.jpg');
        const avatarPathJpeg = path.join(agentDir, 'avatar.jpeg');
        const avatarPathGif = path.join(agentDir, 'avatar.gif');
        config.avatarUrl = null;
        if (await fs.pathExists(avatarPathPng)) {
            config.avatarUrl = `file://${avatarPathPng}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathJpg)) {
            config.avatarUrl = `file://${avatarPathJpg}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathJpeg)) {
            config.avatarUrl = `file://${avatarPathJpeg}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathGif)) {
            config.avatarUrl = `file://${avatarPathGif}?t=${Date.now()}`;
        }
        config.id = agentId;
        // 注入正确的用户数据目录路径，而不是Agent定义目录
        config.agentDataPath = path.join(AGENT_DIR_CACHE.replace('Agents', 'UserData'), agentId);
        return config;
    }
    return { error: `Agent config for ${agentId} not found.` };
}


/**
 * Initializes agent management related IPC handlers.
 * @param {object} context - An object containing necessary context.
 * @param {string} context.AGENT_DIR - The path to the agents directory.
 * @param {string} context.USER_DATA_DIR - The path to the user data directory.
 * @param {string} context.SETTINGS_FILE - The path to the settings.json file.
 * @param {string} context.USER_AVATAR_FILE - The path to the user avatar file.
 * @param {function} context.getSelectionListenerStatus - Function to get the current status of the selection listener.
 * @param {function} context.stopSelectionListener - Function to stop the selection listener.
 * @param {function} context.startSelectionListener - Function to start the selection listener.
 * @param {object} context.settingsManager - The SettingsManager instance.
 */
function initialize(context) {
    const { AGENT_DIR, USER_DATA_DIR, SETTINGS_FILE, USER_AVATAR_FILE, settingsManager, agentConfigManager } = context;
    AGENT_DIR_CACHE = AGENT_DIR; // Cache the directory path

    ipcMain.handle('get-agents', async () => {
        try {
            const agentFolders = await fs.readdir(AGENT_DIR);
            let agents = [];
            for (const folderName of agentFolders) {
                const agentPath = path.join(AGENT_DIR, folderName);
                const stat = await fs.stat(agentPath);
                if (stat.isDirectory()) {
                    const configPath = path.join(agentPath, 'config.json');
                    const avatarPathPng = path.join(agentPath, 'avatar.png');
                    const avatarPathJpg = path.join(agentPath, 'avatar.jpg');
                    const avatarPathJpeg = path.join(agentPath, 'avatar.jpeg'); 
                    const avatarPathGif = path.join(agentPath, 'avatar.gif');
                    
                    let agentData = { id: folderName, name: folderName, avatarUrl: null, config: {} };

                    if (await fs.pathExists(configPath)) {
                        const config = await fs.readJson(configPath);

                        // Load external regex rules if they exist
                        const regexPath = path.join(agentPath, 'regex_rules.json');
                        if (await fs.pathExists(regexPath)) {
                            try {
                                config.stripRegexes = await fs.readJson(regexPath);
                            } catch (e) {
                                console.error(`Error reading regex_rules.json for agent ${folderName} in get-agents:`, e);
                            }
                        }
                        
                        agentData.name = config.name || folderName;
                        agentData.config.avatarCalculatedColor = config.avatarCalculatedColor || null;
                        let topicsArray = config.topics && Array.isArray(config.topics) && config.topics.length > 0
                                           ? config.topics
                                           : [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                        
                        if (!config.topics || !Array.isArray(config.topics) || config.topics.length === 0) {
                            try {
                                config.topics = topicsArray;
                                if (agentConfigManager) {
                                    await agentConfigManager.updateAgentConfig(folderName, existingConfig => ({
                                        ...existingConfig,
                                        topics: topicsArray
                                    }));
                                } else {
                                    await fs.writeJson(configPath, config, { spaces: 2 });
                                }
                            } catch (e) {
                                console.error(`Error saving default/fixed topics for agent ${folderName}:`, e);
                            }
                        }
                        agentData.topics = topicsArray;
                        agentData.config = config;
                        // 注入正确的用户数据目录路径
                        agentData.config.agentDataPath = path.join(AGENT_DIR, '..', 'UserData', folderName);
                    } else {
                        agentData.name = folderName;
                        agentData.topics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                        const defaultConfigData = {
                            name: agentData.name,
                            topics: agentData.topics,
                            systemPrompt: `你是 ${agentData.name}。`,
                            model: '',
                            temperature: 0.7,
                            avatarCalculatedColor: null,
                            contextTokenLimit: 4000,
                            maxOutputTokens: 1000
                        };
                        try {
                            await fs.ensureDir(agentPath);
                            if (agentConfigManager) {
                                await agentConfigManager.writeAgentConfig(folderName, defaultConfigData);
                            } else {
                                await fs.writeJson(configPath, defaultConfigData, { spaces: 2 });
                            }
                            agentData.config = defaultConfigData;
                        } catch (e) {
                            console.error(`Error creating default config for agent ${folderName}:`, e);
                        }
                    }
                    
                    if (await fs.pathExists(avatarPathPng)) agentData.avatarUrl = `file://${avatarPathPng}`;
                    else if (await fs.pathExists(avatarPathJpg)) agentData.avatarUrl = `file://${avatarPathJpg}`;
                    else if (await fs.pathExists(avatarPathJpeg)) agentData.avatarUrl = `file://${avatarPathJpeg}`;
                    else if (await fs.pathExists(avatarPathGif)) agentData.avatarUrl = `file://${avatarPathGif}`;
                    
                    agents.push(agentData);
                }
            }

            let settings = {};
            try {
                settings = await settingsManager.readSettings();
            } catch (readError) {
                console.warn('Could not read settings for agent order:', readError);
            }
        
            if (settings.agentOrder && Array.isArray(settings.agentOrder)) {
                const orderedAgents = [];
                const agentMap = new Map(agents.map(agent => [agent.id, agent]));
                settings.agentOrder.forEach(id => {
                    if (agentMap.has(id)) {
                        orderedAgents.push(agentMap.get(id));
                        agentMap.delete(id);
                    }
                });
                orderedAgents.push(...agentMap.values());
                agents = orderedAgents;
            } else {
                agents.sort((a, b) => a.name.localeCompare(b.name));
            }
            return agents;
        } catch (error) {
            console.error('获取Agent列表失败:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-combined-item-order', async (event, orderedItemsWithTypes) => {
        try {
            const result = await settingsManager.updateSettings(settings => ({
                ...settings,
                combinedItemOrder: orderedItemsWithTypes
            }));
            return result;
        } catch (error) {
            console.error('Error saving combined item order:', error);
            return { success: false, error: error.message || '保存项目顺序时发生未知错误' };
        }
    });

    ipcMain.handle('save-agent-order', async (event, orderedAgentIds) => {
        try {
            const result = await settingsManager.updateSettings(settings => ({
                ...settings,
                agentOrder: orderedAgentIds
            }));
            return result;
        } catch (error) {
            console.error('Error saving agent order:', error);
            return { success: false, error: error.message || '保存Agent顺序时发生未知错误' };
        }
    });

    ipcMain.handle('get-agent-config', (event, agentId) => {
        // Now this handler simply calls the exported function
        return getAgentConfigById(agentId);
    });

    ipcMain.handle('save-agent-config', async (event, agentId, config) => {
        try {
            const agentDir = path.join(AGENT_DIR, agentId);
            await fs.ensureDir(agentDir);
            const regexPath = path.join(agentDir, 'regex_rules.json');

            // Handle stripRegexes separately if the property exists in the incoming config
            if (config.hasOwnProperty('stripRegexes')) {
                const stripRegexes = config.stripRegexes;
                if (Array.isArray(stripRegexes) && stripRegexes.length > 0) {
                    // Save non-empty regexes to the separate file
                    await fs.writeJson(regexPath, stripRegexes, { spaces: 2 });
                } else {
                    // If the array is empty or not an array, remove the regex file if it exists
                    if (await fs.pathExists(regexPath)) {
                        await fs.remove(regexPath);
                    }
                }
            }

            // CRITICAL: Always remove stripRegexes from the object to be saved to config.json
            const configToSave = { ...config };
            delete configToSave.stripRegexes;
            
            if (agentConfigManager) {
                // 使用AgentConfigManager进行安全的配置更新
                const result = await agentConfigManager.updateAgentConfig(agentId, existingConfig => ({
                    ...existingConfig,
                    ...configToSave
                }));
                return { success: true, message: `Agent ${agentId} 配置已保存。` };
            } else {
                // 回退到原来的方式（为了兼容性）
                const configPath = path.join(agentDir, 'config.json');
                let existingConfig = {};
                if (await fs.pathExists(configPath)) {
                    existingConfig = await fs.readJson(configPath);
                }
                
                // Merge configs
                const newConfigData = { ...existingConfig, ...configToSave };
                
                await fs.writeJson(configPath, newConfigData, { spaces: 2 });
                return { success: true, message: `Agent ${agentId} 配置已保存。` };
            }
        } catch (error) {
            console.error(`保存Agent ${agentId} 配置失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-avatar', async (event, agentId, avatarData) => {
        const listenerWasActive = context.getSelectionListenerStatus();
        if (listenerWasActive) context.stopSelectionListener();
        try {
            if (!avatarData || !avatarData.name || !avatarData.type || !avatarData.buffer) {
                return { error: '保存头像失败：未提供有效的头像数据。' };
            }

            const agentDir = path.join(AGENT_DIR, agentId);
            await fs.ensureDir(agentDir);

            let ext = path.extname(avatarData.name).toLowerCase();
            if (!ext) {
                if (avatarData.type === 'image/png') ext = '.png';
                else if (avatarData.type === 'image/jpeg') ext = '.jpg';
                else if (avatarData.type === 'image/gif') ext = '.gif';
                else if (avatarData.type === 'image/webp') ext = '.webp';
                else ext = '.png';
            }

            const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
            if (!allowedExtensions.includes(ext)) {
                return { error: `保存头像失败：不支持的文件类型/扩展名 "${ext}"。` };
            }

            const oldAvatars = [
                path.join(agentDir, 'avatar.png'),
                path.join(agentDir, 'avatar.jpg'),
                path.join(agentDir, 'avatar.gif'),
                path.join(agentDir, 'avatar.webp')
            ];

            for (const oldAvatarPath of oldAvatars) {
                if (await fs.pathExists(oldAvatarPath)) {
                    await fs.remove(oldAvatarPath);
                }
            }

            const newAvatarPath = path.join(agentDir, `avatar${ext}`);
            const nodeBuffer = Buffer.from(avatarData.buffer);

            await fs.writeFile(newAvatarPath, nodeBuffer);
            return { success: true, avatarUrl: `file://${newAvatarPath}?t=${Date.now()}`, needsColorExtraction: true };
        } catch (error) {
            console.error(`保存Agent ${agentId} 头像失败:`, error);
            return { error: `保存头像失败: ${error.message}` };
        } finally {
            if (listenerWasActive) context.startSelectionListener();
        }
    });

    ipcMain.handle('create-agent', async (event, agentName, initialConfig = null) => {
        try {
            const baseName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const agentId = `${baseName}_${Date.now()}`;
            const agentDir = path.join(AGENT_DIR, agentId);

            if (await fs.pathExists(agentDir)) {
                return { error: 'Agent文件夹已存在（ID冲突）。' };
            }
            await fs.ensureDir(agentDir);

            let configToSave;
            if (initialConfig) {
                configToSave = { ...initialConfig, name: agentName }; 
            } else {
                configToSave = {
                    name: agentName,
                    systemPrompt: `你是 ${agentName}。`,
                    model: 'gemini-2.5-flash-preview-05-20', 
                    temperature: 0.7,
                    contextTokenLimit: 1000000, 
                    maxOutputTokens: 60000, 
                    topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }] 
                };
            }
            if (!configToSave.topics || !Array.isArray(configToSave.topics) || configToSave.topics.length === 0) {
                configToSave.topics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
            }

            if (agentConfigManager) {
                await agentConfigManager.writeAgentConfig(agentId, configToSave);
            } else {
                await fs.writeJson(path.join(agentDir, 'config.json'), configToSave, { spaces: 2 });
            }
            
            if (configToSave.topics && configToSave.topics.length > 0) {
                const firstTopicId = configToSave.topics[0].id || "default";
                const topicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', firstTopicId);
                await fs.ensureDir(topicHistoryDir);
                const historyFilePath = path.join(topicHistoryDir, 'history.json');
                if (!await fs.pathExists(historyFilePath)) {
                     await fs.writeJson(historyFilePath, [], { spaces: 2 });
                }
            }
            
            return { success: true, agentId: agentId, agentName: agentName, config: configToSave, avatarUrl: null };
        } catch (error) {
            console.error('创建Agent失败:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('delete-agent', async (event, agentId) => {
        try {
            const agentDir = path.join(AGENT_DIR, agentId);
            const userDataAgentDir = path.join(USER_DATA_DIR, agentId);
            if (await fs.pathExists(agentDir)) await fs.remove(agentDir);
            if (await fs.pathExists(userDataAgentDir)) await fs.remove(userDataAgentDir);
            return { success: true, message: `Agent ${agentId} 已删除。` };
        } catch (error) {
            console.error(`删除Agent ${agentId} 失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-user-avatar', async (event, avatarData) => {
        const listenerWasActive = context.getSelectionListenerStatus();
        if (listenerWasActive) context.stopSelectionListener();
        try {
            if (!avatarData || !avatarData.buffer) {
                return { error: '保存用户头像失败：未提供有效的头像数据。' };
            }
            await fs.ensureDir(USER_DATA_DIR);
            const nodeBuffer = Buffer.from(avatarData.buffer);
            await fs.writeFile(USER_AVATAR_FILE, nodeBuffer);
            return { success: true, avatarUrl: `file://${USER_AVATAR_FILE}?t=${Date.now()}`, needsColorExtraction: true };
        } catch (error) {
            console.error(`保存用户头像失败:`, error);
            return { error: `保存用户头像失败: ${error.message}` };
        } finally {
            if (listenerWasActive) context.startSelectionListener();
        }
    });

    ipcMain.handle('get-all-items', async () => {
        const agents = await getAgentsInternal(context);
        const groups = await getGroupsInternal(context);
        return { success: true, items: [...agents, ...groups] };
    });
}

async function getAgentsInternal({ AGENT_DIR }) {
    try {
        const agentDirs = await fs.readdir(AGENT_DIR);
        const agentConfigs = await Promise.all(agentDirs.map(async (agentId) => {
            const configPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (await fs.pathExists(configPath)) {
                try {
                    const config = await fs.readJson(configPath);
                    const agentDir = path.join(AGENT_DIR, agentId);
                    const avatarPathPng = path.join(agentDir, 'avatar.png');
                    const avatarPathJpg = path.join(agentDir, 'avatar.jpg');
                    const avatarPathJpeg = path.join(agentDir, 'avatar.jpeg');
                    const avatarPathGif = path.join(agentDir, 'avatar.gif');
                    let avatarUrl = null;
                    if (await fs.pathExists(avatarPathPng)) avatarUrl = `file://${avatarPathPng}`;
                    else if (await fs.pathExists(avatarPathJpg)) avatarUrl = `file://${avatarPathJpg}`;
                    else if (await fs.pathExists(avatarPathJpeg)) avatarUrl = `file://${avatarPathJpeg}`;
                    else if (await fs.pathExists(avatarPathGif)) avatarUrl = `file://${avatarPathGif}`;
                    
                    return { ...config, id: agentId, type: 'agent', avatarUrl };
                } catch (e) {
                    console.error(`Error reading agent config for ${agentId}:`, e);
                    return null;
                }
            }
            return null;
        }));
        return agentConfigs.filter(Boolean);
    } catch (error) {
        console.error('Failed to get agents internally:', error);
        return [];
    }
}

async function getGroupsInternal({ USER_DATA_DIR }) {
     const groupsDir = path.join(path.dirname(USER_DATA_DIR), 'VCPChat', 'AppData', 'AgentGroups');
    try {
        if (!await fs.pathExists(groupsDir)) {
            return [];
        }
        const groupDirs = await fs.readdir(groupsDir);
        const groupConfigs = await Promise.all(groupDirs.map(async (groupId) => {
            const configPath = path.join(groupsDir, groupId, 'config.json');
            if (await fs.pathExists(configPath)) {
                try {
                    const config = await fs.readJson(configPath);
                    const groupDir = path.join(groupsDir, groupId);
                    const avatarPathPng = path.join(groupDir, 'avatar.png');
                    const avatarPathJpg = path.join(groupDir, 'avatar.jpg');
                    const avatarPathJpeg = path.join(groupDir, 'avatar.jpeg');
                    const avatarPathGif = path.join(groupDir, 'avatar.gif');
                    let avatarUrl = null;
                    if (await fs.pathExists(avatarPathPng)) avatarUrl = `file://${avatarPathPng}`;
                    else if (await fs.pathExists(avatarPathJpg)) avatarUrl = `file://${avatarPathJpg}`;
                    else if (await fs.pathExists(avatarPathJpeg)) avatarUrl = `file://${avatarPathJpeg}`;
                    else if (await fs.pathExists(avatarPathGif)) avatarUrl = `file://${avatarPathGif}`;

                    return { ...config, id: groupId, type: 'group', avatarUrl };
                } catch (e) {
                    console.error(`Error reading group config for ${groupId}:`, e);
                    return null;
                }
            }
            return null;
        }));
        return groupConfigs.filter(Boolean);
    } catch (error) {
        console.error('Failed to get groups internally:', error);
        return [];
    }
}

module.exports = {
    initialize,
    getAgentConfigById
};

// recoverSettingsFromCorruptedFile 已由 SettingsManager 处理，无需此函数