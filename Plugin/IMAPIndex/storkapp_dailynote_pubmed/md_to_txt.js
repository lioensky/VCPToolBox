#!/usr/bin/env node
/**
 * md_to_txt（pubmed 分支）
 * 变更（硬编码目录名，便于手工修改）：
 * - TXT 输出目录：固定写入 dailynote/{OUTPUT_SUBDIR_NAME}（例如 dailynote/文献鸟），可在本文件开头手动修改 OUTPUT_SUBDIR_NAME
 * - 父目录校验：父目录必须为 dailynote 且存在，否则不创建目标目录并让流程失败
 * - 永久索引更新：仅扫描 dailynote/{OUTPUT_SUBDIR_NAME} 目录下的 .txt 文件名（去扩展名），去重后覆盖写入 paper_doi.index.txt
 * - 保持：成功写出 TXT 后删除对应 MD；若 HTML 仍存在则尝试删除（失败忽略）
 */

const fs = require('fs').promises;
const path = require('path');

// ============================ 手动可改配置（开始） ============================
// dailynote 子目录名（手动修改），例如：'文献鸟'
const OUTPUT_SUBDIR_NAME = '文献';
// ============================ 手动可改配置（结束） ============================

// --- 固定路径配置 ---
const WORK_DIR = __dirname;
const MD_SOURCE_DIR = path.join(WORK_DIR, 'converted_md');
const HTML_SOURCE_DIR = path.join(WORK_DIR, 'fetched_webpages');
const PERMANENT_INDEX_FILE = path.join(WORK_DIR, 'paper_doi.index.txt');

// 父级 dailynote 根目录（必须已存在且名称为 dailynote）
const DAILYNOTE_ROOT = path.resolve(WORK_DIR, '..', '..', '..', 'dailynote');
// --- 配置结束 ---

/**
 * 北京时间（Asia/Shanghai）日期片段
 */
function getBeijingDateParts() {
  const now = new Date();
  const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d = String(bj.getDate()).padStart(2, '0');
  return { y, m, d };
}

/**
 * 生成 TXT 输出目录：dailynote/{OUTPUT_SUBDIR_NAME}
 * 约束：
 * - 父目录必须名为 dailynote，且 dailynote 目录必须已存在
 * - OUTPUT_SUBDIR_NAME 必须设置，且不包含路径分隔符（防止越界）
 */
async function ensureAndGetTxtDir() {
  // 校验硬编码目录名
  const CUSTOM_DIR_NAME = (OUTPUT_SUBDIR_NAME || '').trim();
  if (!CUSTOM_DIR_NAME) {
    const msg = `[FATAL] 硬编码 OUTPUT_SUBDIR_NAME 为空，无法确定 TXT 输出目录名`;
    console.error(msg);
    throw new Error(msg);
  }
  if (/[\\/]/.test(CUSTOM_DIR_NAME)) {
    const msg = `[FATAL] OUTPUT_SUBDIR_NAME 不能包含路径分隔符: ${CUSTOM_DIR_NAME}`;
    console.error(msg);
    throw new Error(msg);
  }

  // 父目录名校验
  const parentBase = path.basename(DAILYNOTE_ROOT);
  if (parentBase !== 'dailynote') {
    const msg = `[FATAL] 目标父目录名不是 dailynote: ${DAILYNOTE_ROOT}`;
    console.error(msg);
    throw new Error(msg);
  }

  // 父目录存在性与类型校验
  try {
    const st = await fs.stat(DAILYNOTE_ROOT);
    if (!st.isDirectory()) {
      const msg = `[FATAL] 父路径存在但不是目录: ${DAILYNOTE_ROOT}`;
      console.error(msg);
      throw new Error(msg);
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      const msg = `[FATAL] 父目录不存在，不创建：${DAILYNOTE_ROOT}`;
      console.error(msg);
      throw new Error(msg);
    }
    throw e;
  }

  const newDir = path.join(DAILYNOTE_ROOT, CUSTOM_DIR_NAME);
  try {
    await fs.mkdir(newDir, { recursive: true });
  } catch (e) {
    const msg = `[FATAL] 创建目录失败: ${newDir} (${e.message})`;
    console.error(msg);
    throw new Error(msg);
  }
  return newDir;
}

/**
 * 简化 Markdown 到纯文本，并只保留包含 doi.org 的行（若有链接）
 */
function normalizeMarkdownToTxt(markdownContent) {
  const linkRegex = /https?:\/\//;
  const doiRegex = /doi\.org/;

  const processed = markdownContent
    .replace(/^#+\s/gm, '')                          // 标题
    .replace(/(\*\*|__|\*|_)(.*?)\1/g, '$2')         // 粗体/斜体
    .replace(/!\[.*?\]\(.*?\)/g, '')                 // 图片
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1 ($2)')       // 链接提示
    .replace(/`([^`]+)`/g, '$1')                     // 行内代码
    .replace(/^-{3,}\s*$/gm, '')                     // 分隔线
    .replace(/\n{3,}/g, '\n\n');                     // 多空行

  const lines = processed.split('\n');
  const filtered = lines.filter(line => {
    const hasLink = linkRegex.test(line);
    if (!hasLink) return true;
    return doiRegex.test(line);
  });

  return filtered.join('\n').trim();
}

/**
 * 将单个 MD 文件转换为 TXT，并执行清理
 * @param {string} doiKey
 * @param {string} txtDir
 */
async function processOne(doiKey, txtDir) {
  const mdFilePath = path.join(MD_SOURCE_DIR, `${doiKey}.md`);
  const htmlFilePath = path.join(HTML_SOURCE_DIR, `${doiKey}.html`); // 可能已被上游删除
  const txtFilePath = path.join(txtDir, `${doiKey}.txt`);

  try {
    const mdContent = await fs.readFile(mdFilePath, 'utf-8');
    const normalized = normalizeMarkdownToTxt(mdContent);

    const { y, m, d } = getBeijingDateParts();
    const headerDate = `${y}-${m}-${d}`;
    const finalContent = `[${headerDate}] - 文献\n` + normalized;

    await fs.writeFile(txtFilePath, finalContent);
    console.log(`  - 成功写出 TXT: ${path.relative(DAILYNOTE_ROOT, txtFilePath)}`);

    // 清理 HTML（若存在）
    try {
      await fs.unlink(htmlFilePath);
    } catch (e) {
      // 可能已在 HTML->MD 后删除；忽略
    }
    // 清理 MD
    try {
      await fs.unlink(mdFilePath);
    } catch (e) {
      // 忽略
    }

    return true;
  } catch (error) {
    console.error(`  - 处理失败: ${path.basename(mdFilePath)} (${error.message})`);
    return false;
  }
}

/**
 * 重建永久索引（仅扫描 dailynote/{OUTPUT_SUBDIR_NAME}）：
 * - 收集该目录下所有 .txt 文件的文件名（去掉扩展名）
 * - 去重并覆盖写入 paper_doi.index.txt
 */
async function rebuildPermanentIndex() {
  const CUSTOM_DIR_NAME = (OUTPUT_SUBDIR_NAME || '').trim();
  if (!CUSTOM_DIR_NAME) {
    console.error(`[ERROR] 永久索引重建失败：OUTPUT_SUBDIR_NAME 为空`);
    return;
  }
  const targetDir = path.join(DAILYNOTE_ROOT, CUSTOM_DIR_NAME);
  let list = [];

  try {
    const st = await fs.stat(targetDir);
    if (!st.isDirectory()) {
      console.error(`[ERROR] 目标不是目录，索引重建跳过: ${targetDir}`);
    } else {
      const files = await fs.readdir(targetDir);
      const names = new Set();
      for (const fn of files) {
        if (!fn.toLowerCase().endsWith('.txt')) continue;
        const base = path.parse(fn).name;
        if (base) names.add(base);
      }
      list = Array.from(names);
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[WARN] 目标目录不存在，索引将写为空: ${targetDir}`);
      list = [];
    } else {
      throw e;
    }
  }

  // 稳定排序
  list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  try {
    await fs.writeFile(PERMANENT_INDEX_FILE, list.join('\n'));
    console.log(`[OK] 永久索引已重建：${PERMANENT_INDEX_FILE}（计数 ${list.length}）`);
  } catch (e) {
    console.error(`[ERROR] 覆盖写入永久索引失败: ${e.message}`);
  }
}

async function main() {
  const doiKeys = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
  if (doiKeys.length === 0) {
    console.log('没有需要处理的 DOI。');
    return;
  }

  let txtDir = '';
  try {
    txtDir = await ensureAndGetTxtDir();
    console.log(`TXT 输出目录：${txtDir}`);
  } catch (e) {
    // 按要求：父目录非 dailynote 或不存在时不创建并让流程失败；配置缺失也失败
    process.exitCode = 1;
    return;
  }

  console.log(`准备处理 ${doiKeys.length} 个 MD -> TXT（按 DOI 命名）...`);

  let okCount = 0;
  for (let i = 0; i < doiKeys.length; i++) {
    const doiKey = doiKeys[i];
    console.log(`[${i + 1}/${doiKeys.length}] 正在处理: ${doiKey}.md`);
    const ok = await processOne(doiKey, txtDir);
    if (ok) okCount++;
  }

  console.log(`\n处理任务完成。成功 ${okCount} 个，失败 ${doiKeys.length - okCount} 个。`);

  // 重建永久索引（覆盖写）
  await rebuildPermanentIndex();
}

main().catch(err => {
  console.error(`发生未处理的严重错误: ${err.message}`);
  process.exit(1);
});