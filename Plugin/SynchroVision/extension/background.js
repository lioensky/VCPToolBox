// background.js for VCP SynchroVision Eye v2.0
// Full Browser Awareness - tabs, history, bookmarks, downloads, sessions

let ws = null;
let isConnected = false;
let currentActiveTabId = null;
let dwellTimer = null;
const DWELL_THRESHOLD = 3 * 60 * 1000;
const WS_URL = 'ws://localhost:6005/vcp-chrome-observer/VCP_Key=00000000';

let lastSnapshotUrl = '';
let snapshotTimer = null;

function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('[SynchroVision] Connected to VCP.');
        isConnected = true;
        broadcastStatus(true);
        if (currentActiveTabId) requestPageInfo(currentActiveTabId);
        sendAllOpenTabs();
    };

    ws.onclose = () => {
        console.log('[SynchroVision] Disconnected.');
        isConnected = false;
        ws = null;
        broadcastStatus(false);
        setTimeout(connect, 5000);
    };

    ws.onerror = (err) => {
        console.error('[SynchroVision] WebSocket error:', err);
        ws = null;
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleServerRequest(msg);
        } catch (e) {
            console.error('[SynchroVision] Failed to parse server message:', e);
        }
    };
}

function broadcastStatus(status) {
    chrome.action.setBadgeText({ text: status ? 'ON' : 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: status ? '#00C853' : '#FF5252' });
}

function sendMessage(type, data) {
    if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, data, timestamp: Date.now() }));
    }
}

async function handleServerRequest(msg) {
    const { request_id, command } = msg;
    let response = { request_id, success: false, error: 'Unknown command' };
    try {
        switch (command) {
            case 'get_all_tabs':
                response = { request_id, success: true, data: await getAllTabs() };
                break;
            case 'get_browser_history':
                response = { request_id, success: true, data: await getBrowserHistory(msg.params || {}) };
                break;
            case 'get_bookmarks':
                response = { request_id, success: true, data: await getBookmarks() };
                break;
            case 'get_downloads':
                response = { request_id, success: true, data: await getDownloads(msg.params || {}) };
                break;
            case 'get_recent_closed':
                response = { request_id, success: true, data: await getRecentlyClosed() };
                break;
            case 'get_top_sites':
                response = { request_id, success: true, data: await getTopSites() };
                break;
            case 'take_screenshot':
                response = { request_id, success: true, data: await takeScreenshot() };
                break;
        }
    } catch (e) {
        response = { request_id, success: false, error: e.message };
    }
    sendMessage('command_response', response);
}

async function getAllTabs() {
    const windows = await chrome.windows.getAll({ populate: true });
    const result = [];
    for (const win of windows) {
        const windowTabs = win.tabs.map(tab => ({
            id: tab.id, windowId: win.id, url: tab.url, title: tab.title,
            active: tab.active, pinned: tab.pinned, audible: tab.audible,
            muted: tab.mutedInfo?.muted || false, discarded: tab.discarded,
            favIconUrl: tab.favIconUrl, index: tab.index
        }));
        result.push({ windowId: win.id, focused: win.focused, type: win.type, tabs: windowTabs });
    }
    return result;
}

async function getBrowserHistory(params = {}) {
    const { text = '', maxResults = 100, startTime = Date.now() - 7 * 24 * 60 * 60 * 1000 } = params;
    const items = await chrome.history.search({ text, startTime, maxResults });
    return items.map(item => ({
        url: item.url, title: item.title, visitCount: item.visitCount,
        typedCount: item.typedCount,
        lastVisitTime: item.lastVisitTime ? new Date(item.lastVisitTime).toLocaleString() : 'Unknown'
    }));
}

async function getBookmarks() {
    const tree = await chrome.bookmarks.getTree();
    const bookmarks = [];
    function traverse(nodes, folder = '') {
        for (const node of nodes) {
            if (node.url) {
                bookmarks.push({
                    id: node.id, title: node.title, url: node.url, folder: folder,
                    dateAdded: node.dateAdded ? new Date(node.dateAdded).toLocaleString() : 'Unknown'
                });
            }
            if (node.children) {
                const folderPath = folder ? folder + '/' + node.title : node.title;
                traverse(node.children, folderPath);
            }
        }
    }
    traverse(tree);
    return bookmarks;
}

async function getDownloads(params = {}) {
    const { limit = 50, query = '' } = params;
    const items = await chrome.downloads.search({ query: query ? [query] : [], limit, orderBy: ['-startTime'] });
    return items.map(item => ({
        id: item.id, filename: item.filename, url: item.url, finalUrl: item.finalUrl,
        state: item.state, paused: item.paused, totalBytes: item.totalBytes,
        receivedBytes: item.receivedBytes,
        startTime: item.startTime ? new Date(item.startTime).toLocaleString() : 'Unknown',
        endTime: item.endTime ? new Date(item.endTime).toLocaleString() : 'N/A',
        mime: item.mime, danger: item.danger
    }));
}

async function getRecentlyClosed() {
    const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    return sessions.map(session => {
        if (session.tab) {
            return { type: 'tab', title: session.tab.title, url: session.tab.url,
                lastModified: session.lastModified ? new Date(session.lastModified * 1000).toLocaleString() : 'Unknown' };
        } else if (session.window) {
            return { type: 'window', tabCount: session.window.tabs.length,
                tabs: session.window.tabs.map(t => ({ title: t.title, url: t.url })),
                lastModified: session.lastModified ? new Date(session.lastModified * 1000).toLocaleString() : 'Unknown' };
        }
        return null;
    }).filter(Boolean);
}

async function getTopSites() {
    const sites = await chrome.topSites.get();
    return sites.map(site => ({ title: site.title, url: site.url }));
}

async function takeScreenshot() {
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 });
        return { success: true, image: dataUrl };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function sendAllOpenTabs() {
    try {
        const tabs = await getAllTabs();
        sendMessage('tabs_sync', { windows: tabs, total_tabs: tabs.reduce((sum, w) => sum + w.tabs.length, 0) });
    } catch (e) {
        console.error('[SynchroVision] Failed to sync tabs:', e);
    }
}

function captureActiveTab(tabId, url) {
    if (!url || url.startsWith('chrome://') || url === lastSnapshotUrl) return;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
        chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) return;
            lastSnapshotUrl = url;
            sendMessage('snapshot_update', { url, image: dataUrl });
        });
    }, 2000);
}

function checkIntent(url) {
    if (!url) return;
    try {
        const u = new URL(url);
        let keyword = null;
        const patterns = [
            { host: 'google.com', param: 'q' }, { host: 'baidu.com', param: 'wd' },
            { host: 'bing.com', param: 'q' }, { host: 'bilibili.com', param: 'keyword', path: '/search' },
            { host: 'youtube.com', param: 'search_query' }, { host: 'github.com', param: 'q', path: '/search' },
            { host: 'zhihu.com', param: 'q', path: '/search' }, { host: 'duckduckgo.com', param: 'q' },
            { host: 'chatgpt.com', param: 'q' }, { host: 'chat.openai.com', param: 'q' },
            { host: 'grok.com', param: 'q' }, { host: 'x.ai', param: 'q' },
            { host: 'x.com', param: 'q', path: '/i/grok' }
        ];
        for (const p of patterns) {
            if (u.hostname.includes(p.host)) {
                if (p.path && !u.pathname.includes(p.path)) continue;
                if (u.searchParams.has(p.param)) { keyword = u.searchParams.get(p.param); break; }
            }
        }
        if (keyword) {
            sendMessage('intent_update', {
                keyword,
                url,
                source: u.hostname,
                intent_type: 'web_search'
            });
        }
    } catch (e) {}
}

function resetDwellTimer(tabId, url) {
    if (dwellTimer) clearTimeout(dwellTimer);
    if (!url || url.startsWith('chrome://') || url.includes('localhost')) return;
    dwellTimer = setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: 'CHECK_ARCHIVE_WORTHINESS' }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response && response.worthy) {
                sendMessage('archive_request', { url: response.url, title: response.title, content: response.content, reason: 'Dwell Time > 3min' });
            }
        });
    }, DWELL_THRESHOLD);
}

function requestPageInfo(tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response) sendMessage('pageInfoUpdate', response);
    });
}

chrome.tabs.onActivated.addListener((activeInfo) => {
    currentActiveTabId = activeInfo.tabId;
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        checkIntent(tab.url);
        resetDwellTimer(activeInfo.tabId, tab.url);
        requestPageInfo(activeInfo.tabId);
        captureActiveTab(activeInfo.tabId, tab.url);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId === currentActiveTabId && changeInfo.status === 'complete') {
        checkIntent(tab.url);
        resetDwellTimer(tabId, tab.url);
        requestPageInfo(tabId);
        captureActiveTab(tabId, tab.url);
    }
    if (changeInfo.status === 'complete' || changeInfo.title) sendAllOpenTabs();
});

chrome.tabs.onCreated.addListener(() => sendAllOpenTabs());
chrome.tabs.onRemoved.addListener(() => sendAllOpenTabs());
chrome.windows.onCreated.addListener(() => sendAllOpenTabs());
chrome.windows.onRemoved.addListener(() => sendAllOpenTabs());

chrome.downloads.onCreated.addListener((item) => {
    sendMessage('download_started', { id: item.id, filename: item.filename, url: item.url, totalBytes: item.totalBytes });
});
chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state && delta.state.current === 'complete') sendMessage('download_completed', { id: delta.id });
});

connect();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PAGE_CONTENT_UPDATE' && sender.tab && sender.tab.id === currentActiveTabId) {
        sendMessage('pageInfoUpdate', msg.data);
    }
    if (msg.type === 'report_intent') {
        sendMessage('report_intent', {
            keyword: msg.data.keyword,
            url: msg.data.url,
            source: msg.data.source,
            intent_type: msg.data.intent_type || 'ai_prompt',
            title: msg.data.title
        });
    }
});
