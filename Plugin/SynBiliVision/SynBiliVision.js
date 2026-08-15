#!/usr/bin/env node

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const stdin = process.stdin;
const PLUGIN_NAME = 'SynBiliVision';
const LOG_DIR = path.join(__dirname, 'logs');
const COOKIE_FILE = path.join(__dirname, 'www.bilibili.com_cookies.txt');
const COOKIE_FILE_NAME_PATTERN = /^www\.bilibili\.com_cookies.*\.txt$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_HISTORY_PAGE_SIZE = 30;
const DEFAULT_HISTORY_ENRICH = 2;
const MAX_HISTORY_PAGES = 5;
const FAVORITES_FETCH_CONCURRENCY = 4;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const DEFAULT_PLUGIN_TIMEOUT_MS = 105000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_SUBTITLE_TIMEOUT_MS = 6000;
const MIN_ENRICH_REMAINING_MS = 18000;

if (fs.existsSync(path.join(__dirname, 'config.env'))) {
    require('dotenv').config({ path: path.join(__dirname, 'config.env') });
}

const DEBUG_MODE = process.env.DebugMode === 'true' || process.env.DEBUG_MODE === 'true';
const PLUGIN_TIMEOUT_MS = clampNumber(process.env.SYNBILIVISION_TIMEOUT_MS, DEFAULT_PLUGIN_TIMEOUT_MS, 15000, 115000);
const REQUEST_TIMEOUT_MS = clampNumber(process.env.SYNBILIVISION_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 3000, 30000);
const SUBTITLE_TIMEOUT_MS = clampNumber(process.env.SYNBILIVISION_SUBTITLE_TIMEOUT_MS, DEFAULT_SUBTITLE_TIMEOUT_MS, 2000, 15000);
const MAX_HISTORY_ENRICH = clampNumber(process.env.SYNBILIVISION_HISTORY_ENRICH, DEFAULT_HISTORY_ENRICH, 0, 5);
const REQUEST_AGENT = new https.Agent({
    keepAlive: true,
    maxSockets: 8,
    timeout: REQUEST_TIMEOUT_MS
});

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
];

let wbiKeysCache = {
    imgKey: null,
    subKey: null,
    expireTime: 0
};

function getLogFilePath() {
    const today = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `${PLUGIN_NAME}-${today}.log`);
}

function log(level, message, data = null) {
    if (level === 'debug' && !DEBUG_MODE) {
        return;
    }

    const timestamp = new Date().toISOString();
    const upper = level.toUpperCase();
    let entry = `[${timestamp}] [${upper}] ${message}`;

    if (data !== null) {
        try {
            entry += `\nDetails: ${JSON.stringify(data, null, 2)}`;
        } catch (error) {
            entry += '\nDetails: [Unserializable]';
        }
    }

    fs.appendFileSync(getLogFilePath(), `${entry}\n`, 'utf8');

    if (DEBUG_MODE || level === 'warn' || level === 'error') {
        const consolePayload = { timestamp, level, message };
        if (DEBUG_MODE && data !== null) {
            consolePayload.data = data;
        }
        console.error(JSON.stringify(consolePayload));
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createDeadline(timeoutMs = PLUGIN_TIMEOUT_MS) {
    return Date.now() + timeoutMs;
}

function getRemainingMs(deadline) {
    if (!deadline) {
        return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, deadline - Date.now());
}

function assertDeadline(deadline, label = 'SynBiliVision') {
    if (deadline && getRemainingMs(deadline) <= 0) {
        throw new Error(`${label} 执行超时，已返回前停止继续抓取`);
    }
}

function getRequestTimeoutMs(options = {}, deadline = null) {
    const requested = options.timeoutMs || REQUEST_TIMEOUT_MS;
    const remaining = getRemainingMs(deadline);
    if (!Number.isFinite(remaining)) {
        return requested;
    }
    return Math.max(1000, Math.min(requested, Math.max(1000, remaining - 1000)));
}

function writePluginOutput(payload) {
    process.stdout.write(JSON.stringify(payload), () => {
        REQUEST_AGENT.destroy();
    });
}

function withTimeout(promise, timeoutMs, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        })
    ]);
}

function createExecutionCache() {
    return {
        favoriteFolders: new Map(),
        favoriteFolderItems: new Map()
    };
}

function getExecutionCache(cache) {
    return cache || createExecutionCache();
}

async function mapWithConcurrency(items, concurrency, mapper) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const workerCount = Math.max(1, Math.min(items.length, concurrency || 1));
    const results = new Array(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;

            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
    return results;
}

function clampNumber(value, fallback, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function buildQuery(params) {
    return Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
}

function getMixinKey(raw) {
    return MIXIN_KEY_ENC_TAB.reduce((result, index) => result + raw[index], '').slice(0, 32);
}

function encWbi(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey + subKey);
    const sorted = { ...params, wts: Math.round(Date.now() / 1000) };
    const query = Object.keys(sorted)
        .sort()
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(sorted[key]).replace(/[!'()*]/g, ''))}`)
        .join('&');

    return {
        ...sorted,
        w_rid: crypto.createHash('md5').update(query + mixinKey).digest('hex')
    };
}

function sanitizeCookie(cookie) {
    return String(cookie || '').replace(/\r?\n/g, ' ').trim();
}

function parseNetscapeCookieFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const cookies = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
            const parts = line.split('\t');
            return parts.length >= 7 ? `${parts[5]}=${parts[6]}` : '';
        })
        .filter(Boolean);

    return sanitizeCookie(cookies.join('; '));
}

function extractMidFromCookie(cookie) {
    const match = sanitizeCookie(cookie).match(/(?:^|;\s*)DedeUserID=(\d+)/);
    return match ? match[1] : null;
}

function getCookieDiagnostics(cookie) {
    const normalized = sanitizeCookie(cookie);
    return {
        hasSessData: /(?:^|;\s*)SESSDATA=/.test(normalized),
        hasBiliJct: /(?:^|;\s*)bili_jct=/.test(normalized),
        hasDedeUserId: /(?:^|;\s*)DedeUserID=/.test(normalized),
        length: normalized.length
    };
}

function getCookieFileCandidates(baseDir = __dirname, primaryFilePath = COOKIE_FILE) {
    const resolvedPrimary = path.resolve(primaryFilePath);
    const files = [];

    if (fs.existsSync(resolvedPrimary)) {
        files.push(resolvedPrimary);
    }

    let directoryEntries = [];
    try {
        directoryEntries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (error) {
        log('warn', '读取 Cookie 文件目录失败', { baseDir, error: error.message });
        return files;
    }

    const extraFiles = directoryEntries
        .filter(entry => entry.isFile() && COOKIE_FILE_NAME_PATTERN.test(entry.name))
        .map(entry => path.join(baseDir, entry.name))
        .filter(filePath => path.resolve(filePath) !== resolvedPrimary)
        .sort((left, right) => {
            try {
                return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
            } catch (_) {
                return 0;
            }
        });

    return [...files, ...extraFiles];
}

function formatCandidateSource(candidate) {
    return Array.isArray(candidate.sources) ? candidate.sources.join(' + ') : String(candidate.source || '');
}

function isTransientStatus(statusCode) {
    return [408, 425, 429, 500, 502, 503, 504].includes(statusCode);
}

function isTransientError(error) {
    const message = String(error?.message || '');
    const code = String(error?.code || '');
    return [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'socket hang up',
        'Request Timeout'
    ].some(token => message.includes(token) || code.includes(token));
}

async function httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObject = new URL(url);
        const requestId = Math.random().toString(36).slice(2, 8);
        const requestOptions = {
            hostname: urlObject.hostname,
            port: urlObject.port || 443,
            path: urlObject.pathname + urlObject.search,
            method: options.method || 'GET',
            agent: REQUEST_AGENT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Referer': 'https://www.bilibili.com/',
                'Origin': 'https://www.bilibili.com',
                'Connection': 'keep-alive',
                ...options.headers
            }
        };

        log('debug', `[${requestId}] Request Start`, { url, method: requestOptions.method });

        const request = https.request(requestOptions, response => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                raw += chunk;
            });
            response.on('end', () => {
                let parsed = raw;
                try {
                    parsed = JSON.parse(raw);
                } catch (_) {
                    // keep raw text
                }

                resolve({
                    statusCode: response.statusCode || 0,
                    headers: response.headers,
                    data: parsed
                });
            });
        });

        request.on('error', error => {
            log('error', `[${requestId}] Network Error`, { message: error.message, code: error.code || '' });
            reject(error);
        });

        request.setTimeout(options.timeoutMs || REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error('Request Timeout'));
        });

        if (options.body) {
            request.write(options.body);
        }
        request.end();
    });
}

async function requestBiliJson(url, requestOptions = {}, retryOptions = {}) {
    const {
        maxRetries = 2,
        retryOnAppCodes = [-799],
        label = url,
        deadline = null
    } = retryOptions;

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        assertDeadline(deadline, label);
        try {
            const response = await httpsRequest(url, {
                ...requestOptions,
                timeoutMs: getRequestTimeoutMs(requestOptions, deadline)
            });
            const appCode = typeof response.data === 'object' && response.data !== null ? response.data.code : undefined;

            if ((isTransientStatus(response.statusCode) || retryOnAppCodes.includes(appCode)) && attempt < maxRetries) {
                log('warn', 'Transient Bilibili response, retrying', {
                    label,
                    attempt: attempt + 1,
                    statusCode: response.statusCode,
                    appCode
                });
                await sleep(Math.min(600 * (attempt + 1), getRemainingMs(deadline)));
                continue;
            }

            return response;
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries && isTransientError(error)) {
                log('warn', 'Transient network error, retrying', {
                    label,
                    attempt: attempt + 1,
                    message: error.message
                });
                await sleep(Math.min(600 * (attempt + 1), getRemainingMs(deadline)));
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error(`请求失败: ${label}`);
}

function ensureBiliSuccess(response, label) {
    const payload = response.data;
    if (!payload || typeof payload !== 'object') {
        throw new Error(`${label} 返回了非 JSON 内容`);
    }
    if (payload.code !== 0) {
        throw new Error(`${label} 失败: ${payload.message || '未知错误'} (code: ${payload.code})`);
    }
    return payload.data;
}

async function checkLogin(cookie) {
    const response = await requestBiliJson('https://api.bilibili.com/x/web-interface/nav', {
        headers: { Cookie: cookie }
    }, {
        label: '登录检查'
    });

    const payload = response.data;
    if (!payload || typeof payload !== 'object') {
        return { isLogin: false, code: -1, message: '登录检查返回非 JSON 内容' };
    }

    if (payload.code !== 0) {
        return { isLogin: false, code: payload.code, message: payload.message || '登录检查失败' };
    }

    return {
        isLogin: Boolean(payload.data?.isLogin),
        code: 0,
        message: payload.message || 'OK',
        mid: String(payload.data?.mid || ''),
        uname: payload.data?.uname || ''
    };
}

function collectCookieCandidates(input = {}, options = {}) {
    const envSource = options.env || process.env;
    const baseDir = options.baseDir || __dirname;
    const primaryCookieFile = options.primaryCookieFile || COOKIE_FILE;
    const candidateMap = new Map();
    const candidates = [];

    const pushCandidate = (source, cookie, mid = null) => {
        const normalizedCookie = sanitizeCookie(cookie);
        if (!normalizedCookie) {
            return;
        }

        const existing = candidateMap.get(normalizedCookie);
        if (existing) {
            if (!existing.sources.includes(source)) {
                existing.sources.push(source);
            }
            if (!existing.mid && mid) {
                existing.mid = mid;
            }
            return;
        }

        const candidate = {
            source,
            sources: [source],
            cookie: normalizedCookie,
            mid: mid || extractMidFromCookie(normalizedCookie),
            diagnostics: getCookieDiagnostics(normalizedCookie)
        };

        candidateMap.set(normalizedCookie, candidate);
        candidates.push(candidate);
    };

    const pushCookieFileCandidate = (source, cookieFilePath) => {
        if (!cookieFilePath) {
            return;
        }
        const resolvedPath = path.resolve(String(cookieFilePath));
        try {
            pushCandidate(`${source}:${path.basename(resolvedPath)}`, parseNetscapeCookieFile(resolvedPath));
        } catch (error) {
            log('warn', '解析指定 Cookie 文件失败', { error: error.message, path: resolvedPath });
        }
    };

    pushCookieFileCandidate('env_cookie_file', envSource.BILIBILI_COOKIE_FILE);
    pushCookieFileCandidate('input_cookie_file', input.config?.BILIBILI_COOKIE_FILE || input.cookie_file);

    for (const cookieFilePath of getCookieFileCandidates(baseDir, primaryCookieFile)) {
        try {
            pushCandidate(`cookie_file:${path.basename(cookieFilePath)}`, parseNetscapeCookieFile(cookieFilePath));
        } catch (error) {
            log('warn', '解析 Cookie 文件失败', { error: error.message, path: cookieFilePath });
        }
    }

    pushCandidate('config_env', envSource.BILIBILI_COOKIE, envSource.BILIBILI_MID);
    pushCandidate('input_config', input.config?.BILIBILI_COOKIE, input.config?.BILIBILI_MID);

    return candidates;
}

async function resolveAuth(input, options = {}) {
    const {
        checkLoginFn = checkLogin,
        collectOptions = {}
    } = options;
    const candidates = collectCookieCandidates(input, collectOptions);
    if (candidates.length === 0) {
        throw new Error('未找到可用的 BILIBILI_COOKIE。请更新 cookie 文件或 config.env。');
    }

    const failures = [];
    for (const candidate of candidates) {
        const sourceLabel = formatCandidateSource(candidate);

        if (!candidate.diagnostics.hasSessData) {
            failures.push(`${sourceLabel}: 缺少 SESSDATA`);
            log('warn', 'Cookie 候选缺少 SESSDATA，跳过登录校验', {
                source: sourceLabel,
                diagnostics: candidate.diagnostics
            });
            continue;
        }

        if (!candidate.diagnostics.hasBiliJct) {
            log('warn', 'Cookie 候选缺少 bili_jct，部分接口可能受限', {
                source: sourceLabel
            });
        }

        try {
            const login = await checkLoginFn(candidate.cookie, candidate);
            if (login.isLogin) {
                return {
                    cookie: candidate.cookie,
                    mid: candidate.mid || login.mid || null,
                    source: sourceLabel,
                    sources: candidate.sources,
                    uname: login.uname || '',
                    login
                };
            }

            failures.push(`${sourceLabel}: ${login.message || '未登录'} (code: ${login.code})`);
            log('warn', 'Cookie 候选登录失败，尝试下一个来源', {
                source: sourceLabel,
                code: login.code,
                message: login.message,
                diagnostics: candidate.diagnostics
            });
        } catch (error) {
            failures.push(`${sourceLabel}: ${error.message}`);
            log('warn', 'Cookie 候选校验异常，尝试下一个来源', {
                source: sourceLabel,
                error: error.message
            });
        }
    }

    throw new Error(`所有 Cookie 来源均不可用: ${failures.join(' | ')}`);
}

async function getWbiKeys(cookie, deadline = null) {
    if (wbiKeysCache.imgKey && wbiKeysCache.subKey && Date.now() < wbiKeysCache.expireTime) {
        return {
            imgKey: wbiKeysCache.imgKey,
            subKey: wbiKeysCache.subKey
        };
    }

    const response = await requestBiliJson('https://api.bilibili.com/x/web-interface/nav', {
        headers: { Cookie: cookie }
    }, {
        label: 'WBI 密钥'
    });
    const data = ensureBiliSuccess(response, 'WBI 密钥');
    const imgUrl = data?.wbi_img?.img_url;
    const subUrl = data?.wbi_img?.sub_url;

    if (!imgUrl || !subUrl) {
        return { imgKey: null, subKey: null };
    }

    const imgKey = imgUrl.split('/').pop().split('.')[0];
    const subKey = subUrl.split('/').pop().split('.')[0];

    wbiKeysCache = {
        imgKey,
        subKey,
        expireTime: Date.now() + 5 * 60 * 1000
    };

    return { imgKey, subKey };
}

async function requestWbiJson(baseUrl, params, cookie, label, deadline = null) {
    const { imgKey, subKey } = await getWbiKeys(cookie, deadline);
    const signedParams = imgKey && subKey ? encWbi(params, imgKey, subKey) : params;
    return requestBiliJson(`${baseUrl}?${buildQuery(signedParams)}`, {
        headers: { Cookie: cookie }
    }, { label, deadline });
}

function formatDateTime(timestampSeconds) {
    if (!timestampSeconds) {
        return null;
    }
    return new Date(timestampSeconds * 1000).toLocaleString('zh-CN');
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return null;
    }
    const totalSeconds = Math.round(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}小时${minutes}分${secs}秒`;
    }
    if (minutes > 0) {
        return `${minutes}分${secs}秒`;
    }
    return `${secs}秒`;
}

function trimText(text, maxLength = 160) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function normalizeAction(rawAction) {
    const action = String(rawAction || 'all').trim().toLowerCase();
    const aliasMap = {
        all: 'all',
        info: 'info',
        user: 'info',
        history: 'history',
        favorites: 'favorites',
        favorite: 'favorites',
        fav: 'favorites',
        recent_fav: 'recent_fav',
        recentfav: 'recent_fav',
        recentfavorites: 'recent_fav',
        recent_favorites: 'recent_fav',
        coins: 'coins',
        coin: 'coins'
    };

    return aliasMap[action] || action;
}

async function getUserInfo(mid, cookie, deadline = null) {
    try {
        const response = await requestWbiJson(
            'https://api.bilibili.com/x/space/wbi/acc/info',
            { mid },
            cookie,
            '用户信息'
        );
        return ensureBiliSuccess(response, '用户信息');
    } catch (error) {
        if (!String(error.message).includes('code: -799')) {
            throw error;
        }
    }

    const fallbackResponse = await requestBiliJson('https://api.bilibili.com/x/member/web/account', {
        headers: { Cookie: cookie }
    }, {
        label: '用户信息回退'
    });
    const fallback = ensureBiliSuccess(fallbackResponse, '用户信息回退');
    return {
        mid: fallback.mid,
        name: fallback.uname,
        userid: fallback.userid,
        sign: fallback.sign,
        sex: fallback.sex,
        birthday: fallback.birthday,
        rank: fallback.rank
    };
}

async function getFavoriteFolders(mid, cookie, deadline = null) {
    const response = await requestBiliJson(
        `https://api.bilibili.com/x/v3/fav/folder/created/list-all?${buildQuery({ up_mid: mid, type: 2, web_location: '333.1387' })}`,
        { headers: { Cookie: cookie } },
        { label: '收藏夹列表' }
    );
    const data = ensureBiliSuccess(response, '收藏夹列表');
    const folders = Array.isArray(data?.list) ? data.list : [];

    return folders
        .map(folder => ({
            id: folder.id,
            fid: folder.fid,
            title: folder.title,
            media_count: folder.media_count,
            mtime: folder.mtime || 0,
            is_private: Boolean(folder.attr & 1)
        }))
        .sort((left, right) => (right.mtime || 0) - (left.mtime || 0));
}

async function getFavoriteFolderItems(folderId, cookie, itemLimit = 5, deadline = null) {
    const response = await requestBiliJson(
        `https://api.bilibili.com/x/v3/fav/resource/list?${buildQuery({
            media_id: folderId,
            pn: 1,
            ps: clampNumber(itemLimit, 5, 1, 20),
            order: 'mtime',
            platform: 'web'
        })}`,
        { headers: { Cookie: cookie } },
        { label: `收藏夹内容 ${folderId}` }
    );
    const data = ensureBiliSuccess(response, `收藏夹内容 ${folderId}`);
    const medias = Array.isArray(data?.medias) ? data.medias : [];

    return medias.map(item => ({
        id: item.id,
        bvid: item.bvid || item.bv_id || null,
        title: item.title,
        author: item.upper?.name || '',
        duration: item.duration || 0,
        duration_str: formatDuration(item.duration || 0),
        fav_time: item.fav_time || 0,
        fav_time_str: formatDateTime(item.fav_time || 0),
        pubtime: item.pubtime || 0,
        pubtime_str: formatDateTime(item.pubtime || 0),
        intro: trimText(item.intro, 120),
        folder_id: folderId
    }));
}

async function getFavoriteFoldersCached(mid, cookie, cache, fetcher = getFavoriteFolders, deadline = null) {
    const runtimeCache = getExecutionCache(cache);
    const cacheKey = String(mid || '');

    if (!runtimeCache.favoriteFolders.has(cacheKey)) {
        runtimeCache.favoriteFolders.set(cacheKey, Promise.resolve().then(() => fetcher(mid, cookie, deadline)));
    }

    return runtimeCache.favoriteFolders.get(cacheKey);
}

async function getFavoriteFolderItemsCached(folderId, cookie, itemLimit, cache, fetcher = getFavoriteFolderItems, deadline = null) {
    const runtimeCache = getExecutionCache(cache);
    const normalizedLimit = clampNumber(itemLimit, 5, 1, 20);
    const cacheKey = String(folderId || '');
    const cachedEntry = runtimeCache.favoriteFolderItems.get(cacheKey);

    if (cachedEntry && cachedEntry.limit >= normalizedLimit) {
        const items = await cachedEntry.promise;
        return items.slice(0, normalizedLimit);
    }

    const promise = Promise.resolve().then(() => fetcher(folderId, cookie, normalizedLimit, deadline));
    runtimeCache.favoriteFolderItems.set(cacheKey, {
        limit: normalizedLimit,
        promise
    });

    const items = await promise;
    return items.slice(0, normalizedLimit);
}

async function getFavorites(mid, cookie, limit, cache, deadline = null) {
    const folders = await getFavoriteFoldersCached(mid, cookie, cache, getFavoriteFolders, deadline);
    const folderLimit = clampNumber(limit, Math.min(DEFAULT_LIMIT, folders.length || 1), 1, Math.max(1, Math.min(folders.length || 1, 20)));
    const previewSize = Math.min(3, folderLimit);
    const selected = folders.slice(0, folderLimit);

    await mapWithConcurrency(selected, FAVORITES_FETCH_CONCURRENCY, async folder => {
        try {
            folder.items = await getFavoriteFolderItemsCached(folder.id, cookie, previewSize, cache, getFavoriteFolderItems, deadline);
        } catch (error) {
            folder.items = [];
            folder.preview_error = error.message;
        }
    });

    return selected;
}

async function getRecentFavorites(mid, cookie, limit, cache, deadline = null) {
    const folders = await getFavoriteFoldersCached(mid, cookie, cache, getFavoriteFolders, deadline);
    if (folders.length === 0) {
        return [];
    }

    const targetLimit = clampNumber(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const scanFolders = Math.min(folders.length, Math.max(10, Math.min(targetLimit * 2, 20)));
    const candidates = [];

    const folderResults = await mapWithConcurrency(
        folders.slice(0, scanFolders),
        FAVORITES_FETCH_CONCURRENCY,
        async folder => {
            try {
                const items = await getFavoriteFolderItemsCached(folder.id, cookie, Math.min(targetLimit, 10), cache, getFavoriteFolderItems, deadline);
                return items.map(item => ({
                    ...item,
                    folder_name: folder.title
                }));
            } catch (error) {
                log('warn', '最近收藏扫描某收藏夹失败', {
                    folderId: folder.id,
                    folderTitle: folder.title,
                    error: error.message
                });
                return [];
            }
        }
    );

    for (const items of folderResults) {
        for (const item of items) {
            candidates.push(item);
        }
    }

    const deduped = [];
    const seen = new Set();
    for (const item of candidates.sort((left, right) => (right.fav_time || 0) - (left.fav_time || 0))) {
        const key = item.bvid || `${item.folder_id}:${item.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(item);
        }
        if (deduped.length >= targetLimit) {
            break;
        }
    }

    return deduped;
}

async function getCoinVideos(mid, cookie, limit, deadline = null) {
    try {
        const response = await requestBiliJson(
            `https://api.bilibili.com/x/space/coin/video?${buildQuery({ vmid: mid })}`,
            { headers: { Cookie: cookie } },
            { label: '投币记录' }
        );
        const data = ensureBiliSuccess(response, '投币记录');
        return (Array.isArray(data) ? data : []).slice(0, clampNumber(limit, 10, 1, 20)).map(item => ({
            aid: item.aid,
            bvid: item.bvid || null,
            title: item.title,
            author: item.author || item.name || '',
            coins: item.coins || 0,
            time: item.time || 0,
            time_str: formatDateTime(item.time || 0)
        }));
    } catch (error) {
        if (!String(error.message).includes('code: 53013')) {
            throw error;
        }
    }

    const fallbackResponse = await requestBiliJson('https://api.bilibili.com/x/member/web/coin/log?jsonp=jsonp', {
        headers: { Cookie: cookie }
    }, {
        label: '投币记录回退'
    });
    const fallback = ensureBiliSuccess(fallbackResponse, '投币记录回退');
    return (Array.isArray(fallback?.list) ? fallback.list : [])
        .slice(0, clampNumber(limit, 10, 1, 20))
        .map(item => ({
            title: item.reason,
            coins: Math.abs(item.delta || 0),
            time: item.time || 0,
            time_str: item.time || ''
        }));
}

async function getVideoDetails(bvid, cookie, deadline = null) {
    const response = await requestBiliJson(
        `https://api.bilibili.com/x/web-interface/view?${buildQuery({ bvid })}`,
        { headers: { Cookie: cookie } },
        { label: `视频详情 ${bvid}` }
    );
    return ensureBiliSuccess(response, `视频详情 ${bvid}`);
}

async function getSubtitleSummary(bvid, cid, aid, cookie, deadline = null) {
    try {
        assertDeadline(deadline, `subtitle ${bvid}`);
        const response = await requestWbiJson(
            'https://api.bilibili.com/x/player/wbi/v2',
            {
                bvid,
                cid,
                aid,
                web_location: 1315873,
                isGaiaAvoided: false
            },
            cookie,
            `字幕信息 ${bvid}`
        );
        const data = ensureBiliSuccess(response, `字幕信息 ${bvid}`);
        const subtitles = data?.subtitle?.subtitles || [];

        if (!Array.isArray(subtitles) || subtitles.length === 0) {
            return null;
        }

        const preferred = subtitles.find(item => item.lan === 'zh-CN')
            || subtitles.find(item => String(item.lan || '').startsWith('zh'))
            || subtitles.find(item => item.lan === 'ai-zh')
            || subtitles[0];

        let subtitleUrl = preferred.subtitle_url;
        if (!subtitleUrl) {
            return null;
        }
        if (subtitleUrl.startsWith('//')) {
            subtitleUrl = `https:${subtitleUrl}`;
        }

        const subtitleResponse = await requestBiliJson(subtitleUrl, {}, {
            label: `字幕正文 ${bvid}`
        });
        if (subtitleResponse.data && subtitleResponse.data.body) {
            const fullText = subtitleResponse.data.body.map(item => item.content).join(' ');
            return trimText(fullText, 500);
        }
    } catch (error) {
        log('warn', `字幕抓取失败 ${bvid}`, { error: error.message });
    }

    return null;
}

function summarizeHistoryPreferences(historyItems) {
    const validItems = historyItems.filter(item => Number.isFinite(item.duration) && item.duration > 0);
    const totalWatchSeconds = validItems.reduce((sum, item) => {
        if (item.progress < 0) {
            return sum + item.duration;
        }
        return sum + Math.min(item.progress || 0, item.duration);
    }, 0);

    const completedVideos = validItems.filter(item => item.is_completed).length;
    const categoryMap = new Map();
    const authorMap = new Map();

    for (const item of historyItems) {
        if (item.tag_name) {
            categoryMap.set(item.tag_name, (categoryMap.get(item.tag_name) || 0) + 1);
        }
        if (item.author) {
            authorMap.set(item.author, (authorMap.get(item.author) || 0) + 1);
        }
    }

    const totalCompletionRate = validItems.length === 0
        ? 0
        : Math.round(validItems.reduce((sum, item) => {
            if (item.progress < 0) {
                return sum + 1;
            }
            return sum + Math.min(1, (item.progress || 0) / item.duration);
        }, 0) / validItems.length * 100);

    return {
        total_videos: historyItems.length,
        total_watch_seconds: totalWatchSeconds,
        total_watch_time_str: formatDuration(totalWatchSeconds) || '0秒',
        avg_completion_rate: totalCompletionRate,
        completed_videos: completedVideos,
        top_categories: Array.from(categoryMap.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((left, right) => right.count - left.count)
            .slice(0, 5),
        top_authors: Array.from(authorMap.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((left, right) => right.count - left.count)
            .slice(0, 5)
    };
}

async function getHistory(cookie, limit = DEFAULT_LIMIT, days = DEFAULT_DAYS, deadline = null) {
    const targetLimit = clampNumber(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const cutoff = Math.floor(Date.now() / 1000) - clampNumber(days, DEFAULT_DAYS, 1, MAX_DAYS) * 86400;
    const items = [];
    const seen = new Set();
    let cursor = null;

    for (let page = 0; page < MAX_HISTORY_PAGES && items.length < targetLimit; page += 1) {
        assertDeadline(deadline, 'history');
        const query = {
            ps: Math.min(targetLimit, MAX_HISTORY_PAGE_SIZE),
            type: 'archive'
        };

        if (cursor) {
            query.max = cursor.max;
            query.view_at = cursor.view_at;
            query.business = cursor.business;
        }

        const response = await requestWbiJson(
            'https://api.bilibili.com/x/web-interface/history/cursor',
            query,
            cookie,
            `浏览历史 第${page + 1}页`
        );
        const data = ensureBiliSuccess(response, `浏览历史 第${page + 1}页`);
        const pageItems = Array.isArray(data?.list) ? data.list : [];

        if (pageItems.length === 0) {
            break;
        }

        let foundOlderItem = false;

        for (const item of pageItems) {
            if ((item.view_at || 0) < cutoff) {
                foundOlderItem = true;
                continue;
            }

            const bvid = item.history?.bvid || item.bvid || null;
            const dedupeKey = bvid || `${item.view_at}:${item.title}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            items.push({
                bvid,
                title: item.title,
                long_title: item.long_title || '',
                author: item.author_name,
                author_mid: item.author_mid,
                view_at: formatDateTime(item.view_at),
                view_at_ts: item.view_at,
                progress: item.progress,
                duration: item.duration || 0,
                duration_str: formatDuration(item.duration || 0),
                progress_str: item.progress < 0 ? '已看完' : formatDuration(item.progress || 0),
                is_completed: item.progress < 0 || (item.duration > 0 && (item.progress || 0) >= item.duration - 5),
                tag_name: item.tag_name || '',
                part: item.history?.part || item.show_title || '',
                badge: item.badge || '',
                description: '',
                subtitle_summary: null
            });

            if (items.length >= targetLimit) {
                break;
            }
        }

        const nextCursor = data?.cursor;
        if (!nextCursor || !nextCursor.max || !nextCursor.view_at) {
            break;
        }

        if (cursor && nextCursor.max === cursor.max && nextCursor.view_at === cursor.view_at) {
            break;
        }

        cursor = nextCursor;

        if (foundOlderItem) {
            break;
        }
    }

    for (let index = 0; index < Math.min(items.length, MAX_HISTORY_ENRICH); index += 1) {
        if (getRemainingMs(deadline) < MIN_ENRICH_REMAINING_MS) {
            log('warn', 'History enrich skipped because execution budget is low', {
                remainingMs: getRemainingMs(deadline),
                enriched: index,
                totalCandidates: Math.min(items.length, MAX_HISTORY_ENRICH)
            });
            break;
        }
        const item = items[index];
        if (!item.bvid) {
            continue;
        }

        try {
            const details = await withTimeout(
                getVideoDetails(item.bvid, cookie, deadline),
                Math.min(REQUEST_TIMEOUT_MS, getRemainingMs(deadline)),
                `video detail ${item.bvid}`
            );
            item.description = trimText(details.desc || '-', 200) || '-';
            if (details.cid && details.aid) {
                item.subtitle_summary = await withTimeout(
                    getSubtitleSummary(item.bvid, details.cid, details.aid, cookie, deadline),
                    Math.min(SUBTITLE_TIMEOUT_MS, getRemainingMs(deadline)),
                    `subtitle ${item.bvid}`
                );
            }
        } catch (error) {
            item.enrich_error = error.message;
            log('warn', '历史记录详情补充失败', { bvid: item.bvid, error: error.message });
        }
    }

    return {
        items,
        preferences: summarizeHistoryPreferences(items)
    };
}

function buildSummary(result) {
    const segments = [];

    if (result.info?.name) {
        segments.push(`用户 ${result.info.name}`);
    }
    if (Array.isArray(result.history)) {
        segments.push(`历史 ${result.history.length} 条`);
    }
    if (Array.isArray(result.favorites)) {
        segments.push(`收藏夹 ${result.favorites.length} 个`);
    }
    if (Array.isArray(result.recent_favorites)) {
        segments.push(`最近收藏 ${result.recent_favorites.length} 条`);
    }
    if (Array.isArray(result.coins)) {
        segments.push(`投币记录 ${result.coins.length} 条`);
    }

    return segments.join('，');
}

async function executeAction(action, context) {
    const { mid, cookie, limit, days, result, cache, deadline } = context;
    assertDeadline(deadline, action);

    switch (action) {
        case 'info':
            result.info = await getUserInfo(mid, cookie, deadline);
            break;
        case 'favorites':
            result.favorites = await getFavorites(mid, cookie, limit, cache, deadline);
            result.folders_count = result.favorites.length;
            break;
        case 'recent_fav':
            result.recent_favorites = await getRecentFavorites(mid, cookie, limit, cache, deadline);
            result.recent_fav_count = result.recent_favorites.length;
            break;
        case 'coins':
            result.coins = await getCoinVideos(mid, cookie, limit, deadline);
            result.coins_count = result.coins.length;
            break;
        case 'history': {
            const history = await getHistory(cookie, limit, days, deadline);
            result.history = history.items;
            result.history_count = history.items.length;
            result.preferences = history.preferences;
            break;
        }
        case 'all': {
            const tasks = [
                { key: 'info', runner: () => executeAction('info', context) },
                { key: 'recent_fav', runner: () => executeAction('recent_fav', context) },
                { key: 'coins', runner: () => executeAction('coins', context) },
                { key: 'history', runner: () => executeAction('history', context) }
            ];

            const settledResults = await Promise.allSettled(tasks.map(task => task.runner()));
            settledResults.forEach((settled, index) => {
                if (settled.status === 'rejected') {
                    const task = tasks[index];
                    result.errors = result.errors || {};
                    result.errors[task.key] = settled.reason?.message || String(settled.reason || 'unknown error');
                }
            });

            try {
                await executeAction('favorites', context);
            } catch (error) {
                result.errors = result.errors || {};
                result.errors.favorites = error.message;
            }
            break;
        }
        default:
            throw new Error(`不支持的 action: ${action}`);
    }
}

async function main() {
    log('info', `${PLUGIN_NAME} Plugin Startup`);

    let inputRaw = '';
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => {
        inputRaw += chunk;
    });

    stdin.on('end', async () => {
        try {
            if (!inputRaw.trim()) {
                throw new Error('输入为空');
            }

            const input = JSON.parse(inputRaw);
            const action = normalizeAction(input.action);
            const limit = clampNumber(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
            const days = clampNumber(input.days, DEFAULT_DAYS, 1, MAX_DAYS);
            const deadline = createDeadline(PLUGIN_TIMEOUT_MS);
            const auth = await resolveAuth(input);

            log('info', '登录验证成功', {
                uname: auth.uname,
                mid: auth.mid,
                source: auth.source
            });

            const result = {
                meta: {
                    action,
                    limit,
                    days,
                    cookie_source: auth.source,
                    executed_at: new Date().toISOString(),
                    timeout_ms: PLUGIN_TIMEOUT_MS,
                    request_timeout_ms: REQUEST_TIMEOUT_MS,
                    subtitle_timeout_ms: SUBTITLE_TIMEOUT_MS
                }
            };

            await executeAction(action, {
                mid: auth.mid,
                cookie: auth.cookie,
                limit,
                days,
                result,
                cache: createExecutionCache(),
                deadline
            });

            result.summary = buildSummary(result);

            const status = result.errors && Object.keys(result.errors).length > 0 && !buildSummary(result)
                ? 'error'
                : 'success';

            writePluginOutput({ status, result });
        } catch (error) {
            log('error', 'Plugin Execution Fatal', { error: error.message });
            writePluginOutput({
                status: 'error',
                error: error.message
            });
        }
    });
}

if (require.main === module) {
    main().catch(error => {
        log('error', 'Unhandled Exception', { error: error.message });
        process.exit(1);
    });
} else {
    module.exports = {
        createExecutionCache,
        collectCookieCandidates,
        formatCandidateSource,
        getFavoriteFolderItemsCached,
        getFavoriteFoldersCached,
        getCookieDiagnostics,
        getCookieFileCandidates,
        mapWithConcurrency,
        resolveAuth,
        sanitizeCookie
    };
}
