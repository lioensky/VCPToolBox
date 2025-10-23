
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
const AGENT_FILES_DIR = path.join(__dirname, '..', 'Agent'); // 定义 Agent 文件目录

module.exports = function(DEBUG_MODE, dailyNoteRootPath, pluginManager, getCurrentServerLogPath, vectorDBManager) {
    const adminApiRouter = express.Router();

    // --- Admin API Router 内容 ---
    
    // --- System Monitor Routes (Merged) ---
    const { exec } = require('child_process');
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

            // 添加明显的标记，便于在 PM2 日志中快速定位
            console.log('=== [SystemMonitor] 开始获取系统资源 ===');
            console.log(`[SystemMonitor] 平台: ${process.platform}, 时间: ${new Date().toISOString()}`);
            if (process.platform === 'win32') {
                // 获取内存信息
                try {
                    console.log('[SystemMonitor] 尝试使用 PowerShell 获取内存信息...');
                    const { stdout: memInfo } = await execAsync('powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json"', execOptions);
                    console.log('[SystemMonitor] PowerShell 内存命令执行成功，输出长度:', memInfo.length);
                    console.log('[SystemMonitor] PowerShell 内存输出原始内容:', memInfo.substring(0, 200));
                    // 尝试清理和解析 JSON 输出
                    let cleanedMemInfo = memInfo.trim();
                    // 移除可能的 PowerShell 输出前缀/后缀和其他非 JSON 内容
                    // 处理多种可能的 PowerShell 输出格式问题
                    if (cleanedMemInfo.startsWith('PowerShell')) {
                        // 尝试提取 JSON 部分 - 使用更宽松的正则表达式匹配多行 JSON
                        const jsonMatch = cleanedMemInfo.match(/({[\s\S]*?})/);
                        if (jsonMatch) {
                            cleanedMemInfo = jsonMatch[1];
                        } else {
                            // 如果没有找到 JSON，尝试其他方法
                            console.log('[SystemMonitor] PowerShell 输出格式异常，尝试分割方法');
                            const lines = cleanedMemInfo.split('\n');
                            // 查找包含 { 的行和包含 } 的行之间的所有内容
                            let startIndex = -1;
                            let endIndex = -1;
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].trim().startsWith('{')) {
                                    startIndex = i;
                                }
                                if (lines[i].trim().endsWith('}') && startIndex !== -1) {
                                    endIndex = i;
                                    break;
                                }
                            }
                            if (startIndex !== -1 && endIndex !== -1) {
                                cleanedMemInfo = lines.slice(startIndex, endIndex + 1).join('');
                            } else {
                                throw new Error('PowerShell 输出中未找到有效的 JSON 数据');
                            }
                        }
                    }
                    const memData = JSON.parse(cleanedMemInfo);
                    systemInfo.memory = {
                        total: (memData.TotalVisibleMemorySize || 0) * 1024,
                        free: (memData.FreePhysicalMemory || 0) * 1024,
                        used: ((memData.TotalVisibleMemorySize || 0) - (memData.FreePhysicalMemory || 0)) * 1024
                    };
                } catch (powershellError) {
                    // 尝试使用更简单的 PowerShell 命令作为替代方案
                    try {
                        const { stdout: altMemInfo } = await execAsync('powershell -Command "(Get-WmiObject -Class Win32_OperatingSystem).TotalVisibleMemorySize; (Get-WmiObject -Class Win32_OperatingSystem).FreePhysicalMemory"', execOptions);
                        console.log('[SystemMonitor] 替代 PowerShell 内存命令执行成功');
                        const memLines = altMemInfo.trim().split('\n');
                        const totalMem = parseInt(memLines[0]) * 1024;
                        const freeMem = parseInt(memLines[1]) * 1024;
                        systemInfo.memory = {
                            total: totalMem || 0,
                            free: freeMem || 0,
                            used: (totalMem || 0) - (freeMem || 0)
                        };
                    } catch (altPowershellError) {
    
                        // 使用 Windows 11 兼容的最终替代方案
                        try {
                            // 使用 typeperf 命令作为最终替代方案
                            const { stdout: typeperfMem } = await execAsync('typeperf "\\Memory\\Available MBytes" "\\Memory\\Committed Bytes" -sc 1', execOptions);
                            console.log('[SystemMonitor] typeperf 内存命令执行成功');
                            const lines = typeperfMem.split('\n');
                            if (lines.length > 2) {
                                const values = lines[2].split(',');
                                const availableMB = parseFloat(values[1].replace(/"/g, ''));
                                const committedBytes = parseFloat(values[2].replace(/"/g, ''));
                                // 估算总内存 (可用 + 已使用)
                                const totalMemory = availableMB * 1024 * 1024 + committedBytes;
                                systemInfo.memory = {
                                    total: totalMemory,
                                    free: availableMB * 1024 * 1024,
                                    used: committedBytes
                                };
                            } else {
                                throw new Error('typeperf 输出格式不正确');
                            }
                        } catch (typeperfError) {
                            console.error('!!! [SystemMonitor] typeperf 内存命令失败 !!!');
                            console.error('!!! [SystemMonitor] 错误详情:', typeperfError.message);
                            console.error('!!! [SystemMonitor] 错误堆栈:', typeperfError.stack);
                            console.log('[SystemMonitor] 回退到 WMIC 命令获取内存信息...');
                            // 最后的回退到 wmic 命令
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
                    }
                }

                // 获取CPU信息
                try {
                    console.log('[SystemMonitor] 尝试使用 PowerShell 获取 CPU 信息...');
                    const { stdout: cpuInfo } = await execAsync('powershell -Command "Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object Average | ConvertTo-Json"', execOptions);
                    console.log('[SystemMonitor] PowerShell CPU 命令执行成功，输出长度:', cpuInfo.length);
                    console.log('[SystemMonitor] PowerShell CPU 输出原始内容:', cpuInfo.substring(0, 200));
                    // 尝试清理和解析 JSON 输出
                    let cleanedCpuInfo = cpuInfo.trim();
                    // 移除可能的 PowerShell 输出前缀/后缀和其他非 JSON 内容
                    // 处理多种可能的 PowerShell 输出格式问题
                    if (cleanedCpuInfo.startsWith('PowerShell')) {
                        // 尝试提取 JSON 部分 - 使用更宽松的正则表达式匹配多行 JSON
                        const jsonMatch = cleanedCpuInfo.match(/({[\s\S]*?})/);
                        if (jsonMatch) {
                            cleanedCpuInfo = jsonMatch[1];
                        } else {
                            // 如果没有找到 JSON，尝试其他方法
                            console.log('[SystemMonitor] PowerShell CPU 输出格式异常，尝试分割方法');
                            const lines = cleanedCpuInfo.split('\n');
                            // 查找包含 { 的行和包含 } 的行之间的所有内容
                            let startIndex = -1;
                            let endIndex = -1;
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].trim().startsWith('{')) {
                                    startIndex = i;
                                }
                                if (lines[i].trim().endsWith('}') && startIndex !== -1) {
                                    endIndex = i;
                                    break;
                                }
                            }
                            if (startIndex !== -1 && endIndex !== -1) {
                                cleanedCpuInfo = lines.slice(startIndex, endIndex + 1).join('');
                            } else {
                                throw new Error('PowerShell CPU 输出中未找到有效的 JSON 数据');
                            }
                        }
                    }
                    
                    console.log('[SystemMonitor] 清理后的 CPU JSON:', cleanedCpuInfo.substring(0, 200));
                    const cpuData = JSON.parse(cleanedCpuInfo);
                    systemInfo.cpu = { usage: Math.round(cpuData.Average || 0) };
                } catch (powershellError) {
                    console.error('!!! [SystemMonitor] PowerShell CPU 命令失败 !!!');
                    console.error('!!! [SystemMonitor] 错误详情:', powershellError.message);
                    console.error('!!! [SystemMonitor] 错误堆栈:', powershellError.stack);
                    console.log('[SystemMonitor] 尝试使用替代 PowerShell 命令获取 CPU 信息...');
                    // 尝试使用更简单的 PowerShell 命令作为替代方案
                    try {
                        const { stdout: altCpuInfo } = await execAsync('powershell -Command "Get-WmiObject -Class Win32_Processor | Select-Object -ExpandProperty LoadPercentage"', execOptions);
                        console.log('[SystemMonitor] 替代 PowerShell CPU 命令执行成功');
                        const cpuUsage = parseInt(altCpuInfo.trim()) || 0;
                        systemInfo.cpu = { usage: cpuUsage };
                    } catch (altPowershellError) {
                        console.error('!!! [SystemMonitor] 替代 PowerShell CPU 命令也失败 !!!');
                        console.error('!!! [SystemMonitor] 错误详情:', altPowershellError.message);
                        console.error('!!! [SystemMonitor] 错误堆栈:', altPowershellError.stack);
                        console.log('[SystemMonitor] 使用 Windows 11 兼容的最终替代方案获取 CPU 信息...');
                        // 使用 Windows 11 兼容的最终替代方案
                        try {
                            // 使用 typeperf 命令作为最终替代方案
                            const { stdout: typeperfCpu } = await execAsync('typeperf "\\Processor(_Total)\\% Processor Time" -sc 1', execOptions);
                            console.log('[SystemMonitor] typeperf CPU 命令执行成功');
                            const lines = typeperfCpu.split('\n');
                            if (lines.length > 2) {
                                const cpuValue = parseFloat(lines[2].split(',')[1].replace(/"/g, ''));
                                systemInfo.cpu = { usage: Math.round(cpuValue) };
                            } else {
                                throw new Error('typeperf 输出格式不正确');
                            }
                        } catch (typeperfError) {
                            console.error('!!! [SystemMonitor] typeperf CPU 命令失败 !!!');
                            console.error('!!! [SystemMonitor] 错误详情:', typeperfError.message);
                            console.error('!!! [SystemMonitor] 错误堆栈:', typeperfError.stack);
                            console.log('[SystemMonitor] 回退到 WMIC 命令获取 CPU 信息...');
                            // 最后的回退到 wmic 命令
                            const { stdout: cpuInfo } = await execAsync('wmic cpu get loadpercentage /value', execOptions);
                            const cpuMatch = cpuInfo.match(/LoadPercentage=(\d+)/);
                            systemInfo.cpu = { usage: cpuMatch ? parseInt(cpuMatch[1]) : 0 };
                        }
                    }
                }
            } else { // Linux/Unix
                const { stdout: memInfo } = await execAsync('free -b', execOptions);
                const memLine = memInfo.split('\n')[1].split(/\s+/);
                systemInfo.memory = { total: parseInt(memLine[1]), used: parseInt(memLine[2]), free: parseInt(memLine[3]) };
                const { stdout: cpuInfo } = await execAsync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", execOptions);
                systemInfo.cpu = { usage: parseFloat(cpuInfo.trim()) || 0 };
            }
            
            systemInfo.nodeProcess = {
                pid: process.pid,
                memory: process.memoryUsage(),
                uptime: process.uptime(),
                version: process.version,
                platform: process.platform,
                arch: process.arch
            };
            
            console.log('[SystemMonitor] 系统资源获取成功，准备返回结果');
            res.json({ success: true, system: systemInfo });
        } catch (error) {
            console.error('!!! [SystemMonitor] 获取系统资源时发生严重错误 !!!');
            console.error('!!! [SystemMonitor] 错误详情:', error.message);
            console.error('!!! [SystemMonitor] 错误堆栈:', error.stack);
            console.error('!!! [SystemMonitor] 这将导致系统监控功能完全不可用 !!!');
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
    // --- End System Monitor Routes ---
 
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
    
    return adminApiRouter;
};    try {
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
    
    return adminApiRouter;
};