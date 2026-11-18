'use strict';

/**
 * 出站守卫：文本里的 Markdown data: 图片。
 *
 * 部分上游网关在把 OpenAI 格式转成 Gemini 原生格式时，会扫描文本中的
 * `![alt](data:...)` 并把它转成内联图片。网页抓取带进来的 1x1 GIF 占位图、
 * 残缺的 base64、甚至讨论这种语法的普通文字，都会让整轮请求以 415/500 失败，
 * 而且这段内容留在历史里之后每一轮都会失败。
 *
 * 这里只处理发往上游的请求副本里的文本：
 *   - 格式受支持、base64 完整、体积不是占位级别的真图原样保留；
 *   - 其余降级成 `[图片: alt]`；
 *   - 零散的 `](data:` 片段插入一个空格，避免被网关误配对。
 * image_url 等多模态 part、工具参数和其他字段都不触碰。
 */

const MARKER = '](data:';
const KEEP_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
// 小于这个体积的内联图基本只会是占位图或跟踪像素。
const MIN_KEEP_BYTES = 1024;
const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/;
const MARKDOWN_DATA_IMAGE_RE = /!\[([^\]\n]{0,300})\]\((data:[^)\s]*)\)/g;

function isGuardEnabled() {
    return String(process.env.EnableMarkdownDataImageGuard || 'true').toLowerCase() !== 'false';
}

function isDeliverableImage(dataUrl) {
    const match = DATA_URL_RE.exec(dataUrl);
    if (!match) return false;
    if (!KEEP_MIME.has(match[1].toLowerCase())) return false;
    const base64 = match[2];
    if (base64.length % 4 !== 0) return false;
    return Math.floor(base64.length * 3 / 4) >= MIN_KEEP_BYTES;
}

function guardMarkdownDataImagesInText(text) {
    if (typeof text !== 'string' || !text.includes(MARKER)) return text;

    const withoutBadImages = text.replace(MARKDOWN_DATA_IMAGE_RE, (whole, alt, dataUrl) => {
        if (isDeliverableImage(dataUrl)) return whole;
        const label = alt.trim();
        return label ? `[图片: ${label}]` : '[图片]';
    });
    if (!withoutBadImages.includes(MARKER)) return withoutBadImages;

    return withoutBadImages.replace(/\]\(data:/g, (marker, offset) => {
        const close = withoutBadImages.indexOf(')', offset);
        const dataUrl = close === -1 ? '' : withoutBadImages.slice(offset + 2, close);
        return isDeliverableImage(dataUrl) ? marker : '] (data:';
    });
}

/** Request-only copy; returns the same object when nothing needs to change. */
function guardMarkdownDataImagesForUpstream(body) {
    if (!isGuardEnabled() || !body || !Array.isArray(body.messages)) return body;
    let changed = false;
    const messages = body.messages.map(message => {
        if (!message) return message;
        const content = message.content;
        if (typeof content === 'string') {
            const guarded = guardMarkdownDataImagesInText(content);
            if (guarded === content) return message;
            changed = true;
            return { ...message, content: guarded };
        }
        if (Array.isArray(content)) {
            let partChanged = false;
            const parts = content.map(part => {
                if (part?.type !== 'text' || typeof part.text !== 'string') return part;
                const guarded = guardMarkdownDataImagesInText(part.text);
                if (guarded === part.text) return part;
                partChanged = true;
                return { ...part, text: guarded };
            });
            if (!partChanged) return message;
            changed = true;
            return { ...message, content: parts };
        }
        return message;
    });
    return changed ? { ...body, messages } : body;
}

module.exports = { guardMarkdownDataImagesInText, guardMarkdownDataImagesForUpstream };
