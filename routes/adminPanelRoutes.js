const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const PREPROCESSOR_ORDER_FILE = path.join(__dirname, '..', 'preprocessor_order.json');

// 导入 reidentify_image 函数 (现在是 reidentify_media)
const { reidentifyMediaByBase64Key } = require('../Plugin/ImageProcessor/reidentify_image');
const { getAuthCode } = require('../modules/captchaDecoder'); // 导入统一的解码函数

// manifestFileName 和 blockedManifestExtension 是在插件路由中使用的常量
const manifestFileName = 'plugin-manifest.json';
const blockedManifestExtension = '.block';

// 记录每个日志文件的 inode，用于检测日志轮转
const logFileInodes = new Map();

module.exports = function (DEBUG_MODE, dailyNoteRootPath, pluginManager, getCurrentServerLogPath, vectorDBManager, agentDirPath) {
    if (!agentDirPath || typeof agentDirPath !== 'string') {
        throw new Error('[AdminPanelRoutes] agentDirPath must be a non-empty string');
    }

    const adminApiRouter = express.Router();
    const AGENT_FILES_DIR = agentDirPath;
    console.log('[AdminPanelRoutes] Agent files directory:', AGENT_FILES_DIR);



    // --- Admin API Router 内容 ---

    // --- System Monitor Routes (Merged) ---
    const { exec } = require('child_process');
    const os = require('os');
    const util = require('util');
    const execAsync = util.promisify(exec);
    const pm2 = require('pm2');

    // 获取PM2进程列表和资源使用情况 (Using PM2 API to avoid pop-ups)
    adminApiRouter.get('/system-monitor/pm2/processes', (req, res) => {
        pm2.list((err, list) => {
            if (err) {
                console.error('[SystemMonitor] PM2 API Error:', err);
                return res.status(500).json({ success: false, error: 'Failed to get PM2 processes via API', details: err.message });
            }

            const processInfo = list.map(proc => ({
                name: proc.name,
                pid: proc.pid,
                status: proc.pm2_env.status,
                cpu: proc.monit.cpu,
                memory: proc.monit.memory,
                uptime: proc.pm2_env.pm_uptime,
                restarts: proc.pm2_env.restart_time
            }));

            res.json({ success: true, processes: processInfo });
        });
    });

    // 获取系统整体资源使用情况
    adminApiRouter.get('/system-monitor/system/resources', async (req, res) => {
        try {
            const systemInfo = {};
            const execOptions = { windowsHide: true }; // Option to prevent window pop-up

            if (process.platform === 'win32') {
                // 先尝试现代 PowerShell 命令，失败时回退到 wmic（向下兼容）
                try {
                    const { stdout: memInfo } = await execAsync('powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json"', execOptions);
                    const memData = JSON.parse(memInfo);
                    systemInfo.memory = {
                        total: (memData.TotalVisibleMemorySize || 0) * 1024,
                        free: (memData.FreePhysicalMemory || 0) * 1024,
                        used: ((memData.TotalVisibleMemorySize || 0) - (memData.FreePhysicalMemory || 0)) * 1024
                    };
                } catch (powershellError) {
                    // 回退到 wmic 命令
                    const { stdout: memInfo } = await execAsync('wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /value', execOptions);
                    const memData = Object.fromEntries(memInfo.split('\r\n').filter(line => line.includes('=')).map(line => {
                        const [key, value] = line.split('=');
                        return [key.trim(), parseInt(value.trim()) * 1024];
                    }));
                    systemInfo.memory = {
                        total: memData.TotalVisibleMemorySize || 0,
                        free: memData.FreePhysicalMemory || 0,
                        used: (memData.TotalVisibleMemorySize || 0) - (memData.FreePhysicalMemory || 0)
                    };
                }

                try {
                    const { stdout: cpuInfo } = await execAsync('powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object Average | ConvertTo-Json"', execOptions);
                    const cpuData = JSON.parse(cpuInfo);
                    systemInfo.cpu = { usage: Math.round(cpuData.Average || 0) };
                } catch (powershellError) {
                    // 回退到 wmic 命令
                    const { stdout: cpuInfo } = await execAsync('wmic cpu get loadpercentage /value', execOptions);
                    const cpuMatch = cpuInfo.match(/LoadPercentage=(\d+)/);
                    systemInfo.cpu = { usage: cpuMatch ? parseInt(cpuMatch[1]) : 0 };
                }
            } else if (process.platform === 'darwin') { // macOS
                const totalMemory = os.totalmem();
                const freeMemory = os.freemem();
                systemInfo.memory = {
                    total: totalMemory,
                    free: freeMemory,
                    used: totalMemory - freeMemory
                };

                try {
                    // macOS 下获取 CPU 使用率的简单方法
                    const { stdout: cpuInfo } = await execAsync("top -l 1 | grep 'CPU usage' | awk '{print $3}' | sed 's/%//'", execOptions);
                    systemInfo.cpu = { usage: parseFloat(cpuInfo.trim()) || 0 };
                } catch (cpuErr) {
                    systemInfo.cpu = { usage: 0 };
                }
            } else { // Linux/Unix
                try {
                    const { stdout: memInfo } = await execAsync('free -b', execOptions);
                    const memLine = memInfo.split('\n')[1].split(/\s+/);
                    systemInfo.memory = { total: parseInt(memLine[1]), used: parseInt(memLine[2]), free: parseInt(memLine[3]) };
                } catch (memErr) {
                    // 如果 free 命令失败，回退到 os 模块
                    const totalMemory = os.totalmem();
                    const freeMemory = os.freemem();
                    systemInfo.memory = {
                        total: totalMemory,
                        free: freeMemory,
                        used: totalMemory - freeMemory
                    };
                }

                try {
                    const { stdout: cpuInfo } = await execAsync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", execOptions);
                    systemInfo.cpu = { usage: parseFloat(cpuInfo.trim()) || 0 };
                } catch (cpuErr) {
                    systemInfo.cpu = { usage: 0 };
                }
            }
            systemInfo.nodeProcess = {
                pid: process.pid,
                memory: process.memoryUsage(),
                uptime: process.uptime(),
                version: process.version,
                platform: process.platform,
                arch: process.arch
            };
            res.json({ success: true, system: systemInfo });
        } catch (error) {
            console.error('[SystemMonitor] Error getting system resources:', error);
            res.status(500).json({ success: false, error: 'Failed to get system resources', details: error.message });
        }
    });


    // 新增：获取 UserAuth 认证码 (现在会解密)
    adminApiRouter.get('/user-auth-code', async (req, res) => {
        const authCodePath = path.join(__dirname, '..', 'Plugin', 'UserAuth', 'code.bin');
        try {
            // 直接调用 getAuthCode 函数，它封装了读取和解密逻辑
            const decryptedCode = await getAuthCode(authCodePath);
            if (decryptedCode) {
                res.json({ success: true, code: decryptedCode });
            } else {
                // 如果 getAuthCode 返回空字符串或其他假值，说明内部发生了错误
                throw new Error('Failed to get auth code internally.');
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ success: false, error: '认证码文件未找到。插件可能尚未运行。' });
            } else {
                res.status(500).json({ success: false, error: '读取或解密认证码文件失败。', details: error.message });
            }
        }
    });

    // 新增：获取天气预报数据
    adminApiRouter.get('/weather', async (req, res) => {
        const weatherCachePath = path.join(__dirname, '..', 'Plugin', 'WeatherReporter', 'weather_cache.json');
        try {
            const content = await fs.readFile(weatherCachePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ success: false, error: '天气缓存文件未找到。' });
            } else {
                res.status(500).json({ success: false, error: '读取天气缓存失败。', details: error.message });
            }
        }
    });
    // --- End System Monitor Routes ---

    // --- Server Log API ---
    adminApiRouter.get('/server-log', async (req, res) => {
        const logPath = getCurrentServerLogPath();
        if (!logPath) {
            return res.status(503).json({ error: 'Server log path not available.', content: '服务器日志路径当前不可用，可能仍在初始化中。' });
        }
        try {
            const stats = await fs.stat(logPath);
            const currentInode = stats.ino;
            const fileSize = stats.size;

            // 检查是否请求增量读取
            const incremental = req.query.incremental === 'true';
            const offset = parseInt(req.query.offset || '0', 10);

            // 检测日志轮转（inode 变化或文件变小）
            const lastInode = logFileInodes.get(logPath);
            if (incremental && lastInode && (currentInode !== lastInode || offset > fileSize)) {
                logFileInodes.set(logPath, currentInode);
                return res.json({
                    needFullReload: true,
                    path: logPath,
                    offset: 0
                });
            }

            logFileInodes.set(logPath, currentInode);

            let content = '';
            let newOffset = 0;

            const fd = await fs.open(logPath, 'r');
            try {
                if (incremental && offset >= 0 && offset <= fileSize) {
                    // 增量读取：从 offset 位置开始
                    const bufferSize = fileSize - offset;
                    if (bufferSize > 0) {
                        const buffer = Buffer.alloc(bufferSize);
                        const { bytesRead } = await fd.read(buffer, 0, bufferSize, offset);
                        content = buffer.toString('utf-8', 0, bytesRead);
                    }
                    newOffset = fileSize;
                } else {
                    // 完整读取（但限制大小）
                    const maxReadSize = 2 * 1024 * 1024; // 2MB
                    let startPos = 0;
                    let readSize = fileSize;

                    if (fileSize > maxReadSize) {
                        startPos = fileSize - maxReadSize;
                        readSize = maxReadSize;
                    }

                    const buffer = Buffer.alloc(readSize);
                    const { bytesRead } = await fd.read(buffer, 0, readSize, startPos);
                    content = buffer.toString('utf-8', 0, bytesRead);

                    // 如果是截断读取，跳过第一行（可能不完整）
                    if (startPos > 0) {
                        const firstNewline = content.indexOf('\n');
                        if (firstNewline !== -1) {
                            content = content.substring(firstNewline + 1);
                        }
                    }
                    newOffset = fileSize;
                }
            } finally {
                await fd.close();
            }

            res.json({
                content: content,
                offset: newOffset,
                path: logPath,
                fileSize: fileSize,
                needFullReload: false
            });
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

    // 清空日志文件
    adminApiRouter.post('/server-log/clear', async (req, res) => {
        const logPath = getCurrentServerLogPath();
        if (!logPath) {
            return res.status(503).json({ error: 'Server log path not available.' });
        }
        try {
            // 使用 truncate 清空文件内容
            await fs.writeFile(logPath, '', 'utf-8');

            // 更新 inode 记录，防止增量读取出错
            const stats = await fs.stat(logPath);
            logFileInodes.set(logPath, stats.ino);

            res.json({ success: true, message: '日志已清空' });
        } catch (error) {
            console.error(`[AdminPanelRoutes API] Error clearing server log file ${logPath}:`, error);
            res.status(500).json({ error: 'Failed to clear server log file', details: error.message });
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
            // Reload all plugins to apply changes from the main config.env
            await pluginManager.loadPlugins();
            res.json({ message: '主配置已成功保存并已重新加载。' });
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
            res.json({ message: `插件 ${pluginName} 的描述已更新并重新加载。` });

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
            // Reload all plugins to apply the configuration changes immediately.
            await pluginManager.loadPlugins();
            res.json({ message: `插件 ${pluginName} 的配置已保存并已重新加载。` });
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
            res.json({ message: `指令 '${commandIdentifier}' 在插件 '${pluginName}' 中的描述已更新并重新加载。` });

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

            // 强制清除Node.js模块缓存，特别是TextChunker.js
            const moduleKeys = Object.keys(require.cache);
            moduleKeys.forEach(key => {
                if (key.includes('TextChunker.js') || key.includes('VectorDBManager.js')) {
                    delete require.cache[key];
                }
            });

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
    const dailyNotesRoutes = require('./dailyNotesRoutes')(dailyNoteRootPath, DEBUG_MODE);
    adminApiRouter.use('/dailynotes', dailyNotesRoutes);
    // --- End Daily Notes API ---

    // --- Agent Files API ---
    const AGENT_MAP_FILE = path.join(__dirname, '..', 'agent_map.json');
    const AGENT_ASSISTANT_CONFIG_PATH = path.join(__dirname, '..', 'Plugin', 'AgentAssistant', 'config.env');
    const AGENT_ASSISTANT_EXAMPLE_CONFIG_PATH = path.join(__dirname, '..', 'Plugin', 'AgentAssistant', 'config.env.example');

    // GET agent map
    adminApiRouter.get('/agents/map', async (req, res) => {
        try {
            const content = await fs.readFile(AGENT_MAP_FILE, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.json({}); // Return empty object if file doesn't exist
            } else {
                console.error('[AdminPanelRoutes API] Error reading agent_map.json:', error);
                res.status(500).json({ error: 'Failed to read agent map file', details: error.message });
            }
        }
    });

    // POST to save agent map
    adminApiRouter.post('/agents/map', async (req, res) => {
        const newMap = req.body;
        if (typeof newMap !== 'object' || newMap === null) {
            return res.status(400).json({ error: 'Invalid request body. Expected a JSON object.' });
        }
        try {
            await fs.writeFile(AGENT_MAP_FILE, JSON.stringify(newMap, null, 2), 'utf-8');
            // Note: For changes to be reflected in chat, the agentManager needs to be reloaded.
            // This currently requires a server restart.
            res.json({ message: 'Agent map saved successfully. A server restart may be required for changes to apply.' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing agent_map.json:', error);
            res.status(500).json({ error: 'Failed to write agent map file', details: error.message });
        }
    });

    // GET list of agent .txt and .md files with folder structure
    adminApiRouter.get('/agents', async (req, res) => {
        try {
            // 使用agentManager的scanAgentFiles方法获取文件列表和文件夹结构
            const agentManager = require('../modules/agentManager');
            const agentFilesData = agentManager.getAllAgentFiles();
            res.json(agentFilesData);
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error listing agent files:', error);
            res.status(500).json({ error: 'Failed to list agent files', details: error.message });
        }
    });

    // POST to create a new agent .txt or .md file
    adminApiRouter.post('/agents/new-file', async (req, res) => {
        const { fileName, folderPath } = req.body;

        if (!fileName || typeof fileName !== 'string') {
            return res.status(400).json({ error: 'Invalid file name. Must be a non-empty string.' });
        }

        // 确保文件名以.txt或.md结尾
        let finalFileName = fileName;
        if (!fileName.toLowerCase().endsWith('.txt') && !fileName.toLowerCase().endsWith('.md')) {
            finalFileName = `${fileName}.txt`; // 默认为.txt
        }

        // 构建完整路径
        let targetDir = AGENT_FILES_DIR;
        if (folderPath && typeof folderPath === 'string') {
            targetDir = path.join(AGENT_FILES_DIR, folderPath);
        }

        const filePath = path.join(targetDir, finalFileName);

        try {
            // 确保目录存在
            await fs.mkdir(targetDir, { recursive: true });

            // 使用 'wx' 标志来原子性地"如果不存在则写入"，如果文件已存在，它会抛出错误。
            await fs.writeFile(filePath, '', { flag: 'wx' });

            // 通知agentManager重新扫描文件
            const agentManager = require('../modules/agentManager');
            await agentManager.scanAgentFiles();

            res.json({ message: `File '${finalFileName}' created successfully.` });
        } catch (error) {
            if (error.code === 'EEXIST') {
                res.status(409).json({ error: `File '${finalFileName}' already exists.` });
            } else {
                console.error(`[AdminPanelRoutes API] Error creating new agent file ${finalFileName}:`, error);
                res.status(500).json({ error: `Failed to create agent file ${finalFileName}`, details: error.message });
            }
        }
    });

    // GET content of a specific agent file
    adminApiRouter.get('/agents/:fileName', async (req, res) => {
        const { fileName } = req.params;

        // 解码URL编码的文件名，处理路径中的斜杠
        const decodedFileName = decodeURIComponent(fileName);

        // 检查文件扩展名
        if (!decodedFileName.toLowerCase().endsWith('.txt') && !decodedFileName.toLowerCase().endsWith('.md')) {
            return res.status(400).json({ error: 'Invalid file name. Must be a .txt or .md file.' });
        }

        // 处理路径中的斜杠，支持子文件夹
        const filePath = path.join(AGENT_FILES_DIR, decodedFileName.replace(/\//g, path.sep));

        try {
            await fs.access(filePath);
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ content });
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: `Agent file '${decodedFileName}' not found.` });
            } else {
                console.error(`[AdminPanelRoutes API] Error reading agent file ${decodedFileName}:`, error);
                res.status(500).json({ error: `Failed to read agent file ${decodedFileName}`, details: error.message });
            }
        }
    });

    // POST to save content of a specific agent file
    adminApiRouter.post('/agents/:fileName', async (req, res) => {
        const { fileName } = req.params;
        const { content } = req.body;

        // 解码URL编码的文件名，处理路径中的斜杠
        const decodedFileName = decodeURIComponent(fileName);

        // 检查文件扩展名
        if (!decodedFileName.toLowerCase().endsWith('.txt') && !decodedFileName.toLowerCase().endsWith('.md')) {
            return res.status(400).json({ error: 'Invalid file name. Must be a .txt or .md file.' });
        }
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { content: string }.' });
        }

        // 处理路径中的斜杠，支持子文件夹
        const filePath = path.join(AGENT_FILES_DIR, decodedFileName.replace(/\//g, path.sep));
        const fileDir = path.dirname(filePath);

        try {
            await fs.mkdir(fileDir, { recursive: true }); // Ensure directory exists
            await fs.writeFile(filePath, content, 'utf-8');
            res.json({ message: `Agent file '${decodedFileName}' saved successfully.` });
        } catch (error) {
            console.error(`[AdminPanelRoutes API] Error saving agent file ${decodedFileName}:`, error);
            res.status(500).json({ error: `Failed to save agent file ${decodedFileName}`, details: error.message });
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

    // --- Placeholders Viewer API ---
    const PREVIEW_MAX_LEN = 180;
    function truncatePreview(text, maxLen = PREVIEW_MAX_LEN) {
        if (text == null) return '';
        if (typeof text !== 'string') return `<${typeof text}>`;
        const str = String(text).trim();
        if (str.length <= maxLen) return str;
        return Array.from(str).slice(0, maxLen).join('') + '…';
    }

    function charCount(str) {
        if (str == null) return 0;
        if (typeof str !== 'string') return '-';
        return Array.from(String(str)).length;
    }

    function getFixedTimeValues() {
        const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Shanghai';
        const now = new Date();
        const date = now.toLocaleDateString('zh-CN', { timeZone: REPORT_TIMEZONE });
        const time = now.toLocaleTimeString('zh-CN', { timeZone: REPORT_TIMEZONE });
        const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: REPORT_TIMEZONE });
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const lunarCalendar = require('chinese-lunar-calendar');
        const lunarDate = lunarCalendar.getLunar(year, month, day);
        let yearName = lunarDate.lunarYear.replace('年', '');
        let festivalInfo = `${yearName}${lunarDate.zodiac}年${lunarDate.dateStr}`;
        if (lunarDate.solarTerm) festivalInfo += ` ${lunarDate.solarTerm}`;
        const port = process.env.PORT || '';
        return { Date: date, Time: time, Today: today, Festival: festivalInfo, Port: port };
    }

    function getPlaceholderDescriptionsFromManifests() {
        const map = new Map();
        if (!pluginManager.plugins) return map;
        for (const plugin of pluginManager.plugins.values()) {
            const placeholders = plugin.capabilities && plugin.capabilities.systemPromptPlaceholders;
            if (!Array.isArray(placeholders)) continue;
            placeholders.forEach(ph => {
                const desc = (ph && ph.description) ? String(ph.description).trim() : '';
                if (ph && ph.placeholder) {
                    const raw = String(ph.placeholder).trim();
                    map.set(raw, desc);
                    const normalized = raw.replace(/^\{\{|\}\}$/g, '');
                    if (normalized !== raw) map.set(normalized, desc);
                }
            });
        }
        return map;
    }

    /** 工具类插件占位符（VCPPluginName）→ 对应插件的 manifest.description */
    function getPluginDescriptionsByToolPlaceholder() {
        const map = new Map();
        if (!pluginManager.plugins) return map;
        for (const plugin of pluginManager.plugins.values()) {
            const hasTools = plugin.capabilities && plugin.capabilities.invocationCommands && plugin.capabilities.invocationCommands.length > 0;
            if (!hasTools) continue;
            const placeholderKey = `VCP${plugin.name}`;
            const desc = (plugin.description != null && plugin.description !== '') ? String(plugin.description).trim() : '';
            map.set(placeholderKey, desc);
        }
        return map;
    }

    adminApiRouter.get('/placeholders', async (req, res) => {
        try {
            const list = [];
            const placeholderDescriptions = getPlaceholderDescriptionsFromManifests();
            const getDesc = (nameOrKey) => {
                const withBraces = nameOrKey.includes('{{') ? nameOrKey : `{{${nameOrKey}}}`;
                const withoutBraces = nameOrKey.replace(/^\{\{|\}\}$/g, '');
                return placeholderDescriptions.get(nameOrKey) || placeholderDescriptions.get(withBraces) || placeholderDescriptions.get(withoutBraces) || '';
            };
            // 1. Agent
            const agentManager = require('../modules/agentManager');
            if (agentManager.agentMap && agentManager.agentMap.size > 0) {
                for (const alias of Array.from(agentManager.agentMap.keys())) {
                    try {
                        const content = await agentManager.getAgentPrompt(alias);
                        list.push({
                            type: 'agent',
                            name: `{{${alias}}}`,
                            preview: truncatePreview(content),
                            charCount: charCount(content)
                        });
                    } catch (e) {
                        list.push({ type: 'agent', name: `{{${alias}}}`, preview: `[获取失败: ${e.message}]`, charCount: 0 });
                    }
                }
            }
            // 2. Tar / Var（env 中以 Tar 或 Var 开头）
            const tvsManager = require('../modules/tvsManager');
            const tarVarKeys = Object.keys(process.env).filter(k => k.startsWith('Tar') || k.startsWith('Var'));
            for (const envKey of tarVarKeys) {
                const raw = process.env[envKey] || '';
                let preview = raw;
                if (typeof raw === 'string' && raw.toLowerCase().endsWith('.txt')) {
                    try {
                        preview = await tvsManager.getContent(raw);
                    } catch (e) {
                        preview = `[读取文件失败: ${e.message}]`;
                    }
                }
                list.push({ type: 'env_tar_var', name: `{{${envKey}}}`, preview: truncatePreview(preview), charCount: charCount(preview) });
            }
            // 3. SarPrompt（env 中 ^SarPrompt\d+$）
            const sarKeys = Object.keys(process.env).filter(k => /^SarPrompt\d+$/.test(k));
            for (const envKey of sarKeys) {
                const raw = process.env[envKey] || '';
                let preview = raw;
                if (typeof raw === 'string' && raw.toLowerCase().endsWith('.txt')) {
                    try {
                        preview = await tvsManager.getContent(raw);
                    } catch (e) {
                        preview = raw || '[按模型注入]';
                    }
                }
                list.push({ type: 'env_sar', name: `{{${envKey}}}`, preview: truncatePreview(preview || '[按模型注入]'), charCount: charCount(preview || '[按模型注入]') });
            }
            // 4. 固定时间/Port
            const fixedVals = getFixedTimeValues();
            for (const key of ['Date', 'Time', 'Today', 'Festival']) {
                list.push({ type: 'fixed', name: `{{${key}}}`, preview: truncatePreview(fixedVals[key]), charCount: charCount(fixedVals[key]) });
            }
            if (fixedVals.Port !== undefined && fixedVals.Port !== '') {
                list.push({ type: 'fixed', name: '{{Port}}', preview: String(fixedVals.Port), charCount: charCount(fixedVals.Port) });
            }
            // 5. 静态插件占位符
            const staticPlaceholderValues = pluginManager.getAllPlaceholderValues && pluginManager.getAllPlaceholderValues();
            if (staticPlaceholderValues && staticPlaceholderValues.size > 0) {
                for (const [key, value] of staticPlaceholderValues.entries()) {
                    const name = key.includes('{{') ? key : `{{${key}}}`;
                    list.push({
                        type: 'static_plugin',
                        name,
                        preview: truncatePreview(value),
                        charCount: charCount(value),
                        description: getDesc(name)
                    });
                }
            }
            // 6. 工具描述（每个 key 一项）+ VCPAllTools（一项）
            const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions && pluginManager.getIndividualPluginDescriptions();
            const pluginDescByTool = getPluginDescriptionsByToolPlaceholder();
            if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
                for (const [placeholderKey, description] of individualPluginDescriptions) {
                    const toolDesc = pluginDescByTool.get(placeholderKey) || '';
                    list.push({
                        type: 'tool_description',
                        name: `{{${placeholderKey}}}`,
                        preview: truncatePreview(description),
                        charCount: charCount(description),
                        description: toolDesc
                    });
                }
                const vcpDescriptionsList = [...individualPluginDescriptions.values()];
                const allVcpToolsString = vcpDescriptionsList.length > 0 ? vcpDescriptionsList.join('\n\n---\n\n') : '没有可用的VCP工具描述信息';
                list.push({
                    type: 'vcp_all_tools',
                    name: '{{VCPAllTools}}',
                    preview: truncatePreview(allVcpToolsString),
                    charCount: charCount(allVcpToolsString)
                });
            }
            // 7. Image_Key
            const effectiveImageKey = pluginManager.getResolvedPluginConfigValue && pluginManager.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
            if (effectiveImageKey) {
                list.push({
                    type: 'image_key',
                    name: '{{Image_Key}}',
                    preview: '******',
                    charCount: charCount(effectiveImageKey)
                });
            }
            // 8. AllCharacterDiariesData + X日记本
            const allDiariesDataString = pluginManager.getPlaceholderValue && pluginManager.getPlaceholderValue('{{AllCharacterDiariesData}}');
            if (allDiariesDataString && !allDiariesDataString.startsWith('[Placeholder')) {
                try {
                    const allDiariesData = JSON.parse(allDiariesDataString);
                    list.push({
                        type: 'diary',
                        name: '{{AllCharacterDiariesData}}',
                        preview: truncatePreview(allDiariesDataString),
                        charCount: charCount(allDiariesDataString)
                    });
                    for (const characterName of Object.keys(allDiariesData)) {
                        const content = allDiariesData[characterName];
                        list.push({
                            type: 'diary_character',
                            name: `{{${characterName}日记本}}`,
                            preview: truncatePreview(content),
                            charCount: charCount(content)
                        });
                    }
                } catch (e) {
                    list.push({
                        type: 'diary',
                        name: '{{AllCharacterDiariesData}}',
                        preview: truncatePreview(allDiariesDataString),
                        charCount: charCount(allDiariesDataString)
                    });
                }
            }
            // 9. VCP_ASYNC_RESULT 说明项
            const asyncDesc = '动态占位符：异步任务完成后按 PluginName 与 requestId 替换为结果内容。列表中不列举具体 requestId。';
            list.push({
                type: 'async_placeholder',
                name: '{{VCP_ASYNC_RESULT::PluginName::requestId}}',
                preview: asyncDesc,
                charCount: charCount(asyncDesc)
            });
            res.json({ success: true, data: { list } });
        } catch (error) {
            console.error('[AdminPanelRoutes] Error listing placeholders:', error);
            res.status(500).json({ success: false, error: 'Failed to list placeholders', details: error.message });
        }
    });

    adminApiRouter.get('/placeholders/detail', async (req, res) => {
        try {
            const type = req.query.type;
            let name = req.query.name;
            if (!type || name === undefined || name === '') {
                return res.status(400).json({ success: false, error: 'Missing type or name' });
            }
            
            name = decodeURIComponent(String(name));
            const rawName = name.replace(/^\{\{|\}\}$/g, '');
            let value = '';
            switch (type) {
                case 'agent': {
                    const agentManager = require('../modules/agentManager');
                    if (!agentManager.isAgent(rawName)) {
                        return res.status(404).json({ success: false, error: 'Agent not found', details: name });
                    }
                    value = await agentManager.getAgentPrompt(rawName);
                    break;
                }
                case 'env_tar_var':
                case 'env_sar': {
                    const envVal = process.env[rawName];
                    if (envVal === undefined) {
                        return res.status(404).json({ success: false, error: 'Environment variable not found', details: name });
                    }
                    if (typeof envVal === 'string' && envVal.toLowerCase().endsWith('.txt')) {
                        const tvsManager = require('../modules/tvsManager');
                        value = await tvsManager.getContent(envVal);
                    } else {
                        value = envVal || '';
                    }
                    if (type === 'env_sar') {
                        value = value || '[当前未配置或按请求模型注入]';
                    }
                    break;
                }
                case 'fixed': {
                    const fixedVals = getFixedTimeValues();
                    const key = rawName === 'Port' ? 'Port' : rawName;
                    value = fixedVals[key] !== undefined ? String(fixedVals[key]) : '[未知固定占位符]';
                    break;
                }
                case 'static_plugin': {
                    value = pluginManager.getPlaceholderValue(rawName);
                    if (value && typeof value === 'string' && value.startsWith('[Placeholder ') && value.includes('not found')) {
                        return res.status(404).json({ success: false, error: 'Placeholder not found', details: name });
                    }
                    if (value != null && typeof value !== 'string') {
                        value = JSON.stringify(value, null, 2);
                    }
                    break;
                }
                case 'tool_description': {
                    const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions && pluginManager.getIndividualPluginDescriptions();
                    if (!individualPluginDescriptions || !individualPluginDescriptions.has(rawName)) {
                        return res.status(404).json({ success: false, error: 'Tool description not found', details: name });
                    }
                    value = individualPluginDescriptions.get(rawName) || '';
                    break;
                }
                case 'vcp_all_tools': {
                    const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions && pluginManager.getIndividualPluginDescriptions();
                    const vcpDescriptionsList = individualPluginDescriptions ? [...individualPluginDescriptions.values()] : [];
                    value = vcpDescriptionsList.length > 0 ? vcpDescriptionsList.join('\n\n---\n\n') : '没有可用的VCP工具描述信息';
                    break;
                }
                case 'image_key': {
                    const effectiveImageKey = pluginManager.getResolvedPluginConfigValue && pluginManager.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
                    if (!effectiveImageKey) {
                        return res.status(404).json({ success: false, error: 'Image_Key not configured', details: name });
                    }
                    value = '安全第一，不显示';
                    break;
                }
                case 'diary': {
                    value = pluginManager.getPlaceholderValue && pluginManager.getPlaceholderValue('{{AllCharacterDiariesData}}');
                    if (!value || value.startsWith('[Placeholder')) {
                        return res.status(404).json({ success: false, error: 'AllCharacterDiariesData not found', details: name });
                    }
                    break;
                }
                case 'diary_character': {
                    const characterName = rawName.replace(/日记本$/, '');
                    const allDiariesDataString = pluginManager.getPlaceholderValue && pluginManager.getPlaceholderValue('{{AllCharacterDiariesData}}');
                    if (!allDiariesDataString || allDiariesDataString.startsWith('[Placeholder')) {
                        return res.status(404).json({ success: false, error: '日记本数据不可用', details: name });
                    }
                    try {
                        const allDiariesData = JSON.parse(allDiariesDataString);
                        value = allDiariesData.hasOwnProperty(characterName) ? allDiariesData[characterName] : `[角色「${characterName}」无日记数据]`;
                    } catch (e) {
                        return res.status(404).json({ success: false, error: '解析日记本数据失败', details: e.message });
                    }
                    break;
                }
                case 'async_placeholder':
                    value = '此占位符为动态格式：`{{VCP_ASYNC_RESULT::插件名::requestId}}`。在系统提示词中使用时，会在对应异步任务完成后被替换为任务结果。具体 requestId 由运行时生成，列表中不列举。';
                    break;
                default:
                    return res.status(400).json({ success: false, error: 'Unknown placeholder type', details: type });
            }
            const displayName = name.includes('{{') ? name : `{{${name}}}`;
            res.json({ success: true, data: { name: displayName, value } });
        } catch (error) {
            console.error('[AdminPanelRoutes] Error getting placeholder detail:', error);
            res.status(500).json({ success: false, error: 'Failed to get placeholder detail', details: error.message });
        }
    });
    // --- End Placeholders Viewer API ---

    // --- Schedule Manager API ---
    const SCHEDULE_FILE = path.join(__dirname, '..', 'Plugin', 'ScheduleManager', 'schedules.json');

    adminApiRouter.get('/schedules', async (req, res) => {
        try {
            let schedules = [];
            try {
                const content = await fs.readFile(SCHEDULE_FILE, 'utf-8');
                schedules = JSON.parse(content);
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
            res.json(schedules);
        } catch (error) {
            console.error('[AdminAPI] Error getting schedules:', error);
            res.status(500).json({ error: 'Failed to get schedules', details: error.message });
        }
    });

    adminApiRouter.post('/schedules', async (req, res) => {
        try {
            const { time, content } = req.body;
            if (!time || !content) {
                return res.status(400).json({ error: 'Time and content are required.' });
            }

            let schedules = [];
            try {
                const fileContent = await fs.readFile(SCHEDULE_FILE, 'utf-8');
                schedules = JSON.parse(fileContent);
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }

            const newSchedule = {
                id: Date.now().toString(),
                time,
                content
            };
            schedules.push(newSchedule);
            await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
            res.json({ status: 'success', result: `日程已添加。ID: ${newSchedule.id}`, schedule: newSchedule });
        } catch (error) {
            console.error('[AdminAPI] Error adding schedule:', error);
            res.status(500).json({ error: 'Failed to add schedule', details: error.message });
        }
    });

    adminApiRouter.delete('/schedules/:id', async (req, res) => {
        try {
            const { id } = req.params;
            let schedules = [];
            try {
                const fileContent = await fs.readFile(SCHEDULE_FILE, 'utf-8');
                schedules = JSON.parse(fileContent);
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }

            const initialLength = schedules.length;
            schedules = schedules.filter(s => s.id !== id);

            if (schedules.length === initialLength) {
                return res.status(404).json({ error: `未找到 ID 为 ${id} 的日程。` });
            }

            await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
            res.json({ status: 'success', result: `日程 ${id} 已删除。` });
        } catch (error) {
            console.error('[AdminAPI] Error deleting schedule:', error);
            res.status(500).json({ error: 'Failed to delete schedule', details: error.message });
        }
    });
    // --- End Schedule Manager API ---

    // --- RAG Tags API ---
    adminApiRouter.get('/rag-tags', async (req, res) => {
        const ragTagsPath = path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'rag_tags.json');
        try {
            const content = await fs.readFile(ragTagsPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reading rag_tags.json:', error);
            if (error.code === 'ENOENT') {
                res.json({}); // Return empty object if file doesn't exist
            } else {
                res.status(500).json({ error: 'Failed to read rag_tags.json', details: error.message });
            }
        }
    });

    adminApiRouter.post('/rag-tags', async (req, res) => {
        const ragTagsPath = path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'rag_tags.json');
        const data = req.body;
        if (typeof data !== 'object' || data === null) {
            return res.status(400).json({ error: 'Invalid request body. Expected a JSON object.' });
        }
        try {
            await fs.writeFile(ragTagsPath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: 'RAG Tags 文件已成功保存。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing rag_tags.json:', error);
            res.status(500).json({ error: 'Failed to write rag_tags.json', details: error.message });
        }
    });
    // --- End RAG Tags API ---

    // --- RAG Params API ---
    adminApiRouter.get('/rag-params', async (req, res) => {
        const ragParamsPath = path.join(__dirname, '..', 'rag_params.json');
        try {
            const content = await fs.readFile(ragParamsPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reading rag_params.json:', error);
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'rag_params.json not found.' });
            } else {
                res.status(500).json({ error: 'Failed to read rag_params.json', details: error.message });
            }
        }
    });

    adminApiRouter.post('/rag-params', async (req, res) => {
        const ragParamsPath = path.join(__dirname, '..', 'rag_params.json');
        const data = req.body;
        if (typeof data !== 'object' || data === null) {
            return res.status(400).json({ error: 'Invalid request body. Expected a JSON object.' });
        }
        try {
            await fs.writeFile(ragParamsPath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: 'RAG Params 文件已成功保存。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing rag_params.json:', error);
            res.status(500).json({ error: 'Failed to write rag_params.json', details: error.message });
        }
    });
    // --- End RAG Params API ---

    // --- Semantic Groups API ---
    adminApiRouter.get('/semantic-groups', async (req, res) => {
        const editFilePath = path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.edit.json');
        const mainFilePath = path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.json');

        try {
            // 优先读取 .edit.json 文件
            const content = await fs.readFile(editFilePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (editError) {
            if (editError.code === 'ENOENT') {
                // 如果 .edit.json 不存在，则回退到读取主文件
                try {
                    const content = await fs.readFile(mainFilePath, 'utf-8');
                    res.json(JSON.parse(content));
                } catch (mainError) {
                    console.error('[AdminPanelRoutes API] Error reading main semantic_groups.json as fallback:', mainError);
                    if (mainError.code === 'ENOENT') {
                        res.json({ config: {}, groups: {} }); // 两个文件都不存在
                    } else {
                        res.status(500).json({ error: 'Failed to read semantic_groups.json', details: mainError.message });
                    }
                }
            } else {
                console.error('[AdminPanelRoutes API] Error reading semantic_groups.edit.json:', editError);
                res.status(500).json({ error: 'Failed to read semantic_groups.edit.json', details: editError.message });
            }
        }
    });

    adminApiRouter.post('/semantic-groups', async (req, res) => {
        const editFilePath = path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.edit.json');
        const data = req.body;
        if (typeof data !== 'object' || data === null) {
            return res.status(400).json({ error: 'Invalid request body. Expected a JSON object.' });
        }
        try {
            // 直接写入 .edit.json 文件，不再调用插件的复杂逻辑
            await fs.writeFile(editFilePath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: '编辑配置已保存。更改将在下次服务器重启后生效。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing semantic_groups.edit.json:', error);
            res.status(500).json({ error: 'Failed to write semantic_groups.edit.json', details: error.message });
        }
    });
    // --- End Semantic Groups API ---

    // --- Thinking Chains API ---
    adminApiRouter.get('/thinking-chains', async (req, res) => {
        const chainsPath = path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'meta_thinking_chains.json');
        try {
            const content = await fs.readFile(chainsPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reading meta_thinking_chains.json:', error);
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'Thinking chains file not found.' });
            } else {
                res.status(500).json({ error: 'Failed to read thinking chains file', details: error.message });
            }
        }
    });

    adminApiRouter.post('/thinking-chains', async (req, res) => {
        const chainsPath = path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'meta_thinking_chains.json');
        const data = req.body;
        if (typeof data !== 'object' || data === null) {
            return res.status(400).json({ error: 'Invalid request body. Expected a JSON object.' });
        }
        try {
            await fs.writeFile(chainsPath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: '思维链配置已成功保存。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing meta_thinking_chains.json:', error);
            res.status(500).json({ error: 'Failed to write thinking chains file', details: error.message });
        }
    });

    adminApiRouter.get('/available-clusters', async (req, res) => {
        try {
            await fs.access(dailyNoteRootPath);
            const entries = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
            const folders = entries
                .filter(entry => entry.isDirectory() && entry.name.endsWith('簇'))
                .map(entry => entry.name);
            res.json({ clusters: folders });
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.warn('[AdminPanelRoutes API] /available-clusters - dailynote directory not found.');
                res.json({ clusters: [] });
            } else {
                console.error('[AdminPanelRoutes API] Error listing available clusters:', error);
                res.status(500).json({ error: 'Failed to list available clusters', details: error.message });
            }
        }
    });
    // --- End Thinking Chains API ---

    // --- VCPTavern API ---
    // This section is now handled by the VCPTavern plugin's own registerRoutes method.
    // The conflicting routes have been removed from here to allow the plugin to manage them.
    // --- End VCPTavern API ---

    // --- 新增：预处理器顺序管理 API ---
    adminApiRouter.get('/preprocessors/order', (req, res) => {
        try {
            const order = pluginManager.getPreprocessorOrder();
            res.json({ status: 'success', order });
        } catch (error) {
            console.error('[AdminAPI] Error getting preprocessor order:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get preprocessor order.' });
        }
    });

    adminApiRouter.post('/preprocessors/order', async (req, res) => {
        const { order } = req.body;
        if (!Array.isArray(order)) {
            return res.status(400).json({ status: 'error', message: 'Invalid request: "order" must be an array.' });
        }

        try {
            await fs.writeFile(PREPROCESSOR_ORDER_FILE, JSON.stringify(order, null, 2), 'utf-8');
            if (DEBUG_MODE) console.log('[AdminAPI] Saved new preprocessor order to file.');

            const newOrder = await pluginManager.hotReloadPluginsAndOrder();
            res.json({ status: 'success', message: 'Order saved and hot-reloaded successfully.', newOrder });

        } catch (error) {
            console.error('[AdminAPI] Error saving or hot-reloading preprocessor order:', error);
            res.status(500).json({ status: 'error', message: 'Failed to save or hot-reload preprocessor order.' });
        }
    });

    // --- VectorDB Status API ---
    adminApiRouter.get('/vectordb/status', (req, res) => {
        if (vectorDBManager && typeof vectorDBManager.getHealthStatus === 'function') {
            try {
                const status = vectorDBManager.getHealthStatus();
                res.json({ success: true, status });
            } catch (error) {
                console.error('[AdminAPI] Error getting VectorDB status:', error);
                res.status(500).json({ success: false, error: 'Failed to get VectorDB status', details: error.message });
            }
        } else {
            res.status(503).json({ success: false, error: 'VectorDBManager is not available.' });
        }
    });

    // ========================
    // AgentAssistant 配置 API
    // ========================

    /**
     * 辅助函数：解析 AgentAssistant config.env 中的配置
     * 返回：{ maxHistoryRounds, contextTtlHours, globalSystemPrompt, agents: [...] }
     */
    async function parseAgentAssistantConfig() {
        let content = '';
        try {
            content = await fs.readFile(AGENT_ASSISTANT_CONFIG_PATH, 'utf-8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                // 如果正式配置不存在，尝试使用示例作为模板
                try {
                    content = await fs.readFile(AGENT_ASSISTANT_EXAMPLE_CONFIG_PATH, 'utf-8');
                } catch (exampleError) {
                    // 示例也不存在则返回默认空配置
                    console.warn('[AdminAPI] AgentAssistant config.env and example config.env not found. Using defaults.');
                    return {
                        maxHistoryRounds: 7,
                        contextTtlHours: 24,
                        agents: []
                    };
                }
            } else {
                throw error;
            }
        }

        const lines = content.split(/\r?\n/);
        let maxHistoryRounds = null;
        let contextTtlHours = null;
        let globalSystemPrompt = null;
        const agentsByBaseName = new Map();

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#') || !line.includes('=')) continue;

            const eqIndex = line.indexOf('=');
            const key = line.substring(0, eqIndex).trim();
            let value = line.substring(eqIndex + 1).trim();

            // 去掉包裹的引号
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.substring(1, value.length - 1);
            }

            // 反转义常见的转义序列
            const unescapedValue = value
                .replace(/\\\\/g, '\\')
                .replace(/\\n/g, '\n')
                .replace(/\\"/g, '"')
                .replace(/\\'/g, "'");

            if (key === 'AGENT_ASSISTANT_MAX_HISTORY_ROUNDS') {
                const parsed = parseInt(unescapedValue, 10);
                if (!Number.isNaN(parsed)) maxHistoryRounds = parsed;
                continue;
            }

            if (key === 'AGENT_ASSISTANT_CONTEXT_TTL_HOURS') {
                const parsed = parseInt(unescapedValue, 10);
                if (!Number.isNaN(parsed)) contextTtlHours = parsed;
                continue;
            }

            if (key === 'AGENT_ALL_SYSTEM_PROMPT') {
                globalSystemPrompt = unescapedValue;
                continue;
            }

            // 解析 AGENT_{BASENAME}_* 定义
            if (key.startsWith('AGENT_')) {
                const match = key.match(/^AGENT_([A-Z0-9_]+)_(MODEL_ID|CHINESE_NAME|SYSTEM_PROMPT|MAX_OUTPUT_TOKENS|TEMPERATURE|DESCRIPTION)$/i);
                if (!match) continue;

                const baseName = match[1].toUpperCase();
                const field = match[2];

                if (!agentsByBaseName.has(baseName)) {
                    agentsByBaseName.set(baseName, {
                        baseName,
                        modelId: '',
                        chineseName: '',
                        systemPrompt: '',
                        maxOutputTokens: 40000,
                        temperature: 0.7,
                        description: ''
                    });
                }

                const agent = agentsByBaseName.get(baseName);

                switch (field) {
                    case 'MODEL_ID':
                        agent.modelId = unescapedValue;
                        break;
                    case 'CHINESE_NAME':
                        agent.chineseName = unescapedValue;
                        break;
                    case 'SYSTEM_PROMPT':
                        agent.systemPrompt = unescapedValue;
                        break;
                    case 'MAX_OUTPUT_TOKENS': {
                        const parsedTokens = parseInt(unescapedValue, 10);
                        if (!Number.isNaN(parsedTokens)) agent.maxOutputTokens = parsedTokens;
                        break;
                    }
                    case 'TEMPERATURE': {
                        const parsedTemp = parseFloat(unescapedValue);
                        if (!Number.isNaN(parsedTemp)) agent.temperature = parsedTemp;
                        break;
                    }
                    case 'DESCRIPTION':
                        agent.description = unescapedValue;
                        break;
                    default:
                        break;
                }
            }
        }

        const agents = Array.from(agentsByBaseName.values()).filter(agent => agent.chineseName || agent.modelId);

        return {
            maxHistoryRounds: maxHistoryRounds != null ? maxHistoryRounds : 7,
            contextTtlHours: contextTtlHours != null ? contextTtlHours : 24,
            globalSystemPrompt: globalSystemPrompt != null ? globalSystemPrompt : '',
            agents
        };
    }

    function escapeForDoubleQuotes(value) {
        if (value == null) return '';
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\r?\n/g, '\\n');
    }

    function generateBaseName(chineseName, existingBaseNames) {
        const used = new Set(existingBaseNames.map(name => name.toUpperCase()));
        let base = (chineseName || '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
        if (!base) base = 'AGENT';
        base = base.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (!base) base = 'AGENT';
        base = base.toUpperCase();

        let candidate = base;
        let counter = 2;
        while (used.has(candidate)) {
            candidate = `${base}_${counter}`;
            counter += 1;
        }
        return candidate;
    }

    // 获取 AgentAssistant 配置
    adminApiRouter.get('/agent-assistant/config', async (req, res) => {
        try {
            const config = await parseAgentAssistantConfig();
            res.json(config);
        } catch (error) {
            console.error('[AdminAPI] Error reading AgentAssistant config:', error);
            res.status(500).json({ error: 'Failed to read AgentAssistant config', details: error.message });
        }
    });

    // 保存 AgentAssistant 配置
    adminApiRouter.post('/agent-assistant/config', async (req, res) => {
        const body = req.body || {};
        let { maxHistoryRounds, contextTtlHours, globalSystemPrompt, agents } = body;

        if (!Array.isArray(agents)) {
            return res.status(400).json({ error: 'Invalid request body. Expected { agents: [...] }.' });
        }

        maxHistoryRounds = parseInt(maxHistoryRounds, 10);
        if (Number.isNaN(maxHistoryRounds) || maxHistoryRounds <= 0) maxHistoryRounds = 7;

        contextTtlHours = parseInt(contextTtlHours, 10);
        if (Number.isNaN(contextTtlHours) || contextTtlHours <= 0) contextTtlHours = 24;

        // 轻量校验 agent 配置
        const normalizedAgents = [];
        const baseNames = [];

        for (const agent of agents) {
            if (!agent) continue;
            const chineseName = (agent.chineseName || '').trim();
            const modelId = (agent.modelId || '').trim();

            if (!chineseName || !modelId) {
                // 对于缺少关键字段的条目，直接跳过，不写入配置
                continue;
            }

            const baseName = (agent.baseName || '').trim();
            normalizedAgents.push({
                baseName,
                chineseName,
                modelId,
                systemPrompt: agent.systemPrompt || '',
                maxOutputTokens: parseInt(agent.maxOutputTokens, 10) || 40000,
                temperature: Number.isNaN(parseFloat(agent.temperature))
                    ? 0.7
                    : parseFloat(agent.temperature),
                description: agent.description || ''
            });
            if (baseName) baseNames.push(baseName);
        }

        try {
            // 读取原始文件内容，用于保留非 AGENT_* 的其他配置与注释
            let originalLines = [];
            try {
                const originalContent = await fs.readFile(AGENT_ASSISTANT_CONFIG_PATH, 'utf-8');
                originalLines = originalContent.split(/\r?\n/);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    // 如果正式配置不存在，尝试示例以获取注释模板
                    try {
                        const exampleContent = await fs.readFile(AGENT_ASSISTANT_EXAMPLE_CONFIG_PATH, 'utf-8');
                        originalLines = exampleContent.split(/\r?\n/);
                    } catch (exampleError) {
                        originalLines = [];
                    }
                } else {
                    throw error;
                }
            }

            // 保留所有非 AGENT_ 开头的行（包括注释）
            const preservedLines = originalLines.filter(line => !line.trim().startsWith('AGENT_'));

            const newLines = [...preservedLines];
            if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== '') {
                newLines.push('');
            }

            newLines.push(`# -------------------------------------------------------------------`);
            newLines.push(`# [AgentAssistant 基础配置] （由控制中心自动生成）`);
            newLines.push(`# -------------------------------------------------------------------`);
            newLines.push(`AGENT_ASSISTANT_MAX_HISTORY_ROUNDS=${maxHistoryRounds}`);
            newLines.push(`AGENT_ASSISTANT_CONTEXT_TTL_HOURS=${contextTtlHours}`);

            if (globalSystemPrompt && String(globalSystemPrompt).trim() !== '') {
                newLines.push(
                    `AGENT_ALL_SYSTEM_PROMPT="${escapeForDoubleQuotes(String(globalSystemPrompt))}"`
                );
            }

            newLines.push('');

            if (normalizedAgents.length > 0) {
                newLines.push(`# -------------------------------------------------------------------`);
                newLines.push(`# [AgentAssistant 定义的 Agent 列表] （由控制中心自动生成）`);
                newLines.push(`# 请尽量通过控制中心修改，避免手动编辑造成不一致。`);
                newLines.push(`# -------------------------------------------------------------------`);
                newLines.push('');

                const existingBaseNames = normalizedAgents
                    .map(a => a.baseName)
                    .filter(Boolean)
                    .map(name => name.toUpperCase());

                for (const agent of normalizedAgents) {
                    let baseName = (agent.baseName || '').trim();
                    if (!baseName) {
                        baseName = generateBaseName(agent.chineseName, existingBaseNames);
                        existingBaseNames.push(baseName);
                    }

                    newLines.push(`# Agent: ${agent.chineseName}`);
                    newLines.push(`AGENT_${baseName}_MODEL_ID="${escapeForDoubleQuotes(agent.modelId)}"`);
                    newLines.push(`AGENT_${baseName}_CHINESE_NAME="${escapeForDoubleQuotes(agent.chineseName)}"`);
                    if (agent.systemPrompt) {
                        newLines.push(
                            `AGENT_${baseName}_SYSTEM_PROMPT="${escapeForDoubleQuotes(agent.systemPrompt)}"`
                        );
                    }
                    if (agent.maxOutputTokens) {
                        newLines.push(`AGENT_${baseName}_MAX_OUTPUT_TOKENS=${agent.maxOutputTokens}`);
                    }
                    if (typeof agent.temperature === 'number') {
                        newLines.push(`AGENT_${baseName}_TEMPERATURE=${agent.temperature}`);
                    }
                    if (agent.description) {
                        newLines.push(
                            `AGENT_${baseName}_DESCRIPTION="${escapeForDoubleQuotes(agent.description)}"`
                        );
                    }
                    newLines.push('');
                }
            }

            const finalContent = newLines.join('\n');
            await fs.writeFile(AGENT_ASSISTANT_CONFIG_PATH, finalContent, 'utf-8');

            // 重新加载插件，使新的 Agent 配置生效
            try {
                await pluginManager.loadPlugins();
            } catch (reloadError) {
                console.error('[AdminAPI] Error reloading plugins after AgentAssistant config save:', reloadError);
                // 即使重载失败，配置文件也已经更新，前端仍然认为保存成功
            }

            res.json({ message: 'AgentAssistant 配置已保存。' });
        } catch (error) {
            console.error('[AdminAPI] Error writing AgentAssistant config:', error);
            res.status(500).json({ error: 'Failed to write AgentAssistant config', details: error.message });
        }
    });

    // ========================
    // Tool List Editor API
    // ========================
    const PROJECT_BASE_PATH = path.join(__dirname, '..');
    const TOOL_CONFIGS_DIR = path.join(PROJECT_BASE_PATH, 'ToolConfigs');

    // 确保ToolConfigs目录存在
    async function ensureToolConfigsDir() {
        try {
            await fs.access(TOOL_CONFIGS_DIR);
        } catch {
            await fs.mkdir(TOOL_CONFIGS_DIR, { recursive: true });
        }
    }

    // 获取所有可用工具列表
    adminApiRouter.get('/tool-list-editor/tools', (req, res) => {
        try {
            const tools = [];

            // 遍历所有插件
            for (const [pluginName, manifest] of pluginManager.plugins.entries()) {
                if (manifest.capabilities && manifest.capabilities.invocationCommands) {
                    // 为每个invocation command创建一个工具条目
                    manifest.capabilities.invocationCommands.forEach(cmd => {
                        tools.push({
                            name: cmd.commandIdentifier || pluginName,
                            pluginName: pluginName,
                            displayName: manifest.displayName || pluginName,
                            description: cmd.description || manifest.description || '',
                            example: cmd.example || ''
                        });
                    });
                }
            }

            res.json({ tools });
        } catch (error) {
            console.error('[AdminAPI] Error getting tool list:', error);
            res.status(500).json({ error: 'Failed to get tool list', details: error.message });
        }
    });

    // 获取所有可用的配置文件列表
    adminApiRouter.get('/tool-list-editor/configs', async (req, res) => {
        try {
            await ensureToolConfigsDir();
            const files = await fs.readdir(TOOL_CONFIGS_DIR);
            const configs = files
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace('.json', ''));
            res.json({ configs });
        } catch (error) {
            console.error('[AdminAPI] Error getting config list:', error);
            res.status(500).json({ error: 'Failed to get config list', details: error.message });
        }
    });

    // 加载指定的配置文件
    adminApiRouter.get('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            const configName = req.params.configName;
            const configPath = path.join(TOOL_CONFIGS_DIR, `${configName}.json`);

            const content = await fs.readFile(configPath, 'utf-8');
            const configData = JSON.parse(content);

            res.json(configData);
        } catch (error) {
            console.error('[AdminAPI] Error loading config:', error);
            res.status(500).json({ error: 'Failed to load config', details: error.message });
        }
    });

    // 保存配置文件
    adminApiRouter.post('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            await ensureToolConfigsDir();
            const configName = req.params.configName;
            const configPath = path.join(TOOL_CONFIGS_DIR, `${configName}.json`);

            const configData = {
                selectedTools: req.body.selectedTools || [],
                toolDescriptions: req.body.toolDescriptions || {}
            };

            await fs.writeFile(configPath, JSON.stringify(configData, null, 2), 'utf-8');
            res.json({ status: 'success', message: 'Config saved successfully' });
        } catch (error) {
            console.error('[AdminAPI] Error saving config:', error);
            res.status(500).json({ error: 'Failed to save config', details: error.message });
        }
    });

    // 删除配置文件
    adminApiRouter.delete('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            const configName = req.params.configName;
            const configPath = path.join(TOOL_CONFIGS_DIR, `${configName}.json`);

            await fs.unlink(configPath);
            res.json({ status: 'success', message: 'Config deleted successfully' });
        } catch (error) {
            console.error('[AdminAPI] Error deleting config:', error);
            res.status(500).json({ error: 'Failed to delete config', details: error.message });
        }
    });

    // 检查文件是否存在
    adminApiRouter.get('/tool-list-editor/check-file/:fileName', async (req, res) => {
        try {
            const fileName = req.params.fileName;
            const tvsTxtDir = path.join(PROJECT_BASE_PATH, 'TVStxt');
            const outputPath = path.join(tvsTxtDir, `${fileName}.txt`);

            try {
                await fs.access(outputPath);
                // 文件存在
                res.json({ exists: true });
            } catch {
                // 文件不存在
                res.json({ exists: false });
            }
        } catch (error) {
            console.error('[AdminAPI] Error checking file:', error);
            res.status(500).json({ error: 'Failed to check file', details: error.message });
        }
    });

    // 导出为txt文件
    adminApiRouter.post('/tool-list-editor/export/:fileName', async (req, res) => {
        try {
            const fileName = req.params.fileName;
            const tvsTxtDir = path.join(PROJECT_BASE_PATH, 'TVStxt');
            const outputPath = path.join(tvsTxtDir, `${fileName}.txt`);

            const { selectedTools, toolDescriptions, includeHeader, includeExamples } = req.body;

            let output = '';

            // 添加头部说明
            if (includeHeader) {
                output += 'VCP工具调用格式与指南\r\n\r\n';
                output += '<<<[TOOL_REQUEST]>>>\r\n';
                output += 'maid:「始」你的署名「末」, //重要字段，以进行任务追踪\r\n';
                output += 'tool_name:「始」工具名「末」, //必要字段\r\n';
                output += 'arg:「始」工具参数「末」, //具体视不同工具需求而定\r\n';
                output += '<<<[END_TOOL_REQUEST]>>>\r\n\r\n';
                output += '使用「始」「末」包裹参数来兼容富文本识别。\r\n';
                output += '主动判断当前需求，灵活使用各类工具调用。\r\n\r\n';
                output += '========================================\r\n\r\n';
            }

            // 收集所有选中的工具信息
            const tools = [];
            for (const [pluginName, manifest] of pluginManager.plugins.entries()) {
                if (manifest.capabilities && manifest.capabilities.invocationCommands) {
                    manifest.capabilities.invocationCommands.forEach(cmd => {
                        const toolName = cmd.commandIdentifier || pluginName;
                        if (selectedTools.includes(toolName)) {
                            tools.push({
                                name: toolName,
                                pluginName: pluginName,
                                displayName: manifest.displayName || pluginName,
                                description: cmd.description || manifest.description || '',
                                example: cmd.example || ''
                            });
                        }
                    });
                }
            }

            // 按插件分组工具，以节省Tokens
            const toolsByPlugin = {};
            tools.forEach(tool => {
                if (!toolsByPlugin[tool.pluginName]) {
                    toolsByPlugin[tool.pluginName] = [];
                }
                toolsByPlugin[tool.pluginName].push(tool);
            });

            // 按插件名排序
            const sortedPluginNames = Object.keys(toolsByPlugin).sort((a, b) => a.localeCompare(b));

            // 为每个插件生成说明
            let pluginIndex = 0;
            sortedPluginNames.forEach(pluginName => {
                pluginIndex++;
                const pluginTools = toolsByPlugin[pluginName];

                // 获取插件显示名称（使用第一个工具的displayName）
                const pluginDisplayName = pluginTools[0].displayName || pluginName;

                // 如果该插件只有一个工具
                if (pluginTools.length === 1) {
                    const tool = pluginTools[0];
                    const desc = toolDescriptions[tool.name] || tool.description || '暂无描述';

                    output += `${pluginIndex}. ${pluginDisplayName} (${tool.name})\r\n`;
                    output += `插件: ${pluginName}\r\n`;
                    output += `说明: ${desc}\r\n`;

                    if (includeExamples && tool.example) {
                        output += `\r\n示例:\r\n${tool.example}\r\n`;
                    }
                } else {
                    // 如果该插件有多个工具，合并显示
                    output += `${pluginIndex}. ${pluginDisplayName}\r\n`;
                    output += `插件: ${pluginName}\r\n`;
                    output += `该插件包含 ${pluginTools.length} 个工具调用:\r\n\r\n`;

                    pluginTools.forEach((tool, toolIdx) => {
                        const desc = toolDescriptions[tool.name] || tool.description || '暂无描述';

                        output += `  ${pluginIndex}.${toolIdx + 1} ${tool.name}\r\n`;

                        // 处理说明部分，保持原有的多行格式
                        const descLines = desc.split('\n');
                        descLines.forEach((line, lineIdx) => {
                            if (lineIdx === 0) {
                                output += `  说明: ${line}\r\n`;
                            } else {
                                output += `  ${line}\r\n`;
                            }
                        });

                        if (includeExamples && tool.example) {
                            output += `\r\n`;
                            // 将示例内容缩进
                            const exampleLines = tool.example.split('\n');
                            exampleLines.forEach(line => {
                                output += `  ${line}\r\n`;
                            });
                        }

                        if (toolIdx < pluginTools.length - 1) {
                            output += '\r\n';
                        }
                    });
                }

                output += '\r\n' + '----------------------------------------' + '\r\n\r\n';
            });

            await fs.writeFile(outputPath, output, 'utf-8');
            res.json({ status: 'success', filePath: `TVStxt/${fileName}.txt` });
        } catch (error) {
            console.error('[AdminAPI] Error exporting to txt:', error);
            res.status(500).json({ error: 'Failed to export to txt', details: error.message });
        }
    });

    // 新增：验证登录端点
    adminApiRouter.post('/verify-login', (req, res) => {
        // 能到达这里说明已通过 adminAuth 验证
        // 设置认证 Cookie（24小时有效）
        if (req.headers.authorization) {
            const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
            const cookieOptions = [
                `admin_auth=${encodeURIComponent(req.headers.authorization)}`,
                'Path=/',
                'HttpOnly',
                'SameSite=Strict',
                'Max-Age=86400' // 24小时
            ];

            // 如果是 HTTPS，添加 Secure 标志
            if (isSecure) {
                cookieOptions.push('Secure');
            }

            res.setHeader('Set-Cookie', cookieOptions.join('; '));
        }

        res.status(200).json({
            status: 'success',
            message: 'Authentication successful'
        });
    });

    // 可选：添加登出端点
    adminApiRouter.post('/logout', (req, res) => {
        // 清除认证 Cookie
        res.setHeader('Set-Cookie', 'admin_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        res.status(200).json({ status: 'success', message: 'Logged out' });
    });

    // 新增：检查认证状态端点
    adminApiRouter.get('/check-auth', (req, res) => {
        // 能到达这里说明已通过 adminAuth 中间件验证
        res.status(200).json({ authenticated: true });
    });

    // ========================
    // AgentDream 梦境审批 API
    // ========================
    const DREAM_LOGS_DIR = path.join(__dirname, '..', 'Plugin', 'AgentDream', 'dream_logs');

    // 列出所有梦日志
    adminApiRouter.get('/dream-logs', async (req, res) => {
        try {
            await fs.mkdir(DREAM_LOGS_DIR, { recursive: true });
            const files = await fs.readdir(DREAM_LOGS_DIR);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            const logs = [];
            for (const file of jsonFiles) {
                try {
                    const content = await fs.readFile(path.join(DREAM_LOGS_DIR, file), 'utf-8');
                    const data = JSON.parse(content);
                    const ops = data.operations || [];
                    const pendingCount = ops.filter(o => o.status === 'pending_review').length;
                    logs.push({
                        filename: file,
                        dreamId: data.dreamId || file,
                        agentName: data.agentName || '未知',
                        timestamp: data.timestamp || '',
                        hasNarrative: !!(data.dreamNarrative),
                        operationCount: ops.length,
                        pendingCount,
                        operationSummary: ops.map(o => ({ type: o.type, status: o.status, operationId: o.operationId }))
                    });
                } catch (e) {
                    logs.push({ filename: file, error: e.message });
                }
            }

            // 按时间倒序
            logs.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
            res.json({ logs });
        } catch (error) {
            console.error('[AdminAPI] Error listing dream logs:', error);
            res.status(500).json({ error: 'Failed to list dream logs', details: error.message });
        }
    });

    // 获取单个梦日志详情
    adminApiRouter.get('/dream-logs/:filename', async (req, res) => {
        try {
            const filename = req.params.filename;
            if (!filename.endsWith('.json') || filename.includes('..')) {
                return res.status(400).json({ error: 'Invalid filename.' });
            }
            const filePath = path.join(DREAM_LOGS_DIR, filename);
            const content = await fs.readFile(filePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Dream log not found.' });
            }
            console.error('[AdminAPI] Error reading dream log:', error);
            res.status(500).json({ error: 'Failed to read dream log', details: error.message });
        }
    });

    // 审批/拒绝梦操作
    adminApiRouter.post('/dream-logs/:filename/operations/:opId', async (req, res) => {
        const { filename, opId } = req.params;
        const { action } = req.body; // 'approve' or 'reject'

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'action 必须是 "approve" 或 "reject"。' });
        }
        if (!filename.endsWith('.json') || filename.includes('..')) {
            return res.status(400).json({ error: 'Invalid filename.' });
        }

        const filePath = path.join(DREAM_LOGS_DIR, filename);

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const dreamLog = JSON.parse(content);
            const operations = dreamLog.operations || [];
            const operation = operations.find(o => o.operationId === opId);

            if (!operation) {
                return res.status(404).json({ error: `操作 ${opId} 未找到。` });
            }
            if (operation.status !== 'pending_review') {
                return res.status(400).json({ error: `操作 ${opId} 已被处理 (${operation.status})，无法重复审批。` });
            }

            if (action === 'reject') {
                operation.status = 'rejected';
                operation.reviewedAt = new Date().toISOString();
                await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                return res.json({ status: 'success', message: `操作 ${opId} 已拒绝。`, operation });
            }

            // --- action === 'approve' ---
            let result = {};

            switch (operation.type) {
                case 'merge': {
                    // 用 DailyNoteWrite 插件创建合并后的新日记
                    const maidName = dreamLog.agentName || '未知';
                    const now = new Date();
                    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

                    try {
                        const writeResult = await pluginManager.executePlugin('DailyNoteWrite', JSON.stringify({
                            maidName: maidName,
                            dateString: dateStr,
                            contentText: operation.newContent || ''
                        }));
                        result.newDiary = writeResult;
                    } catch (e) {
                        operation.status = 'error';
                        operation.error = `创建合并日记失败: ${e.message}`;
                        operation.reviewedAt = new Date().toISOString();
                        await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                        return res.status(500).json({ error: operation.error });
                    }

                    // 删除源日记文件
                    const deleteResults = [];
                    for (const diaryUrl of (operation.sourceDiaries || [])) {
                        const diaryPath = _urlToFilePath(diaryUrl);
                        try {
                            await fs.unlink(diaryPath);
                            deleteResults.push({ path: diaryUrl, deleted: true });
                            // 更新向量库
                            if (vectorDBManager && typeof vectorDBManager.removeDocument === 'function') {
                                try { await vectorDBManager.removeDocument(diaryPath); } catch (e) { /* ignore */ }
                            }
                        } catch (e) {
                            deleteResults.push({ path: diaryUrl, deleted: false, error: e.message });
                        }
                    }
                    result.deletedSources = deleteResults;
                    break;
                }

                case 'delete': {
                    const targetPath = _urlToFilePath(operation.targetDiary || '');
                    try {
                        await fs.unlink(targetPath);
                        result.deleted = true;
                        // 更新向量库
                        if (vectorDBManager && typeof vectorDBManager.removeDocument === 'function') {
                            try { await vectorDBManager.removeDocument(targetPath); } catch (e) { /* ignore */ }
                        }
                    } catch (e) {
                        operation.status = 'error';
                        operation.error = `删除日记失败: ${e.message}`;
                        operation.reviewedAt = new Date().toISOString();
                        await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                        return res.status(500).json({ error: operation.error });
                    }
                    break;
                }

                case 'insight': {
                    // 用 DailyNoteWrite 插件创建梦感悟日记
                    const maidName = operation.suggestedMaid || dreamLog.agentName || '未知';
                    const dateStr = operation.suggestedDate || new Date().toISOString().split('T')[0];

                    try {
                        const writeResult = await pluginManager.executePlugin('DailyNoteWrite', JSON.stringify({
                            maidName: `[${maidName}的梦]${maidName}`,
                            dateString: dateStr,
                            contentText: operation.insightContent || ''
                        }));
                        result.newDiary = writeResult;
                    } catch (e) {
                        operation.status = 'error';
                        operation.error = `创建梦感悟失败: ${e.message}`;
                        operation.reviewedAt = new Date().toISOString();
                        await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                        return res.status(500).json({ error: operation.error });
                    }
                    break;
                }

                default:
                    return res.status(400).json({ error: `不支持的操作类型: ${operation.type}` });
            }

            operation.status = 'approved';
            operation.reviewedAt = new Date().toISOString();
            operation.result = result;
            await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
            res.json({ status: 'success', message: `操作 ${opId} 已批准并执行。`, operation });

        } catch (error) {
            console.error('[AdminAPI] Error processing dream operation:', error);
            res.status(500).json({ error: 'Failed to process operation', details: error.message });
        }
    });

    // 辅助: file:/// URL 转本地路径
    function _urlToFilePath(fileUrl) {
        if (fileUrl.startsWith('file:///')) {
            return fileUrl.replace('file:///', '').replace(/\//g, path.sep);
        }
        return fileUrl;
    }
    // --- End AgentDream API ---
    return adminApiRouter;
};