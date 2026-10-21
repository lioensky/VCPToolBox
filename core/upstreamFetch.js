// core/upstreamFetch.js
/**
 * @fileoverview VCP 方案 2 上游连接池与重试驱动器
 * 封装防御性长连接池 (Keep-Alive Pool)、超时中断、状态码重试与语义模型降级重试。
 */

'use strict';

const http = require('http');
const https = require('https');

// 防御性长连接池 (Keep-Alive Pool)
const agentOptions = {
  keepAlive: true,
  keepAliveMsecs: 1000,
  freeSocketTimeout: 8000,
  scheduling: 'lifo',
  maxSockets: 10000
};

const keepAliveHttpAgent = new http.Agent(agentOptions);
const keepAliveHttpsAgent = new https.Agent(agentOptions);

function getFetchAgent(parsedURL) {
  return parsedURL.protocol === 'http:' ? keepAliveHttpAgent : keepAliveHttpsAgent;
}

/**
 * 针对重试轮次应用语义模型备选候选池
 * @param {object} options - fetch 选项
 * @param {string[]} candidates - 模型候选列表
 * @param {number} attemptIndex - 尝试索引
 * @param {boolean} debugMode
 * @returns {object}
 */
function applyModelFallbackForAttempt(options, candidates, attemptIndex, debugMode = false) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !options || typeof options.body !== 'string') {
    return options;
  }

  const selectedModel = candidates[Math.min(attemptIndex, candidates.length - 1)];
  if (!selectedModel) return options;

  try {
    const parsedBody = JSON.parse(options.body);
    if (!parsedBody || typeof parsedBody !== 'object') return options;

    const previousModel = parsedBody.model;
    parsedBody.model = selectedModel;

    if (debugMode && previousModel !== selectedModel) {
      console.log(`[SemanticModelRouter] 容灾切换上游模型: ${previousModel} -> ${selectedModel} (attempt=${attemptIndex + 1})`);
    }

    return {
      ...options,
      body: JSON.stringify(parsedBody)
    };
  } catch (error) {
    if (debugMode) {
      console.warn(`[SemanticModelRouter] 无法为本次重试替换模型，继续使用原始请求体: ${error.message}`);
    }
    return options;
  }
}

/**
 * 销毁未消费的 HTTP 响应体，释放底层套接字与文件描述符
 * @param {Response} response
 */
function destroyResponseBody(response) {
  if (!response || !response.body) return;
  const body = response.body;
  try {
    if (typeof body.destroy === 'function') {
      body.destroy();
    } else if (typeof body.cancel === 'function') {
      body.cancel().catch(() => {});
    } else if (typeof body.resume === 'function') {
      body.resume();
    }
  } catch {
    // 忽略流销毁时的同步异常
  }
}

/**
 * 带重试与连接超时保护的上游 fetch 函数
 * @param {string} url
 * @param {object} options
 * @param {object} retryConfig
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(
  url,
  options,
  {
    retries = 3,
    delay = 1000,
    debugMode = false,
    onRetry = null,
    connectionTimeout = 900000,
    modelFallbackCandidates = null,
    fetchImpl = null
  } = {}
) {
  const customFetch = fetchImpl || (await import('node-fetch')).default;
  const maxAttempts = Math.max(
    Number.isFinite(Number(retries)) && Number(retries) > 0 ? Math.floor(Number(retries)) : 1,
    Array.isArray(modelFallbackCandidates) ? modelFallbackCandidates.length : 0
  );

  for (let i = 0; i < maxAttempts; i++) {
    const attemptController = new AbortController();
    let didTimeout = false;
    const externalSignal = options.signal;

    let removeExternalListener = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      }
      const forwardAbort = () => attemptController.abort();
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
      removeExternalListener = () => externalSignal.removeEventListener('abort', forwardAbort);
    }

    const timeoutId = connectionTimeout > 0
      ? setTimeout(() => {
          didTimeout = true;
          attemptController.abort();
        }, connectionTimeout)
      : null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (removeExternalListener) removeExternalListener();
    };

    let response;
    try {
      const attemptOptions = applyModelFallbackForAttempt(options, modelFallbackCandidates, i, debugMode);
      response = await customFetch(url, {
        ...attemptOptions,
        agent: getFetchAgent,
        signal: attemptController.signal
      });
      cleanup();

      let shouldRetryStatus = response.status === 500 || response.status === 503 || response.status === 429;
      let retryMessage = response.statusText;

      // 401 偶发 token 瞬时异常容错重试
      if (response.status === 401) {
        try {
          const responseBodyText = await response.clone().text();
          if (responseBodyText.toLowerCase().includes('token')) {
            shouldRetryStatus = true;
            retryMessage = responseBodyText || response.statusText;
          }
        } catch (bodyReadError) {
          if (debugMode) {
            console.warn(`[Fetch Retry] Failed to inspect 401 response body: ${bodyReadError.message}`);
          }
        }
      }

      if (shouldRetryStatus) {
        destroyResponseBody(response);
        if (i === maxAttempts - 1) {
          throw new Error(`Fetch failed with status ${response.status}: ${retryMessage || 'All retries exhausted'}`);
        }
        const currentDelay = delay * (i + 1);
        if (debugMode) {
          console.warn(`[Fetch Retry] Received status ${response.status}. Retrying in ${currentDelay}ms... (${i + 1}/${retries})`);
        }
        if (onRetry) {
          await onRetry(i + 1, { status: response.status, message: retryMessage });
        }
        await new Promise(resolve => setTimeout(resolve, currentDelay));
        continue;
      }

      return response;
    } catch (error) {
      cleanup();
      if (response) {
        destroyResponseBody(response);
      }

      if (error.name === 'AbortError') {
        if (didTimeout) {
          const msg = `Connection timed out after ${connectionTimeout / 1000}s`;
          if (i === maxAttempts - 1) {
            console.error(`[Fetch Retry] ${msg}. All retries exhausted.`);
            throw new Error(msg);
          }
          if (debugMode) console.warn(`[Fetch Retry] ${msg}. Retrying... (${i + 1}/${retries})`);
          if (onRetry) {
            await onRetry(i + 1, { status: 'TIMEOUT', message: msg });
          }
          await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
          continue;
        }
        // 外部主动中止，不重试
        if (debugMode) console.log('[Fetch Retry] Request was aborted by caller. No retries will be attempted.');
        throw error;
      }

      if (i === maxAttempts - 1) {
        console.error(`[Fetch Retry] All retries failed. Last error: ${error.message}`);
        throw error;
      }

      if (debugMode) {
        console.warn(`[Fetch Retry] Fetch error (${error.message}). Retrying in ${delay * (i + 1)}ms... (${i + 1}/${retries})`);
      }
      if (onRetry) {
        await onRetry(i + 1, { status: 'NETWORK_ERROR', message: error.message });
      }
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }

  throw new Error('Fetch failed after all retries.');
}

/**
 * 智能解析上游 API 版本前缀
 * 当未显式指定前缀时，自动根据 apiUrl 特征匹配官方推荐规范：
 * - Google Gemini -> v1beta/openai
 * - 智谱 GLM -> v4
 * - 默认 / OpenAI / DeepSeek / 自建中转 -> v1
 * @param {string} apiUrl - 上游服务基础地址
 * @param {string} [explicitPrefix] - 用户显式指定的前缀（可选）
 * @returns {string} 规整后的版本前缀（去首尾斜杠）
 */
function resolveApiVersionPrefix(apiUrl, explicitPrefix) {
  if (explicitPrefix && typeof explicitPrefix === 'string' && explicitPrefix.trim()) {
    return explicitPrefix.trim().replace(/^\/+|\/+$/g, '');
  }
  if (!apiUrl) return 'v1';
  const lower = String(apiUrl).toLowerCase();
  if (lower.includes('generativelanguage.googleapis.com') || lower.includes('google')) {
    return 'v1beta/openai';
  }
  if (lower.includes('bigmodel.cn') || lower.includes('zhipu')) {
    return 'v4';
  }
  return 'v1';
}

module.exports = {
  agentOptions,
  keepAliveHttpAgent,
  keepAliveHttpsAgent,
  getFetchAgent,
  applyModelFallbackForAttempt,
  fetchWithRetry,
  resolveApiVersionPrefix
};
