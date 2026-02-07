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
  ], { temperature: 0.1, traceTag: `DeepReader:chunk_${chunkIndex}` });

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
  const notesDir = path.join(wsDir, 'reading_notes');
  const summariesPath = path.join(notesDir, 'Chunk_Summaries.json');
  const roundPath = path.join(notesDir, 'Round_1_Summary.md');

  process.stderr.write(`[PaperReader][DeepReader] start: paperId=${paperId}, goal=${options.goal || '(default)'}\n`);

  // ── Cache check: if Round_1_Summary.md already exists, return directly ──
  if (!options.forceReread && fsSync.existsSync(roundPath) && fsSync.existsSync(summariesPath)) {
    const existingSummaries = JSON.parse(await fs.readFile(summariesPath, 'utf-8'));
    process.stderr.write(`[PaperReader][DeepReader] cache hit: Round_1_Summary.md exists (${existingSummaries.count} chunk summaries). Returning cached result.\n`);
    return { paperId, summariesPath, roundPath, cached: true };
  }

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
  let summaries = [];
  let rollingContext = '';

  // ── Incremental resume: load existing chunk summaries if available ──
  const existingSummariesMap = new Map();
  if (!options.forceReread && fsSync.existsSync(summariesPath)) {
    try {
      const existing = JSON.parse(await fs.readFile(summariesPath, 'utf-8'));
      if (existing.summaries && Array.isArray(existing.summaries)) {
        for (const s of existing.summaries) {
          existingSummariesMap.set(s.chunkIndex, s);
        }
        process.stderr.write(`[PaperReader][DeepReader] found ${existingSummariesMap.size} cached chunk summaries, will skip those\n`);
      }
    } catch { /* ignore corrupt file */ }
  }

  process.stderr.write(`[PaperReader][DeepReader] config: totalChunks=${chunks.length}, processing=${limited.length}, batchSize=${batchSize}, chunkDelay=${CHUNK_DELAY_MS}ms\n`);

  // Concurrent batch processing with Rolling Context
  // Each batch shares the same rolling context snapshot, chunks within a batch run in parallel.
  // After a batch completes, results are merged in order to update rolling context before next batch.
  for (let i = 0; i < limited.length; i += batchSize) {
    const batch = limited.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(limited.length / batchSize);
    process.stderr.write(`[PaperReader][DeepReader] batch ${batchNum}/${totalBatches} start (chunks ${i}-${Math.min(i + batchSize, limited.length) - 1}, concurrency=${batch.length})\n`);

    // Delay between batches to avoid rate limiting (skip first batch)
    if (i > 0) {
      await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
    }

    // Snapshot rolling context for this batch — all chunks in the batch see the same context
    const batchRollingContext = rollingContext;

    // Launch all chunks in this batch concurrently (skip cached ones)
    const batchPromises = batch.map(async (chunk) => {
      // Check incremental cache
      if (existingSummariesMap.has(chunk.index)) {
        process.stderr.write(`[PaperReader][DeepReader] chunk ${chunk.index}/${limited.length - 1} (section: ${chunk.section || 'unknown'}) CACHED, skipping LLM\n`);
        return existingSummariesMap.get(chunk.index);
      }

      // Read chunk content
      const chunkPath = path.join(chunksDir, `chunk_${chunk.index}.md`);
      let chunkText;
      if (fsSync.existsSync(chunkPath)) {
        chunkText = await fs.readFile(chunkPath, 'utf-8');
      } else {
        chunkText = chunk.text || '';
      }

      process.stderr.write(`[PaperReader][DeepReader] chunk ${chunk.index}/${limited.length - 1} (section: ${chunk.section || 'unknown'}) summarizing...\n`);

      const summary = await summarizeChunk(chunkText, {
        goal,
        globalMap,
        rollingContext: batchRollingContext,
        chunkIndex: chunk.index,
        section: chunk.section || 'unknown'
      });

      return {
        chunkIndex: chunk.index,
        section: chunk.section,
        ...summary
      };
    });

    // Wait for all chunks in this batch to complete
    const batchResults = await Promise.all(batchPromises);

    // Merge results in order
    for (const result of batchResults) {
      summaries.push(result);
      process.stderr.write(`[PaperReader][DeepReader] chunk ${result.chunkIndex} done (${summaries.length}/${limited.length} completed)\n`);

      // Update Rolling Context in order
      const newFacts = result.key_facts.join('; ');
      if (newFacts) {
        rollingContext += `\n[Chunk ${result.chunkIndex} - ${result.section}]: ${newFacts}`;
      }
    }

    // Compress rolling context if exceeding limit (once per batch)
    if (countTokens(rollingContext) > ROLLING_CONTEXT_MAX_TOKENS) {
      process.stderr.write(`[PaperReader][DeepReader] rolling context exceeds ${ROLLING_CONTEXT_MAX_TOKENS} tokens, compressing...\n`);
      rollingContext = await compressContext(rollingContext);
    }
  }

  // Save chunk summaries
  await fs.mkdir(notesDir, { recursive: true });
  await fs.writeFile(summariesPath, JSON.stringify({ count: summaries.length, summaries }, null, 2), 'utf-8');

  process.stderr.write(`[PaperReader][DeepReader] all ${summaries.length} chunks summarized, starting synthesis...\n`);

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
  ], { temperature: 0.2, traceTag: 'DeepReader:synthesis' });

  await fs.writeFile(roundPath, merged || '', 'utf-8');

  process.stderr.write(`[PaperReader][DeepReader] complete: summariesPath=${summariesPath}, roundPath=${roundPath}\n`);

  return { paperId, summariesPath, roundPath };
}

module.exports = { readDeep };
