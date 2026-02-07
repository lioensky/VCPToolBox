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

async function handleIngestPDF({ filePath, paperId }) {
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
  await writeJson(path.join(wsDir, 'meta.json'), meta);

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
  await writeJson(path.join(chunksDir, 'manifest.json'), manifest);

  // Create reading_notes dir
  await fs.mkdir(path.join(wsDir, 'reading_notes'), { recursive: true });

  return {
    paperId: resolvedPaperId,
    workspace: wsDir,
    pageCount: meta.pageCount,
    chunkCount: chunks.length,
    engine: parsed.engine
  };
}

async function handleReadSkeleton({ paperId, focus }) {
  if (!paperId) throw new Error('ReadSkeleton requires paperId');
  const result = await generateSkeleton(paperId, { focus });
  return { paperId, globalMapPath: result.globalMapPath };
}

async function handleReadDeep({ paperId, goal }) {
  if (!paperId) throw new Error('ReadDeep requires paperId');
  return await readDeep(paperId, { goal });
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

  try {
    if (!command) throw new Error('Missing command');

    let result;
    switch (command) {
      case 'IngestPDF':
        result = await handleIngestPDF({ filePath: request.filePath, paperId: request.paperId });
        break;
      case 'ReadSkeleton':
        result = await handleReadSkeleton({ paperId: request.paperId, focus: request.focus });
        break;
      case 'ReadDeep':
        result = await handleReadDeep({ paperId: request.paperId, goal: request.goal });
        break;
      case 'Query':
        result = await handleQuery({ paperId: request.paperId, question: request.question });
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }

    sendResponse({ status: 'success', result });
  } catch (err) {
    sendResponse({ status: 'error', error: err?.message || String(err) });
  }
}

main();
