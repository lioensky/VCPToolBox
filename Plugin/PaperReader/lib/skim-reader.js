/**
 * Skim Reader 模块 (v0.4)
 * 
 * 轻量摘要：用简化 prompt 处理 skim 标记的 chunk。
 * 核心约束：Skim 结果不写入 Rolling Context（不污染精读上下文）。
 * 支持 upgrade 检测：如果发现高密度信息，自动提升为 deep。
 */

const { callLLMJson } = require('./llm');

/**
 * 对单个 chunk 执行 Skim 摘要
 * 
 * @param {string} chunkText - chunk 原文
 * @param {object} options - { goal, chunkIndex, section }
 * @returns {Promise<{summary: string, upgrade: boolean, reason: string}>}
 */
async function skimChunk(chunkText, { goal, chunkIndex, section }) {
  const system = [
    '你是一个快速扫读器。用一句话概括这个章节的核心内容。',
    '如果发现与阅读目标高度相关的意外重要内容，标记 upgrade: true。',
    '',
    '输出 JSON（纯 JSON，不要代码块）：',
    '{"summary": string, "upgrade": boolean, "reason": string}',
    '',
    'upgrade 规则：',
    '- true：该 chunk 包含与阅读目标直接相关的关键数据/方法/结论，值得精读',
    '- false：该 chunk 是背景/综述/已知信息，扫读即可',
    'reason：解释为什么 upgrade 或不 upgrade（一句话）'
  ].join('\n');

  const user = [
    `阅读目标：${goal || '全面理解文档核心内容'}`,
    `当前位置：第 ${chunkIndex} 块，章节「${section}」`,
    '',
    `【chunk 内容】`,
    chunkText
  ].join('\n');

  const result = await callLLMJson([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { temperature: 0.1, max_tokens: 500, traceTag: `Skim:chunk_${chunkIndex}` });

  return {
    summary: result.summary || result.raw_response || '',
    upgrade: result.upgrade === true,
    reason: result.reason || ''
  };
}

module.exports = { skimChunk };
