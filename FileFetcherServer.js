// FileFetcherServer.js
const fs = require('fs').promises;
const { fileURLToPath } = require('url');
const mime = require('mime-types');
const path = require('path');
const crypto = require('crypto');

const failedFetchCache = new Map();
const CACHE_EXPIRATION_MS = 30000; // 30秒内防止重复失败请求
const CACHE_DIR = path.join(__dirname, '.file_cache');
const recentRequests = new Map(); // 用于检测未命中缓存时的快速死循环请求
const REQ_CACHE_EXPIRATION_MS = 5000; // 5秒内重复穿透缓存请求视为潜在循环
const inFlightFetches = new Map(); // Singleflight: 合并同一来源+URL的并发拉取Promise

// 存储对 WebSocketServer 的引用
let webSocketServer = null;

/**
 * 初始化 FileFetcherServer，注入依赖。
 * @param {object} wss - WebSocketServer 的实例
 */
async function initialize(wss) {
    if (!wss || typeof wss.findServerByIp !== 'function' || typeof wss.executeDistributedTool !== 'function') {
        throw new Error('FileFetcherServer 初始化失败：传入的 WebSocketServer 实例无效。');
    }
    webSocketServer = wss;
    // 确保缓存目录存在
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        console.log(`[FileFetcherServer] Cache directory ensured at: ${CACHE_DIR}`);
    } catch (e) {
        console.error(`[FileFetcherServer] Failed to create cache directory: ${e.message}`);
    }
    console.log('[FileFetcherServer] Initialized and linked with WebSocketServer.');
}

/**
 * 归一化请求来源 IP：剥离 ::ffff: 映射前缀并将 ::1 视同 127.0.0.1，
 * 避免同一本机双栈回环在缓存/限流键中分裂。
 * @param {string|null|undefined} ip
 * @returns {string}
 */
function normalizeRequestIp(ip) {
    if (typeof ip !== 'string') return '';
    const trimmed = ip.trim();
    const v4 = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
    return v4 === '::1' ? '127.0.0.1' : v4;
}

/**
 * 安全提取 VCPChat 内容寻址附件的 SHA-256（64 位十六进制文件名）。
 * 先归一化分隔符并切出 basename 再单独解码，即使父目录含未转义 '%' 也不影响附件识别，
 * 同时避免抛出 URIError，并兼容无扩展名及大小写十六进制。
 * @param {string} fileUrl
 * @returns {string|null}
 */
function extractAttachmentSha256(fileUrl) {
    if (typeof fileUrl !== 'string') return null;
    let rawPath = fileUrl;
    try {
        rawPath = new URL(fileUrl).pathname;
    } catch {
        // 无法按标准 URL 解析时沿用原字符串兜底
    }
    const normalizedSeparators = rawPath
        .replace(/\\/g, '/')
        .replace(/%(?:2f|5c)/gi, '/');
    let baseName = path.posix.basename(normalizedSeparators);
    try {
        baseName = decodeURIComponent(baseName);
    } catch {
        // 含未转义 '%'（如 100%_report.png）时原样降级，避免抛出 URIError
    }
    const match = baseName.match(/^([0-9a-fA-F]{64})(?:\.[A-Za-z0-9_-]+)?$/);
    return match ? match[1].toLowerCase() : null;
}

/**
 * 计算本地缓存文件路径。
 * - 内容寻址附件（文件名即 SHA-256 且入库强校验哈希）跨节点内容恒等，按 fileUrl 寻址；
 * - 非附件普通路径按归一化 requestIp + fileUrl 隔离，防止不同机器同路径文件跨租户缓存串台。
 * @param {string} fileUrl
 * @param {string} requestIp
 * @param {string|null} [precomputedAttachHash]
 * @returns {{ cacheKey: string, originalExtension: string, cachedFilePath: string, attachHash: string|null }}
 */
function getCachedFileInfo(fileUrl, requestIp, precomputedAttachHash) {
    const attachHash = precomputedAttachHash !== undefined
        ? precomputedAttachHash
        : extractAttachmentSha256(fileUrl);
    const normalizedIp = normalizeRequestIp(requestIp);
    const cacheKeySeed = attachHash
        ? fileUrl
        : `${normalizedIp || 'noip'}::${fileUrl}`;
    const cacheKey = crypto.createHash('sha256').update(cacheKeySeed).digest('hex');

    let originalExtension = '';
    try {
        const pathname = new URL(fileUrl).pathname.replace(/\\/g, '/');
        const ext = path.posix.extname(pathname);
        if (/^\.[A-Za-z0-9_-]{1,16}$/.test(ext)) {
            originalExtension = ext;
        }
    } catch {
        console.warn(`[FileFetcherServer] 无法从URL解析路径名以获取扩展名: ${fileUrl}`);
    }
    const cachedFilePath = path.join(CACHE_DIR, cacheKey + originalExtension);
    return { cacheKey, originalExtension, cachedFilePath, attachHash };
}

/**
 * 原子写入缓存文件（先写同目录唯一 .tmp 再 rename），
 * 防止并发 resolveFileUrl 的 fs.access 命中正在写入的半截损坏文件（Torn Read）。
 * @param {string} cachedFilePath
 * @param {Buffer} buffer
 */
async function writeCacheFileAtomically(cachedFilePath, buffer) {
    const tempPath = `${cachedFilePath}.${process.pid}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fs.writeFile(tempPath, buffer);
        await fs.rename(tempPath, cachedFilePath);
    } catch (err) {
        try {
            await fs.unlink(tempPath);
        } catch {
            // ignore cleanup error
        }
        throw err;
    }
}

/**
 * 获取文件的 Buffer 和 MIME 类型。
 * 如果是本地文件且不存在，则尝试通过 WebSocket 从来源分布式服务器获取。
 * @param {string} fileUrl - 文件的 URL (file://...)
 * @param {string} requestIp - 发起原始请求的客户端 IP
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function fetchFile(fileUrl, requestIp) {
    if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) {
        throw new Error('FileFetcher 目前只支持 file:// 协议。');
    }

    const normalizedIpKey = normalizeRequestIp(requestIp) || 'noip';
    const requestScopedKey = `${normalizedIpKey}::${fileUrl}`;
    const { originalExtension, cachedFilePath, attachHash } = getCachedFileInfo(fileUrl, requestIp);

    // 1. 优先尝试从本地缓存读取（已落盘缓存直接 O(1) 返回，不受 5s 防循环定时器误伤）
    try {
        const buffer = await fs.readFile(cachedFilePath);
        const mimeType = mime.lookup(cachedFilePath) || 'application/octet-stream';
        console.log(`[FileFetcherServer] 成功从本地缓存读取文件: ${cachedFilePath} (原始URL: ${fileUrl})`);
        return { buffer, mimeType };
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new Error(`读取缓存文件时发生意外错误: ${e.message}`);
        }
        console.log(`[FileFetcherServer] URL缓存未命中: ${fileUrl}。将尝试从来源服务器获取。`);
    }

    // 2. Singleflight 并发合并：同一 Turn 多工具并发请求同一未缓存文件时共享同一个拉取 Promise
    if (inFlightFetches.has(requestScopedKey)) {
        console.log(`[FileFetcherServer] 复用正在进行的并发拉取请求: ${fileUrl} (IP: ${requestIp || 'N/A'})`);
        return await inFlightFetches.get(requestScopedKey);
    }

    // 3. 失败缓存熔断逻辑（30s，按来源 IP + URL 隔离）
    const cachedFailure = failedFetchCache.get(requestScopedKey);
    if (cachedFailure && (Date.now() - cachedFailure.timestamp < CACHE_EXPIRATION_MS)) {
        throw new Error(`文件获取在短时间内已失败，为防止循环已中断。错误: ${cachedFailure.error}`);
    }
    failedFetchCache.delete(requestScopedKey);

    // 4. 快速循环检测（防缓存写盘失败或异常重入时的 5s 内死循环）
    const now = Date.now();
    if (recentRequests.has(requestScopedKey)) {
        const lastRequestTime = recentRequests.get(requestScopedKey);
        if (now - lastRequestTime < REQ_CACHE_EXPIRATION_MS) {
            recentRequests.set(requestScopedKey, now);
            throw new Error(`在 ${REQ_CACHE_EXPIRATION_MS}ms 内检测到对同一文件 '${fileUrl}' 的重复请求。为防止无限循环，已中断操作。`);
        }
    }
    recentRequests.set(requestScopedKey, now);
    const recentTimer = setTimeout(() => {
        if (recentRequests.get(requestScopedKey) === now) {
            recentRequests.delete(requestScopedKey);
        }
    }, REQ_CACHE_EXPIRATION_MS * 2);
    if (typeof recentTimer.unref === 'function') {
        recentTimer.unref();
    }

    if (!requestIp) {
        throw new Error('无法确定请求来源，因为缺少 requestIp。');
    }
    if (!webSocketServer) {
        throw new Error('FileFetcherServer 尚未初始化。');
    }

    const remotePromise = (async () => {
        // 1) 自报真实 IP 唯一锁定的节点允许直接拉取；
        // 2) 未能唯一锁定时（如经 FRP/SSH 隧道、反代 127.0.0.1 或多机共享公网 NAT），不信任连接跳 IP 代表身份，
        //    一律仅对 VCPChat 内容寻址附件（64位内容 sha256）询问同源候选节点并强制校验内容哈希；
        //    非附件普通路径绝不跨机盲拉，杜绝多用户反代/隧道下的跨机文件越权读取。
        const primary = webSocketServer.findServerByIp(requestIp);
        let candidates = primary ? [primary] : [];
        if (!primary && attachHash) {
            const candidateSet = new Set();
            if (typeof webSocketServer.findServersByReportedIp === 'function') {
                for (const id of webSocketServer.findServersByReportedIp(requestIp)) {
                    candidateSet.add(id);
                }
            }
            if (typeof webSocketServer.findServersByConnectionIp === 'function') {
                for (const id of webSocketServer.findServersByConnectionIp(requestIp)) {
                    candidateSet.add(id);
                }
            }
            candidates = Array.from(candidateSet);
        }
        if (candidates.length === 0) {
            throw new Error(`根据IP [${requestIp}] 未找到任何已知的分布式服务器。`);
        }
        const errors = [];
        for (const serverId of candidates) {
            console.log(`[FileFetcherServer] 确定文件来源服务器为: ${serverId} (IP: ${requestIp})。正在请求文件...`);
            try {
                // 关键：将原始的、未经修改的 fileUrl 作为参数传递给远程工具。
                const result = await webSocketServer.executeDistributedTool(serverId, 'internal_request_file', { fileUrl: fileUrl }, 60000);
                if (!(result && result.status === 'success' && typeof result.fileData === 'string' && result.fileData.length > 0)) {
                    throw new Error(result ? result.error : '未知错误');
                }
                const buffer = Buffer.from(result.fileData, 'base64');
                if (attachHash && crypto.createHash('sha256').update(buffer).digest('hex') !== attachHash) {
                    throw new Error('内容哈希与附件文件名不符');
                }
                console.log(`[FileFetcherServer] 成功从服务器 ${serverId} 获取到文件 ${fileUrl} 的 Base64 数据。`);

                // 原子写入本地缓存，避免并发读取到半截文件
                try {
                    await writeCacheFileAtomically(cachedFilePath, buffer);
                    console.log(`[FileFetcherServer] 已将获取的文件缓存到本地: ${cachedFilePath}`);
                } catch (writeError) {
                    console.error(`[FileFetcherServer] 无法将获取的文件写入本地缓存: ${writeError.message}`);
                }

                const mimeType = result.mimeType || mime.lookup(originalExtension) || 'application/octet-stream';
                return { buffer, mimeType };
            } catch (e) {
                errors.push(`${serverId}: ${e.message}`);
            }
        }
        const errorMsg = errors.join('；');
        failedFetchCache.set(requestScopedKey, {
            timestamp: Date.now(),
            error: errorMsg
        });
        throw new Error(`通过 WebSocket 请求文件失败: ${errorMsg}`);
    })();

    inFlightFetches.set(requestScopedKey, remotePromise);
    try {
        return await remotePromise;
    } finally {
        if (inFlightFetches.get(requestScopedKey) === remotePromise) {
            inFlightFetches.delete(requestScopedKey);
        }
    }
}
/**
 * 解析并确保文件存在于本地。
 * 如果本地路径存在，直接返回原始 URL。
 * 如果不存在，触发 fetchFile 获取缓存，并返回指向缓存的 file:// URL。
 * @param {string} fileUrl 文件的 URL (file://...)
 * @param {string} requestIp 发起原始请求的客户端 IP
 * @returns {Promise<string>} 返回最终的本地可用 file:// URL
 */
async function resolveFileUrl(fileUrl, requestIp) {
    if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) {
        return fileUrl; // 非 file 协议原样返回
    }

    let filePath;
    try {
        filePath = fileURLToPath(fileUrl);
    } catch (e) {
        console.warn(`[FileFetcherServer] Invalid local file URL: ${fileUrl}`);
        return fileUrl;
    }

    try {
        // 尝试判断此文件的实体是否存在于这个本地文件系统上
        await fs.access(filePath);
        return fileUrl; // 本地存在，直接返回给插件读取
    } catch {
        // 本地不存在，说明是跨服务器调用的文件，触发拉取机制！
        const { cachedFilePath } = getCachedFileInfo(fileUrl, requestIp);
        try {
            await fs.access(cachedFilePath);
            // 缓存文件已存在（由于采用原子 rename，可见即完整）！直接返回指向缓存的 file URL
            const cachedUrl = require('url').pathToFileURL(cachedFilePath).href;
            console.log(`[FileFetcherServer] File already exists in local cache, bypassing remote fetch: ${cachedUrl}`);
            return cachedUrl;
        } catch {
            console.log(`[FileFetcherServer] ${filePath} not found locally or in cache, initiating pre-fetch...`);

            try {
                // 调用 fetchFile 将文件写到 CACHE_DIR
                await fetchFile(fileUrl, requestIp);

                // 构造指向此缓存文件的 file URL
                const cachedUrl = require('url').pathToFileURL(cachedFilePath).href;
                console.log(`[FileFetcherServer] Pre-fetched file wrapped to local cache url: ${cachedUrl}`);
                return cachedUrl;

            } catch (fetchError) {
                console.warn(`[FileFetcherServer] Pre-fetch failed for ${fileUrl}, falling back to original URL: ${fetchError.message}`);
                // 获取失败不再抛出错误，而是原样返回原始 URL，让插件/工具自行处理
                return fileUrl;
            }
        }
    }
}

module.exports = {
    initialize,
    fetchFile,
    resolveFileUrl,
    // Narrow test hooks for deterministic unit & isolation tests; not used by production callers.
    __testing: {
        normalizeRequestIp,
        extractAttachmentSha256,
        getCachedFileInfo,
        writeCacheFileAtomically,
        failedFetchCache,
        recentRequests,
        inFlightFetches,
        CACHE_DIR
    }
};