/**
 * LLM 调用封装 (T4)
 *
 * 从 PaperReader.js 抽出，统一管理模型调用。
 */

const axios = require('axios');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', 'config.env') });

const API_KEY = process.env.PaperReaderApiKey || process.env.Key || process.env.API_Key;
const RAW_API_URL = process.env.PaperReaderApiUrl || process.env.API_URL;
const VCP_PORT = process.env.PORT || '6005';
const MODEL = process.env.PaperReaderModel;
const MAX_OUTPUT_TOKENS = parseInt(process.env.PaperReaderMaxOutputTokens || '12000', 10);

function resolveApiUrl() {
  let url = RAW_API_URL;
  if (!url) return null;

  // If API_URL is just a base like http://127.0.0.1:3000, auto-fix to VCP port + path
  // VCP serves its chat completions API on PORT (default 6005), not the admin panel port
  if (url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/)) {
    const base = url.replace(/:\d+$/, '');
    url = `${base}:${VCP_PORT}/v1/chat/completions`;
  }

  // Append /v1/chat/completions if URL doesn't already end with a path
  if (!url.includes('/v1/') && !url.includes('/chat/')) {
    url = url.replace(/\/$/, '') + '/v1/chat/completions';
  }

  return url;
}

const API_URL = resolveApiUrl();

function ensureConfig() {
  if (!API_KEY || !API_URL) {
    throw new Error(
      `Missing API config: API_Key=${API_KEY ? 'set' : 'MISSING'}, API_URL=${API_URL || 'MISSING'} (raw=${RAW_API_URL || 'MISSING'}). ` +
      'Check repo root config.env and Plugin/PaperReader/config.env.'
    );
  }
  if (!MODEL) {
    throw new Error('Missing PaperReaderModel in config.env');
  }
}

function classifyLlmError(err) {
  const status = err?.response?.status;
  const code = err?.code;

  if (status === 429) {
    return {
      type: 'rate_limit',
      message: 'LLM API 触发速率限制(429)。建议降低并发/增大 chunk 间隔后重试。'
    };
  }
  if (status === 401 || status === 403) {
    return {
      type: 'auth',
      message: 'LLM API 鉴权失败(401/403)。请检查 API_Key 与权限。'
    };
  }
  if (code === 'ECONNABORTED') {
    return {
      type: 'timeout',
      message: 'LLM API 请求超时(ECONNABORTED)。可提高超时或降低单次输入体积。'
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      type: 'upstream_5xx',
      message: `LLM API 上游服务错误(${status})。建议稍后重试。`
    };
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
    return {
      type: 'network',
      message: `LLM API 网络异常(${code})。请检查 API_URL 或网络连通性。`
    };
  }

  return {
    type: 'unknown',
    message: `LLM API 未分类错误：${err?.message || 'unknown error'}`
  };
}

/**
 * 调用 LLM (OpenAI-compatible API)
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options - { max_tokens, temperature, traceTag }
 * @returns {Promise<string>} 模型输出文本
 */
async function callLLM(messages, { max_tokens = MAX_OUTPUT_TOKENS, temperature = 0.2, traceTag = 'callLLM' } = {}) {
  ensureConfig();

  const payload = {
    model: MODEL,
    messages,
    stream: false,
    max_tokens,
    temperature
  };

  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      process.stderr.write(`[PaperReader][LLM][${traceTag}] request start: model=${MODEL}, attempt=${attempt + 1}/${maxRetries}, max_tokens=${max_tokens}\n`);
      const resp = await axios.post(API_URL, payload, {
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 180000
      });
      process.stderr.write(`[PaperReader][LLM][${traceTag}] request success: attempt=${attempt + 1}/${maxRetries}\n`);
      return resp?.data?.choices?.[0]?.message?.content || '';
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 && attempt < maxRetries - 1) {
        // Exponential backoff: 3s, 6s, 12s, 24s
        const delay = 3000 * Math.pow(2, attempt);
        process.stderr.write(`[PaperReader][LLM][${traceTag}] 429 rate limit, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})\n`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const classified = classifyLlmError(err);
      process.stderr.write(
        `[PaperReader][LLM][${traceTag}] request failed: type=${classified.type}, status=${status || 'n/a'}, code=${err?.code || 'n/a'}, message=${err?.message || 'n/a'}\n`
      );
      throw new Error(`${classified.message} [status=${status || 'n/a'} code=${err?.code || 'n/a'}]`);
    }
  }
}

/**
 * 调用 LLM 并解析 JSON 响应
 *
 * @param {Array} messages
 * @param {object} options
 * @returns {Promise<object>} 解析后的 JSON 对象
 */
async function callLLMJson(messages, options = {}) {
  const raw = await callLLM(messages, {
    ...options,
    temperature: options.temperature ?? 0.1,
    traceTag: options.traceTag || 'callLLMJson'
  });
  try {
    // 尝试从 markdown 代码块中提取 JSON
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    return JSON.parse(jsonStr);
  } catch {
    return { raw_response: raw };
  }
}

module.exports = { callLLM, callLLMJson };
