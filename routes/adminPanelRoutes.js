const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// 导入 reidentify_image 函数 (现在是 reidentify_media)
const { reidentifyMediaByBase64Key } = require('../Plugin/ImageProcessor/reidentify_image');

// manifestFileName 和 blockedManifestExtension 是在插件路由中使用的常量
const manifestFileName = 'plugin-manifest.json';
const blockedManifestExtension = '.block';
const AGENT_FILES_DIR = path.join(__dirname, '..', 'Agent'); // 定义 Agent 文件目录

module.exports = function(DEBUG_MODE, dailyNoteRootPath, pluginManager, getCurrentServerLogPath) {
    const adminApiRouter = express.Router();

    // --- Admin API Router 内容 ---

    // --- Server Log API ---
    adminApiRouter.get('/server-log', async (req, res) => {
        const logPath = getCurrentServerLogPath();
        if (!logPath) {
            return res.status(503).json({ error: 'Server log path not available.', content: '服务器日志路径当前不可用，可能仍在初始化中。' });
        }
        try {
            await fs.access(logPath);
            const content = await fs.readFile(logPath, 'utf-8');
            res.json({ content: content, path: logPath });
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.warn(`[AdminPanelRoutes API] /server-log - Log file not found at: ${logPath}`);
                res.status(404).json({ error: 'Log file not found.', content: `日志文件 ${logPath} 未找到。它可能尚未创建或已被删除。`, path: logPath });
            } else {
                console.error(`[AdminPanelRoutes API] Error reading server log file ${logPath}:`, error);
                res.status(500).json({ error: 'Failed to read server log file', details: error.message, content: `读取日志文件 ${logPath} 失败。`, path: logPath });
            }
        }
    });
    // --- End Server Log API ---
    // GET main config.env content (filtered)
    adminApiRouter.get('/config/main', async (req, res) => {
        try {
            const configPath = path.join(__dirname, '..', 'config.env');
            const content = await fs.readFile(configPath, 'utf-8');
            res.json({ content: content });
        } catch (error) {
            console.error('Error reading main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to read main config file', details: error.message });
        }
    });

    // GET raw main config.env content (for saving purposes)
    adminApiRouter.get('/config/main/raw', async (req, res) => {
        try {
            const configPath = path.join(__dirname, '..', 'config.env');
            const content = await fs.readFile(configPath, 'utf-8');
            res.json({ content: content });
        } catch (error) {
            console.error('Error reading raw main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to read raw main config file', details: error.message });
        }
    });

    // POST to save main config.env content
    adminApiRouter.post('/config/main', async (req, res) => {
        const { content } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid content format. String expected.' });
        }
        try {
            const configPath = path.join(__dirname, '..', 'config.env');
            await fs.writeFile(configPath, content, 'utf-8');
            res.json({ message: '主配置已成功保存。更改可能需要重启服务才能完全生效。' });
        } catch (error) {
            console.error('Error writing main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to write main config file', details: error.message });
        }
    });

    // GET plugin list with manifest, status, and config.env content
    adminApiRouter.get('/plugins', async (req, res) => {
        try {
            const pluginDataMap = new Map();
            const PLUGIN_DIR = path.join(__dirname, '..', 'Plugin');

            // 1. 从 pluginManager 获取所有已加载的插件（包括云端和启用的本地插件）
            const loadedPlugins = Array.from(pluginManager.plugins.values());
            for (const p of loadedPlugins) {
                let configEnvContent = null;
                if (!p.isDistributed && p.basePath) {
                    try {
                        const pluginConfigPath = path.join(p.basePath, 'config.env');
                        configEnvContent = await fs.readFile(pluginConfigPath, 'utf-8');
                    } catch (envError) {
                        if (envError.code !== 'ENOENT') {
                            console.warn(`[AdminPanelRoutes] Error reading config.env for ${p.name}:`, envError);
                        }
                    }
                }
                pluginDataMap.set(p.name, {
                    name: p.name,
                    manifest: p,
                    enabled: true, // 从 manager 加载的都是启用的
                    configEnvContent: configEnvContent,
                    isDistributed: p.isDistributed || false,
                    serverId: p.serverId || null
                });
            }

            // 2. 扫描本地 Plugin 目录，补充被禁用的插件
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const pluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(pluginPath, manifestFileName);
                    const blockedManifestPath = manifestPath + blockedManifestExtension;

                    try {
                        // 检查是否存在被禁用的 manifest
                        const manifestContent = await fs.readFile(blockedManifestPath, 'utf-8');
                        const manifest = JSON.parse(manifestContent);

                        // 如果这个插件还没被 manager 加载，就说明它是被禁用的
                        if (!pluginDataMap.has(manifest.name)) {
                            let configEnvContent = null;
                            try {
                                const pluginConfigPath = path.join(pluginPath, 'config.env');
                                configEnvContent = await fs.readFile(pluginConfigPath, 'utf-8');
                            } catch (envError) {
                                if (envError.code !== 'ENOENT') {
                                    console.warn(`[AdminPanelRoutes] Error reading config.env for disabled plugin ${manifest.name}:`, envError);
                                }
                            }
                            
                            // 为 manifest 添加 basePath，以便前端和后续操作使用
                            manifest.basePath = pluginPath;

                            pluginDataMap.set(manifest.name, {
                                name: manifest.name,
                                manifest: manifest,
                                enabled: false, // 明确标记为禁用
                                configEnvContent: configEnvContent,
                                isDistributed: false, // 本地扫描到的肯定是本地插件
                                serverId: null
                            });
                        }
                    } catch (error) {
                        // 如果读取 .block 文件失败（例如文件不存在），则忽略
                        if (error.code !== 'ENOENT') {
                            console.warn(`[AdminPanelRoutes] Error processing potential disabled plugin in ${folder.name}:`, error);
                        }
                    }
                }
            }
            
            const pluginDataList = Array.from(pluginDataMap.values());
            res.json(pluginDataList);

        } catch (error) {
            console.error('[AdminPanelRoutes] Error listing plugins:', error);
            res.status(500).json({ error: 'Failed to list plugins', details: error.message });
        }
    });

    // POST to toggle plugin enabled/disabled status
    adminApiRouter.post('/plugins/:pluginName/toggle', async (req, res) => {
        const pluginName = req.params.pluginName;
        const { enable } = req.body; 
        const PLUGIN_DIR = path.join(__dirname, '..', 'Plugin');

        if (typeof enable !== 'boolean') {
            return res.status(400).json({ error: 'Invalid request body. Expected { enable: boolean }.' });
        }

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            let targetPluginPath = null;
            // let currentManifestPath = null; // Not strictly needed here for rename logic
            // let currentBlockedPath = null; // Not strictly needed here for rename logic
            let foundManifest = null; // To ensure we operate on a valid plugin

            for (const folder of pluginFolders) {
                 if (folder.isDirectory()) {
                    const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                    const potentialManifestPath = path.join(potentialPluginPath, manifestFileName);
                    const potentialBlockedPath = potentialManifestPath + blockedManifestExtension;
                    let manifestContent = null;

                    try { // Try reading enabled manifest first
                        manifestContent = await fs.readFile(potentialManifestPath, 'utf-8');
                    } catch (err) {
                        if (err.code === 'ENOENT') { // If enabled not found, try disabled
                            try {
                                manifestContent = await fs.readFile(potentialBlockedPath, 'utf-8');
                            } catch (blockedErr) { continue; /* Neither found, skip folder */ }
                        } else { continue; /* Other error reading enabled manifest, skip folder */ }
                    }

                    try {
                        const manifest = JSON.parse(manifestContent);
                        if (manifest.name === pluginName) {
                            targetPluginPath = potentialPluginPath;
                            foundManifest = manifest; 
                            break; 
                        }
                    } catch (parseErr) { continue; /* Invalid JSON, skip folder */ }
                }
            }

            if (!targetPluginPath || !foundManifest) {
                return res.status(404).json({ error: `Plugin '${pluginName}' not found.` });
            }
            
            const manifestPathToUse = path.join(targetPluginPath, manifestFileName);
            const blockedManifestPathToUse = manifestPathToUse + blockedManifestExtension;

            if (enable) {
                try {
                    await fs.rename(blockedManifestPathToUse, manifestPathToUse);
                    await fs.rename(blockedManifestPathToUse, manifestPathToUse);
                    await pluginManager.loadPlugins(); // 重新加载插件以更新内存状态
                    res.json({ message: `插件 ${pluginName} 已启用。` });
                } catch (error) {
                    if (error.code === 'ENOENT') {
                         try {
                             await fs.access(manifestPathToUse);
                             res.json({ message: `插件 ${pluginName} 已经是启用状态。` });
                         } catch (accessError) {
                             res.status(500).json({ error: `无法启用插件 ${pluginName}。找不到 manifest 文件。`, details: accessError.message });
                         }
                    } else {
                        console.error(`[AdminPanelRoutes] Error enabling plugin ${pluginName}:`, error);
                        res.status(500).json({ error: `启用插件 ${pluginName} 时出错`, details: error.message });
                    }
                }
            } else { // Disable
                try {
                    await fs.rename(manifestPathToUse, blockedManifestPathToUse);
                    await pluginManager.loadPlugins(); // 重新加载插件以更新内存状态
                    res.json({ message: `插件 ${pluginName} 已禁用。` });
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        try {
                             await fs.access(blockedManifestPathToUse);
                             res.json({ message: `插件 ${pluginName} 已经是禁用状态。` });
                         } catch (accessError) {
                             res.status(500).json({ error: `无法禁用插件 ${pluginName}。找不到 manifest 文件。`, details: accessError.message });
                         }
                    } else {
                        console.error(`[AdminPanelRoutes] Error disabling plugin ${pluginName}:`, error);
                        res.status(500).json({ error: `禁用插件 ${pluginName} 时出错`, details: error.message });
                    }
                }
            }
        } catch (error) { // Catch errors from fs.readdir or other unexpected issues
            console.error(`[AdminPanelRoutes] Error toggling plugin ${pluginName}:`, error);
            res.status(500).json({ error: `处理插件 ${pluginName} 状态切换时出错`, details: error.message });
        }
    });

    // POST to update plugin description in manifest
    adminApiRouter.post('/plugins/:pluginName/description', async (req, res) => {
        const pluginName = req.params.pluginName;
        const { description } = req.body;
        const PLUGIN_DIR = path.join(__dirname, '..', 'Plugin');

        if (typeof description !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { description: string }.' });
        }

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            let targetManifestPath = null;
            let manifest = null;

            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                    const potentialManifestPath = path.join(potentialPluginPath, manifestFileName);
                    const potentialBlockedPath = potentialManifestPath + blockedManifestExtension;
                    let currentPath = null;
                    let manifestContent = null;

                    try { 
                        manifestContent = await fs.readFile(potentialManifestPath, 'utf-8');
                        currentPath = potentialManifestPath;
                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            try { 
                                manifestContent = await fs.readFile(potentialBlockedPath, 'utf-8');
                                currentPath = potentialBlockedPath;
                            } catch (blockedErr) { continue; }
                        } else { continue; }
                    }

                    try {
                        const parsedManifest = JSON.parse(manifestContent);
                        if (parsedManifest.name === pluginName) {
                            targetManifestPath = currentPath;
                            manifest = parsedManifest;
                            break;
                        }
                    } catch (parseErr) { continue; }
                }
            }

            if (!targetManifestPath || !manifest) {
                return res.status(404).json({ error: `Plugin '${pluginName}' or its manifest file not found.` });
            }

            manifest.description = description;
            await fs.writeFile(targetManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
            await pluginManager.loadPlugins(); // 重新加载以更新指令
            res.json({ message: `插件 ${pluginName} 的描述已更新。` });

        } catch (error) {
            console.error(`[AdminPanelRoutes] Error updating description for plugin ${pluginName}:`, error);
            res.status(500).json({ error: `更新插件 ${pluginName} 描述时出错`, details: error.message });
        }
    });

    // POST to save plugin-specific config.env
    adminApiRouter.post('/plugins/:pluginName/config', async (req, res) => {
        const pluginName = req.params.pluginName;
        const { content } = req.body;
        const PLUGIN_DIR = path.join(__dirname, '..', 'Plugin');

         if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid content format. String expected.' });
        }

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            let targetPluginPath = null;

            for (const folder of pluginFolders) {
                 if (folder.isDirectory()) {
                    const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(potentialPluginPath, manifestFileName);
                    const blockedManifestPath = manifestPath + blockedManifestExtension;
                    let manifestContent = null;
                     try {
                        manifestContent = await fs.readFile(manifestPath, 'utf-8');
                     } catch (err) {
                         if (err.code === 'ENOENT') {
                             try { manifestContent = await fs.readFile(blockedManifestPath, 'utf-8'); }
                             catch (blockedErr) { continue; }
                         } else { continue; }
                     }
                     try {
                         const manifest = JSON.parse(manifestContent);
                         if (manifest.name === pluginName) {
                             targetPluginPath = potentialPluginPath;
                             break;
                         }
                     } catch (parseErr) { continue; }
                 }
            }

            if (!targetPluginPath) {
                 return res.status(404).json({ error: `Plugin folder for '${pluginName}' not found.` });
            }

            const configPath = path.join(targetPluginPath, 'config.env');
            await fs.writeFile(configPath, content, 'utf-8');
            
            res.json({ message: `插件 ${pluginName} 的配置已保存。更改可能需要重启插件或服务才能生效。` });
        } catch (error) {
            console.error(`[AdminPanelRoutes] Error writing config.env for plugin ${pluginName}:`, error);
            res.status(500).json({ error: `保存插件 ${pluginName} 配置时出错`, details: error.message });
        }
    });

    // POST to update a specific invocation command's description in a plugin's manifest
    adminApiRouter.post('/plugins/:pluginName/commands/:commandIdentifier/description', async (req, res) => {
        const { pluginName, commandIdentifier } = req.params;
        const { description } = req.body;
        const PLUGIN_DIR = path.join(__dirname, '..', 'Plugin');

        if (typeof description !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { description: string }.' });
        }

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            let targetManifestPath = null;
            let manifest = null;
            let pluginFound = false;

            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                    const potentialManifestPath = path.join(potentialPluginPath, manifestFileName);
                    const potentialBlockedPath = potentialManifestPath + blockedManifestExtension;
                    let currentPath = null;
                    let manifestContent = null;

                    try {
                        manifestContent = await fs.readFile(potentialManifestPath, 'utf-8');
                        currentPath = potentialManifestPath;
                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            try {
                                manifestContent = await fs.readFile(potentialBlockedPath, 'utf-8');
                                currentPath = potentialBlockedPath;
                            } catch (blockedErr) { continue; }
                        } else { continue; }
                    }

                    try {
                        const parsedManifest = JSON.parse(manifestContent);
                        if (parsedManifest.name === pluginName) {
                            targetManifestPath = currentPath;
                            manifest = parsedManifest;
                            pluginFound = true;
                            break;
                        }
                    } catch (parseErr) {
                        console.warn(`[AdminPanelRoutes] Error parsing manifest for ${folder.name} while updating command description: ${parseErr.message}`);
                        continue;
                    }
                }
            }

            if (!pluginFound || !manifest) {
                return res.status(404).json({ error: `Plugin '${pluginName}' or its manifest file not found.` });
            }

            let commandUpdated = false;
            if (manifest.capabilities && manifest.capabilities.invocationCommands && Array.isArray(manifest.capabilities.invocationCommands)) {
                const commandIndex = manifest.capabilities.invocationCommands.findIndex(cmd => cmd.commandIdentifier === commandIdentifier || cmd.command === commandIdentifier);
                if (commandIndex !== -1) {
                    manifest.capabilities.invocationCommands[commandIndex].description = description;
                    commandUpdated = true;
                }
            }

            if (!commandUpdated) {
                return res.status(404).json({ error: `Command '${commandIdentifier}' not found in plugin '${pluginName}'.` });
            }

            await fs.writeFile(targetManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
            await pluginManager.loadPlugins(); // 重新加载以更新指令
            res.json({ message: `指令 '${commandIdentifier}' 在插件 '${pluginName}' 中的描述已更新。` });

        } catch (error) {
            console.error(`[AdminPanelRoutes] Error updating command description for plugin ${pluginName}, command ${commandIdentifier}:`, error);
            res.status(500).json({ error: `更新指令描述时出错`, details: error.message });
        }
    });

    // POST to restart the server
    adminApiRouter.post('/server/restart', async (req, res) => {
        res.json({ message: '服务器重启命令已发送。服务器正在关闭，如果由进程管理器（如 PM2）管理，它应该会自动重启。' });
        
        setTimeout(() => {
            console.log('[AdminPanelRoutes] Received restart command. Shutting down...');
            process.exit(1); 
        }, 1000); 
    });
     

    // --- MultiModal Cache API (New) ---
    adminApiRouter.get('/multimodal-cache', async (req, res) => {
        const cachePath = path.join(__dirname, '..', 'Plugin', 'ImageProcessor', 'multimodal_cache.json');
        try {
            const content = await fs.readFile(cachePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reading multimodal cache file:', error);
            if (error.code === 'ENOENT') {
                res.json({});
            } else {
                res.status(500).json({ error: 'Failed to read multimodal cache file', details: error.message });
            }
        }
    });

    adminApiRouter.post('/multimodal-cache', async (req, res) => {
        const { data } = req.body;
        const cachePath = path.join(__dirname, '..', 'Plugin', 'ImageProcessor', 'multimodal_cache.json');
        if (typeof data !== 'object' || data === null) {
             return res.status(400).json({ error: 'Invalid request body. Expected a JSON object in "data" field.' });
        }
        try {
            await fs.writeFile(cachePath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: '多媒体缓存文件已成功保存。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing multimodal cache file:', error);
            res.status(500).json({ error: 'Failed to write multimodal cache file', details: error.message });
        }
    });

    adminApiRouter.post('/multimodal-cache/reidentify', async (req, res) => {
        const { base64Key } = req.body;
        if (typeof base64Key !== 'string' || !base64Key) {
            return res.status(400).json({ error: 'Invalid request body. Expected { base64Key: string }.' });
        }
        try {
            const result = await reidentifyMediaByBase64Key(base64Key);
            res.json({
                message: '媒体重新识别成功。',
                newDescription: result.newDescription,
                newTimestamp: result.newTimestamp
            });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reidentifying media:', error);
            res.status(500).json({ error: 'Failed to reidentify media', details: error.message });
        }
    });
    // --- End MultiModal Cache API ---

    // --- Image Cache API (Legacy, for backward compatibility) ---
    adminApiRouter.get('/image-cache', async (req, res) => {
        const imageCachePath = path.join(__dirname, '..', 'Plugin', 'ImageProcessor', 'image_cache.json');
        try {
            const content = await fs.readFile(imageCachePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reading image cache file:', error);
            if (error.code === 'ENOENT') {
                res.json({});
            } else {
                res.status(500).json({ error: 'Failed to read image cache file', details: error.message });
            }
        }
    });

    adminApiRouter.post('/image-cache', async (req, res) => {
        const { data } = req.body;
        const imageCachePath = path.join(__dirname, '..', 'Plugin', 'ImageProcessor', 'image_cache.json');
        if (typeof data !== 'object' || data === null) {
             return res.status(400).json({ error: 'Invalid request body. Expected a JSON object in "data" field.' });
        }
        try {
            await fs.writeFile(imageCachePath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: '图像缓存文件已成功保存。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing image cache file:', error);
            res.status(500).json({ error: 'Failed to write image cache file', details: error.message });
        }
    });

    adminApiRouter.post('/image-cache/reidentify', async (req, res) => {
        const { base64Key } = req.body;
        if (typeof base64Key !== 'string' || !base64Key) {
            return res.status(400).json({ error: 'Invalid request body. Expected { base64Key: string }.' });
        }
        try {
            // Note: This still calls the new function, which should handle old cache formats gracefully.
            const result = await reidentifyMediaByBase64Key(base64Key);
            res.json({
                message: '图片重新识别成功。',
                newDescription: result.newDescription,
                newTimestamp: result.newTimestamp
            });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reidentifying image:', error);
            res.status(500).json({ error: 'Failed to reidentify image', details: error.message });
        }
    });
    // --- End Image Cache API ---

    // --- Daily Notes API ---
    // dailyNoteRootPath is passed as a parameter

    // GET all folder names in dailynote directory
    adminApiRouter.get('/dailynotes/folders', async (req, res) => {
        try {
            await fs.access(dailyNoteRootPath); 
            const entries = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
            const folders = entries
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name);
            res.json({ folders });
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.warn('[AdminPanelRoutes API] /dailynotes/folders - dailynote directory not found.');
                res.json({ folders: [] }); 
            } else {
                console.error('[AdminPanelRoutes API] Error listing daily note folders:', error);
                res.status(500).json({ error: 'Failed to list daily note folders', details: error.message });
            }
        }
    });

    // GET all note files in a specific folder with last modified time
    adminApiRouter.get('/dailynotes/folder/:folderName', async (req, res) => {
        const folderName = req.params.folderName;
        const specificFolderParentPath = path.join(dailyNoteRootPath, folderName);

        try {
            await fs.access(specificFolderParentPath); 
            const files = await fs.readdir(specificFolderParentPath);
            const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));
            const PREVIEW_LENGTH = 100; 

            const notes = await Promise.all(txtFiles.map(async (file) => {
                const filePath = path.join(specificFolderParentPath, file);
                const stats = await fs.stat(filePath);
                let preview = '';
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    preview = content.substring(0, PREVIEW_LENGTH).replace(/\n/g, ' ') + (content.length > PREVIEW_LENGTH ? '...' : '');
                } catch (readError) {
                    console.warn(`[AdminPanelRoutes API] Error reading file for preview ${filePath}: ${readError.message}`);
                    preview = '[无法加载预览]';
                }
                return {
                    name: file,
                    lastModified: stats.mtime.toISOString(),
                    preview: preview
                };
            }));

            notes.sort((a, b) => a.name.localeCompare(b.name));
            res.json({ notes });

        } catch (error) {
            if (error.code === 'ENOENT') {
                console.warn(`[AdminPanelRoutes API] /dailynotes/folder/${folderName} - Folder not found.`);
                res.status(404).json({ error: `Folder '${folderName}' not found.` });
            } else {
                console.error(`[AdminPanelRoutes API] Error listing notes in folder ${folderName}:`, error);
                res.status(500).json({ error: `Failed to list notes in folder ${folderName}`, details: error.message });
            }
        }
    });

    // New API endpoint for searching notes with full content
    adminApiRouter.get('/dailynotes/search', async (req, res) => {
        const { term, folder } = req.query; 

        if (!term || typeof term !== 'string' || term.trim() === '') {
            return res.status(400).json({ error: 'Search term is required.' });
        }

        const searchTerm = term.trim().toLowerCase();
        const PREVIEW_LENGTH = 100; 
        let foldersToSearch = [];
        const matchedNotes = [];

        try {
            if (folder && typeof folder === 'string' && folder.trim() !== '') {
                const specificFolderPath = path.join(dailyNoteRootPath, folder);
                try {
                    await fs.access(specificFolderPath); 
                    if ((await fs.stat(specificFolderPath)).isDirectory()) {
                        foldersToSearch.push({ name: folder, path: specificFolderPath });
                    } else {
                        console.warn(`[AdminPanelRoutes API Search] Specified path '${folder}' is not a directory.`);
                        return res.status(404).json({ error: `Specified path '${folder}' is not a directory.`});
                    }
                } catch (e) {
                    console.warn(`[AdminPanelRoutes API Search] Specified folder '${folder}' not found during access check.`);
                    return res.status(404).json({ error: `Specified folder '${folder}' not found.` });
                }
            } else {
                await fs.access(dailyNoteRootPath);
                const entries = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
                entries.filter(entry => entry.isDirectory()).forEach(dir => {
                    foldersToSearch.push({ name: dir.name, path: path.join(dailyNoteRootPath, dir.name) });
                });
                if (foldersToSearch.length === 0) {
                     console.log('[AdminPanelRoutes API Search] No folders found in dailynote directory for global search.');
                     return res.json({ notes: [] });
                }
            }

            for (const dir of foldersToSearch) {
                const files = await fs.readdir(dir.path);
                const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));

                for (const fileName of txtFiles) {
                    const filePath = path.join(dir.path, fileName);
                    try {
                        const content = await fs.readFile(filePath, 'utf-8');
                        if (content.toLowerCase().includes(searchTerm)) {
                            const stats = await fs.stat(filePath);
                            let preview = content.substring(0, PREVIEW_LENGTH).replace(/\n/g, ' ') + (content.length > PREVIEW_LENGTH ? '...' : '');
                            matchedNotes.push({
                                name: fileName,
                                folderName: dir.name, 
                                lastModified: stats.mtime.toISOString(),
                                preview: preview
                            });
                        }
                    } catch (readError) {
                        console.warn(`[AdminPanelRoutes API Search] Error reading file ${filePath} for search: ${readError.message}`);
                    }
                }
            }

            matchedNotes.sort((a, b) => {
                const folderCompare = a.folderName.localeCompare(b.folderName);
                if (folderCompare !== 0) return folderCompare;
                return a.name.localeCompare(b.name);
            });

            res.json({ notes: matchedNotes });

        } catch (error) {
            if (error.code === 'ENOENT' && error.path && error.path.includes('dailynote')) {
                console.warn('[AdminPanelRoutes API Search] dailynote directory not found.');
                return res.json({ notes: [] }); 
            }
            console.error('[AdminPanelRoutes API Search] Error during daily note search:', error);
            res.status(500).json({ error: 'Failed to search daily notes', details: error.message });
        }
    });

    // GET content of a specific note file
    adminApiRouter.get('/dailynotes/note/:folderName/:fileName', async (req, res) => {
        const { folderName, fileName } = req.params;
        const filePath = path.join(dailyNoteRootPath, folderName, fileName);

        try {
            await fs.access(filePath); 
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ content });
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.warn(`[AdminPanelRoutes API] /dailynotes/note/${folderName}/${fileName} - File not found.`);
                res.status(404).json({ error: `Note file '${fileName}' in folder '${folderName}' not found.` });
            } else {
                console.error(`[AdminPanelRoutes API] Error reading note file ${folderName}/${fileName}:`, error);
                res.status(500).json({ error: `Failed to read note file ${folderName}/${fileName}`, details: error.message });
            }
        }
    });

    // POST to save/update content of a specific note file
    adminApiRouter.post('/dailynotes/note/:folderName/:fileName', async (req, res) => {
        const { folderName, fileName } = req.params;
        const { content } = req.body;

        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { content: string }.' });
        }

        const targetFolderPath = path.join(dailyNoteRootPath, folderName); 
        const filePath = path.join(targetFolderPath, fileName);

        try {
            await fs.mkdir(targetFolderPath, { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            res.json({ message: `Note '${fileName}' in folder '${folderName}' saved successfully.` });
        } catch (error) {
            console.error(`[AdminPanelRoutes API] Error saving note file ${folderName}/${fileName}:`, error);
            res.status(500).json({ error: `Failed to save note file ${folderName}/${fileName}`, details: error.message });
        }
    });

    // POST to move one or more notes to a different folder
    adminApiRouter.post('/dailynotes/move', async (req, res) => {
        const { sourceNotes, targetFolder } = req.body;

        if (!Array.isArray(sourceNotes) || sourceNotes.some(n => !n.folder || !n.file) || typeof targetFolder !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { sourceNotes: [{folder, file}], targetFolder: string }.' });
        }

        const results = {
            moved: [],
            errors: []
        };

        const targetFolderPath = path.join(dailyNoteRootPath, targetFolder);

        try {
            await fs.mkdir(targetFolderPath, { recursive: true });
        } catch (mkdirError) {
            console.error(`[AdminPanelRoutes API] Error creating target folder ${targetFolder} for move:`, mkdirError);
            return res.status(500).json({ error: `Failed to create target folder '${targetFolder}'`, details: mkdirError.message });
        }

        for (const note of sourceNotes) {
            const sourceFilePath = path.join(dailyNoteRootPath, note.folder, note.file);
            const destinationFilePath = path.join(targetFolderPath, note.file); 

            try {
                await fs.access(sourceFilePath);
                try {
                    await fs.access(destinationFilePath);
                    results.errors.push({
                        note: `${note.folder}/${note.file}`,
                        error: `File already exists at destination '${targetFolder}/${note.file}'. Move aborted for this file.`
                    });
                    continue; 
                } catch (destAccessError) {
                    // Destination file does not exist, proceed with move
                }
                
                await fs.rename(sourceFilePath, destinationFilePath);
                results.moved.push(`${note.folder}/${note.file} to ${targetFolder}/${note.file}`);
            } catch (error) {
                if (error.code === 'ENOENT' && error.path === sourceFilePath) {
                     results.errors.push({ note: `${note.folder}/${note.file}`, error: 'Source file not found.' });
                } else {
                    console.error(`[AdminPanelRoutes API] Error moving note ${note.folder}/${note.file} to ${targetFolder}:`, error);
                    results.errors.push({ note: `${note.folder}/${note.file}`, error: error.message });
                }
            }
        }

        const message = `Moved ${results.moved.length} note(s). ${results.errors.length > 0 ? `Encountered ${results.errors.length} error(s).` : ''}`;
        res.json({ message, moved: results.moved, errors: results.errors });
    });

    // POST to delete multiple notes
    if (DEBUG_MODE) console.log('[AdminPanelRoutes DEBUG] Attempting to register POST /admin_api/dailynotes/delete-batch');
    adminApiRouter.post('/dailynotes/delete-batch', async (req, res) => {
        if (DEBUG_MODE) console.log('[AdminPanelRoutes DEBUG] POST /admin_api/dailynotes/delete-batch route hit!');
        const { notesToDelete } = req.body; 

        if (!Array.isArray(notesToDelete) || notesToDelete.some(n => !n.folder || !n.file)) {
            return res.status(400).json({ error: 'Invalid request body. Expected { notesToDelete: [{folder, file}] }.' });
        }

        const results = {
            deleted: [],
            errors: []
        };

        for (const note of notesToDelete) {
            const filePath = path.join(dailyNoteRootPath, note.folder, note.file);
            try {
                await fs.access(filePath); 
                await fs.unlink(filePath); 
                results.deleted.push(`${note.folder}/${note.file}`);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    results.errors.push({ note: `${note.folder}/${note.file}`, error: 'File not found.' });
                } else {
                    console.error(`[AdminPanelRoutes API] Error deleting note ${note.folder}/${note.file}:`, error);
                    results.errors.push({ note: `${note.folder}/${note.file}`, error: error.message });
                }
            }
        }

        const message = `Deleted ${results.deleted.length} note(s). ${results.errors.length > 0 ? `Encountered ${results.errors.length} error(s).` : ''}`;
        res.json({ message, deleted: results.deleted, errors: results.errors });
    });
    // --- End Daily Notes API ---

    // --- Agent Files API ---
    // GET list of agent .txt files
    adminApiRouter.get('/agents', async (req, res) => {
        try {
            await fs.mkdir(AGENT_FILES_DIR, { recursive: true }); // Ensure directory exists
            const files = await fs.readdir(AGENT_FILES_DIR);
            const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));
            res.json({ files: txtFiles });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error listing agent files:', error);
            res.status(500).json({ error: 'Failed to list agent files', details: error.message });
        }
    });

    // GET content of a specific agent file
    adminApiRouter.get('/agents/:fileName', async (req, res) => {
        const { fileName } = req.params;
        if (!fileName.toLowerCase().endsWith('.txt')) {
            return res.status(400).json({ error: 'Invalid file name. Must be a .txt file.' });
        }
        const filePath = path.join(AGENT_FILES_DIR, fileName);

        try {
            await fs.access(filePath);
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ content });
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: `Agent file '${fileName}' not found.` });
            } else {
                console.error(`[AdminPanelRoutes API] Error reading agent file ${fileName}:`, error);
                res.status(500).json({ error: `Failed to read agent file ${fileName}`, details: error.message });
            }
        }
    });

    // POST to save content of a specific agent file
    adminApiRouter.post('/agents/:fileName', async (req, res) => {
        const { fileName } = req.params;
        const { content } = req.body;

        if (!fileName.toLowerCase().endsWith('.txt')) {
            return res.status(400).json({ error: 'Invalid file name. Must be a .txt file.' });
        }
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { content: string }.' });
        }

        const filePath = path.join(AGENT_FILES_DIR, fileName);

        try {
            await fs.mkdir(AGENT_FILES_DIR, { recursive: true }); // Ensure directory exists
            await fs.writeFile(filePath, content, 'utf-8');
            res.json({ message: `Agent file '${fileName}' saved successfully.` });
        } catch (error) {
            console.error(`[AdminPanelRoutes API] Error saving agent file ${fileName}:`, error);
            res.status(500).json({ error: `Failed to save agent file ${fileName}`, details: error.message });
        }
    });
    // --- End Agent Files API ---

    // --- TVS Variable Files API ---
    const TVS_FILES_DIR = path.join(__dirname, '..', 'TVStxt'); // 定义 TVS 文件目录

    // GET list of TVS .txt files
    adminApiRouter.get('/tvsvars', async (req, res) => {
        try {
            await fs.mkdir(TVS_FILES_DIR, { recursive: true }); // Ensure directory exists
            const files = await fs.readdir(TVS_FILES_DIR);
            const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));
            res.json({ files: txtFiles });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error listing TVS files:', error);
            res.status(500).json({ error: 'Failed to list TVS files', details: error.message });
        }
    });

    // GET content of a specific TVS file
    adminApiRouter.get('/tvsvars/:fileName', async (req, res) => {
        const { fileName } = req.params;
        if (!fileName.toLowerCase().endsWith('.txt')) {
            return res.status(400).json({ error: 'Invalid file name. Must be a .txt file.' });
        }
        const filePath = path.join(TVS_FILES_DIR, fileName);

        try {
            await fs.access(filePath);
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ content });
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: `TVS file '${fileName}' not found.` });
            } else {
                console.error(`[AdminPanelRoutes API] Error reading TVS file ${fileName}:`, error);
                res.status(500).json({ error: `Failed to read TVS file ${fileName}`, details: error.message });
            }
        }
    });

    // POST to save content of a specific TVS file
    adminApiRouter.post('/tvsvars/:fileName', async (req, res) => {
        const { fileName } = req.params;
        const { content } = req.body;

        if (!fileName.toLowerCase().endsWith('.txt')) {
            return res.status(400).json({ error: 'Invalid file name. Must be a .txt file.' });
        }
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { content: string }.' });
        }

        const filePath = path.join(TVS_FILES_DIR, fileName);

        try {
            await fs.mkdir(TVS_FILES_DIR, { recursive: true }); // Ensure directory exists
            await fs.writeFile(filePath, content, 'utf-8');
            res.json({ message: `TVS file '${fileName}' saved successfully.` });
        } catch (error) {
            console.error(`[AdminPanelRoutes API] Error saving TVS file ${fileName}:`, error);
            res.status(500).json({ error: `Failed to save TVS file ${fileName}`, details: error.message });
        }
    });
    // --- End TVS Variable Files API ---
    
    return adminApiRouter;
};