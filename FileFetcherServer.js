// FileFetcherServer.js
const fs = require('fs').promises;
const { fileURLToPath } = require('url');
const mime = require('mime-types');

// 存储对 WebSocketServer 的引用
let webSocketServer = null;

/**
 * 初始化 FileFetcherServer，注入依赖。
 * @param {object} wss - WebSocketServer 的实例
 */
function initialize(wss) {
    if (!wss || typeof wss.findServerByIp !== 'function' || typeof wss.executeDistributedTool !== 'function') {
        throw new Error('FileFetcherServer 初始化失败：传入的 WebSocketServer 实例无效。');
    }
    webSocketServer = wss;
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
    if (!fileUrl.startsWith('file://')) {
        throw new Error('FileFetcher 目前只支持 file:// 协议。');
    }

    const filePath = fileURLToPath(fileUrl);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';

    // 1. 尝试直接读取本地文件
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

    // 2. 本地文件不存在，尝试从来源的分布式服务器获取
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
            return {
                buffer: Buffer.from(result.fileData, 'base64'),
                mimeType: result.mimeType || mimeType
            };
        } else {
            const errorMsg = result ? result.error : '未知错误';
            throw new Error(`从服务器 ${serverId} 获取文件失败: ${errorMsg}`);
        }
    } catch (e) {
        throw new Error(`通过 WebSocket 从服务器 ${serverId} 请求文件时发生错误: ${e.message}`);
    }
}

module.exports = { initialize, fetchFile };