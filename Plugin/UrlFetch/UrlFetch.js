#!/usr/bin/env node
const axios = require('axios');
const { JSDOM } = require('jsdom');
const stdin = require('process').stdin;

// 简单的去广告选择器列表
const AD_SELECTORS = [
    'script', // 移除所有脚本
    'style', // 移除所有样式
    'iframe', // 移除 iframe
    'ins', // 通常用于广告
    '.ads',
    '[class*="ads"]',
    '[id*="ads"]',
    '.advertisement',
    '[class*="advertisement"]',
    '[id*="advertisement"]',
    '.banner',
    '[class*="banner"]',
    '[id*="banner"]',
    '.popup',
    '[class*="popup"]',
    '[id*="popup"]',
    'nav', // 移除导航栏
    'aside', // 移除侧边栏
    'footer', // 移除页脚
    '[aria-hidden="true"]' // 移除ARIA隐藏元素
];

function cleanHtml(html) {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // 移除广告相关元素
    AD_SELECTORS.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove());
    });

    // 提取主要文本内容
    // 尝试从常见的文章/内容容器中提取，如果不存在则从 body 提取
    const articleSelectors = ['article', '.content', '.main', '.post-content', 'main'];
    let mainContent = null;
    for (const selector of articleSelectors) {
        mainContent = document.querySelector(selector);
        if (mainContent) break;
    }

    if (!mainContent) {
        mainContent = document.body;
    }
    
    // 进一步清理，移除空标签和不必要的空白
    let text = mainContent.textContent || "";
    text = text.replace(/\s\s+/g, ' ').trim(); // 替换多个空格为一个，并去除首尾空格
    text = text.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n'); // 清理空行

    return text;
}

async function main() {
    let inputData = '';
    stdin.setEncoding('utf8');

    stdin.on('data', function(chunk) {
        inputData += chunk;
    });

    stdin.on('end', async function() {
        let output = {};
        try {
            if (!inputData.trim()) {
                throw new Error("未从 stdin 接收到输入数据。");
            }

            const data = JSON.parse(inputData);
            const url = data.url;

            if (!url) {
                throw new Error("缺少必需的参数: url");
            }

            // 验证 URL 格式 (简单验证)
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                throw new Error("无效的 URL 格式。URL 必须以 http:// 或 https:// 开头。");
            }
            
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 RooAIUrlFetchPlugin/0.1.0'
                },
                timeout: 15000 // 15 秒超时
            });

            if (response.status !== 200) {
                throw new Error(`请求失败，状态码: ${response.status}`);
            }

            const contentType = response.headers['content-type'];
            if (!contentType || !contentType.includes('text/html')) {
                throw new Error(`不支持的内容类型: ${contentType}. 只支持 text/html。`);
            }

            const cleanedText = cleanHtml(response.data);
            
            if (!cleanedText.trim()) {
                output = { status: "success", result: "成功获取网页，但提取到的文本内容为空或只包含空白字符。" };
            } else {
                output = { status: "success", result: cleanedText };
            }

        } catch (e) {
            let errorMessage;
            if (e.response) { // Axios 错误
                errorMessage = `请求错误: ${e.message} (状态码: ${e.response.status})`;
            } else if (e.request) { // 请求已发出但没有收到响应
                errorMessage = `请求错误: 未收到响应 (${e.message})`;
            } else if (e instanceof SyntaxError) {
                errorMessage = "无效的 JSON 输入。";
            } else if (e instanceof Error) {
                errorMessage = e.message;
            } else {
                errorMessage = "发生未知错误。";
            }
            output = { status: "error", error: `UrlFetch 错误: ${errorMessage}` };
        }

        process.stdout.write(JSON.stringify(output, null, 2));
    });
}

main().catch(error => {
    process.stdout.write(JSON.stringify({ status: "error", error: `未处理的插件错误: ${error.message || error}` }));
    process.exit(1);
});