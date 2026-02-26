// FileFetcherServer.js
const fs = require('fs').promises;
const { fileURLToPath } = require('url');
const mime = require('mime-types');
const path = require('path');
const crypto = require('crypto');

const failedFetchCache = new Map();
const CACHE_EXPIRATION_MS = 30000; // 30秒内防止重复失败请求
const CACHE_DIR = path.join(__dirname, '.file_cache');
const recentRequests = new Map(); // 新增：用于检测快速循环的请求缓存
const REQ_CACHE_EXPIRATION_MS = 5000; // 5秒内重复请求视为潜在循环

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
 * 获取文件的 Buffer 和 MIME 类型。
 * 如果是本地文件且不存在，则尝试通过 WebSocket 从来源分布式服务器获取。
 * @param {string} fileUrl - 文件的 URL (file://...)
 * @param {string} requestIp - 发起原始请求的客户端 IP
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function fetchFile(fileUrl, requestIp) {
    // --- 快速循环检测 (保留) ---
    const now = Date.now();
    if (recentRequests.has(fileUrl)) {
        const lastRequestTime = recentRequests.get(fileUrl);
        if (now - lastRequestTime < REQ_CACHE_EXPIRATION_MS) {
            recentRequests.set(fileUrl, now);
            throw new Error(`在 ${REQ_CACHE_EXPIRATION_MS}ms 内检测到对同一文件 '${fileUrl}' 的重复请求。为防止无限循环，已中断操作。`);
        }
    }
    recentRequests.set(fileUrl, now);
    setTimeout(() => {
        if (recentRequests.get(fileUrl) === now) {
            recentRequests.delete(fileUrl);
        }
    }, REQ_CACHE_EXPIRATION_MS * 2);
    // --- 快速循环检测结束 ---

    if (!fileUrl.startsWith('file://')) {
        throw new Error('FileFetcher 目前只支持 file:// 协议。');
    }

    // --- 平台无关的缓存逻辑 ---
    // 关键：直接使用原始 fileUrl 作为缓存键，不进行任何本地解析。
    const cacheKey = crypto.createHash('sha256').update(fileUrl).digest('hex');
    let originalExtension = '';
    try {
        // 以平台无关的方式从URL中提取路径名以获取扩展名
        const pathname = new URL(fileUrl).pathname;
        originalExtension = path.extname(pathname);
    } catch (e) {
        console.warn(`[FileFetcherServer] 无法从URL解析路径名以获取扩展名: ${fileUrl}`);
    }
    const cachedFilePath = path.join(CACHE_DIR, cacheKey + originalExtension);

    // 1. 尝试从本地缓存读取
    try {
        const buffer = await fs.readFile(cachedFilePath);
        const mimeType = mime.lookup(cachedFilePath) || 'application/octet-stream';
        console.log(`[FileFetcherServer] 成功从本地缓存读取文件: ${cachedFilePath} (原始URL: ${fileUrl})`);
        return { buffer, mimeType };
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new Error(`读取缓存文件时发生意外错误: ${e.message}`);
        }
        // 缓存未命中，继续从远程获取
        console.log(`[FileFetcherServer] URL缓存未命中: ${fileUrl}。将尝试从来源服务器获取。`);
    }

    // 2. 缓存未命中，优先尝试主服务器本地读取（单机/本机客户端场景）
    // 若本地不存在或不可读，再回退到分布式超栈追踪链路。
    try {
        const localFilePath = fileURLToPath(fileUrl);
        const localBuffer = await fs.readFile(localFilePath);
        const localMimeType = mime.lookup(localFilePath) || 'application/octet-stream';
        console.log(`[FileFetcherServer] 本地直读成功: ${localFilePath}`);

        try {
            await fs.writeFile(cachedFilePath, localBuffer);
            console.log(`[FileFetcherServer] 已将本地文件缓存到: ${cachedFilePath}`);
        } catch (writeError) {
            console.error(`[FileFetcherServer] 本地文件缓存写入失败: ${writeError.message}`);
        }

        return { buffer: localBuffer, mimeType: localMimeType };
    } catch (localReadError) {
        const localErrorCode = localReadError && localReadError.code ? localReadError.code : 'UNKNOWN';
        console.log(`[FileFetcherServer] 本地直读未命中或失败 (${localErrorCode})，回退到分布式拉取: ${fileUrl}`);
    }

    // 3. 本地直读失败后，回退到来源分布式服务器获取

    // --- 失败缓存逻辑 (保留) ---
    const cachedFailure = failedFetchCache.get(fileUrl);
    if (cachedFailure && (Date.now() - cachedFailure.timestamp < CACHE_EXPIRATION_MS)) {
        throw new Error(`文件获取在短时间内已失败，为防止循环已中断。错误: ${cachedFailure.error}`);
    }
    failedFetchCache.delete(fileUrl);

    if (!requestIp) {
        throw new Error('无法确定请求来源，因为缺少 requestIp。');
    }
    if (!webSocketServer) {
        throw new Error('FileFetcherServer 尚未初始化。');
    }

    const serverId = webSocketServer.findServerByIp(requestIp);
    if (!serverId) {
        throw new Error(`根据IP [${requestIp}] 未找到任何已知的分布式服务器。`);
    }
    
    console.log(`[FileFetcherServer] 确定文件来源服务器为: ${serverId} (IP: ${requestIp})。正在请求文件...`);

    try {
        // 关键：将原始的、未经修改的 fileUrl 作为参数传递给远程工具。
        const result = await webSocketServer.executeDistributedTool(serverId, 'internal_request_file', { fileUrl: fileUrl }, 60000);

        if (result && result.status === 'success' && result.fileData) {
            console.log(`[FileFetcherServer] 成功从服务器 ${serverId} 获取到文件 ${fileUrl} 的 Base64 数据。`);
            const buffer = Buffer.from(result.fileData, 'base64');

            // 将获取的文件写入本地缓存
            try {
                await fs.writeFile(cachedFilePath, buffer);
                console.log(`[FileFetcherServer] 已将获取的文件缓存到本地: ${cachedFilePath}`);
            } catch (writeError) {
                console.error(`[FileFetcherServer] 无法将获取的文件写入本地缓存: ${writeError.message}`);
            }

            const mimeType = result.mimeType || mime.lookup(originalExtension) || 'application/octet-stream';
            return { buffer, mimeType };
        } else {
            const errorMsg = result ? result.error : '未知错误';
            throw new Error(`从服务器 ${serverId} 获取文件失败: ${errorMsg}`);
        }
    } catch (e) {
        failedFetchCache.set(fileUrl, {
            timestamp: Date.now(),
            error: e.message
        });
        throw new Error(`通过 WebSocket 从服务器 ${serverId} 请求文件时发生错误: ${e.message}`);
    }
}

module.exports = { initialize, fetchFile };