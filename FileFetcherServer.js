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
    // --- 新增：快速循环检测 ---
    const now = Date.now();
    if (recentRequests.has(fileUrl)) {
        const lastRequestTime = recentRequests.get(fileUrl);
        if (now - lastRequestTime < REQ_CACHE_EXPIRATION_MS) {
            recentRequests.set(fileUrl, now); // 更新时间戳以便后续的连锁错误能够显示最新的时间
            throw new Error(`在 ${REQ_CACHE_EXPIRATION_MS}ms 内检测到对同一文件 '${fileUrl}' 的重复请求。为防止无限循环，已中断操作。`);
        }
    }
    recentRequests.set(fileUrl, now);
    // 在一段时间后清除缓存以防内存泄漏
    setTimeout(() => {
        if (recentRequests.get(fileUrl) === now) {
            recentRequests.delete(fileUrl);
        }
    }, REQ_CACHE_EXPIRATION_MS * 2);
    // --- 快速循环检测结束 ---

    if (!fileUrl.startsWith('file://')) {
        throw new Error('FileFetcher 目前只支持 file:// 协议。');
    }

    const filePath = fileURLToPath(fileUrl);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';

    // --- 健壮的缓存逻辑 ---
    const cacheKey = crypto.createHash('sha256').update(filePath).digest('hex');
    const originalExtension = path.extname(filePath);
    const cachedFilePath = path.join(CACHE_DIR, cacheKey + originalExtension);

    // 1. 尝试从本地缓存读取
    try {
        const buffer = await fs.readFile(cachedFilePath);
        console.log(`[FileFetcherServer] 成功从本地缓存读取文件: ${cachedFilePath} (原始路径: ${filePath})`);
        return { buffer, mimeType };
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new Error(`读取缓存文件时发生意外错误: ${e.message}`);
        }
        // 缓存未命中，继续执行
    }

    // 2. 尝试直接读取本地文件 (以防主服务器有直接访问权限)
    try {
        const buffer = await fs.readFile(filePath);
        console.log(`[FileFetcherServer] 成功直接读取本地文件: ${filePath}`);
        return { buffer, mimeType };
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new Error(`读取本地文件时发生意外错误: ${e.message}`);
        }
        console.log(`[FileFetcherServer] 本地文件未找到: ${filePath}。将尝试从来源服务器获取。`);
    }

    // 3. 本地文件不存在，尝试从来源的分布式服务器获取

    // --- 检查失败缓存以防止循环 ---
    const cachedFailure = failedFetchCache.get(fileUrl);
    if (cachedFailure) {
        if (Date.now() - cachedFailure.timestamp < CACHE_EXPIRATION_MS) {
            // 缓存仍然有效，直接抛出错误
            throw new Error(`文件获取在短时间内已失败，为防止循环已中断。错误: ${cachedFailure.error}`);
        } else {
            // 缓存已过期，将其删除，然后继续尝试获取
            failedFetchCache.delete(fileUrl);
        }
    }

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
        const result = await webSocketServer.executeDistributedTool(serverId, 'internal_request_file', { filePath }, 60000);

        if (result && result.status === 'success' && result.fileData) {
            console.log(`[FileFetcherServer] 成功从服务器 ${serverId} 获取到文件 ${filePath} 的 Base64 数据。`);
            const buffer = Buffer.from(result.fileData, 'base64');

            // --- 将获取的文件写入健壮的本地缓存 ---
            try {
                await fs.writeFile(cachedFilePath, buffer);
                console.log(`[FileFetcherServer] 已将获取的文件缓存到本地: ${cachedFilePath}`);
            } catch (writeError) {
                // 这个错误现在不应再发生，但保留日志以防万一
                console.error(`[FileFetcherServer] 无法将获取的文件写入本地缓存: ${writeError.message}`);
            }

            return {
                buffer: buffer,
                mimeType: result.mimeType || mimeType
            };
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