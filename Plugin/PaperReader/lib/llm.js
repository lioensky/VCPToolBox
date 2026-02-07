/**
 * LLM 调用封装 (T4)
 * 
 * 从 PaperReader.js 抽出，统一管理模型调用。
 */

const axios = require('axios');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', 'config.env') });

const API_KEY = process.env.API_Key;
const API_URL = process.env.API_URL;
const MODEL = process.env.PaperReaderModel;
const MAX_OUTPUT_TOKENS = parseInt(process.env.PaperReaderMaxOutputTokens || '12000', 10);

function ensureConfig() {
  if (!API_KEY || !API_URL) {
    throw new Error('Missing API config: API_Key/API_URL are required (from repo root config.env).');
  }
  if (!MODEL) {
    throw new Error('Missing PaperReaderModel in config.env');
  }
}

/**
 * 调用 LLM (OpenAI-compatible API)
 * 
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options - { max_tokens, temperature }
 * @returns {Promise<string>} 模型输出文本
 */
async function callLLM(messages, { max_tokens = MAX_OUTPUT_TOKENS, temperature = 0.2 } = {}) {
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
      const resp = await axios.post(API_URL, payload, {
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 180000
      });
      return resp?.data?.choices?.[0]?.message?.content || '';
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 && attempt < maxRetries - 1) {
        // Exponential backoff: 3s, 6s, 12s, 24s
        const delay = 3000 * Math.pow(2, attempt);
        process.stderr.write(`[PaperReader] 429 rate limit, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})\n`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
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
  const raw = await callLLM(messages, { ...options, temperature: options.temperature ?? 0.1 });
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
