/**
 * PaperReader v0.2 — 主入口
 * 
 * stdin 接收 JSON → 路由到各 command handler → stdout 输出 JSON
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, 'config.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') });

const { ingestPdf } = require('./lib/ingest');
const { chunkMarkdown } = require('./lib/chunker');
const { generateSkeleton } = require('./lib/skeleton');
const { readDeep } = require('./lib/deep-reader');
const { queryPaper } = require('./lib/query');

const WORKSPACE_ROOT = path.join(__dirname, 'workspace');

function sendResponse(data) {
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function getPaperWorkspace(paperId) {
  return path.join(WORKSPACE_ROOT, paperId);
}

async function writeJson(filePath, obj) {
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8');
}

// ─── Command Handlers ───

async function handleIngestPDF({ filePath, paperId, forceReparse }) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('IngestPDF requires filePath');
  }

  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fsSync.existsSync(abs)) {
    throw new Error(`PDF not found: ${abs}`);
  }

  const resolvedPaperId = paperId && String(paperId).trim()
    ? String(paperId).trim()
    : `paper-${sha1(abs).slice(0, 10)}`;

  const wsDir = getPaperWorkspace(resolvedPaperId);
  const manifestPath = path.join(wsDir, 'chunks', 'manifest.json');
  const metaPath = path.join(wsDir, 'meta.json');

  // ── Cache check: if manifest + meta already exist, skip re-parsing ──
  if (!forceReparse && fsSync.existsSync(manifestPath) && fsSync.existsSync(metaPath)) {
    const existingMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    const existingManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    process.stderr.write(`[PaperReader][Ingest] cache hit: paperId=${resolvedPaperId}, chunkCount=${existingManifest.chunkCount}, engine=${existingMeta.engine}\n`);
    return {
      paperId: resolvedPaperId,
      workspace: wsDir,
      pageCount: existingMeta.pageCount,
      chunkCount: existingManifest.chunkCount,
      engine: existingMeta.engine,
      cached: true
    };
  }

  process.stderr.write(`[PaperReader][Ingest] no cache, starting full parse: paperId=${resolvedPaperId}\n`);

  await fs.mkdir(wsDir, { recursive: true });

  // L0: 解析 PDF → Markdown + Figures
  const parsed = await ingestPdf(abs, { outputDir: wsDir });

  // Save meta
  const meta = {
    paperId: resolvedPaperId,
    sourceFilePath: abs,
    extractedAt: new Date().toISOString(),
    pageCount: parsed.pageCount,
    textLength: (parsed.markdown || '').length,
    engine: parsed.engine
  };
  await writeJson(metaPath, meta);

  // Save full markdown
  await fs.writeFile(path.join(wsDir, 'full_text.md'), parsed.markdown || '', 'utf-8');

  // Save figure map
  if (parsed.figureMap && parsed.figureMap.length > 0) {
    await writeJson(path.join(wsDir, 'figure_map.json'), parsed.figureMap);
  }

  // L1: 章节感知切分
  const chunks = chunkMarkdown(parsed.markdown || '');

  // Save chunks
  const chunksDir = path.join(wsDir, 'chunks');
  await fs.mkdir(chunksDir, { recursive: true });

  for (const chunk of chunks) {
    const chunkContent = chunk.metaHeader
      ? `${chunk.metaHeader}\n\n---\n\n${chunk.text}`
      : chunk.text;
    await fs.writeFile(
      path.join(chunksDir, `chunk_${chunk.index}.md`),
      chunkContent,
      'utf-8'
    );
  }

  // Save manifest
  const manifest = {
    chunkCount: chunks.length,
    chunks: chunks.map(c => ({
      index: c.index,
      section: c.section,
      tokenCount: c.tokenCount
    }))
  };
  await writeJson(manifestPath, manifest);

  // Create reading_notes dir
  await fs.mkdir(path.join(wsDir, 'reading_notes'), { recursive: true });

  return {
    paperId: resolvedPaperId,
    workspace: wsDir,
    pageCount: meta.pageCount,
    chunkCount: chunks.length,
    engine: parsed.engine,
    cached: false
  };
}

async function handleReadSkeleton({ paperId, focus }) {
  if (!paperId) throw new Error('ReadSkeleton requires paperId');
  const result = await generateSkeleton(paperId, { focus });
  return { paperId, globalMapPath: result.globalMapPath, content: result.globalMapContent };
}

async function handleReadDeep({ paperId, goal, maxChunks, batchSize, forceReread }) {
  if (!paperId) throw new Error('ReadDeep requires paperId');
  const opts = { goal };
  if (maxChunks) opts.maxChunks = maxChunks;
  if (batchSize) opts.batchSize = batchSize;
  if (forceReread) opts.forceReread = true;
  const result = await readDeep(paperId, opts);
  // Read the Round_1_Summary.md to return its content
  const summaryContent = fsSync.existsSync(result.roundPath)
    ? (await fs.readFile(result.roundPath, 'utf-8'))
    : '';
  return { ...result, content: summaryContent };
}

async function handleQuery({ paperId, question }) {
  return await queryPaper(paperId, question);
}

// ─── Main ───

async function main() {
  let inputData = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) inputData += chunk;

  const request = JSON.parse(inputData || '{}');
  const command = request.command;

  process.stderr.write(`[PaperReader][Main] request received: command=${command || 'undefined'}, paperId=${request.paperId || 'n/a'}\n`);

  try {
    if (!command) throw new Error('Missing command');

    let result;
    switch (command) {
      case 'IngestPDF':
        process.stderr.write('[PaperReader][Main] route hit: IngestPDF\n');
        result = await handleIngestPDF({ filePath: request.filePath, paperId: request.paperId, forceReparse: request.forceReparse });
        break;
      case 'ReadSkeleton':
        process.stderr.write('[PaperReader][Main] route hit: ReadSkeleton\n');
        result = await handleReadSkeleton({ paperId: request.paperId, focus: request.focus });
        break;
      case 'ReadDeep':
        process.stderr.write('[PaperReader][Main] route hit: ReadDeep\n');
        result = await handleReadDeep({ paperId: request.paperId, goal: request.goal, maxChunks: request.maxChunks, batchSize: request.batchSize, forceReread: request.forceReread });
        break;
      case 'Query':
        process.stderr.write('[PaperReader][Main] route hit: Query\n');
        result = await handleQuery({ paperId: request.paperId, question: request.question });
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }

    sendResponse({ status: 'success', result });
  } catch (err) {
    process.stderr.write(`[PaperReader][Main] request failed: command=${command || 'undefined'}, error=${err?.message || String(err)}\n`);
    sendResponse({ status: 'error', error: err?.message || String(err) });
  }
}

main();
