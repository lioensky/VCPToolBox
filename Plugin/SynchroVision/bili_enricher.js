const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.bilibili.com/x/web-interface/view?bvid=';
const HISTORY_API_BASE = 'https://api.bilibili.com/x/web-interface/history/cursor';
const COOKIE_FILE = 'www.bilibili.com_cookies.txt';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Netscape Cookie Parser
function getCookieString() {
    try {
        const cookiePath = path.join(__dirname, COOKIE_FILE);
        if (!fs.existsSync(cookiePath)) {
            console.warn('[BiliEnricher] Cookie file not found, running in anonymous mode.');
            return '';
        }

        const content = fs.readFileSync(cookiePath, 'utf8');
        const cookies = content.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(line => {
                const parts = line.split('\t');
                // Netscape format: domain, flag, path, secure, expiration, name, value
                if (parts.length >= 7) {
                    return `${parts[5]}=${parts[6].trim()}`;
                }
                return null;
            })
            .filter(c => c)
            .join('; ');

        return cookies;
    } catch (e) {
        console.error('[BiliEnricher] Failed to load cookies:', e.message);
        return '';
    }
}

const CACHED_COOKIES = getCookieString();

/**
 * Fetches metadata for a single Bilibili video by its BV ID.
 * @param {string} bvid - The Bilibili video ID (e.g., 'BV19LuGzAE2M').
 * @returns {Promise<object>} - A promise that resolves to video metadata.
 */
function fetchMetadata(bvid) {
    return new Promise((resolve) => {
        const url = API_BASE + bvid;

        const headers = {
            'User-Agent': DEFAULT_UA,
            'Referer': 'https://www.bilibili.com/',
            'Accept': 'application/json, text/plain, */*'
        };

        if (CACHED_COOKIES) {
            headers['Cookie'] = CACHED_COOKIES;
        }

        https.get(url, { headers }, (res) => {
            if (res.statusCode === 412) {
                console.warn(`[BiliEnricher] 412 Precondition Failed for ${bvid}. Cookies might be expired.`);
                resolve({ bvid, success: false, error: '412' });
                return;
            }
            if (res.statusCode !== 200) {
                // console.error(`[BiliEnricher] HTTP Error ${res.statusCode} for ${bvid}`);
                resolve({ bvid, success: false, error: `HTTP ${res.statusCode}` });
                return;
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.code === 0 && json.data) {
                        resolve({
                            bvid: bvid,
                            title: json.data.title,
                            owner: json.data.owner.name,
                            desc: json.data.desc ? json.data.desc.substring(0, 50) + '...' : '',
                            pic: json.data.pic, // 封面图 URL
                            success: true
                        });
                    } else {
                        // console.log(`[BiliEnricher] API Error for ${bvid}:`, json.message);
                        resolve({ bvid, success: false, error: json.message });
                    }
                } catch (e) {
                    resolve({ bvid, success: false, error: 'Parse Error' });
                }
            });
        }).on('error', (e) => {
            console.error(`[BiliEnricher] Network Error for ${bvid}:`, e.message);
            resolve({ bvid, success: false, error: e.message });
        });
    });
}

/**
 * Enriches a list of history items by fetching Bilibili video metadata.
 * @param {Array<object>} historyList - List of history items, potentially containing Bilibili URLs.
 * @returns {Promise<Array<object>>} - A promise that resolves to the enriched history list.
 */
async function enrichHistory(historyList) {
    console.log(`[BiliEnricher] Processing ${historyList.length} items for enrichment...`);

    const enrichedList = await Promise.all(historyList.map(async (item) => {
        const match = item.url.match(/\/video\/(BV[a-zA-Z0-9]+)/);

        if (match && match[1]) {
            const bvid = match[1];
            const meta = await fetchMetadata(bvid);
            if (meta.success) {
                return {
                    ...item,
                    title: `[Bilibili] ${meta.title} (@${meta.owner})`,
                    is_video: true,
                    meta: meta
                };
            }
        }
        return item; // Non-Bilibili video or parse failure, return as is
    }));

    return enrichedList;
}

/**
 * Fetches the user's Bilibili viewing history using the official API.
 * @param {number} ps - Page size (number of items to fetch).
 * @returns {Promise<Array<object>>} - A promise that resolves to a list of Bilibili history items.
 */
function fetchBilibiliHistory(ps = 20) {
    return new Promise((resolve) => {
        const url = `${HISTORY_API_BASE}?ps=${ps}`;

        const headers = {
            'User-Agent': DEFAULT_UA,
            'Referer': 'https://www.bilibili.com/',
            'Accept': 'application/json, text/plain, */*'
        };

        if (CACHED_COOKIES) {
            headers['Cookie'] = CACHED_COOKIES;
        } else {
            console.warn('[BiliEnricher] No cookies for Bilibili history API, might fail.');
        }

        https.get(url, { headers }, (res) => {
            if (res.statusCode === 412) {
                console.warn(`[BiliEnricher] 412 Precondition Failed for Bilibili history API. Cookies might be expired or invalid.`);
                resolve([]);
                return;
            }
            if (res.statusCode !== 200) {
                console.error(`[BiliEnricher] HTTP Error ${res.statusCode} for Bilibili history API.`);
                resolve([]);
                return;
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.code === 0 && json.data && Array.isArray(json.data.list)) {
                        const historyItems = json.data.list.map(item => {
                            // Add robust checks for expected properties
                            const title = item.title || 'Untitled';
                            const ownerName = (item.owner && item.owner.name) ? item.owner.name : 'Unknown UP';
                            const url = item.uri || (item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : `https://www.bilibili.com/`);

                            return {
                                source: 'Bilibili_API',
                                title: title,
                                url: url,
                                view_at: new Date(item.view_at * 1000).toLocaleString(),
                                owner: ownerName,
                                cover: item.cover || 'N/A'
                            };
                        });
                        resolve(historyItems);
                    } else {
                        console.warn(`[BiliEnricher] Bilibili history API returned error: ${json.message || 'Unknown error'}`);
                        resolve([]);
                    }
                } catch (e) {
                    console.error('[BiliEnricher] Parse Error for Bilibili history API response:', e.message);
                    resolve([]);
                }
            });
        }).on('error', (e) => {
            console.error('[BiliEnricher] Network Error for Bilibili history API:', e.message);
            resolve([]);
        });
    });
}

module.exports = { enrichHistory, fetchBilibiliHistory };