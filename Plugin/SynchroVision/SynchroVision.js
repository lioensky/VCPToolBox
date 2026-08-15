// Plugin/SynchroVision/SynchroVision.js
// 视界同调 (SynchroVision) - Full Browser Awareness System v2.1
// 集成文件日志系统 (Based on VCPEverything)

const pluginManager = require('../../Plugin.js');
const fs = require('fs');
const path = require('path');
const windowScanner = require('./window_scanner.js');
const biliEnricher = require('./bili_enricher.js');

let chromeMiner = null;
try {
    chromeMiner = require('./chrome_data_miner.js');
} catch (e) {
    console.warn('[SynchroVision] chrome_data_miner not available:', e.message);
}

let pluginConfig = {};
let debugMode = false;

const connectedClients = new Map();
let latestPageInfo = { url: '', title: '', content: '' };
let recentIntents = [];
let lastScreenshotPath = '';
let openTabs = { windows: [], total_tabs: 0 };

const ARCHIVE_BASE_PATH = path.join(__dirname, '../../file/document/AutoArchive');
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const LOG_DIR = path.join(__dirname, 'logs');

// ============ 日志系统 (新增) ============

if (!fs.existsSync(LOG_DIR)) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (e) {
        console.error(`[System ERROR] Failed to create log dir: ${e.message}`);
    }
}

function getLogFilePath() {
    const today = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `SynchroVision-${today}.log`);
}

function formatSearchTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function inferIntentEngine(intent = {}) {
    const source = String(intent.source || '').toLowerCase();
    const url = String(intent.url || '').toLowerCase();
    const combined = `${source} ${url}`;
    if (combined.includes('chatgpt') || combined.includes('openai')) return 'ChatGPT';
    if (combined.includes('grok') || combined.includes('x.ai') || combined.includes('/i/grok') || combined.includes('x.com')) return 'Grok';
    if (combined.includes('gemini.google.com') || combined.includes('gemini')) return 'Gemini';
    if (combined.includes('aistudio.google.com') || combined.includes('aistudio')) return 'Google AI Studio';
    if (combined.includes('claude.ai') || combined.includes('claude')) return 'Claude';
    if (combined.includes('google')) return 'Google';
    if (combined.includes('bing')) return 'Bing';
    if (combined.includes('baidu')) return 'Baidu';
    if (combined.includes('bilibili')) return 'Bilibili';
    if (combined.includes('youtube')) return 'YouTube';
    return 'AI';
}

function normalizeIntentSearch(intent = {}) {
    const rawKeyword = String(intent.keyword || '').trim();
    if (!rawKeyword) return null;

    const normalizedQuery = rawKeyword.replace(/^\[AI Prompt\]\s*/i, '').trim();
    if (!normalizedQuery) return null;

    const timestamp = Number(intent.timestamp || intent.captured_at || Date.now());
    return {
        source: intent.source || 'extension',
        engine: inferIntentEngine(intent),
        query: normalizedQuery,
        url: intent.url || '',
        time: formatSearchTimestamp(timestamp),
        timestamp,
        capture_method: intent.intent_type || 'intent_stream'
    };
}

function mergeSearchRecords(primary = [], secondary = [], limit = 20) {
    const merged = [...primary, ...secondary]
        .filter(item => item && item.query && item.timestamp)
        .sort((a, b) => b.timestamp - a.timestamp);

    const deduped = [];
    const seen = new Set();

    for (const item of merged) {
        const key = `${String(item.engine || 'unknown').toLowerCase()}::${String(item.query).toLowerCase()}::${String(item.url || '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
        if (deduped.length >= limit) break;
    }

    return deduped;
}

async function getUnifiedRecentSearches(options = {}) {
    const { limit = 20, daysBack = 7, browser = 'all' } = options;
    const minerSearches = chromeMiner
        ? await chromeMiner.getSearches({ limit: Math.max(limit * 3, 50), daysBack, browser })
        : [];
    const intentSearches = recentIntents
        .map(normalizeIntentSearch)
        .filter(Boolean);

    return mergeSearchRecords(intentSearches, minerSearches, limit);
}

/**
 * 统一日志记录函数
 * @param {string} level - info, warn, error, debug
 * @param {string} message - 日志消息
 * @param {object} data - 附加数据
 */
function log(level, message, data = null) {
    if (level === 'debug' && !debugMode) return;

    const timestamp = new Date().toISOString();
    const upperLevel = level.toUpperCase();

    let fileLogEntry = `[${timestamp}] [${upperLevel}] ${message}`;
    if (data) {
        try {
            const dataStr = JSON.stringify(data, null, 2);
            fileLogEntry += `\nDetails: ${dataStr}`;
        } catch (e) {
            fileLogEntry += `\nDetails: [Circular/Unserializable]`;
        }
    }
    fileLogEntry += '\n';

    try {
        fs.appendFileSync(getLogFilePath(), fileLogEntry, 'utf8');
    } catch (e) {
        console.error(`[Log Write Fail] ${e.message}`);
    }

    if (['warn', 'error'].includes(level) || debugMode) {
        const consoleObj = { timestamp, level, message };
        if (data && debugMode) consoleObj.data = data;
        // 注意：SynchroVision 作为 Hybrid Service，标准输出可能被主程序捕获或忽略，
        // 但为了兼容性，依然输出到 console
        if (level === 'error') console.error(JSON.stringify(consoleObj));
        else console.log(JSON.stringify(consoleObj));
    }
}

// ============ 初始化逻辑 ============

function initialize(config) {
    pluginConfig = config;
    debugMode = pluginConfig.DebugMode || false;

    log('info', 'Initializing SynchroVision v2.1 (Full Browser Awareness)', { debugMode });

    pluginManager.staticPlaceholderValues.set("{{CurrentVisualContext}}", "视界感知系统启动中...");

    if (!fs.existsSync(ARCHIVE_BASE_PATH)) fs.mkdirSync(ARCHIVE_BASE_PATH, { recursive: true });
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    log('info', 'SynchroVision Ready - Services Active');
}

// ============ 核心业务逻辑 ============

async function aggregateVisualContext() {
    const context = { timestamp: new Date().toLocaleString(), sources: [] };
    if (connectedClients.size > 0 && latestPageInfo.title) {
        context.sources.push({
            type: 'Realtime_Extension', status: 'Active',
            data: { ...latestPageInfo, screenshot: lastScreenshotPath ? '[Image Available] ' + lastScreenshotPath : 'None' }
        });
    } else {
        context.sources.push({ type: 'Realtime_Extension', status: 'Disconnected' });
    }
    if (openTabs.total_tabs > 0) {
        context.sources.push({ type: 'Open_Tabs', count: openTabs.total_tabs, windows: openTabs.windows });
    }
    try {
        const windows = await windowScanner.scanWindows();
        if (windows.length > 0) context.sources.push({ type: 'System_Windows', count: windows.length, items: windows });
    } catch (e) {
        log('warn', 'Window Scan Failed', { error: e.message });
    }
    return context;
}

function handleNewClient(ws) {
    const clientId = ws.clientId;
    connectedClients.set(clientId, ws);
    log('info', `Live Eye Connected: ${clientId}`);
    updatePlaceholder("实时连接已建立");
    ws.on('close', () => {
        connectedClients.delete(clientId);
        log('info', `Live Eye Disconnected: ${clientId}`);
    });
}

function handleClientMessage(clientId, message) {
    try {
        // 降低高频消息日志级别
        const isHighFreq = ['pageInfoUpdate', 'snapshot_update'].includes(message.type);
        if (!isHighFreq) {
            log('debug', `Client Message: ${message.type}`, { clientId });
        }

        switch (message.type) {
            case 'pageInfoUpdate':
                latestPageInfo = message.data;
                updatePlaceholder('正在浏览: ' + latestPageInfo.title);
                break;
            case 'report_intent': case 'intent_update':
                recentIntents.unshift({
                    ...message.data,
                    timestamp: Number(message.timestamp || Date.now()),
                    captured_at: Number(message.timestamp || Date.now()),
                    intent_type: message.data.intent_type || (message.type === 'report_intent' ? 'ai_prompt' : 'web_search')
                });
                if (recentIntents.length > 50) recentIntents.pop();
                log('info', 'User Intent Captured', recentIntents[0]);
                break;
            case 'archive_request': performArchive(message.data); break;
            case 'snapshot_update': handleSnapshot(message.data); break;
            case 'tabs_sync':
                openTabs = message.data;
                log('debug', `Synced ${openTabs.total_tabs} tabs`);
                break;
        }
    } catch (e) {
        log('error', 'Message Handling Error', { error: e.message, clientId });
    }
}

function handleSnapshot(data) {
    const base64Data = data.image.replace(/^data:image\/jpeg;base64,/, "");
    const filename = 'snap_' + Date.now() + '.jpg';
    const filepath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFile(filepath, base64Data, 'base64', (err) => {
        if (!err) {
            // 截图日志降级为 debug，避免刷屏
            log('debug', 'Screenshot Saved', { filename });
            lastScreenshotPath = filepath;
            cleanOldScreenshots();
        } else {
            log('error', 'Screenshot Save Failed', { error: err.message });
        }
    });
}

function cleanOldScreenshots() {
    fs.readdir(SCREENSHOT_DIR, (err, files) => {
        if (err) return;
        const snapFiles = files.filter(f => f.startsWith('snap_'));
        if (snapFiles.length > 10) {
            snapFiles.sort();
            for (let i = 0; i < snapFiles.length - 10; i++) {
                fs.unlink(path.join(SCREENSHOT_DIR, snapFiles[i]), () => {});
            }
        }
    });
}

function updatePlaceholder(statusText) {
    const tabCount = openTabs.total_tabs || 0;
    const summary = '[视界状态]: ' + statusText + '\n[当前焦点]: ' + (latestPageInfo.title || '无') + '\n[打开标签]: ' + tabCount + '\n[URL]: ' + (latestPageInfo.url || 'N/A');
    pluginManager.staticPlaceholderValues.set("{{CurrentVisualContext}}", summary);
}

function performArchive(data) {
    log('info', `Archiving Page: ${data.title}`);
    const today = new Date().toISOString().split('T')[0];
    const saveDir = path.join(ARCHIVE_BASE_PATH, today);
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    const safeTitle = (data.title || 'Untitled').replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
    const filename = safeTitle + '_' + Date.now() + '.md';
    fs.writeFile(path.join(saveDir, filename), '# ' + data.title + '\nURL: ' + data.url + '\n\n' + data.content, (err) => {
        if(err) log('error', 'Archive Write Failed', { error: err.message });
    });
}

// ============ 工具调用处理 ============

async function processToolCall(params) {
    const command = params.command;
    const reqId = Math.random().toString(36).substr(2, 6);

    log('info', `[${reqId}] Tool Call: ${command}`, params);

    try {
        let result;
        if (command === 'inspect_active_tab') {
            result = { status: "success", data: await aggregateVisualContext() };
        }
        else if (command === 'check_user_intent') {
            result = await performDeepScan();
        }
        else if (['get_browser_history', 'get_bookmarks', 'get_downloads', 'get_recent_searches', 'get_extensions'].includes(command)) {
            if (!chromeMiner) {
                if (command !== 'get_recent_searches') {
                    log('warn', `[${reqId}] chrome_data_miner Missing`);
                    return { error: "chrome_data_miner not available" };
                }
            }

            // 通用 Miner 调用逻辑
            let data = [];
            if (command === 'get_browser_history') {
                data = await chromeMiner.getHistory({ limit: params.limit || 50, daysBack: params.days_back || 7, browser: params.browser || 'all' });
            } else if (command === 'get_bookmarks') {
                data = await chromeMiner.getBookmarks({ browser: params.browser || 'all', search: params.search || '' });
            } else if (command === 'get_downloads') {
                data = await chromeMiner.getDownloads({ limit: params.limit || 30, daysBack: params.days_back || 30, browser: params.browser || 'all' });
            } else if (command === 'get_recent_searches') {
                data = await getUnifiedRecentSearches({ limit: params.limit || 20, daysBack: params.days_back || 7, browser: params.browser || 'all' });
            } else if (command === 'get_extensions') {
                data = await chromeMiner.getExtensions({ browser: params.browser || 'all' });
            }

            result = { status: "success", count: data.length, data: data };
        }
        else if (command === 'get_open_tabs') {
            if (openTabs.total_tabs > 0) result = { status: "success", ...openTabs };
            else result = { status: "warning", message: "Extension not connected", data: [] };
        }
        else if (command === 'get_full_overview') {
            result = await getFullBrowserOverview();
        }
        else if (command === 'get_focus_summary') {
            result = { status: "success", data: await windowScanner.getFocusSummary() };
        }
        else if (command === 'get_all_windows') {
            const windows = await windowScanner.scanWindows();
            result = { status: "success", count: windows.length, data: windows };
        }
        else {
            log('warn', `[${reqId}] Unknown Command: ${command}`);
            return { error: "Unknown command: " + command };
        }

        log('info', `[${reqId}] Tool Call Completed`, { status: result.status, count: result.count });
        return result;

    } catch (e) {
        log('error', `[${reqId}] Tool Call Failed`, { error: e.message, stack: e.stack });
        return { error: `Internal Error: ${e.message}` };
    }
}

async function performDeepScan() {
    log('info', 'Starting Deep Scan v2.1');
    let windows = [], browserHistory = [], bilibiliApiHistory = [], searches = [];
    try {
        const promises = [
            windowScanner.scanWindows().catch(e => { log('warn', 'ScanWindows Failed', {e: e.message}); return []; }),
            biliEnricher.fetchBilibiliHistory().catch(e => { log('warn', 'FetchBili Failed', {e: e.message}); return []; })
        ];
        if (chromeMiner) {
            promises.push(chromeMiner.getHistory({ limit: 30, daysBack: 3 }).catch(e => { log('warn', 'MinerHistory Failed', {e: e.message}); return []; }));
            promises.push(chromeMiner.getSearches({ limit: 15, daysBack: 3 }).catch(e => { log('warn', 'MinerSearch Failed', {e: e.message}); return []; }));
        } else {
            promises.push(Promise.resolve([]));
            promises.push(Promise.resolve([]));
        }
        [windows, bilibiliApiHistory, browserHistory, searches] = await Promise.all(promises);
    } catch (e) {
        log('error', 'Deep Scan Fatal Error', { error: e.message });
    }

    // 安全处理
    bilibiliApiHistory = Array.isArray(bilibiliApiHistory) ? bilibiliApiHistory : [];
    windows = Array.isArray(windows) ? windows : [];
    browserHistory = Array.isArray(browserHistory) ? browserHistory : [];
    searches = Array.isArray(searches) ? searches : [];

    const enrichedHistory = await biliEnricher.enrichHistory(browserHistory);
    const unifiedSearches = await getUnifiedRecentSearches({ limit: 20, daysBack: 3, browser: 'all' });
    log('info', 'Deep Scan Completed', { win: windows.length, bili: bilibiliApiHistory.length, hist: browserHistory.length });

    return {
        status: "success",
        report: {
            message: "Full Browser Awareness Report (v2.1)",
            realtime_focus: latestPageInfo.title ? latestPageInfo : "Extension Offline",
            latest_screenshot: lastScreenshotPath || "None",
            open_tabs: openTabs,
            active_windows: windows,
            browser_history: enrichedHistory,
            bilibili_api_history: bilibiliApiHistory,
            recent_searches: unifiedSearches,
            search_intents: recentIntents.slice(0, 20)
        }
    };
}

async function getFullBrowserOverview() {
    log('info', 'Starting Full Overview');
    const report = {
        generated_at: new Date().toLocaleString(),
        realtime: { current_page: latestPageInfo.title ? latestPageInfo : null, screenshot: lastScreenshotPath || null, extension_connected: connectedClients.size > 0 },
        open_tabs: openTabs
    };
    try { report.focus_summary = await windowScanner.getFocusSummary(); } catch (e) { report.focus_summary = { error: e.message }; }

    if (chromeMiner) {
        try {
            const [history, bookmarks, downloads, extensions] = await Promise.all([
                chromeMiner.getHistory({ limit: 30, daysBack: 3 }).catch(() => []),
                chromeMiner.getBookmarks({ limit: 30 }).catch(() => []),
                chromeMiner.getDownloads({ limit: 15 }).catch(() => []),
                chromeMiner.getExtensions().catch(() => [])
            ]);
            const searches = await getUnifiedRecentSearches({ limit: 20, daysBack: 7, browser: 'all' });
            report.browser_data = { recent_history: history, recent_bookmarks: bookmarks, recent_downloads: downloads, recent_searches: searches, installed_extensions: extensions };
        } catch (e) {
            log('error', 'FullOverview Miner Error', { error: e.message });
            report.browser_data = { error: e.message };
        }
    } else {
        report.browser_data = { recent_searches: await getUnifiedRecentSearches({ limit: 20, daysBack: 7, browser: 'all' }) };
    }
    try { report.bilibili_history = await biliEnricher.fetchBilibiliHistory(); } catch (e) { report.bilibili_history = []; }
    report.ai_intents = recentIntents.slice(0, 20);

    log('info', 'Full Overview Completed');
    return { status: "success", overview: report };
}

module.exports = { initialize, handleNewClient, handleClientMessage, processToolCall, normalizeIntentSearch, mergeSearchRecords };
