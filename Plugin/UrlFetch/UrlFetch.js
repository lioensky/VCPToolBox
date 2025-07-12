#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, 'config.env') });
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const stdin = require('process').stdin;
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');

// --- Configuration (from environment variables set by Plugin.js) ---
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl; // Read VarHttpUrl from env

puppeteer.use(StealthPlugin());

const AD_SELECTORS = [
    'script', 'style', 'iframe', 'ins', '.ads', '[class*="ads"]',
    '[id*="ads"]', '.advertisement', '[class*="advertisement"]',
    '[id*="advertisement"]', '.banner', '[class*="banner"]', '[id*="banner"]',
    '.popup', '[class*="popup"]', '[id*="popup"]', 'nav', 'aside', 'footer',
    '[aria-hidden="true"]'
];

// A more robust auto-scroll function to handle lazy-loading content
async function autoScroll(page) {
    let lastHeight = await page.evaluate('document.body.scrollHeight');
    const maxScrolls = 5; // Limit scrolls to a reasonable number (e.g., 5 screens)
    let scrolls = 0;

    while (scrolls < maxScrolls) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, 1000));

        let newHeight = await page.evaluate('document.body.scrollHeight');
        if (newHeight === lastHeight) {
            // If height hasn't changed, wait a little longer to be sure, then break.
            await new Promise(resolve => setTimeout(resolve, 1000));
            newHeight = await page.evaluate('document.body.scrollHeight');
            if (newHeight === lastHeight) {
                break;
            }
        }
        lastHeight = newHeight;
        scrolls++;
    }
}

async function fetchWithPuppeteer(url, mode = 'text', proxyPort = null) {
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

        if (mode === 'snapshot') {
            // Check for essential environment variables for saving image
            if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
                throw new Error("UrlFetch Plugin Snapshot Error: Required environment variables for saving image are not set (PROJECT_BASE_PATH, SERVER_PORT, IMAGESERVER_IMAGE_KEY, VarHttpUrl).");
            }

            // Use the robust auto-scroll function
            await autoScroll(page);
            
            // 网页快照模式
            const imageBuffer = await page.screenshot({ fullPage: true, type: 'png' });
            
            // Save the image
            const generatedFileName = `${uuidv4()}.png`;
            const urlFetchImageDir = path.join(PROJECT_BASE_PATH, 'image', 'urlfetch');
            const localImageServerPath = path.join(urlFetchImageDir, generatedFileName);

            await fs.mkdir(urlFetchImageDir, { recursive: true });
            await fs.writeFile(localImageServerPath, imageBuffer);

            // Construct accessible URL
            const relativeServerPathForUrl = path.join('urlfetch', generatedFileName).replace(/\\/g, '/');
            const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;

            // Prepare response for AI
            const base64Image = imageBuffer.toString('base64');
            const imageMimeType = 'image/png';
            const pageTitle = await page.title();
            const altText = pageTitle ? pageTitle.substring(0, 80) + (pageTitle.length > 80 ? "..." : "") : (generatedFileName || "网页快照");
            const imageHtml = `<img src="${accessibleImageUrl}" alt="${altText}" width="500">`;

            return {
                content: [
                    {
                        type: 'text',
                        text: `已成功获取网页快照: ${url}\n- 标题: ${pageTitle}\n- 可访问URL: ${accessibleImageUrl}\n\n请使用以下HTML <img> 标签将图片直接展示给用户：\n${imageHtml}`
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${imageMimeType};base64,${base64Image}`
                        }
                    }
                ],
                details: {
                    serverPath: `image/urlfetch/${generatedFileName}`,
                    fileName: generatedFileName,
                    originalUrl: url,
                    pageTitle: pageTitle,
                    imageUrl: accessibleImageUrl
                }
            };
        } else {
            // 默认的文本提取模式
            await page.evaluate((selectors) => {
                selectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => el.remove());
                });
            }, AD_SELECTORS);

            const extractedData = await page.evaluate(() => {
                const contentSelectors = ['article', '.content', '.main', '.post-content', 'main', 'body'];
                let mainContent = null;
                for (const selector of contentSelectors) {
                    mainContent = document.querySelector(selector);
                    if (mainContent) break;
                }
                
                if (!mainContent) return [];

                // 策略1: 查找所有可见的 <a> 标签
                let links = Array.from(mainContent.querySelectorAll('a'));
                let results = links.map(link => {
                    const text = (link.innerText || "").trim();
                    const url = link.href;
                    if (text && url && url.startsWith('http') && link.offsetParent !== null) { // 确保链接可见
                        return { text, url };
                    }
                    return null;
                }).filter(item => item !== null);

                // 策略2: 如果<a>标签策略效果不好，尝试查找列表项，并从内部提取链接
                if (results.length < 5) { // 如果链接少于5个，可能主内容不是链接列表，尝试更通用的方法
                    const itemSelectors = 'div[class*="item"], li[class*="item"], div[class*="card"], li, .post, .entry';
                    const items = Array.from(mainContent.querySelectorAll(itemSelectors));
                    if (items.length > results.length) {
                        const itemResults = items.map(item => {
                            const linkElement = item.querySelector('a');
                            if (linkElement) {
                                const text = (item.innerText || "").trim();
                                const url = linkElement.href;
                                 if (text && url && url.startsWith('http')) {
                                    return { text, url };
                                }
                            }
                            return null;
                        }).filter(item => item !== null);
                        
                        // 合并和去重
                        const combined = [...results, ...itemResults];
                        const uniqueResults = Array.from(new Map(combined.map(item => [item.url, item])).values());
                        if(uniqueResults.length > results.length) {
                            results = uniqueResults;
                        }
                    }
                }

                if (results.length > 0) {
                    return results;
                }

                // 回退策略: 提取纯文本
                let text = mainContent.innerText || "";
                text = text.replace(/\s\s+/g, ' ').trim();
                return text.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n');
            });

            return extractedData;
        }
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
            const mode = data.mode || 'text'; // 'text' or 'snapshot'

            if (!url) {
                throw new Error("缺少必需的参数: url");
            }

            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                throw new Error("无效的 URL 格式。URL 必须以 http:// 或 https:// 开头。");
            }

            let fetchedData;
            try {
                fetchedData = await fetchWithPuppeteer(url, mode);
            } catch (e) {
                const proxyPort = process.env.FETCH_PROXY_PORT;
                if (proxyPort) {
                    try {
                        fetchedData = await fetchWithPuppeteer(url, mode, proxyPort);
                    } catch (proxyError) {
                        throw new Error(`直接访问和通过代理端口 ${proxyPort} 访问均失败。原始错误: ${e.message}, 代理错误: ${proxyError.message}`);
                    }
                } else {
                    throw e;
                }
            }
            
            if (mode === 'snapshot') {
                output = { status: "success", result: fetchedData };
            } else {
                const isEmptyString = typeof fetchedData === 'string' && !fetchedData.trim();
                const isEmptyArray = Array.isArray(fetchedData) && fetchedData.length === 0;

                if (isEmptyString || isEmptyArray) {
                    output = { status: "success", result: "成功获取网页，但提取到的内容为空。" };
                } else {
                    output = { status: "success", result: fetchedData };
                }
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