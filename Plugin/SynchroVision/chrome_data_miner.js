// [SynchroVision] Chrome Data Miner (v2.0)
// Full Chrome data extraction: History, Bookmarks, Downloads, Sessions
// Uses better-sqlite3 for proper SQLite parsing

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Lazy load better-sqlite3 to avoid startup issues
let Database = null;
function getDatabase() {
    if (!Database) {
        try {
            Database = require('better-sqlite3');
        } catch (e) {
            console.error('[ChromeMiner] Failed to load better-sqlite3:', e.message);
            return null;
        }
    }
    return Database;
}

const LOCAL_APP_DATA = process.env.LOCALAPPDATA;
const TEMP_DIR = path.join(os.tmpdir(), 'VCP_Chrome_Miner');

// Browser profile paths
const BROWSER_PROFILES = {
    Chrome: path.join(LOCAL_APP_DATA, 'Google', 'Chrome', 'User Data', 'Default'),
    Edge: path.join(LOCAL_APP_DATA, 'Microsoft', 'Edge', 'User Data', 'Default'),
    Brave: path.join(LOCAL_APP_DATA, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default'),
    Opera: path.join(LOCAL_APP_DATA, 'Opera Software', 'Opera Stable'),
    Vivaldi: path.join(LOCAL_APP_DATA, 'Vivaldi', 'User Data', 'Default')
};

// Chrome timestamp is microseconds since 1601-01-01
// JavaScript Date epoch is milliseconds since 1970-01-01
const CHROME_EPOCH_OFFSET = 11644473600000000; // microseconds from 1601 to 1970

const SEARCH_PATTERNS = [
    { engine: 'Google', hosts: ['google.com'], params: ['q'] },
    { engine: 'Bing', hosts: ['bing.com'], params: ['q'] },
    { engine: 'Baidu', hosts: ['baidu.com'], params: ['wd'] },
    { engine: 'Bilibili', hosts: ['bilibili.com'], params: ['keyword'], pathIncludes: ['/search'] },
    { engine: 'YouTube', hosts: ['youtube.com'], params: ['search_query'] },
    { engine: 'DuckDuckGo', hosts: ['duckduckgo.com'], params: ['q'] },
    { engine: 'GitHub', hosts: ['github.com'], params: ['q'], pathIncludes: ['/search'] },
    { engine: 'Zhihu', hosts: ['zhihu.com'], params: ['q'], pathIncludes: ['/search'] },
    { engine: 'Taobao', hosts: ['taobao.com'], params: ['q'], pathIncludes: ['/search'] },
    { engine: 'Amazon', hosts: ['amazon.'], params: ['k'] },
    { engine: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'], params: ['q', 'query', 'prompt'] },
    { engine: 'Grok', hosts: ['grok.com', 'x.ai'], params: ['q', 'query', 'prompt', 'text'] },
    { engine: 'Grok', hosts: ['x.com'], params: ['q', 'query', 'prompt', 'text'], pathIncludes: ['/i/grok', '/grok', '/search'] }
];

const GENERIC_AI_TITLES = [
    'chatgpt',
    'chatgpt - openai',
    'new chat',
    'new conversation',
    'openai',
    'grok',
    'grok - xai',
    'grok - x.ai',
    'x',
    'x.com',
    'login',
    'sign in',
    'sign up',
    'gemini',
    'google gemini',
    'claude',
    'claude.ai',
    'google ai studio',
    'ai studio',
    'welcome to gemini',
    'gemini - google',
    'imagine - grok',
    'imagine 已保存 - grok',
    '谷歌 gemini --- google gemini',
    '谷歌 gemini',
    '谷歌 gemini --',
    'google gemini --'
];

function chromeTimeToDate(chromeTime) {
    if (!chromeTime || chromeTime <= 0) return null;
    try {
        const jsTime = (chromeTime - CHROME_EPOCH_OFFSET) / 1000;
        return new Date(jsTime);
    } catch (e) {
        return null;
    }
}

function formatDate(date) {
    if (!date) return 'Unknown';
    return date.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

function copyDbFile(srcPath, destName) {
    ensureTempDir();
    const destPath = path.join(TEMP_DIR, destName);
    try {
        if (!fs.existsSync(srcPath)) return null;
        fs.copyFileSync(srcPath, destPath);
        return destPath;
    } catch (e) {
        // File might be locked, try using Windows copy command
        try {
            execSync(`copy /y "${srcPath}" "${destPath}"`, { stdio: 'ignore', windowsHide: true });
            return destPath;
        } catch (e2) {
            console.error(`[ChromeMiner] Failed to copy ${srcPath}:`, e2.message);
            return null;
        }
    }
}

function hostMatches(hostname, hostRule) {
    if (!hostname || !hostRule) return false;
    return hostRule.includes('.') ? hostname.includes(hostRule) : hostname === hostRule || hostname.endsWith(`.${hostRule}`);
}

function decodeQueryValue(rawValue) {
    if (!rawValue) return '';
    try {
        return decodeURIComponent(String(rawValue).replace(/\+/g, ' ')).trim();
    } catch (e) {
        return String(rawValue).trim();
    }
}

function isMeaningfulAiTitle(title) {
    const normalized = String(title || '').trim();
    if (normalized.length < 6 || normalized.length > 160) return false;
    const lower = normalized.toLowerCase();
    return !GENERIC_AI_TITLES.includes(lower);
}

function extractAiTitleFallback(entry, hostname) {
    const lowerHost = String(hostname || '').toLowerCase();
    const isChatGPT = lowerHost.includes('chatgpt.com') || lowerHost.includes('chat.openai.com');
    const isGrok = lowerHost.includes('grok.com') || lowerHost.includes('x.ai') || lowerHost.includes('x.com');
    const isGemini = lowerHost.includes('gemini.google.com');
    const isAiStudio = lowerHost.includes('aistudio.google.com');
    const isClaude = lowerHost.includes('claude.ai');

    if (!isChatGPT && !isGrok && !isGemini && !isAiStudio && !isClaude) return null;
    if (!isMeaningfulAiTitle(entry.title)) return null;

    let engine = 'AI';
    if (isChatGPT) engine = 'ChatGPT';
    else if (isGrok) engine = 'Grok';
    else if (isGemini) engine = 'Gemini';
    else if (isAiStudio) engine = 'Google AI Studio';
    else if (isClaude) engine = 'Claude';

    // 清洗后缀以保留纯净的 Prompt (支持 - 、| 等分隔符)
    let query = entry.title.trim();
    if (isChatGPT) {
        query = query.replace(/\s*[-\|]\s*ChatGPT$/i, '').replace(/\s*[-\|]\s*OpenAI$/i, '');
    } else if (isGrok) {
        query = query.replace(/\s*[-\|]\s*Grok$/i, '').replace(/\s*[-\|]\s*xAI$/i, '');
    } else if (isGemini) {
        query = query.replace(/\s*[-\|]+\s*Google Gemini$/i, '').replace(/\s*[-\|]+\s*Gemini$/i, '');
    } else if (isAiStudio) {
        query = query.replace(/\s*[-\|]\s*Google AI Studio$/i, '');
    } else if (isClaude) {
        query = query.replace(/\s*[-\|]\s*Claude$/i, '');
    }

    return {
        source: entry.source,
        engine: engine,
        query: query,
        url: entry.url,
        time: entry.last_visit,
        timestamp: entry.timestamp,
        capture_method: 'history_title'
    };
}

function extractSearchRecord(entry) {
    if (!entry || !entry.url) return null;

    let parsedUrl = null;
    try {
        parsedUrl = new URL(entry.url);
    } catch (e) {
        return null;
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname.toLowerCase();

    for (const matcher of SEARCH_PATTERNS) {
        if (!matcher.hosts.some(host => hostMatches(hostname, host))) continue;
        if (matcher.pathIncludes && !matcher.pathIncludes.some(fragment => pathname.includes(fragment))) continue;

        for (const param of matcher.params) {
            const rawValue = parsedUrl.searchParams.get(param) || parsedUrl.hash.match(new RegExp(`[?#&]${param}=([^&]+)`))?.[1];
            const query = decodeQueryValue(rawValue);
            if (!query) continue;

            return {
                source: entry.source,
                engine: matcher.engine,
                query,
                url: entry.url,
                time: entry.last_visit,
                timestamp: entry.timestamp,
                capture_method: 'url_param'
            };
        }
    }

    return extractAiTitleFallback(entry, hostname);
}

/**
 * Fetch browser history with full details
 * @param {Object} options - { limit: 50, daysBack: 7, browser: 'all' }
 * @returns {Promise<Array>} History entries with title, url, visit_time, visit_count
 */
async function getHistory(options = {}) {
    const { limit = 50, daysBack = 7, browser = 'all' } = options;
    const results = [];
    const DatabaseClass = getDatabase();
    if (!DatabaseClass) return results;

    const browsers = browser === 'all' ? Object.keys(BROWSER_PROFILES) : [browser];
    const cutoffTime = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const cutoffChromeTime = (cutoffTime * 1000) + CHROME_EPOCH_OFFSET;

    for (const browserName of browsers) {
        const profilePath = BROWSER_PROFILES[browserName];
        if (!profilePath || !fs.existsSync(profilePath)) continue;

        const historyPath = path.join(profilePath, 'History');
        const tempPath = copyDbFile(historyPath, `${browserName}_History`);
        if (!tempPath) continue;

        try {
            const db = new DatabaseClass(tempPath, { readonly: true, fileMustExist: true });

            const rows = db.prepare(`
                SELECT
                    urls.url,
                    urls.title,
                    urls.visit_count,
                    urls.typed_count,
                    MAX(visits.visit_time) as last_visit_time
                FROM urls
                LEFT JOIN visits ON urls.id = visits.url
                WHERE urls.last_visit_time > ?
                GROUP BY urls.url
                ORDER BY last_visit_time DESC
                LIMIT ?
            `).all(cutoffChromeTime, limit);

            for (const row of rows) {
                const visitDate = chromeTimeToDate(row.last_visit_time);
                results.push({
                    source: browserName,
                    url: row.url,
                    title: row.title || 'Untitled',
                    visit_count: row.visit_count || 1,
                    typed_count: row.typed_count || 0,
                    last_visit: formatDate(visitDate),
                    timestamp: visitDate ? visitDate.getTime() : 0
                });
            }

            db.close();
        } catch (e) {
            console.error(`[ChromeMiner] Error reading ${browserName} history:`, e.message);
        } finally {
            try { fs.unlinkSync(tempPath); } catch (e) {}
        }
    }

    // Sort by timestamp and deduplicate
    results.sort((a, b) => b.timestamp - a.timestamp);
    return results;
}

/**
 * Fetch bookmarks from browser
 * @param {Object} options - { browser: 'all', search: '' }
 * @returns {Promise<Array>} Bookmark entries
 */
async function getBookmarks(options = {}) {
    const { browser = 'all', search = '' } = options;
    const results = [];
    const browsers = browser === 'all' ? Object.keys(BROWSER_PROFILES) : [browser];

    for (const browserName of browsers) {
        const profilePath = BROWSER_PROFILES[browserName];
        if (!profilePath || !fs.existsSync(profilePath)) continue;

        const bookmarksPath = path.join(profilePath, 'Bookmarks');
        if (!fs.existsSync(bookmarksPath)) continue;

        try {
            const content = fs.readFileSync(bookmarksPath, 'utf8');
            const data = JSON.parse(content);

            function parseBookmarkNode(node, folder = 'Root') {
                if (!node) return;

                if (node.type === 'url') {
                    const entry = {
                        source: browserName,
                        type: 'bookmark',
                        name: node.name || 'Untitled',
                        url: node.url,
                        folder: folder,
                        date_added: node.date_added ? formatDate(chromeTimeToDate(parseInt(node.date_added))) : 'Unknown'
                    };

                    if (!search ||
                        entry.name.toLowerCase().includes(search.toLowerCase()) ||
                        entry.url.toLowerCase().includes(search.toLowerCase())) {
                        results.push(entry);
                    }
                } else if (node.type === 'folder' && node.children) {
                    const folderName = folder ? `${folder}/${node.name}` : node.name;
                    for (const child of node.children) {
                        parseBookmarkNode(child, folderName);
                    }
                }
            }

            // Parse bookmark bar and other folders
            if (data.roots) {
                if (data.roots.bookmark_bar) parseBookmarkNode(data.roots.bookmark_bar, 'Bookmark Bar');
                if (data.roots.other) parseBookmarkNode(data.roots.other, 'Other');
                if (data.roots.synced) parseBookmarkNode(data.roots.synced, 'Mobile');
            }

        } catch (e) {
            console.error(`[ChromeMiner] Error reading ${browserName} bookmarks:`, e.message);
        }
    }

    return results;
}

/**
 * Fetch download history
 * @param {Object} options - { limit: 30, daysBack: 30, browser: 'all' }
 * @returns {Promise<Array>} Download entries
 */
async function getDownloads(options = {}) {
    const { limit = 30, daysBack = 30, browser = 'all' } = options;
    const results = [];
    const DatabaseClass = getDatabase();
    if (!DatabaseClass) return results;

    const browsers = browser === 'all' ? Object.keys(BROWSER_PROFILES) : [browser];
    const cutoffTime = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const cutoffChromeTime = (cutoffTime * 1000) + CHROME_EPOCH_OFFSET;

    for (const browserName of browsers) {
        const profilePath = BROWSER_PROFILES[browserName];
        if (!profilePath || !fs.existsSync(profilePath)) continue;

        const historyPath = path.join(profilePath, 'History');
        const tempPath = copyDbFile(historyPath, `${browserName}_Downloads`);
        if (!tempPath) continue;

        try {
            const db = new DatabaseClass(tempPath, { readonly: true, fileMustExist: true });

            // Check if downloads table exists
            const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'").get();
            if (!tableCheck) {
                db.close();
                continue;
            }

            const rows = db.prepare(`
                SELECT
                    target_path,
                    tab_url,
                    total_bytes,
                    received_bytes,
                    start_time,
                    end_time,
                    state,
                    mime_type
                FROM downloads
                WHERE start_time > ?
                ORDER BY start_time DESC
                LIMIT ?
            `).all(cutoffChromeTime, limit);

            for (const row of rows) {
                const startDate = chromeTimeToDate(row.start_time);
                const filename = row.target_path ? path.basename(row.target_path) : 'Unknown';
                const sizeStr = row.total_bytes > 0 ? formatBytes(row.total_bytes) : 'Unknown';

                // State: 0 = in progress, 1 = complete, 2 = cancelled, 3 = interrupted
                const stateMap = { 0: 'In Progress', 1: 'Complete', 2: 'Cancelled', 3: 'Interrupted' };

                results.push({
                    source: browserName,
                    type: 'download',
                    filename: filename,
                    path: row.target_path || 'N/A',
                    url: row.tab_url || 'N/A',
                    size: sizeStr,
                    mime_type: row.mime_type || 'unknown',
                    state: stateMap[row.state] || 'Unknown',
                    start_time: formatDate(startDate),
                    timestamp: startDate ? startDate.getTime() : 0
                });
            }

            db.close();
        } catch (e) {
            console.error(`[ChromeMiner] Error reading ${browserName} downloads:`, e.message);
        } finally {
            try { fs.unlinkSync(tempPath); } catch (e) {}
        }
    }

    results.sort((a, b) => b.timestamp - a.timestamp);
    return results;
}

/**
 * Fetch recent searches from browser history
 * @param {Object} options - { limit: 20, daysBack: 7, browser: 'all' }
 * @returns {Promise<Array>} Search queries
 */
async function getSearches(options = {}) {
    const { limit = 20, daysBack = 7, browser = 'all' } = options;
    const history = await getHistory({ limit: 500, daysBack, browser });

    const searches = [];
    const seen = new Set();

    for (const entry of history) {
        if (searches.length >= limit) break;
        const record = extractSearchRecord(entry);
        if (!record) continue;

        const key = `${record.engine}:${record.query.toLowerCase()}:${record.url || ''}`;
        if (seen.has(key)) continue;

        seen.add(key);
        searches.push(record);
    }

    return searches;
}

/**
 * Get installed extensions list
 * @param {Object} options - { browser: 'all' }
 * @returns {Promise<Array>} Extension entries
 */
async function getExtensions(options = {}) {
    const { browser = 'all' } = options;
    const results = [];
    const browsers = browser === 'all' ? Object.keys(BROWSER_PROFILES) : [browser];

    for (const browserName of browsers) {
        const profilePath = BROWSER_PROFILES[browserName];
        if (!profilePath || !fs.existsSync(profilePath)) continue;

        const extensionsPath = path.join(profilePath, 'Extensions');
        if (!fs.existsSync(extensionsPath)) continue;

        try {
            const extensionIds = fs.readdirSync(extensionsPath);

            for (const extId of extensionIds) {
                if (extId.startsWith('.')) continue;

                const extPath = path.join(extensionsPath, extId);
                const stat = fs.statSync(extPath);
                if (!stat.isDirectory()) continue;

                // Get latest version folder
                const versions = fs.readdirSync(extPath).filter(v => !v.startsWith('.'));
                if (versions.length === 0) continue;

                const latestVersion = versions.sort().pop();
                const manifestPath = path.join(extPath, latestVersion, 'manifest.json');

                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                        results.push({
                            source: browserName,
                            type: 'extension',
                            id: extId,
                            name: manifest.name || 'Unknown',
                            version: manifest.version || latestVersion,
                            description: (manifest.description || '').substring(0, 100)
                        });
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.error(`[ChromeMiner] Error reading ${browserName} extensions:`, e.message);
        }
    }

    return results;
}

/**
 * Get Login Data (site credentials - only domains, no passwords)
 * @param {Object} options - { browser: 'all', limit: 50 }
 * @returns {Promise<Array>} Saved login domains
 */
async function getSavedLogins(options = {}) {
    const { browser = 'all', limit = 50 } = options;
    const results = [];
    const DatabaseClass = getDatabase();
    if (!DatabaseClass) return results;

    const browsers = browser === 'all' ? Object.keys(BROWSER_PROFILES) : [browser];

    for (const browserName of browsers) {
        const profilePath = BROWSER_PROFILES[browserName];
        if (!profilePath || !fs.existsSync(profilePath)) continue;

        const loginPath = path.join(profilePath, 'Login Data');
        const tempPath = copyDbFile(loginPath, `${browserName}_LoginData`);
        if (!tempPath) continue;

        try {
            const db = new DatabaseClass(tempPath, { readonly: true, fileMustExist: true });

            const rows = db.prepare(`
                SELECT
                    origin_url,
                    username_value,
                    date_created,
                    times_used
                FROM logins
                ORDER BY times_used DESC
                LIMIT ?
            `).all(limit);

            for (const row of rows) {
                try {
                    const url = new URL(row.origin_url);
                    results.push({
                        source: browserName,
                        type: 'saved_login',
                        domain: url.hostname,
                        username_hint: row.username_value ? `${row.username_value.substring(0, 3)}***` : 'N/A',
                        times_used: row.times_used || 0,
                        date_created: row.date_created ? formatDate(chromeTimeToDate(row.date_created)) : 'Unknown'
                    });
                } catch (e) {}
            }

            db.close();
        } catch (e) {
            console.error(`[ChromeMiner] Error reading ${browserName} logins:`, e.message);
        } finally {
            try { fs.unlinkSync(tempPath); } catch (e) {}
        }
    }

    return results;
}

/**
 * Get autofill data (form entries)
 * @param {Object} options - { browser: 'all', limit: 30 }
 * @returns {Promise<Array>} Autofill entries (excluding sensitive fields)
 */
async function getAutofill(options = {}) {
    const { browser = 'all', limit = 30 } = options;
    const results = [];
    const DatabaseClass = getDatabase();
    if (!DatabaseClass) return results;

    const browsers = browser === 'all' ? Object.keys(BROWSER_PROFILES) : [browser];

    // Fields to exclude for privacy
    const sensitiveFields = ['password', 'pwd', 'pass', 'secret', 'card', 'cvv', 'ssn', 'credit', 'debit'];

    for (const browserName of browsers) {
        const profilePath = BROWSER_PROFILES[browserName];
        if (!profilePath || !fs.existsSync(profilePath)) continue;

        const webDataPath = path.join(profilePath, 'Web Data');
        const tempPath = copyDbFile(webDataPath, `${browserName}_WebData`);
        if (!tempPath) continue;

        try {
            const db = new DatabaseClass(tempPath, { readonly: true, fileMustExist: true });

            const rows = db.prepare(`
                SELECT name, value, count, date_last_used
                FROM autofill
                ORDER BY count DESC
                LIMIT ?
            `).all(limit * 2); // Get extra to filter

            for (const row of rows) {
                if (results.length >= limit) break;

                // Skip sensitive fields
                const fieldName = row.name.toLowerCase();
                if (sensitiveFields.some(s => fieldName.includes(s))) continue;

                results.push({
                    source: browserName,
                    type: 'autofill',
                    field_name: row.name,
                    value: row.value ? row.value.substring(0, 50) : '',
                    usage_count: row.count || 0,
                    last_used: row.date_last_used ? formatDate(chromeTimeToDate(row.date_last_used)) : 'Unknown'
                });
            }

            db.close();
        } catch (e) {
            console.error(`[ChromeMiner] Error reading ${browserName} autofill:`, e.message);
        } finally {
            try { fs.unlinkSync(tempPath); } catch (e) {}
        }
    }

    return results;
}

/**
 * Get a comprehensive overview of all Chrome data
 * @returns {Promise<Object>} Combined overview
 */
async function getFullOverview() {
    console.log('[ChromeMiner] Generating full overview...');

    const [history, bookmarks, downloads, searches, extensions] = await Promise.all([
        getHistory({ limit: 30, daysBack: 3 }),
        getBookmarks({ limit: 30 }),
        getDownloads({ limit: 15, daysBack: 7 }),
        getSearches({ limit: 15, daysBack: 3 }),
        getExtensions()
    ]);

    return {
        generated_at: new Date().toLocaleString(),
        summary: {
            history_count: history.length,
            bookmark_count: bookmarks.length,
            download_count: downloads.length,
            search_count: searches.length,
            extension_count: extensions.length
        },
        recent_history: history,
        recent_bookmarks: bookmarks.slice(0, 30),
        recent_downloads: downloads,
        recent_searches: searches,
        installed_extensions: extensions
    };
}

// Utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
    getHistory,
    getBookmarks,
    getDownloads,
    getSearches,
    getExtensions,
    getSavedLogins,
    getAutofill,
    getFullOverview,
    BROWSER_PROFILES,
    extractSearchRecord
};
