#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, 'config.env') });
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const stdin = require('process').stdin;

puppeteer.use(StealthPlugin());

// 简单的去广告选择器列表
const AD_SELECTORS = [
    'script', 'style', 'iframe', 'ins', '.ads', '[class*="ads"]',
    '[id*="ads"]', '.advertisement', '[class*="advertisement"]',
    '[id*="advertisement"]', '.banner', '[class*="banner"]', '[id*="banner"]',
    '.popup', '[class*="popup"]', '[id*="popup"]', 'nav', 'aside', 'footer',
    '[aria-hidden="true"]'
];

async function fetchWithPuppeteer(url, proxyPort = null) {
    let browser;
    try {
        const launchOptions = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };

        if (proxyPort) {
            launchOptions.args.push(`--proxy-server=http://127.0.0.1:${proxyPort}`);
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setViewport({ width: 1280, height: 800 });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // 移除广告和不需要的元素
        await page.evaluate((selectors) => {
            selectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => el.remove());
            });
        }, AD_SELECTORS);

        // 提取主要文本内容
        const textContent = await page.evaluate(() => {
            const articleSelectors = ['article', '.content', '.main', '.post-content', 'main'];
            let mainContent = null;
            for (const selector of articleSelectors) {
                mainContent = document.querySelector(selector);
                if (mainContent) break;
            }
            if (!mainContent) {
                mainContent = document.body;
            }
            let text = mainContent.innerText || "";
            text = text.replace(/\s\s+/g, ' ').trim();
            return text.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n');
        });

        return textContent;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
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

            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                throw new Error("无效的 URL 格式。URL 必须以 http:// 或 https:// 开头。");
            }

            let cleanedText;
            try {
                cleanedText = await fetchWithPuppeteer(url);
            } catch (e) {
                const proxyPort = process.env.FETCH_PROXY_PORT;
                if (proxyPort) {
                    // 第一次失败，尝试使用代理
                    try {
                        cleanedText = await fetchWithPuppeteer(url, proxyPort);
                    } catch (proxyError) {
                        throw new Error(`直接访问和通过代理端口 ${proxyPort} 访问均失败。原始错误: ${e.message}, 代理错误: ${proxyError.message}`);
                    }
                } else {
                    // 没有配置代理，直接抛出原始错误
                    throw e;
                }
            }
            
            if (!cleanedText.trim()) {
                output = { status: "success", result: "成功获取网页，但提取到的文本内容为空或只包含空白字符。" };
            } else {
                output = { status: "success", result: cleanedText };
            }

        } catch (e) {
            let errorMessage;
            if (e instanceof SyntaxError) {
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