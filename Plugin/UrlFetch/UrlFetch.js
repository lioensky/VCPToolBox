#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, 'config.env') });
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const stdin = require('process').stdin;
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');

// --- Configuration (from environment variables set by Plugin.js) ---
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl; // Read VarHttpUrl from env

puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUAPlugin());

const AD_SELECTORS = [
    'script', 'style', 'iframe', 'ins', '.ads', '[class*="ads"]',
    '[id*="ads"]', '.advertisement', '[class*="advertisement"]',
    '[id*="advertisement"]', '.banner', '[class*="banner"]', '[id*="banner"]',
    '.popup', '[class*="popup"]', '[id*="popup"]', 'nav', 'aside', 'footer',
    '[aria-hidden="true"]'
];

// A more robust auto-scroll function to handle lazy-loading content
async function autoScroll(page, mode = 'text') {
    let lastHeight = await page.evaluate('document.body.scrollHeight');
    // 根据模式设置滚动次数：截图模式3次，文字模式5次
    const maxScrolls = mode === 'snapshot' ? 3 : 5;
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

        // We no longer need to set UserAgent manually, AnonymizeUAPlugin handles it.
        await page.setViewport({ width: 1280, height: 800 });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        if (mode === 'snapshot') {
            // Check for essential environment variables for saving image
            if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
                throw new Error("UrlFetch Plugin Snapshot Error: Required environment variables for saving image are not set (PROJECT_BASE_PATH, SERVER_PORT, IMAGESERVER_IMAGE_KEY, VarHttpUrl).");
            }

            // Use the robust auto-scroll function
            await autoScroll(page, mode);
            
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
            await autoScroll(page, mode); // 滚动页面以加载所有懒加载内容
            await page.evaluate((selectors) => {
                selectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => el.remove());
                });
            }, AD_SELECTORS);

            const extractedData = await page.evaluate(() => {
                // Helper to resolve relative URLs
                const toAbsoluteURL = (url) => {
                    try {
                        // new URL() will correctly handle absolute URLs and resolve relative ones.
                        return new URL(url, window.location.href).href;
                    } catch (e) {
                        return url; // Return original if it's not a valid URL format (e.g., data: URI)
                    }
                };

                // 1. 精准提取正文
                const contentSelectors = ['[data-testid="article"]', 'article', '.content', '.main', '.post-content', 'main'];
                let mainContent = null;
                for (const selector of contentSelectors) {
                    mainContent = document.querySelector(selector);
                    if (mainContent) break;
                }
                if (!mainContent) mainContent = document.body;

                let text = mainContent.innerText || "";
                text = text.replace(/\s\s+/g, ' ').trim();
                const potentialText = text.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n');

                // 2. 全面提取链接 (从整个body)
                const allLinks = Array.from(document.body.querySelectorAll('a'));
                const links = allLinks.map(link => {
                    const text = (link.innerText || "").trim();
                    const url = link.href;
                    if (text && url && url.startsWith('http') && link.offsetParent !== null) {
                        return { text, url };
                    }
                    return null;
                }).filter(item => item !== null);
                const uniqueLinks = Array.from(new Map(links.map(item => [item.url, item])).values());

                // 3. 提取图片信息
                const allImages = Array.from(document.body.querySelectorAll('img'));
                const images = allImages.map(img => {
                    const src = img.src;
                    const alt = (img.alt || img.title || "").trim();
                    // Check for visibility and valid, non-data URI src
                    if (src && !src.startsWith('data:') && img.offsetParent !== null) {
                        return { text: alt || 'Untitled Image', url: toAbsoluteURL(src) };
                    }
                    return null;
                }).filter(item => item !== null);
                const uniqueImages = Array.from(new Map(images.map(item => [item.url, item])).values());

                // 4. 提取视频信息
                const allVideos = Array.from(document.body.querySelectorAll('video'));
                const videos = allVideos.map(video => {
                    const src = video.currentSrc || video.src || (video.querySelector('source') ? video.querySelector('source').src : null);
                    const title = (video.title || video.getAttribute('aria-label') || "").trim();
                    if (src && !src.startsWith('blob:') && video.offsetParent !== null) {
                        return { text: title || 'Untitled Video', url: toAbsoluteURL(src) };
                    }
                    return null;
                }).filter(item => item !== null);
                const uniqueVideos = Array.from(new Map(videos.map(item => [item.url, item])).values());

                // 5. 智能组合输出
                let combinedResult = "";
                if (potentialText.length > 50) { // Consider it a content page if there's some text
                    combinedResult += potentialText;
                }

                if (uniqueLinks.length > 0) {
                    const linkText = uniqueLinks.map(l => `- ${l.text}: ${l.url}`).join('\n');
                    combinedResult += (combinedResult ? '\n\n' : '') + '--- 页面包含的链接 ---\n' + linkText;
                }

                if (uniqueImages.length > 0) {
                    const imageText = uniqueImages.map(i => `- [图片] ${i.text}: ${i.url}`).join('\n');
                    combinedResult += (combinedResult ? '\n\n' : '') + '--- 页面包含的图片 ---\n' + imageText;
                }

                if (uniqueVideos.length > 0) {
                    const videoText = uniqueVideos.map(v => `- [视频] ${v.text}: ${v.url}`).join('\n');
                    combinedResult += (combinedResult ? '\n\n' : '') + '--- 页面包含的视频 ---\n' + videoText;
                }

                // Fallback for list-like pages with little text but many links/media
                if (!combinedResult.trim()) {
                    if (uniqueLinks.length > 0) return uniqueLinks;
                    if (uniqueImages.length > 0) return uniqueImages;
                    if (uniqueVideos.length > 0) return uniqueVideos;
                }
                
                return combinedResult || potentialText; // Return combined or just text if nothing else found
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