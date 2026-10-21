'use strict';

/**
 * 上游请求体净化
 *
 * 背景：VCP 会把客户端请求体转发给上游，客户端可能带有内部字段（如 requestId / messageId /
 * vcpchatExtensions / contextTokenLimit）。
 *
 * 官方 OpenAI / NewAPI / oneapi 这类网关会忽略未知字段；
 * 但 Google 原生端点（generativelanguage.googleapis.com，v1beta/openai）是 protobuf
 * 严格校验，见到任何未定义字段直接 400：
 *   Invalid JSON payload received. Unknown name "requestId": Cannot find field.
 *
 * 字段兼容策略：
 *   - ALWAYS_STRIP：纯 VCP 内部字段，任何上游都不该收到
 *   - GOOGLE_STRICT_STRIP：OpenAI 生态里合法（top_k/seed 在 vLLM、Anthropic 等常见），
 *     仅在直连 Google 原生端点时剔除
 *
 * 保证纯函数特性：返回净化后的新浅拷贝对象，绝不修改调用方手里的原对象，
 * 避免影响日志、缓存与 finalContextStore 的原始记录，同时避免严格模式下对 frozen 对象抛错。
 */

const ALWAYS_STRIP = [
    'requestId',
    'messageId',
    'vcpchatExtensions',
    'contextTokenLimit',
    'id',
    'signal',
    'clientIp',
    'forceShowVCP'
];
const GOOGLE_STRICT_STRIP = ['top_k', 'seed'];

function isGoogleNativeUpstream() {
    // STRICT_UPSTREAM_SANITIZE 可强制覆盖：true=按 Google 严格模式剔 top_k/seed，
    // false=只剔 VCP 私有字段。留空则按 API_URL 自动判断（反代/自定义域名时手动打开）。
    const override = String(process.env.STRICT_UPSTREAM_SANITIZE || '').trim().toLowerCase();
    if (override === 'true') return true;
    if (override === 'false') return false;

    const apiUrl = String(process.env.API_URL || '').toLowerCase();
    return apiUrl.includes('generativelanguage.googleapis.com');
}

function currentStripKeys() {
    return isGoogleNativeUpstream() ? ALWAYS_STRIP.concat(GOOGLE_STRICT_STRIP) : ALWAYS_STRIP;
}

/**
 * 净化发给上游的请求体对象
 * @param {object} body 原请求体
 * @returns {object} 净化后的新对象（浅拷贝），原对象不被修改
 */
function stripVcpPrivateFields(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return body;
    }

    const stripKeys = new Set(currentStripKeys());
    const stripped = [];
    const sanitizedBody = {};

    for (const key of Object.keys(body)) {
        if (stripKeys.has(key)) {
            stripped.push(key);
        } else {
            sanitizedBody[key] = body[key];
        }
    }

    if (stripped.length > 0) {
        const note = isGoogleNativeUpstream() ? '（Google 原生严格校验）' : '';
        console.log(`[UpstreamSanitizer] 已剔除字段${note}: ${stripped.join(', ')}`);
    }

    return sanitizedBody;
}

module.exports = {
    stripVcpPrivateFields,
    isGoogleNativeUpstream,
    currentStripKeys,
    ALWAYS_STRIP,
    GOOGLE_STRICT_STRIP
};
