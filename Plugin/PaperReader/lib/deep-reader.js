/**
 * Rolling Context Deep Reader (T6)
 * 
 * 带滚动上下文的深度阅读：每个 chunk 摘要时携带前序累积的关键事实，
 * 保持 chunk 间的连贯性。超出上限时自动压缩。
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { callLLM, callLLMJson } = require('./llm');
const { countTokens } = require('./chunker');

const WORKSPACE_ROOT = path.join(__dirname, '..', 'workspace');
const BATCH_SIZE = parseInt(process.env.PaperReaderBatchSize || '4', 10);
const MAX_CHUNKS = parseInt(process.env.PaperReaderMaxChunks || '120', 10);
const ROLLING_CONTEXT_MAX_TOKENS = 4000;
const CHUNK_DELAY_MS = parseInt(process.env.PaperReaderChunkDelay || '1500', 10);

/**
 * 压缩 Rolling Context（当超过上限时）
 */
async function compressContext(rollingContext) {
  const compressed = await callLLM([
    { role: 'system', content: '将以下累积的阅读笔记压缩为关键事实列表，保留最重要的信息、关键步骤和核心结论。删除冗余和过渡性描述。输出纯文本，不超过 2000 tokens。' },
    { role: 'user', content: rollingContext }
  ], { max_tokens: 3000, temperature: 0.1 });
  return compressed;
}

/**
 * 对单个 chunk 做摘要（携带 Rolling Context）
 */
async function summarizeChunk(chunkText, { goal, globalMap, rollingContext, chunkIndex, section }) {
  const system = [
    '你是一个"长文档分块摘要器"，适用于各类文档（学术论文、技术报告、书籍、法律文书等）。',
    '你会结合已有的阅读上下文，对当前 chunk 进行摘要。',
    '输出 JSON（纯 JSON，不要代码块）：',
    '{"summary": string, "key_facts": string[], "methods": string[], "claims": string[], "open_questions": string[]}',
    '其中 methods 字段可包含任何流程/步骤/操作方法（不限于科研实验），claims 包含文档中的核心论断/条款/规定。'
  ].join('\n');

  const userParts = [
    `主任务目标：${goal || '全面理解文档核心内容'}`,
    `当前位置：第 ${chunkIndex} 块，章节「${section}」`
  ];

  if (rollingContext) {
    userParts.push(`【已有阅读上下文】\n${rollingContext}`);
  }
  if (globalMap) {
    userParts.push(`【全局地图摘要】\n${globalMap.slice(0, 2000)}`);
  }
  userParts.push(`【当前 chunk 内容】\n${chunkText}`);

  const result = await callLLMJson([
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n\n') }
  ], { temperature: 0.1 });

  // Normalize result
  return {
    summary: result.summary || result.raw_response || '',
    key_facts: result.key_facts || [],
    methods: result.methods || [],
    claims: result.claims || [],
    open_questions: result.open_questions || []
  };
}

/**
 * 带滚动上下文的深度阅读
 * 
 * @param {string} paperId
 * @param {object} options - { goal, batchSize, maxChunks }
 * @returns {Promise<{ summariesPath, roundPath }>}
 */
async function readDeep(paperId, options = {}) {
  const wsDir = path.join(WORKSPACE_ROOT, paperId);
  const chunksDir = path.join(wsDir, 'chunks');
  const manifestPath = path.join(chunksDir, 'manifest.json');

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

  const batchSize = options.batchSize || BATCH_SIZE;
  const maxChunks = Math.min(options.maxChunks || MAX_CHUNKS, chunks.length);
  const goal = options.goal || '';

  const limited = chunks.slice(0, maxChunks);
  const summaries = [];
  let rollingContext = '';

  // Sequential processing with Rolling Context
  // Process in small batches but maintain rolling context between batches
  for (let i = 0; i < limited.length; i += batchSize) {
    const batch = limited.slice(i, i + batchSize);

    // Within a batch, process sequentially to maintain rolling context
    for (const chunk of batch) {
      // Read chunk content
      const chunkPath = path.join(chunksDir, `chunk_${chunk.index}.md`);
      let chunkText;
      if (fsSync.existsSync(chunkPath)) {
        chunkText = await fs.readFile(chunkPath, 'utf-8');
      } else {
        chunkText = chunk.text || '';
      }

      // Delay between LLM calls to avoid 429 rate limiting (skip first chunk)
      if (summaries.length > 0) {
        await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
      }

      const summary = await summarizeChunk(chunkText, {
        goal,
        globalMap,
        rollingContext,
        chunkIndex: chunk.index,
        section: chunk.section || 'unknown'
      });

      summaries.push({
        chunkIndex: chunk.index,
        section: chunk.section,
        ...summary
      });

      // Update Rolling Context
      const newFacts = summary.key_facts.join('; ');
      if (newFacts) {
        rollingContext += `\n[Chunk ${chunk.index} - ${chunk.section}]: ${newFacts}`;
      }

      // Compress if exceeding limit
      if (countTokens(rollingContext) > ROLLING_CONTEXT_MAX_TOKENS) {
        rollingContext = await compressContext(rollingContext);
      }
    }
  }

  // Save chunk summaries
  const notesDir = path.join(wsDir, 'reading_notes');
  await fs.mkdir(notesDir, { recursive: true });
  const summariesPath = path.join(notesDir, 'Chunk_Summaries.json');
  await fs.writeFile(summariesPath, JSON.stringify({ count: summaries.length, summaries }, null, 2), 'utf-8');

  // Synthesis: merge all summaries into Round_1_Summary.md
  const system = [
    '你是一个"长文档合并器"，适用于各类文档。',
    '输入是多段 chunk 的结构化摘要（含滚动上下文），请合并成一份结构化的深度笔记。',
    '输出 Markdown，根据文档类型自适应包含：核心主题与结论、关键内容与论点、方法/流程/步骤（如有）、重要数据与证据、局限与风险、待解决问题清单。'
  ].join('\n');

  const user = [
    `主任务目标：${goal || '全面理解文档核心内容'}`,
    globalMap ? `全局地图：\n${globalMap.slice(0, 3000)}` : '',
    `最终累积上下文：\n${rollingContext}`,
    `Chunk 摘要（${summaries.length} 个）：\n${JSON.stringify(summaries).slice(0, 150000)}`
  ].filter(Boolean).join('\n\n');

  const merged = await callLLM([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { temperature: 0.2 });

  const roundPath = path.join(notesDir, 'Round_1_Summary.md');
  await fs.writeFile(roundPath, merged || '', 'utf-8');

  return { paperId, summariesPath, roundPath };
}

module.exports = { readDeep };
