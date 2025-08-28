#!/usr/bin/env node
const axios = require('axios');
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// --- 配置 ---
const WORK_DIR = __dirname;
const TARGET_DIR = path.join(WORK_DIR, 'fetched_webpages');
const STORK_IDS_TMP = path.join(WORK_DIR, 'stork_paper_ids.tmp.txt');
const STORK_IDS_NEW_TMP = path.join(WORK_DIR, 'stork_paper_ids.new.tmp.txt'); // 若存在则使用它（即使为空也不回退）
const PUBMED_IDS_TMP = path.join(WORK_DIR, 'pubmed_ids.tmp.txt');

const STORK_SHOW_BASE = 'https://www.storkapp.cn/paper/showPaper.php?id=';
const STORK_REFERER = 'https://www.storkapp.cn/paper/showPaper.php';
const PUBMED_PAGE_BASE = 'https://www.storkapp.me/pubpaper/';

const HTML_TO_MD_SCRIPT_PATH = path.join(WORK_DIR, 'html_to_md.js');
const PERMANENT_INDEX_FILE = path.join(WORK_DIR, 'paper_doi.index.txt');

const FETCH_INTERVAL_MS = parseInt(process.env.STORK_FETCH_INTERVAL_MS || '2000', 10);
// 新增：批次大小（成功抓取到 N 个 HTML 即触发后续流程；默认 50）
const HTML_BATCH_SIZE = parseInt(process.env.HTML_BATCH_SIZE || '50', 10);

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 StorkFetcher/3.0',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2'
};
// --- 配置结束 ---

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function doiToKey(doi) {
  return String(doi).trim().replace(/\//g, '_');
}

function sanitizeFilename(name) {
  // 替换 Windows 非法字符，并修剪首尾空白与点
  let n = String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/[\. ]+$/g, ''); // 去除末尾点或空格
  return n || 'unknown';
}

async function readLines(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[ERROR] 读取失败: ${filePath} -> ${err.message}`);
    }
    return [];
  }
}

async function readTsvPairs(filePath) {
  const lines = await readLines(filePath);
  const pairs = [];
  for (const line of lines) {
    const [idRaw, doiRaw] = line.split('\t');
    const id = (idRaw || '').trim();
    const doi = (doiRaw || '').trim();
    if (id) {
      pairs.push({ id, doi });
    }
  }
  return pairs;
}

async function getStorkPairs() {
  // 关键行为：若 NEW 文件存在则永远使用它（即使为空也不回退）
  if (fssync.existsSync(STORK_IDS_NEW_TMP)) {
    return await readTsvPairs(STORK_IDS_NEW_TMP);
  }
  return await readTsvPairs(STORK_IDS_TMP);
}

async function getPubmedPairs() {
  return await readTsvPairs(PUBMED_IDS_TMP);
}

async function readPermanentIndex() {
  try {
    const txt = await fs.readFile(PERMANENT_INDEX_FILE, 'utf-8');
    return new Set(txt.split('\n').map(s => s.trim()).filter(Boolean));
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    throw e;
  }
}

async function ensureCleanTargetDir() {
  try {
    await fs.rm(TARGET_DIR, { recursive: true, force: true });
    await fs.mkdir(TARGET_DIR, { recursive: true });
    console.log(`已清空并重建目录: ${TARGET_DIR}`);
  } catch (err) {
    console.error(`[FATAL] 处理目录失败: ${TARGET_DIR} -> ${err.message}`);
    throw err;
  }
}

async function fetchAndSave(url, destPath, headers = {}) {
  try {
    const resp = await axios.get(url, { headers: { ...COMMON_HEADERS, ...headers }, timeout: 20000, maxRedirects: 5 });
    if (resp.status === 200 && typeof resp.data === 'string') {
      await fs.writeFile(destPath, resp.data);
      return true;
    }
    console.warn(`[WARN] 非 200 或返回非文本: url=${url}, status=${resp.status}`);
    return false;
  } catch (err) {
    const msg = err.response ? `状态码 ${err.response.status}` : err.message;
    console.error(`[ERROR] 抓取失败: url=${url} -> ${msg}`);
    return false;
  }
}

/**
 * 构建抓取任务：仅保留含 DOI 的记录，使用永久索引去重，冲突时 stork 优先
 * 返回 Map<doi_key, { source: 'stork'|'pubmed', id: string }>
 */
async function buildTasks() {
  const storkPairs = await getStorkPairs();
  const pubmedPairs = await getPubmedPairs();
  const permanent = await readPermanentIndex();

  const byDoi = new Map();

  // 先放入 stork（优先）
  for (const { id, doi } of storkPairs) {
    const d = (doi || '').trim();
    if (!d) continue;
    const key = sanitizeFilename(doiToKey(d));
    if (permanent.has(key)) continue;
    byDoi.set(key, { source: 'stork', id: String(id) });
  }

  // 再放入 pubmed（仅当同 DOI 未被 stork 覆盖）
  for (const { id, doi } of pubmedPairs) {
    const d = (doi || '').trim();
    if (!d) continue;
    const key = sanitizeFilename(doiToKey(d));
    if (permanent.has(key)) continue;
    if (byDoi.has(key)) continue; // 已有 stork
    byDoi.set(key, { source: 'pubmed', id: String(id) });
  }

  return byDoi;
}

function spawnHtmlToMdBatch(doiKeys) {
  if (!doiKeys || doiKeys.length === 0) return null;
  console.log(`--- 触发批次转换 (size=${doiKeys.length}) ---`);
  // 异步触发，不等待
  const p = spawn('node', [HTML_TO_MD_SCRIPT_PATH, ...doiKeys], { stdio: 'inherit', cwd: WORK_DIR });
  p.on('error', (err) => {
    console.error(`[ERROR] 启动 html_to_md.js 失败: ${err.message}`);
  });
  p.on('close', (code) => {
    console.log(`--- 批次转换进程退出码: ${code} ---`);
  });
  return p;
}

async function main() {
  console.log('--- fetch_stork_pages: 按 DOI 命名抓取 HTML（批次触发下游）---');
  console.log(`节流: ${FETCH_INTERVAL_MS}ms, 批次: ${HTML_BATCH_SIZE}`);

  const tasks = await buildTasks();
  const entries = Array.from(tasks.entries());

  console.log(`准备抓取条目：${entries.length} 个（已按永久索引与 DOI 过滤）`);
  if (entries.length === 0) {
    console.log('无待抓取条目。退出。');
    return;
  }

  await ensureCleanTargetDir();

  let ok = 0;
  let batchKeys = [];
  let spawnedCount = 0;

  for (let i = 0; i < entries.length; i++) {
    const [doiKey, info] = entries[i];
    const dest = path.join(TARGET_DIR, `${doiKey}.html`);
    let url = '';
    let headers = {};
    if (info.source === 'stork') {
      url = `${STORK_SHOW_BASE}${encodeURIComponent(info.id)}`;
      headers = { Referer: STORK_REFERER };
    } else {
      url = `${PUBMED_PAGE_BASE}${encodeURIComponent(info.id)}`;
      headers = { Referer: 'https://www.storkapp.me/' };
    }
    console.log(`[${i + 1}/${entries.length}] GET ${url} -> ${path.basename(dest)} (${info.source})`);
    const success = await fetchAndSave(url, dest, headers);
    if (success) {
      ok++;
      batchKeys.push(doiKey);
      if (batchKeys.length >= HTML_BATCH_SIZE) {
        spawnHtmlToMdBatch(batchKeys);
        spawnedCount++;
        batchKeys = [];
      }
    }
    if (i < entries.length - 1) await delay(FETCH_INTERVAL_MS);
  }

  // 处理尾批（未满一批）
  if (batchKeys.length > 0) {
    spawnHtmlToMdBatch(batchKeys);
    spawnedCount++;
  }

  console.log(`抓取完成：成功 ${ok}/${entries.length}，已异步触发 ${spawnedCount} 个批次转换。`);
  console.log('注意：批次转换在后台进行，本进程不等待其完成。');
}

main().catch(err => {
  console.error(`发生未处理的严重错误: ${err.message}`);
  process.exit(1);
});