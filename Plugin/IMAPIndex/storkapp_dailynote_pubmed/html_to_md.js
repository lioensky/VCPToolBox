#!/usr/bin/env node
/**
 * 新版 html_to_md（支持批次 CLI 列表）：
 * - 若以 argv 传入 doi_key 列表，仅处理这些 key，且不清空整个 MD 目录（并发安全）
 * - 否则：扫描 fetched_webpages/ 下的 *.html，文件名即 doi_key.html，然后重建 MD 目录做全量转换
 * - 输出：converted_md/{doi_key}.md
 * - 链接：成功列表使用 doi_key 作为参数传给 md_to_txt.js
 */

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const TurndownService = require('turndown');
const { JSDOM } = require('jsdom');

// --- 配置 ---
const WORK_DIR = __dirname;
const HTML_SOURCE_DIR = path.join(WORK_DIR, 'fetched_webpages');
const MD_TARGET_DIR = path.join(WORK_DIR, 'converted_md');
const MD_TO_TXT_SCRIPT_PATH = path.join(WORK_DIR, 'md_to_txt.js');
// --- 配置结束 ---

const turndownService = new TurndownService();

async function listDoiKeysFromHtmlDir() {
  try {
    const files = await fs.readdir(HTML_SOURCE_DIR);
    const htmls = files.filter(f => f.toLowerCase().endsWith('.html'));
    const keys = htmls.map(f => f.replace(/\.html$/i, '').trim()).filter(Boolean);
    return keys;
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`[ERROR] 未找到目录: ${HTML_SOURCE_DIR}`);
      return [];
    }
    throw e;
  }
}

async function ensureMdDirExists() {
  try {
    await fs.mkdir(MD_TARGET_DIR, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

/**
 * 预处理 HTML，提取并清理正文，移除广告/导航/分享等噪音
 */
function preprocessHtml(htmlContent) {
  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;

  // 基础清理：脚本/样式/noscript
  document.querySelectorAll('script, style, noscript').forEach(el => el.remove());

  // 广泛过滤
  const selectorsToRemove = [
    'header', '.header', '.site-header', '.top', '.topbar', '.navbar', '.nav', '.site-nav',
    'footer', '.footer', '.site-footer', 'aside', '.sidebar', '.sidebar-*',
    '.ads', '[class*="ads"]', '[id*="ads"]',
    '.advertisement', '[class*="advertisement"]', '[id*="advertisement"]',
    '.banner', '[class*="banner"]', '[id*="banner"]',
    '.popup', '[class*="popup"]', '[id*="popup"]',
    '.share', '[class*="share"]', '[class*="social"]', '.social',
    '.breadcrumb', '.breadcrumbs', '.breadcrumbs-wrap',
    '.menu', '.site-menu', '.widget', '.related', '.related-posts',
    '.comments', '.comment', '.subscribe', '.search', '.site-search',
    '.tools', '.toolbox'
  ];
  try {
    document.querySelectorAll(selectorsToRemove.join(', ')).forEach(el => el.remove());
  } catch (_) {}

  // 隐藏元素
  document.querySelectorAll('[hidden],[aria-hidden="true"]').forEach(el => el.remove());
  document.querySelectorAll('[style*="display:none"], [style*="display: none"], [style*="visibility: hidden"]').forEach(el => el.remove());

  // 常见正文容器
  const articleSelectors = ['article', '.content', '.main', '.post-content', 'main', '#content', '#main', '.post', '.article-body'];
  let mainContent = null;
  for (const selector of articleSelectors) {
    try {
      mainContent = document.querySelector(selector);
      if (mainContent) break;
    } catch (_) {}
  }
  const targetElement = mainContent || document.body;

  // 删除正文内图片
  targetElement.querySelectorAll('img').forEach(el => el.remove());

  // 精细化去噪
  const children = Array.from(targetElement.children || []);
  children.forEach(child => {
    try {
      const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
      const textLen = text.length;
      const links = child.querySelectorAll('a') || [];
      let linksTextLen = 0;
      links.forEach(a => linksTextLen += ((a.textContent || '').trim().length));
      const linkCount = links.length;
      const linkDensity = textLen === 0 ? (linkCount > 0 ? 1 : 0) : (linksTextLen / textLen);

      if (
        (textLen < 200 && linkCount > 3) ||
        (linkDensity > 0.6 && textLen < 1000) ||
        ['nav', 'aside'].includes((child.tagName || '').toLowerCase()) ||
        (child.className && /breadcrumb|share|social|nav|menu|footer|header|sidebar|widget|related/i.test(child.className))
      ) {
        child.remove();
      }
    } catch (_) {}
  });

  // 空文本链接处理：无可见文本则使用 href（仅 http(s)）
  targetElement.querySelectorAll('a').forEach(a => {
    if (!a.textContent.trim() && a.href) {
      if (/^https?:\/\//i.test(a.href.trim())) {
        a.textContent = a.href;
      } else {
        a.remove();
      }
    }
  });

  // 移除空节点
  targetElement.querySelectorAll('a:empty').forEach(a => a.remove());
  const allElements = Array.from(targetElement.querySelectorAll('*'));
  allElements.forEach(el => {
    if (!el.textContent.trim() && el.children.length === 0 && !el.querySelector('a,img')) {
      el.remove();
    }
  });

  return targetElement.innerHTML;
}

/**
 * 将单个 HTML 文件转换为 MD
 * @param {string} doiKey
 */
async function convertOne(doiKey) {
  const htmlFilePath = path.join(HTML_SOURCE_DIR, `${doiKey}.html`);
  const mdFilePath = path.join(MD_TARGET_DIR, `${doiKey}.md`);
  try {
    const htmlContent = await fs.readFile(htmlFilePath, 'utf-8');
    const cleanedHtml = preprocessHtml(htmlContent);
    const markdown = turndownService.turndown(cleanedHtml);
    await fs.writeFile(mdFilePath, markdown);
    console.log(`  - 成功转换: ${path.basename(htmlFilePath)} -> ${path.basename(mdFilePath)}`);
    return true;
  } catch (error) {
    console.error(`  - 转换失败: ${path.basename(htmlFilePath)} (${error.message})`);
    return false;
  }
}

/**
 * 触发 MD 到 TXT 的转换脚本，参数使用 doi_key 列表
 */
function triggerMdToTxtScript(doiKeys) {
  return new Promise((resolve, reject) => {
    if (doiKeys.length === 0) {
      console.log('\n没有成功转换的 MD 文件，跳过 MD -> TXT 转换。');
      return resolve();
    }

    console.log(`\n--- 开始调用 MD -> TXT 转换脚本 ---`);
    const p = spawn('node', [MD_TO_TXT_SCRIPT_PATH, ...doiKeys], { stdio: 'inherit' });

    p.on('close', (code) => {
      console.log(`--- MD -> TXT 转换脚本执行完毕，退出码: ${code} ---`);
      code === 0 ? resolve() : reject(new Error(`MD -> TXT 转换脚本执行失败，退出码: ${code}`));
    });
    p.on('error', (err) => {
      console.error('无法启动 MD -> TXT 转换脚本:', err);
      reject(err);
    });
  });
}

async function main() {
  const argKeys = process.argv.slice(2).map(s => s.trim()).filter(Boolean);

  if (argKeys.length > 0) {
    console.log(`--- html_to_md: 处理指定批次 ${argKeys.length} 个 DOI ---`);
    // 并发安全：仅确保目录存在，不清空
    await ensureMdDirExists();

    const successfulKeys = [];
    for (let i = 0; i < argKeys.length; i++) {
      const doiKey = argKeys[i];
      console.log(`[${i + 1}/${argKeys.length}] 转换: ${doiKey}.html -> ${doiKey}.md`);
      const ok = await convertOne(doiKey);
      if (ok) successfulKeys.push(doiKey);
    }

    console.log(`\n批次完成。成功 ${successfulKeys.length} 个，失败 ${argKeys.length - successfulKeys.length} 个。`);
    await triggerMdToTxtScript(successfulKeys);
    return;
  }

  console.log('--- html_to_md: 扫描 fetched_webpages 并生成 MD（全量） ---');

  const doiKeys = await listDoiKeysFromHtmlDir();
  if (doiKeys.length === 0) {
    console.log('[INFO] 未找到任何 HTML 输入，退出。');
    return;
  }

  // 全量模式：重建 MD 目录
  try {
    await fs.rm(MD_TARGET_DIR, { recursive: true, force: true });
    await fs.mkdir(MD_TARGET_DIR, { recursive: true });
    console.log(`已清空并重建目录: ${MD_TARGET_DIR}`);
  } catch (error) {
    console.error(`处理目录时出错: ${MD_TARGET_DIR}`, error);
    return;
  }

  console.log(`准备转换 ${doiKeys.length} 个 HTML -> MD`);
  const successfulKeys = [];

  for (let i = 0; i < doiKeys.length; i++) {
    const doiKey = doiKeys[i];
    console.log(`[${i + 1}/${doiKeys.length}] 正在转换: ${doiKey}.html -> ${doiKey}.md`);
    const ok = await convertOne(doiKey);
    if (ok) successfulKeys.push(doiKey);
  }

  console.log(`\n转换任务完成。成功 ${successfulKeys.length} 个，失败 ${doiKeys.length - successfulKeys.length} 个。`);

  await triggerMdToTxtScript(successfulKeys);
}

main().catch(error => {
  console.error(`发生未处理的严重错误:`, error);
  process.exit(1);
});