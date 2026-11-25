// modules/streamUsageOption.js
//
// 流式上游请求默认带 stream_options.include_usage=true，让 OpenAI 兼容接口在流末尾返回
// usage（上下文计数以它为准）。不认识这个参数而返回 400 的渠道，去掉它重试一次，并在本进程内
// 按「上游地址 + 模型」记住，之后不再带。config.env 的 UpstreamStreamIncludeUsage=false 可整体关闭。

const { readBool } = require('./jevScorer');

const REJECTION_PATTERN = /stream_options|include_usage/i;
const unsupportedChannels = new Set();

function channelKey(url, body) {
  return `${url}|${body?.model || ''}`;
}

/**
 * 需要时给流式请求体加上 include_usage。客户端自己带了 stream_options 时原样保留。
 * @returns {{ options: object, key: string|null }} key 非空表示本次请求加了参数。
 */
function applyStreamUsageOption(url, options) {
  if (!readBool('UpstreamStreamIncludeUsage', true) || typeof options?.body !== 'string') {
    return { options, key: null };
  }
  let body;
  try {
    body = JSON.parse(options.body);
  } catch (_) {
    return { options, key: null };
  }
  if (!body || body.stream !== true || body.stream_options !== undefined) return { options, key: null };
  const key = channelKey(url, body);
  if (unsupportedChannels.has(key)) return { options, key: null };
  body.stream_options = { include_usage: true };
  return { options: { ...options, body: JSON.stringify(body) }, key };
}

/** 400 且错误内容指向 stream_options / include_usage 时视为渠道不支持。不消费原响应体。 */
async function rejectsStreamUsageOption(response) {
  if (response?.status !== 400) return false;
  try {
    return REJECTION_PATTERN.test(await response.clone().text());
  } catch (_) {
    return false;
  }
}

function markStreamUsageUnsupported(key) {
  if (key) unsupportedChannels.add(key);
}

/**
 * 包一层上游请求函数：流式请求带上 include_usage；渠道不认识该参数（400 且错误指向它）时，
 * 记住这个渠道并去掉参数重发一次。
 */
function withStreamUsage(fetchUpstream) {
  return async function fetchUpstreamWithUsage(url, options, retryOptions) {
    const usageOption = applyStreamUsageOption(url, options);
    const response = await fetchUpstream(url, usageOption.options, retryOptions);
    if (!usageOption.key || !(await rejectsStreamUsageOption(response))) return response;
    // 容灾链换过模型时，拒绝参数的是实际请求的那个模型，不是最初的模型。
    const rejectedKey = response.vcpAttemptModel ? `${url}|${response.vcpAttemptModel}` : usageOption.key;
    markStreamUsageUnsupported(rejectedKey);
    response.text?.().catch(() => {});
    console.warn(`[StreamUsage] 上游不支持 stream_options.include_usage，已去掉该参数重试并记住此渠道: ${rejectedKey}`);
    return fetchUpstream(url, options, retryOptions);
  };
}

function resetStreamUsageChannels() {
  unsupportedChannels.clear();
}

module.exports = {
  applyStreamUsageOption,
  rejectsStreamUsageOption,
  markStreamUsageUnsupported,
  withStreamUsage,
  resetStreamUsageChannels,
};
