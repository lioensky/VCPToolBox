const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const util = require('util');
const execAsync = util.promisify(exec);
const pm2 = require('pm2');
const { getAuthCode } = require('../../modules/captchaDecoder');

function buildCurrentProcessSnapshot() {
    return {
        name: 'vcptoolbox',
        pid: process.pid,
        status: 'online',
        cpu: 0,
        memory: process.memoryUsage().rss,
        uptime: process.uptime(),
        restarts: 0,
        source: 'process'
    };
}

function buildCurrentProcessResponse(extra = {}) {
    return {
        success: true,
        source: 'process',
        processes: [buildCurrentProcessSnapshot()],
        ...extra
    };
}

function normalizePm2Process(proc) {
    return {
        name: proc.name,
        pid: proc.pid,
        status: proc.pm2_env?.status || 'unknown',
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory || 0,
        uptime: proc.pm2_env?.pm_uptime || 0,
        restarts: proc.pm2_env?.restart_time || 0,
        source: 'pm2'
    };
}

module.exports = function(options) {
    const router = express.Router();
    // const { DEBUG_MODE } = options; // Currently unused in this module but available

    // 获取当前 VCP 进程快照；用于非 PM2 启动方式下的只读监控
    router.get('/system-monitor/processes', (req, res) => {
        res.json(buildCurrentProcessResponse());
    });

    // 获取PM2进程列表和资源使用情况
    router.get('/system-monitor/pm2/processes', (req, res) => {
        pm2.list((err, list) => {
            if (err) {
                console.warn('[SystemMonitor] PM2 API unavailable, returning current process snapshot:', err.message);
                return res.json(buildCurrentProcessResponse({
                    degraded: true,
                    warning: 'PM2 process list unavailable; returned current VCP process snapshot.'
                }));
            }

            if (!Array.isArray(list) || list.length === 0) {
                return res.json(buildCurrentProcessResponse({
                    degraded: true,
                    warning: 'No PM2 processes found; returned current VCP process snapshot.'
                }));
            }

            const processInfo = list.map(normalizePm2Process);

            res.json({ success: true, source: 'pm2', processes: processInfo });
        });
    });

    // 获取系统整体资源使用情况
    router.get('/system-monitor/system/resources', async (req, res) => {
        try {
            const systemInfo = {};
            const execOptions = { windowsHide: true };

            if (process.platform === 'win32') {
                try {
                    const { stdout: memInfo } = await execAsync('powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json"', execOptions);
                    const memData = JSON.parse(memInfo);
                    systemInfo.memory = {
                        total: (memData.TotalVisibleMemorySize || 0) * 1024,
                        free: (memData.FreePhysicalMemory || 0) * 1024,
                        used: ((memData.TotalVisibleMemorySize || 0) - (memData.FreePhysicalMemory || 0)) * 1024
                    };
                } catch (powershellError) {
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
                    const { stdout: cpuInfo } = await execAsync('wmic cpu get loadpercentage /value', execOptions);
                    const cpuMatch = cpuInfo.match(/LoadPercentage=(\d+)/);
                    systemInfo.cpu = { usage: cpuMatch ? parseInt(cpuMatch[1]) : 0 };
                }
            } else if (process.platform === 'darwin') {
                const totalMemory = os.totalmem();
                const freeMemory = os.freemem();
                systemInfo.memory = {
                    total: totalMemory,
                    free: freeMemory,
                    used: totalMemory - freeMemory
                };
                try {
                    const { stdout: cpuInfo } = await execAsync("top -l 1 | grep 'CPU usage' | awk '{print $3}' | sed 's/%//'", execOptions);
                    systemInfo.cpu = { usage: parseFloat(cpuInfo.trim()) || 0 };
                } catch (cpuErr) {
                    systemInfo.cpu = { usage: 0 };
                }
            } else {
                try {
                    const { stdout: memInfo } = await execAsync('free -b', execOptions);
                    const memLine = memInfo.split('\n')[1].split(/\s+/);
                    systemInfo.memory = { total: parseInt(memLine[1]), used: parseInt(memLine[2]), free: parseInt(memLine[3]) };
                } catch (memErr) {
                    const totalMemory = os.totalmem();
                    const freeMemory = os.freemem();
                    systemInfo.memory = {
                        total: totalMemory,
                        free: freeMemory,
                        used: totalMemory - freeMemory
                    };
                }
                try {
                    const { stdout: cpuInfo } = await execAsync("top -bn1 | grep -E '^\\s*(%?Cpu\\(s\\)?:|CPU:)' | head -1 | awk '{print $2}'", execOptions);
                    systemInfo.cpu = { usage: parseFloat(cpuInfo.trim().replace('%', '')) || 0 };
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

    // 获取 UserAuth 认证码
    router.get('/user-auth-code', async (req, res) => {
        const authCodePath = path.join(__dirname, '..', '..', 'Plugin', 'UserAuth', 'code.bin');
        try {
            const decryptedCode = await getAuthCode(authCodePath);
            if (decryptedCode) {
                res.json({ success: true, code: decryptedCode });
            } else {
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

    // 获取天气预报数据
    router.get('/weather', async (req, res) => {
        const weatherCachePath = path.join(__dirname, '..', '..', 'Plugin', 'WeatherReporter', 'weather_cache.json');
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

    // 获取每日热榜数据
    router.get('/dailyhot', async (req, res) => {
        const dailyHotPath = path.join(__dirname, '..', '..', 'Plugin', 'DailyHot', 'dailyhot_cache.md');
        try {
            const content = await fs.readFile(dailyHotPath, 'utf-8');
            const lines = content.split('\n');
            const newsItems = [];
            let currentSource = '';

            for (const line of lines) {
                const sourceMatch = line.match(/^##\s+(.+)$/);
                if (sourceMatch) {
                    currentSource = sourceMatch[1].trim();
                    continue;
                }

                const itemMatch = line.match(/^\d+\.\s+\[(.+?)\]\((.+?)\)/);
                if (itemMatch) {
                    newsItems.push({
                        source: currentSource,
                        title: itemMatch[1],
                        url: itemMatch[2]
                    });
                }
            }

            res.json({ success: true, data: newsItems });
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ success: false, error: '热榜缓存文件未找到。' });
            } else {
                res.status(500).json({ success: false, error: '读取热榜缓存失败。', details: error.message });
            }
        }
    });

    return router;
};
