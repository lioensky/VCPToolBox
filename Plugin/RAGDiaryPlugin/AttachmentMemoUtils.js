'use strict';

const fs = require('fs').promises;
const axios = require('axios');
const mime = require('mime-types');

let sharpModule = null;
function getSharp() {
    if (sharpModule !== null) return sharpModule;
    try {
        sharpModule = require('sharp');
    } catch {
        sharpModule = false;
    }
    return sharpModule || null;
}

const DEFAULT_MAX_SIZE_MB = 20;
const DEFAULT_COMPRESS_THRESHOLD_MB = 4;
const DEFAULT_COMPRESS_MAX_DIMENSION = 2048;
const DEFAULT_COMPRESS_QUALITY = 85;

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
 * 规范化日记来源路径为 file:/// 超栈追踪格式。
 *
 * @param {object} entry
 * @param {string} [fallbackDiaryName]
 * @returns {{ sourcePath: string, diaryName: string }}
 */
function resolveEntrySourceMeta(entry, fallbackDiaryName = '') {
    const rawPath = entry?.fullPath || entry?.sourceFile || entry?.path || '';
    const diaryName = String(entry?.dbName || fallbackDiaryName || '').trim();
    if (!rawPath) {
        return { sourcePath: '', diaryName };
    }
    const normalized = String(rawPath).replace(/\\/g, '/').trim();
    const sourcePath = normalized.startsWith('file://')
        ? normalized
        : `file:///${normalized.replace(/^\/+/, '')}`;
    return { sourcePath, diaryName };
}

/**
 * 从结构化检索结果数组或格式化文本中提取带日记来源路径的附件列表。
 *
 * @param {Array<object>} results
 * @param {string} [fallbackText]
 * @param {string} [diaryName]
 * @returns {Array<{ url: string, sourcePath: string, diaryName: string }>}
 */
function extractAttachmentsFromResults(results, fallbackText = '', diaryName = '') {
    const items = [];
    const seenInBatch = new Set();

    if (Array.isArray(results) && results.length > 0) {
        for (const entry of results) {
            const entryText = entry?.text || '';
            const urls = extractAttachments(entryText);
            if (urls.length === 0) continue;
            const { sourcePath, diaryName: resolvedDiary } = resolveEntrySourceMeta(entry, diaryName);
            for (const url of urls) {
                if (seenInBatch.has(url)) continue;
                seenInBatch.add(url);
                items.push({
                    url,
                    sourcePath,
                    diaryName: resolvedDiary
                });
            }
        }
    }

    if (items.length === 0 && fallbackText) {
        // 回退：从格式化后的文本块中按段落匹配紧随其后的 [路径: file:///...]
        const lines = String(fallbackText).split(/\r?\n/);
        let pendingUrls = [];
        for (const line of lines) {
            const pathMatch = line.match(/\[路径:\s*(file:\/\/\/[^\]]+)\]/i);
            if (pathMatch && pendingUrls.length > 0) {
                const sourcePath = pathMatch[1].trim();
                for (const url of pendingUrls) {
                    if (seenInBatch.has(url)) continue;
                    seenInBatch.add(url);
                    items.push({ url, sourcePath, diaryName: String(diaryName || '').trim() });
                }
                pendingUrls = [];
                continue;
            }
            const lineUrls = extractAttachments(line);
            if (lineUrls.length > 0) {
                pendingUrls.push(...lineUrls);
            }
        }
        for (const url of pendingUrls) {
            if (seenInBatch.has(url)) continue;
            seenInBatch.add(url);
            items.push({ url, sourcePath: '', diaryName: String(diaryName || '').trim() });
        }
    }

    return items;
}

function formatSizeMB(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * 构建紧邻附件图片的日记溯源与压缩说明文本。
 *
 * @param {object} meta
 * @param {string} [meta.sourcePath]
 * @param {string} [meta.diaryName]
 * @param {boolean} [meta.compressed]
 * @param {number} [meta.originalBytes]
 * @param {number} [meta.finalBytes]
 * @param {number} [meta.index]
 * @param {number} [meta.total]
 * @returns {string}
 */
function formatAttachmentSourceNote(meta = {}) {
    const indexPrefix = (Number.isFinite(meta.index) && Number.isFinite(meta.total) && meta.total > 1)
        ? `(${meta.index}/${meta.total}) `
        : '';
    const diaryLabel = meta.diaryName ? `《${meta.diaryName}》` : '';
    const pathLabel = meta.sourcePath
        ? `${diaryLabel ? ' ' : ''}${meta.sourcePath}`
        : (diaryLabel || '日记记忆库');
    const compressClause = (meta.compressed && Number.isFinite(meta.originalBytes) && Number.isFinite(meta.finalBytes))
        ? `，原图 ${formatSizeMB(meta.originalBytes)} 已自适应压缩至 ${formatSizeMB(meta.finalBytes)}`
        : '';

    return `[日记召回附件图片${indexPrefix}：源自 ${diaryLabel}${pathLabel}${compressClause}]`;
}

/**
 * 获取附件内容，执行硬上限检查（默认 20MB）与自适应图像瘦身（默认 >4MB 触发压缩），返回详细元数据。
 *
 * @param {string} url
 * @param {object} [options]
 * @param {Console} [options.logger]
 * @param {number} [options.maxSizeMB] - 硬上限 MB（<=0 表示不设上限，默认读取 BASE64_MEMO_MAX_SIZE_MB 或 20）
 * @param {number} [options.compressThresholdMB] - 自适应压缩阈值 MB（<=0 表示关闭压缩，默认读取 BASE64_MEMO_COMPRESS_THRESHOLD_MB 或 4）
 * @param {number} [options.maxDimension] - 压缩时最长边像素上限（默认 2048）
 * @param {number} [options.quality] - 压缩质量（默认 85）
 * @param {Function} [options.sharpImpl] - 可选注入的 sharp 实现（便于测试）
 * @returns {Promise<{ dataUri: string, mimeType: string, originalBytes: number, finalBytes: number, compressed: boolean, skippedReason: string|null }|null>}
 */
async function fetchAttachmentWithMeta(url, options = {}) {
    const logger = options.logger || console;

    const envMaxMB = process.env.BASE64_MEMO_MAX_SIZE_MB !== undefined && process.env.BASE64_MEMO_MAX_SIZE_MB !== ''
        ? Number(process.env.BASE64_MEMO_MAX_SIZE_MB)
        : NaN;
    const maxSizeMB = Number.isFinite(Number(options.maxSizeMB))
        ? Number(options.maxSizeMB)
        : (Number.isFinite(envMaxMB) ? envMaxMB : DEFAULT_MAX_SIZE_MB);
    const maxSizeBytes = maxSizeMB > 0 ? Math.floor(maxSizeMB * 1024 * 1024) : Infinity;

    const envCompressMB = process.env.BASE64_MEMO_COMPRESS_THRESHOLD_MB !== undefined && process.env.BASE64_MEMO_COMPRESS_THRESHOLD_MB !== ''
        ? Number(process.env.BASE64_MEMO_COMPRESS_THRESHOLD_MB)
        : NaN;
    const compressThresholdMB = Number.isFinite(Number(options.compressThresholdMB))
        ? Number(options.compressThresholdMB)
        : (Number.isFinite(envCompressMB) ? envCompressMB : DEFAULT_COMPRESS_THRESHOLD_MB);
    const compressThresholdBytes = compressThresholdMB > 0 ? Math.floor(compressThresholdMB * 1024 * 1024) : Infinity;

    const maxDimension = Math.max(256, Number(options.maxDimension) || DEFAULT_COMPRESS_MAX_DIMENSION);
    const quality = Math.min(100, Math.max(10, Number(options.quality) || DEFAULT_COMPRESS_QUALITY));

    try {
        let buffer;
        let mimeType;

        if (url.startsWith('file://')) {
            let filePath = url.replace(/^file:\/\/\/?/, '');
            try {
                filePath = decodeURIComponent(filePath);
            } catch {
                // ignore malformed URI escape
            }

            const stat = await fs.stat(filePath);
            if (stat.size > maxSizeBytes) {
                logger.warn(`[RAGDiaryPlugin] 🌟 V7: 附件体积 ${formatSizeMB(stat.size)} 超过硬上限 ${maxSizeMB}MB，取消召回 (${url})`);
                return null;
            }

            buffer = await fs.readFile(filePath);
            mimeType = mime.lookup(filePath) || 'application/octet-stream';
        } else {
            const axiosOpts = {
                responseType: 'arraybuffer',
                timeout: 10000
            };
            if (Number.isFinite(maxSizeBytes)) {
                axiosOpts.maxContentLength = maxSizeBytes;
                axiosOpts.maxBodyLength = maxSizeBytes;
            }
            const response = await axios.get(url, axiosOpts);
            buffer = Buffer.from(response.data);
            mimeType = (response.headers && response.headers['content-type'])
                ? String(response.headers['content-type']).split(';')[0].trim()
                : (mime.lookup(url) || 'application/octet-stream');
        }

        if (!buffer) return null;

        const originalBytes = buffer.length;
        if (originalBytes > maxSizeBytes) {
            logger.warn(`[RAGDiaryPlugin] 🌟 V7: 附件体积 ${formatSizeMB(originalBytes)} 超过硬上限 ${maxSizeMB}MB，取消召回 (${url})`);
            return null;
        }

        let finalBuffer = buffer;
        let finalMimeType = mimeType;
        let compressed = false;

        const isCompressibleStaticImage = /^image\/(png|jpeg|jpg|webp)$/i.test(mimeType);
        const sharpFn = options.sharpImpl !== undefined ? options.sharpImpl : getSharp();

        if (isCompressibleStaticImage && originalBytes > compressThresholdBytes && sharpFn) {
            try {
                const compressedBuffer = await sharpFn(buffer)
                    .rotate()
                    .resize({
                        width: maxDimension,
                        height: maxDimension,
                        fit: 'inside',
                        withoutEnlargement: true
                    })
                    .webp({ quality })
                    .toBuffer();

                if (compressedBuffer && compressedBuffer.length < originalBytes) {
                    finalBuffer = compressedBuffer;
                    finalMimeType = 'image/webp';
                    compressed = true;
                    logger.log(`[RAGDiaryPlugin] 🌟 V7: 附件自适应压缩生效 (${url}): ${formatSizeMB(originalBytes)} -> ${formatSizeMB(finalBuffer.length)}`);
                }
            } catch (compressErr) {
                logger.warn(`[RAGDiaryPlugin] 🌟 V7: 附件自适应压缩失败，回退原图 (${url}):`, compressErr.message);
            }
        }

        const base64 = finalBuffer.toString('base64');
        return {
            dataUri: `data:${finalMimeType};base64,${base64}`,
            mimeType: finalMimeType,
            originalBytes,
            finalBytes: finalBuffer.length,
            compressed,
            skippedReason: null
        };
    } catch (e) {
        logger.error(`[RAGDiaryPlugin] 🌟 V7: 获取附件 Base64 失败 (${url}):`, e.message);
    }

    return null;
}

/**
 * 获取链接内容并转为 data URI base64（向后兼容旧签名）。
 *
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<string|null>}
 */
async function fetchAsBase64(url, options = {}) {
    const res = await fetchAttachmentWithMeta(url, options);
    return res ? res.dataUri : null;
}

module.exports = {
    extractAttachments,
    extractAttachmentsFromResults,
    resolveEntrySourceMeta,
    formatAttachmentSourceNote,
    fetchAttachmentWithMeta,
    fetchAsBase64
};