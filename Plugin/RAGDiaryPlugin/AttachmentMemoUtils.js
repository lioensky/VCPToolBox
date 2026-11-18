'use strict';

const fs = require('fs').promises;
const axios = require('axios');
const mime = require('mime-types');

/**
 * 从召回文本中提取可作为 Base64Memo 注入的附件链接。
 * 支持 http / https / file 协议，并排除表情包、emoji、sticker 路径。
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractAttachments(text) {
    if (!text) return [];

    const regex = /(https?:\/\/[^\s\)\"\'\>]+|file:\/\/[^\s\)\"\'\>]+)/gi;
    const matches = text.match(regex) || [];

    return matches.filter(url => {
        const lowerUrl = url.toLowerCase();

        if (lowerUrl.includes('表情包') || lowerUrl.includes('emoji') || lowerUrl.includes('sticker')) {
            return false;
        }

        return /\.(jpg|jpeg|png|gif|webp|mp3|wav|ogg|mp4|webm|pdf)$/i.test(lowerUrl);
    });
}

/**
 * 获取链接内容并转为 data URI base64。
 *
 * @param {string} url
 * @param {object} [options]
 * @param {Console} [options.logger]
 * @returns {Promise<string|null>}
 */
async function fetchAsBase64(url, options = {}) {
    const logger = options.logger || console;

    try {
        let buffer;
        let mimeType;

        if (url.startsWith('file://')) {
            let filePath = url.replace(/^file:\/\/\/?/, '');

            try {
                filePath = decodeURIComponent(filePath);
            } catch (e) {
                // ignore malformed URI escape
            }

            buffer = await fs.readFile(filePath);
            mimeType = mime.lookup(filePath) || 'application/octet-stream';
        } else {
            const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
            buffer = Buffer.from(response.data);
            mimeType = response.headers['content-type'] || mime.lookup(url) || 'application/octet-stream';
        }

        if (buffer) {
            const base64 = buffer.toString('base64');
            return `data:${mimeType};base64,${base64}`;
        }
    } catch (e) {
        logger.error(`[RAGDiaryPlugin] 🌟 V7: 获取附件 Base64 失败 (${url}):`, e.message);
    }

    return null;
}

module.exports = {
    extractAttachments,
    fetchAsBase64
};