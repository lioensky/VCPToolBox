// [SynchroVision] Window Scanner (v2.0 Full Scan)
// Captures ALL visible windows without keyword filtering
// Robust fallback: PowerShell -> tasklist -> WMIC

const { exec } = require('child_process');

const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |
Select-Object @{N='app';E={$_.ProcessName}}, @{N='title';E={$_.MainWindowTitle}}, @{N='id';E={$_.Id}}, @{N='memory_mb';E={[math]::Round($_.WorkingSet64/1MB,1)}} |
ConvertTo-Json -Compress
`;

const IGNORE_LIST = [
    'Default IME', 'MSCTFIME UI', 'OleMainThreadWndName',
    'GDI+ Window', 'DWM Notification Window',
    'Windows Push Notifications Platform', 'N/A', 'Unknown', '暂缺'
];

const APP_CATEGORIES = {
    browser: ['chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi', 'iexplore'],
    code: ['code', 'devenv', 'idea64', 'pycharm64', 'webstorm64', 'sublime_text', 'notepad++', 'atom'],
    terminal: ['windowsterminal', 'cmd', 'powershell', 'mintty', 'conhost', 'git-bash'],
    communication: ['discord', 'slack', 'teams', 'zoom', 'wechat', 'telegram', 'qq', 'dingtalk', 'feishu'],
    productivity: ['excel', 'winword', 'powerpnt', 'onenote', 'notion', 'obsidian', 'evernote', 'typora'],
    media: ['spotify', 'music', 'vlc', 'potplayer', 'mpv', 'netflix', 'bilibili'],
    ai: ['chatgpt', 'openai', 'grok', 'claude', 'gemini', 'deepseek', 'copilot'],
    game: ['steam', 'epicgames', 'origin', 'uplay']
};

function categorizeApp(appName) {
    const lower = appName.toLowerCase();
    for (const [category, apps] of Object.entries(APP_CATEGORIES)) {
        if (apps.some(app => lower.includes(app))) return category;
    }
    return 'other';
}

function filterAndEnrichWindows(list) {
    const results = [];
    const seen = new Set();
    for (const w of list) {
        const title = w.title || w.MainWindowTitle || '';
        const app = w.app || w.ProcessName || 'Unknown';
        if (!title || title.length < 2) continue;
        if (IGNORE_LIST.some(ig => title === ig || title.includes(ig))) continue;
        const key = `${app}:${title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
            app: app,
            title: title.substring(0, 200),
            category: categorizeApp(app),
            id: w.id || w.Id || 0,
            memory_mb: w.memory_mb || 0
        });
    }
    return results;
}

function scanWindowsTasklist() {
    return new Promise((resolve) => {
        exec('chcp 65001 >nul && tasklist /v /fo csv /nh', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err || !stdout) { resolve([]); return; }
            try {
                const windows = [];
                stdout.split('\n').forEach(line => {
                    const parts = line.split('","');
                    if (parts.length >= 9) {
                        const processName = parts[0].replace(/"/g, '');
                        const pid = parseInt(parts[1]) || 0;
                        const memUsage = parts[4].replace(/[^0-9]/g, '');
                        let windowTitle = parts[8].replace(/"/g, '').trim();
                        if (windowTitle && windowTitle !== 'N/A') {
                            windows.push({ app: processName, title: windowTitle, id: pid, memory_mb: parseInt(memUsage) / 1024 || 0 });
                        }
                    }
                });
                resolve(windows);
            } catch (e) { resolve([]); }
        });
    });
}

function scanWindowsWMIC() {
    return new Promise((resolve) => {
        exec('wmic process get processid,name /format:csv', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err || !stdout) { resolve([]); return; }
            try {
                const processes = [];
                stdout.split('\n').forEach(line => {
                    const parts = line.split(',');
                    if (parts.length >= 3) {
                        const name = parts[1]?.trim();
                        const pid = parseInt(parts[2]) || 0;
                        if (name && name !== 'Name') {
                            processes.push({ app: name, title: name, id: pid, memory_mb: 0 });
                        }
                    }
                });
                resolve(processes);
            } catch (e) { resolve([]); }
        });
    });
}

function scanWindows() {
    return new Promise((resolve) => {
        const psCommand = `powershell -NoProfile -NonInteractive -Command "${PS_SCRIPT.replace(/"/g, '\\"')}"`;
        exec(psCommand, { timeout: 5000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, async (err, stdout) => {
            let windows = [];
            let success = false;
            if (!err && stdout.trim()) {
                try {
                    const rawList = JSON.parse(stdout);
                    windows = Array.isArray(rawList) ? rawList : [rawList];
                    success = true;
                    console.log(`[Scanner] PowerShell found ${windows.length} windows`);
                } catch (e) { console.log('[Scanner] PS JSON parse error:', e.message); }
            } else { console.log('[Scanner] PowerShell failed:', err?.message || 'No output'); }
            if (!success || windows.length === 0) {
                console.log('[Scanner] Trying tasklist fallback...');
                windows = await scanWindowsTasklist();
            }
            if (windows.length === 0) {
                console.log('[Scanner] Trying WMIC fallback...');
                windows = await scanWindowsWMIC();
            }
            const finalResult = filterAndEnrichWindows(windows);
            console.log(`[Scanner] Final result: ${finalResult.length} windows`);
            resolve(finalResult);
        });
    });
}

async function getWindowsByCategory() {
    const windows = await scanWindows();
    const grouped = {};
    for (const w of windows) {
        if (!grouped[w.category]) grouped[w.category] = [];
        grouped[w.category].push(w);
    }
    return grouped;
}

async function getBrowserWindows() {
    const windows = await scanWindows();
    return windows.filter(w => w.category === 'browser');
}

async function getFocusSummary() {
    const windows = await scanWindows();
    const categories = {};
    for (const w of windows) {
        categories[w.category] = (categories[w.category] || 0) + 1;
    }
    let primaryFocus = 'idle';
    let maxCount = 0;
    for (const [cat, count] of Object.entries(categories)) {
        if (count > maxCount) { maxCount = count; primaryFocus = cat; }
    }
    return {
        window_count: windows.length,
        category_breakdown: categories,
        primary_focus: primaryFocus,
        active_windows: windows.slice(0, 10)
    };
}

module.exports = { scanWindows, getWindowsByCategory, getBrowserWindows, getFocusSummary };
