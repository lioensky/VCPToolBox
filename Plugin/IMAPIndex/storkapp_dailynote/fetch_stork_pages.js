#!/usr/bin/env node
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

// --- 配置 ---
const TARGET_DIR = path.join(__dirname, 'fetched_webpages');
const BASE_URL = 'https://www.storkapp.cn/paper/showPaper.php';
const FETCH_INTERVAL = 5000;
const HTML_TO_MD_SCRIPT_PATH = path.join(__dirname, 'html_to_md.js');
// --- 配置结束 ---

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 抓取单个网页并保存
 * @param {string} paperId - 文献 ID
 * @returns {Promise<boolean>} - 返回 true 表示成功，false 表示失败
 */
async function fetchAndSave(paperId) {
    const url = `${BASE_URL}?id=${paperId}`;
    const filePath = path.join(TARGET_DIR, `${paperId}.html`);

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 StorkPageFetcher/1.0.0'
            },
            timeout: 20000
        });

        if (response.status === 200) {
            await fs.writeFile(filePath, response.data);
            console.log(`  - 成功: ${paperId}`);
            return true;
        } else {
            console.warn(`  - 警告: ${paperId} 返回状态码 ${response.status}`);
            return false;
        }
    } catch (error) {
        let errorMessage = error.message;
        if (error.response) {
            errorMessage = `状态码 ${error.response.status}`;
        }
        console.error(`  - 失败: ${paperId} (${errorMessage})`);
        return false;
    }
}

/**
 * 触发 HTML 到 MD 的转换脚本
 * @param {string[]} successfulIds
 */
function triggerHtmlToMdScript(successfulIds) {
    return new Promise((resolve, reject) => {
        if (successfulIds.length === 0) {
            console.log("\n没有成功抓取的页面，跳过 HTML -> MD 转换。");
            return resolve();
        }

        console.log(`\n--- 开始调用 HTML -> MD 转换脚本 ---`);
        const convertProcess = spawn('node', [HTML_TO_MD_SCRIPT_PATH, ...successfulIds], { stdio: 'inherit' });

        convertProcess.on('close', (code) => {
            console.log(`--- HTML -> MD 转换脚本执行完毕，退出码: ${code} ---`);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`HTML -> MD 转换脚本执行失败，退出码: ${code}`));
            }
        });

        convertProcess.on('error', (err) => {
            console.error('无法启动 HTML -> MD 转换脚本:', err);
            reject(err);
        });
    });
}

/**
 * 主执行函数
 */
async function main() {
    const idsToFetch = process.argv.slice(2);
    const successfulIds = [];

    if (idsToFetch.length === 0) {
        console.log("没有需要抓取的 ID。");
        return;
    }

    console.log(`准备抓取 ${idsToFetch.length} 个页面...`);

    try {
        await fs.rm(TARGET_DIR, { recursive: true, force: true });
        await fs.mkdir(TARGET_DIR, { recursive: true });
        console.log(`已清空并重建目录: ${TARGET_DIR}`);
    } catch (error) {
        console.error(`处理目录时出错: ${TARGET_DIR}`, error);
        return;
    }

    console.log("开始抓取:");
    for (let i = 0; i < idsToFetch.length; i++) {
        const paperId = idsToFetch[i];
        console.log(`[${i + 1}/${idsToFetch.length}] 正在抓取 ID: ${paperId}`);
        const success = await fetchAndSave(paperId);
        if (success) {
            successfulIds.push(paperId);
        }
        
        if (i < idsToFetch.length - 1) {
            await delay(FETCH_INTERVAL);
        }
    }

    console.log(`\n抓取任务完成。成功 ${successfulIds.length} 个，失败 ${idsToFetch.length - successfulIds.length} 个。`);

    // 触发下一个脚本
    await triggerHtmlToMdScript(successfulIds);
}

main().catch(error => {
    console.error(`发生未处理的严重错误:`, error);
    process.exit(1);
});