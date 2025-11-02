#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
// --- 配置 ---
const MD_SOURCE_DIR = path.join(__dirname, 'converted_md');
const TXT_TARGET_DIR = path.join(__dirname, '..', '..', '..', 'dailynote', '文献');
const HTML_SOURCE_DIR = path.join(__dirname, 'fetched_webpages');
const PERMANENT_INDEX_FILE = path.join(__dirname, 'stork_paper_ids.txt');
// --- 配置结束 ---

/**
 * 规整 MD 内容为 TXT
 * @param {string} markdownContent 
 * @returns {string}
 */
/**
 * 获取格式化的时区时间戳
 * @returns {{fileNameTimestamp: string, headerDate: string}}
 */
function getFormattedTimestamps() {
    const now = new Date();
    const localTime = new Date(now.toLocaleString("en-US", { timeZone: DEFAULT_TIMEZONE }));

    const year = localTime.getFullYear();
    const month = (beijingTime.getMonth() + 1).toString().padStart(2, '0');
    const day = beijingTime.getDate().toString().padStart(2, '0');
    const hours = beijingTime.getHours().toString().padStart(2, '0');
    const minutes = beijingTime.getMinutes().toString().padStart(2, '0');
    const seconds = beijingTime.getSeconds().toString().padStart(2, '0');

    const fileNameTimestamp = `${year}-${month}-${day}-${hours}_${minutes}_${seconds}`;
    const headerDate = `${year}-${month}-${day}`;
    
    return { fileNameTimestamp, headerDate };
}


function normalizeMarkdownToTxt(markdownContent) {
    const linkRegex = /https?:\/\//;
    const doiRegex = /doi\.org/;

    const processedContent = markdownContent
        // 移除 Markdown 标题
        .replace(/^#+\s/gm, '')
        // 移除加粗、斜体
        .replace(/(\*\*|__|\*|_)(.*?)\1/g, '$2')
        // 移除图片链接
        .replace(/!\[.*?\]\(.*?\)/g, '')
        // 将链接转换为 "文本 (链接)" 格式
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1 ($2)')
        // 移除行内代码
        .replace(/`([^`]+)`/g, '$1')
        // 移除分隔线
        .replace(/^-{3,}\s*$/gm, '')
        // 合并多个空行
        .replace(/\n{3,}/g, '\n\n');

    const lines = processedContent.split('\n');
    const filteredLines = lines.filter(line => {
        const hasLink = linkRegex.test(line);
        if (!hasLink) {
            return true; // 保留没有链接的行
        }
        const hasDoi = doiRegex.test(line);
        return hasDoi; // 如果有链接，则仅保留包含 doi.org 的行
    });

    return filteredLines.join('\n').trim();
}

/**
 * 将单个 MD 文件转换为 TXT，并执行清理和索引更新
 * @param {string} paperId
 * @returns {Promise<boolean>}
 */
async function processMdToTxt(paperId) {
    const mdFilePath = path.join(MD_SOURCE_DIR, `${paperId}.md`);
    const htmlFilePath = path.join(HTML_SOURCE_DIR, `${paperId}.html`);

    const { headerDate } = getFormattedTimestamps();
    const newTxtFileName = `${paperId}.txt`;
    const txtFilePath = path.join(TXT_TARGET_DIR, newTxtFileName);

    try {
        const mdContent = await fs.readFile(mdFilePath, 'utf-8');
        const normalizedContent = normalizeMarkdownToTxt(mdContent);
        
        const diaryHeader = `[${headerDate}] - 文献\n`;
        const finalContent = diaryHeader + normalizedContent;

        await fs.writeFile(txtFilePath, finalContent);
        console.log(`  - 成功转换: ${path.basename(mdFilePath)} -> ${newTxtFileName}`);

        // 清理中间文件
        await fs.unlink(htmlFilePath);
        await fs.unlink(mdFilePath);
        console.log(`  - 已清理中间文件: ${path.basename(htmlFilePath)}, ${path.basename(mdFilePath)}`);

        return true;
    } catch (error) {
        console.error(`  - 处理失败: ${path.basename(mdFilePath)} (${error.message})`);
        return false;
    }
}

/**
 * 将成功的 ID 追加到永久索引
 * @param {string[]} successfulIds 
 */
async function appendToPermanentIndex(successfulIds) {
    if (successfulIds.length === 0) return;

    try {
        // 读取现有文件以确定是否需要在开头添加换行符
        let existingContent = '';
        try {
            existingContent = await fs.readFile(PERMANENT_INDEX_FILE, 'utf-8');
        } catch (readError) {
            if (readError.code !== 'ENOENT') throw readError;
        }

        const contentToAppend = (existingContent.trim().length > 0 ? '\n' : '') + successfulIds.join('\n');
        await fs.appendFile(PERMANENT_INDEX_FILE, contentToAppend);
        console.log(`\n已将 ${successfulIds.length} 个新 ID 追加到永久索引: ${PERMANENT_INDEX_FILE}`);
    } catch (error) {
        console.error(`\n更新永久索引失败:`, error);
    }
}

/**
 * 主函数
 */
async function main() {
    const idsToProcess = process.argv.slice(2);
    const successfulIds = [];

    if (idsToProcess.length === 0) {
        console.log("没有需要处理的 ID。");
        return;
    }

    console.log(`准备处理 ${idsToProcess.length} 个 MD 文件...`);

    console.log("开始处理:");
    for (let i = 0; i < idsToProcess.length; i++) {
        const paperId = idsToProcess[i];
        console.log(`[${i + 1}/${idsToProcess.length}] 正在处理 ID: ${paperId}`);
        const success = await processMdToTxt(paperId);
        if (success) {
            successfulIds.push(paperId);
        }
    }

    console.log(`\n处理任务完成。成功 ${successfulIds.length} 个，失败 ${idsToProcess.length - successfulIds.length} 个。`);

    await appendToPermanentIndex(successfulIds);
}

main().catch(error => {
    console.error(`发生未处理的严重错误:`, error);
    process.exit(1);
});