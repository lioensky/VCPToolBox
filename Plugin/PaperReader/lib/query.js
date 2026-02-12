/**
 * Query 问答模块 (T7)
 * 
 * Phase 1: 关键词匹配挑选相关 chunk + LLM 问答
 * Phase 2: 升级为向量检索
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { callLLM } = require('./llm');

const WORKSPACE_ROOT = path.join(__dirname, '..', 'workspace');

/**
 * 关键词匹配挑选相关 chunk
 */
function keywordPick(chunks, question, topK = 6) {
  const q = String(question || '').toLowerCase().trim();
  if (!q) return chunks.slice(0, topK);

  const words = q.split(/[\s,;，；。？！?!]+/).filter(w => w.length >= 2).slice(0, 15);

  const scored = chunks.map(c => {
    const text = (c.text || '').toLowerCase();
    const section = (c.section || '').toLowerCase();
    let score = 0;
    for (const w of words) {
      if (text.includes(w)) score += 1;
      if (section.includes(w)) score += 2;
    }
    return { chunk: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(s => s.score > 0).map(s => s.chunk);
}

/**
 * 对已导入的文档做检索式问答
 * 
 * @param {string} paperId
 * @param {string} question
 * @returns {Promise<{ paperId, answer, sources: Array }>}
 */
async function queryPaper(paperId, question) {
  if (!paperId) throw new Error('Query requires paperId');
  if (!question) throw new Error('Query requires question');

  const wsDir = path.join(WORKSPACE_ROOT, paperId);
  const manifestPath = path.join(wsDir, 'chunks', 'manifest.json');

  if (!fsSync.existsSync(manifestPath)) {
    throw new Error(`chunks/manifest.json not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  const chunks = manifest.chunks || [];

  // Load Global Map if exists
  const globalMapPath = path.join(wsDir, 'reading_notes', 'Global_Map.md');
  const globalMap = fsSync.existsSync(globalMapPath)
    ? await fs.readFile(globalMapPath, 'utf-8')
    : '';

  // Pick relevant chunks
  const picked = keywordPick(chunks, question, 6);
  const contextChunks = picked.length > 0 ? picked : chunks.slice(0, 4);

  // Read chunk files for full content
  const contextParts = [];
  for (const c of contextChunks) {
    const chunkPath = path.join(wsDir, 'chunks', `chunk_${c.index}.md`);
    let text;
    if (fsSync.existsSync(chunkPath)) {
      text = await fs.readFile(chunkPath, 'utf-8');
    } else {
      text = c.text || '';
    }
    contextParts.push(`---\n[chunk ${c.index} | 章节: ${c.section || 'unknown'}]\n${text}`);
  }
  const context = contextParts.join('\n\n');

  const system = [
    '你是一个"文档问答助手"，适用于各类长文档（学术论文、技术报告、书籍、法律文书等）。',
    '只根据提供的上下文回答；若上下文不足，明确说"证据不足"，并给出下一步需要检索的章节/关键词。',
    '输出：先给结论，再给证据引用（标注 chunk index 和章节名）。'
  ].join('\n');

  const user = [
    globalMap ? `全局地图：\n${globalMap.slice(0, 2000)}` : '',
    `问题：${question}`,
    `上下文：\n${context}`
  ].filter(Boolean).join('\n\n');

  const answer = await callLLM([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { temperature: 0.2 });

  return {
    paperId,
    answer,
    sources: contextChunks.map(c => ({ index: c.index, section: c.section }))
  };
}

module.exports = { queryPaper };
