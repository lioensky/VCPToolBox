#!/usr/bin/env node
/**
 * 新版 md_to_txt（与 DOI 命名抓取对齐）：
 * - 输入：argv 传入 doi_key 列表（由 html_to_md.js 调用）
 * - 读取：converted_md/doi_key.md
 * - 输出：<外部目录>/doi_key.txt（不创建外部目录，若不存在则跳过并记录错误）
 * - 清理：成功写出 TXT 后，删除 fetched_webpages/doi_key.html 与 converted_md/doi_key.md
 * - 索引：将成功的 doi_key 追加写入 paper_doi.index.txt（永久索引）
 */

const fs = require('fs').promises;
const path = require('path');

// --- 配置 ---
const WORK_DIR = __dirname;
const MD_SOURCE_DIR = path.join(WORK_DIR, 'converted_md');
const TXT_TARGET_DIR = path.join(WORK_DIR, '..', '..', '..', 'dailynote', '文献'); // 不创建该目录
const HTML_SOURCE_DIR = path.join(WORK_DIR, 'fetched_webpages');
const PERMANENT_INDEX_FILE = path.join(WORK_DIR, 'paper_doi.index.txt');
// --- 配置结束 ---

/**
 * 获取格式化的北京时间日期（用于日记抬头）
 */
function getBeijingDateHeader() {
  const now = new Date();
  const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d = String(bj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
 * 将单个 MD 文件转换为 TXT，并执行清理与索引
 * @param {string} doiKey
 */
async function processOne(doiKey) {
  const mdFilePath = path.join(MD_SOURCE_DIR, `${doiKey}.md`);
  const htmlFilePath = path.join(HTML_SOURCE_DIR, `${doiKey}.html`);
  const txtFilePath = path.join(TXT_TARGET_DIR, `${doiKey}.txt`);

  try {
    const mdContent = await fs.readFile(mdFilePath, 'utf-8');
    const normalized = normalizeMarkdownToTxt(mdContent);

    const headerDate = getBeijingDateHeader();
    const finalContent = `[${headerDate}] - 文献\n` + normalized;

    // 不创建外部目录，若不存在则写入会抛错，捕获后记录并跳过
    try {
      await fs.writeFile(txtFilePath, finalContent);
      console.log(`  - 成功写出 TXT: ${path.basename(txtFilePath)}`);
    } catch (writeErr) {
      console.error(`  - 写入 TXT 失败（可能外部目录不存在）: ${path.basename(txtFilePath)} (${writeErr.message})`);
      // 外部目录缺失时仅记录错误，保留中间件以便后续可重试
      return false;
    }

    // 清理中间件
    try {
      await fs.unlink(htmlFilePath);
    } catch (e) {
      // 忽略 HTML 清理失败
    }
    try {
      await fs.unlink(mdFilePath);
    } catch (e) {
      // 忽略 MD 清理失败
    }

    return true;
  } catch (error) {
    console.error(`  - 处理失败: ${path.basename(mdFilePath)} (${error.message})`);
    return false;
  }
}

/**
 * 追加永久索引（doi_key 列表）
 */
async function appendToPermanentIndex(doiKeys) {
  if (!doiKeys.length) return;
  try {
    let existing = '';
    try {
      existing = await fs.readFile(PERMANENT_INDEX_FILE, 'utf-8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const prefix = existing.trim().length > 0 ? '\n' : '';
    await fs.appendFile(PERMANENT_INDEX_FILE, prefix + doiKeys.join('\n'));
    console.log(`\n已将 ${doiKeys.length} 个 DOI 追加到永久索引: ${PERMANENT_INDEX_FILE}`);
  } catch (e) {
    console.error(`[ERROR] 更新永久索引失败: ${e.message}`);
  }
}

async function main() {
  const doiKeys = process.argv.slice(2);
  if (doiKeys.length === 0) {
    console.log('没有需要处理的 DOI。');
    return;
  }

  console.log(`准备处理 ${doiKeys.length} 个 MD -> TXT（按 DOI 命名）...`);

  const successful = [];
  for (let i = 0; i < doiKeys.length; i++) {
    const doiKey = doiKeys[i];
    console.log(`[${i + 1}/${doiKeys.length}] 正在处理: ${doiKey}.md`);
    const ok = await processOne(doiKey);
    if (ok) successful.push(doiKey);
  }

  console.log(`\n处理任务完成。成功 ${successful.length} 个，失败 ${doiKeys.length - successful.length} 个。`);

  await appendToPermanentIndex(successful);
}

main().catch(err => {
  console.error(`发生未处理的严重错误: ${err.message}`);
  process.exit(1);
});