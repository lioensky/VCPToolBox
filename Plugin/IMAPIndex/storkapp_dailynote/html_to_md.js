#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const TurndownService = require('turndown');
const { JSDOM } = require('jsdom');

// --- 配置 ---
const HTML_SOURCE_DIR = path.join(__dirname, 'fetched_webpages');
const MD_TARGET_DIR = path.join(__dirname, 'converted_md');
const MD_TO_TXT_SCRIPT_PATH = path.join(__dirname, 'md_to_txt.js');
// --- 配置结束 ---

const turndownService = new TurndownService();

/**
 * 预处理 HTML，提取并清理正文，移除广告/导航/分享等噪音
 * @param {string} htmlContent
 * @returns {string}
 */
function preprocessHtml(htmlContent) {
    const dom = new JSDOM(htmlContent);
    const document = dom.window.document;

    // 基础清理：脚本/样式/noscript
    document.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    // 广泛的噪音选择器（参考 UrlFetch.js 并扩展）
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
    } catch (e) {
        // 某些选择器可能不被支持或存在异常，忽略失败
    }

    // 移除通过 style 隐藏的元素
    document.querySelectorAll('[hidden],[aria-hidden="true"]').forEach(el => el.remove());
    document.querySelectorAll('[style*="display:none"], [style*="display: none"], [style*="visibility: hidden"]').forEach(el => el.remove());

    // 优先从常见正文容器中提取
    const articleSelectors = ['article', '.content', '.main', '.post-content', 'main', '#content', '#main', '.post', '.article-body'];
    let mainContent = null;
    for (const selector of articleSelectors) {
        try {
            mainContent = document.querySelector(selector);
            if (mainContent) break;
        } catch (e) { /* ignore */ }
    }
    const targetElement = mainContent || document.body;

    // 移除图片（在正文内）
    targetElement.querySelectorAll('img').forEach(el => el.remove());

    // 精细化：按子节点进行链接密度与长度判断，剔除导航/分享等噪音块
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

            // 条件：短文本且包含较多链接，或链接文本占比较高，或明显的结构标签
            if (
                (textLen < 200 && linkCount > 3) ||
                (linkDensity > 0.6 && textLen < 1000) ||
                ['nav','aside'].includes((child.tagName || '').toLowerCase()) ||
                (child.className && /breadcrumb|share|social|nav|menu|footer|header|sidebar|widget|related/i.test(child.className))
            ) {
                child.remove();
            }
        } catch (e) {
            // 忽略个别节点解析错误
        }
    });

    // 处理仅图片/空文本的链接：移除图片后若无可见文本，使用 href（仅保留 http(s)）
    targetElement.querySelectorAll('a').forEach(a => {
        if (!a.textContent.trim() && a.href) {
            if (/^https?:\/\//i.test(a.href.trim())) {
                a.textContent = a.href;
            } else {
                // 非 http 链接（javascript: 等）删掉
                a.remove();
            }
        }
    });

    // 移除空链接与空节点
    targetElement.querySelectorAll('a:empty').forEach(a => a.remove());
    const allElements = Array.from(targetElement.querySelectorAll('*'));
    allElements.forEach(el => {
        if (!el.textContent.trim() && el.children.length === 0 && !el.querySelector('a,img')) {
            el.remove();
        }
    });

    // 返回正文内干净的 HTML（保留必要链接文本）
    return targetElement.innerHTML;
}


/**
 * 将单个 HTML 文件转换为 MD
 * @param {string} paperId
 * @returns {Promise<boolean>}
 */
async function convertHtmlToMd(paperId) {
    const htmlFilePath = path.join(HTML_SOURCE_DIR, `${paperId}.html`);
    const mdFilePath = path.join(MD_TARGET_DIR, `${paperId}.md`);

    try {
        const htmlContent = await fs.readFile(htmlFilePath, 'utf-8');
        const cleanedHtml = preprocessHtml(htmlContent);
        const markdown = turndownService.turndown(cleanedHtml);
        await fs.writeFile(mdFilePath, markdown);
        console.log(`  - 成功转换: ${paperId}.html -> ${paperId}.md`);
        return true;
    } catch (error) {
        console.error(`  - 转换失败: ${paperId}.html (${error.message})`);
        return false;
    }
}

/**
 * 触发 MD 到 TXT 的转换脚本
 * @param {string[]} successfulIds 
 */
function triggerMdToTxtScript(successfulIds) {
    return new Promise((resolve, reject) => {
        if (successfulIds.length === 0) {
            console.log("\n没有成功转换的 MD 文件，跳过 MD -> TXT 转换。");
            return resolve();
        }

        console.log(`\n--- 开始调用 MD -> TXT 转换脚本 ---`);
        const convertProcess = spawn('node', [MD_TO_TXT_SCRIPT_PATH, ...successfulIds], { stdio: 'inherit' });

        convertProcess.on('close', (code) => {
            console.log(`--- MD -> TXT 转换脚本执行完毕，退出码: ${code} ---`);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`MD -> TXT 转换脚本执行失败，退出码: ${code}`));
            }
        });

        convertProcess.on('error', (err) => {
            console.error('无法启动 MD -> TXT 转换脚本:', err);
            reject(err);
        });
    });
}

/**
 * 主函数
 */
async function main() {
    const idsToConvert = process.argv.slice(2);
    const successfulIds = [];

    if (idsToConvert.length === 0) {
        console.log("没有需要转换的 ID。");
        return;
    }

    console.log(`准备转换 ${idsToConvert.length} 个 HTML 文件...`);

    try {
        await fs.rm(MD_TARGET_DIR, { recursive: true, force: true });
        await fs.mkdir(MD_TARGET_DIR, { recursive: true });
        console.log(`已清空并重建目录: ${MD_TARGET_DIR}`);
    } catch (error) {
        console.error(`处理目录时出错: ${MD_TARGET_DIR}`, error);
        return;
    }

    console.log("开始转换:");
    for (let i = 0; i < idsToConvert.length; i++) {
        const paperId = idsToConvert[i];
        console.log(`[${i + 1}/${idsToConvert.length}] 正在转换 ID: ${paperId}`);
        const success = await convertHtmlToMd(paperId);
        if (success) {
            successfulIds.push(paperId);
        }
    }

    console.log(`\n转换任务完成。成功 ${successfulIds.length} 个，失败 ${idsToConvert.length - successfulIds.length} 个。`);

    await triggerMdToTxtScript(successfulIds);
}

main().catch(error => {
    console.error(`发生未处理的严重错误:`, error);
    process.exit(1);
});