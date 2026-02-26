#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, 'config.env') });
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const stdin = require('process').stdin;
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

// 图片扩展名常量
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif'];
const MIME_MAP = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff'
};

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

// --- 本地文件读取 ---
async function handleLocalFile(fileUrl) {
    // 解析 file:/// URL 为本地路径
    let localPath;
    try {
        // 使用 URL API 正确解析 file:// URL
        const fileUrlObj = new URL(fileUrl);
        localPath = decodeURIComponent(fileUrlObj.pathname);
        // Windows 路径修正：移除开头的 / (e.g., /C:/... → C:/...)
        if (/^\/[A-Za-z]:/.test(localPath)) {
            localPath = localPath.substring(1);
        }
    } catch {
        // 回退：手动解析，兼容 file:/// 和 file://
        localPath = decodeURIComponent(fileUrl.replace(/^file:\/\/\/?\/?(\w)/, '$1'));
    }

    // 检查文件是否存在
    try {
        await fs.access(localPath);
    } catch {
        throw new Error(`本地文件不存在或无法访问: ${localPath}`);
    }

    const ext = path.extname(localPath).toLowerCase();

    if (IMAGE_EXTENSIONS.includes(ext)) {
        // 本地图片 → 读取并返回 base64
        const buffer = await fs.readFile(localPath);
        const mime = MIME_MAP[ext] || 'application/octet-stream';
        const base64 = buffer.toString('base64');
        const fileName = path.basename(localPath);

        return {
            content: [
                { type: 'text', text: `已读取本地图片: ${fileName}\n路径: ${localPath}\n类型: ${mime}\n大小: ${(buffer.length / 1024).toFixed(1)} KB` },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
            ]
        };
    } else {
        // 本地文本文件 → 读取并返回内容
        const textContent = await fs.readFile(localPath, 'utf-8');
        const fileName = path.basename(localPath);
        return { content: [{ type: 'text', text: `文件: ${fileName}\n路径: ${localPath}\n\n${textContent}` }] };
    }
}

// --- 判断 URL 是否指向图片 ---
function isImageUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname.toLowerCase();
        return IMAGE_EXTENSIONS.some(ext => pathname.endsWith(ext));
    } catch {
        return false;
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

        // 设置 Cookies（支持三种格式）
        const urlObj = new URL(url);
        let cookiesToSet = [];

        // 辅助函数：解析原始 cookie 字符串
        const parseRawCookies = (cookieString, targetUrl) => {
            const cookiePairs = cookieString.split(';').map(pair => pair.trim()).filter(pair => pair);
            return cookiePairs.map(pair => {
                const equalIndex = pair.indexOf('=');
                if (equalIndex === -1) return null;

                const name = pair.substring(0, equalIndex).trim();
                const value = pair.substring(equalIndex + 1).trim();

                return {
                    name,
                    value,
                    domain: `.${targetUrl.hostname}`,
                    url: `${targetUrl.protocol}//${targetUrl.hostname}`
                };
            }).filter(cookie => cookie !== null);
        };

        // 方式1：多站点原始格式 (FETCH_COOKIES_RAW_MULTI) - 优先级最高
        const fetchCookiesRawMulti = process.env.FETCH_COOKIES_RAW_MULTI;
        if (fetchCookiesRawMulti && fetchCookiesRawMulti.trim()) {
            try {
                const cookiesMap = JSON.parse(fetchCookiesRawMulti);
                // 遍历所有域名配置，找到匹配当前访问 URL 的
                for (const [domain, cookieString] of Object.entries(cookiesMap)) {
                    if (urlObj.hostname.includes(domain)) {
                        cookiesToSet = parseRawCookies(cookieString, urlObj);
                        break;
                    }
                }
            } catch (multiCookieError) {
                console.error('解析多站点 Cookies 失败:', multiCookieError.message);
            }
        }

        // 方式2：单站点原始格式 (FETCH_COOKIES_RAW)
        if (cookiesToSet.length === 0) {
            const fetchCookiesRaw = process.env.FETCH_COOKIES_RAW;
            if (fetchCookiesRaw && fetchCookiesRaw.trim()) {
                try {
                    cookiesToSet = parseRawCookies(fetchCookiesRaw, urlObj);
                } catch (rawCookieError) {
                    console.error('解析原始 Cookies 失败:', rawCookieError.message);
                }
            }
        }

        // 方式3：JSON 数组格式 (FETCH_COOKIES)
        if (cookiesToSet.length === 0) {
            const fetchCookies = process.env.FETCH_COOKIES;
            if (fetchCookies && fetchCookies.trim()) {
                try {
                    const cookies = JSON.parse(fetchCookies);
                    if (Array.isArray(cookies) && cookies.length > 0) {
                        // 确保每个 cookie 都有 url 字段（Puppeteer 要求）
                        cookiesToSet = cookies.map(cookie => ({
                            ...cookie,
                            url: cookie.url || `${urlObj.protocol}//${cookie.domain || urlObj.hostname}`
                        }));
                    }
                } catch (cookieError) {
                    console.error('解析 JSON Cookies 失败:', cookieError.message);
                }
            }
        }

        // 应用 cookies
        if (cookiesToSet.length > 0) {
            try {
                await page.setCookie(...cookiesToSet);
            } catch (setCookieError) {
                console.error('设置 Cookies 失败:', setCookieError.message);
            }
        }

        // image 模式：直接下载图片，不需要先导航到页面
        if (mode === 'image') {
            const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            const buffer = await response.buffer();
            const contentType = response.headers()['content-type'] || 'image/png';
            // 提取纯 MIME 类型（去除 charset 等参数）
            const mime = contentType.split(';')[0].trim();
            const base64 = buffer.toString('base64');

            return {
                content: [
                    { type: 'text', text: `已下载网络图片: ${url}\n类型: ${mime}\n大小: ${(buffer.length / 1024).toFixed(1)} KB` },
                    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
                ]
            };
        }

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
            await autoScroll(page, mode); // Scroll page to load all lazy-loaded content

            // === 特定站点提取增强 ===
            const isGithub = urlObj.hostname.includes('github.com');
            if (isGithub) {
                const githubData = await page.evaluate(() => {
                    let md = '';

                    // 1. 获取 Repository 名称和简述
                    const repoNameEl = document.querySelector('strong[itemprop="name"] a') || document.querySelector('[itemprop="name"]');
                    if (repoNameEl) {
                        md += `# GitHub Repository: ${repoNameEl.textContent.trim()}\n\n`;
                    }
                    const aboutEl = document.querySelector('p.f4') || document.querySelector('.BorderGrid-cell p');
                    if (aboutEl) {
                        md += `> ${aboutEl.textContent.trim()}\n\n`;
                    }

                    // 2. 获取文件和目录列表
                    const fileRows = Array.from(document.querySelectorAll('tr.react-directory-row, div.react-directory-row'));
                    if (fileRows.length > 0) {
                        md += `## 文件列表\n`;
                        fileRows.forEach(row => {
                            const nameEl = row.querySelector('.react-directory-truncate a, a.Link--primary');
                            if (nameEl && nameEl.textContent) {
                                const isDir = row.querySelector('svg.icon-directory') || row.querySelector('[aria-label="Directory"]');
                                const typeIcon = isDir ? '📁' : '📄';
                                md += `- ${typeIcon} [${nameEl.textContent.trim()}](${nameEl.href})\n`;
                            }
                        });
                        md += '\n';
                    } else {
                        const fileLinks = Array.from(document.querySelectorAll('.js-navigation-item .js-navigation-open'));
                        if (fileLinks.length > 0) {
                            md += `## 文件列表\n`;
                            fileLinks.forEach(link => {
                                if (link.textContent && link.textContent.trim() !== '..') {
                                    md += `- [${link.textContent.trim()}](${link.href})\n`;
                                }
                            });
                            md += '\n';
                        }
                    }

                    // 3. 获取 README 内容
                    const readmeArticle = document.querySelector('article.markdown-body');
                    if (readmeArticle) {
                        md += `## README\n\n${readmeArticle.innerText}\n`;
                    }

                    // 4. Issue 或 PR 的内容支持
                    const issueTitle = document.querySelector('.gh-header-title');
                    if (issueTitle) {
                        md += `# ${issueTitle.textContent.trim()}\n\n`;
                        const comments = document.querySelectorAll('.timeline-comment');
                        comments.forEach(comment => {
                            const author = comment.querySelector('.author');
                            const body = comment.querySelector('.comment-body');
                            if (author && body) {
                                md += `**${author.textContent.trim()}**: \n${body.innerText}\n\n---\n`;
                            }
                        });
                    }

                    // 5. Blob 文件（具体代码文件）内容支持
                    const blobTextArea = document.querySelector('textarea#read-only-cursor-text-area');
                    if (blobTextArea && blobTextArea.value) {
                        const fileNameEl = document.querySelector('[data-testid="breadcrumbs-filename"]') || document.querySelector('#blob-path');
                        const fileName = fileNameEl ? fileNameEl.textContent.trim() : 'Code File';
                        md += `## 文件内容: ${fileName}\n\n\`\`\`\n${blobTextArea.value}\n\`\`\`\n`;
                    } else {
                        // 回退尝试获取旧版或不同结构的纯文本
                        const rawContentEl = document.querySelector('[data-testid="raw-button"]');
                        if (rawContentEl && window.location.href.includes('/blob/')) {
                            // Blob 页面但没找到 textarea，可能是其他类型或者渲染不同，尝试抓取内容区
                            const codeArea = document.querySelector('.js-file-line-container') || document.querySelector('table[data-paste-markdown-skip]');
                            if (codeArea) {
                                md += `## 文件代码\n\n\`\`\`\n${codeArea.innerText}\n\`\`\`\n`;
                            }
                        }
                    }

                    return md;
                });

                if (githubData && githubData.length > 50) {
                    return githubData;
                }
            }
            // === 特定站点提取增强结束 ===

            // 优先尝试作为聚合页提取有分类的链接
            const groupedLinks = await page.evaluate(() => {
                // 根据用户反馈，新闻源标题的特征是 'span.text-xl.font-bold'
                const titleElements = Array.from(document.querySelectorAll('span.text-xl.font-bold'));
                const results = [];

                for (const titleEl of titleElements) {
                    const category = titleEl.textContent.trim();
                    // 寻找包裹该分类和其链接的最近的 "卡片" 容器
                    // 这是一个基于典型卡片式布局的推断，对特定网站有效
                    const container = titleEl.closest('div[class*="rounded"]');
                    if (!container) continue;

                    const anchors = Array.from(container.querySelectorAll('a[href]'));
                    const linkData = anchors.map(anchor => ({
                        title: anchor.textContent.trim(),
                        url: anchor.href
                    })).filter(link =>
                        link.title &&
                        link.url &&
                        link.url.startsWith('http') &&
                        !link.url.startsWith('javascript:') &&
                        link.title.length > 5 // 过滤掉短的导航链接
                    );

                    // 对分类内部的链接进行去重
                    const uniqueLinks = [];
                    const seenUrls = new Set();
                    for (const link of linkData) {
                        if (!seenUrls.has(link.url)) {
                            seenUrls.add(link.url);
                            uniqueLinks.push(link);
                        }
                    }

                    if (uniqueLinks.length > 0) {
                        results.push({ category, links: uniqueLinks });
                    }
                }
                return results;
            });

            // 如果找到了带分组的链接，格式化为带标题的Markdown列表
            if (groupedLinks && groupedLinks.length > 0) {
                const pageTitle = await page.title();
                let markdownOutput = `页面标题: ${pageTitle}\n\n`;
                for (const group of groupedLinks) {
                    markdownOutput += `## ${group.category}\n`;
                    markdownOutput += group.links.map(link => `- [${link.title}](${link.url})`).join('\n');
                    markdownOutput += '\n\n';
                }
                return markdownOutput.trim();
            }

            // 如果链接提取失败或链接很少，则回退到使用Readability提取文章正文
            const pageContent = await page.content();
            const doc = new JSDOM(pageContent, { url });
            const reader = new Readability(doc.window.document);
            const article = reader.parse();

            if (article && article.textContent) {
                // Format the output with title and content
                const result = `标题: ${article.title}\n\n${article.textContent.trim()}`;
                return result;
            } else {
                // Fallback if Readability fails to extract content
                return "成功获取网页，但无法提取主要内容或链接列表。";
            }
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

    stdin.on('data', function (chunk) {
        inputData += chunk;
    });

    stdin.on('end', async function () {
        let output = {};
        try {
            if (!inputData.trim()) {
                throw new Error("未从 stdin 接收到输入数据。");
            }

            const data = JSON.parse(inputData);
            const url = data.url;
            let mode = data.mode || 'text'; // 'text', 'snapshot', or 'image'

            if (!url) {
                throw new Error("缺少必需的参数: url");
            }

            if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
                throw new Error("无效的 URL 格式。URL 必须以 http:// 、 https:// 或 file:// 开头。");
            }

            let fetchedData;

            // === 本地文件处理 ===
            if (url.startsWith('file://')) {
                fetchedData = await handleLocalFile(url);
                // 根据返回类型设置 output
                if (typeof fetchedData === 'object' && fetchedData.content) {
                    output = { status: "success", result: fetchedData };
                } else {
                    output = { status: "success", result: { content: [{ type: 'text', text: typeof fetchedData === 'string' ? fetchedData : JSON.stringify(fetchedData) }] } };
                }
            } else {
                // === 网络 URL 处理 ===
                // 智能检测：如果 URL 指向图片且未指定模式，自动切换为 image 模式
                if (mode === 'text' && isImageUrl(url)) {
                    mode = 'image';
                }

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

                if (mode === 'snapshot' || mode === 'image') {
                    output = { status: "success", result: fetchedData };
                } else {
                    const isEmptyString = typeof fetchedData === 'string' && !fetchedData.trim();
                    const isEmptyArray = Array.isArray(fetchedData) && fetchedData.length === 0;

                    if (isEmptyString || isEmptyArray) {
                        output = { status: "success", result: { content: [{ type: 'text', text: "成功获取网页，但提取到的内容为空。" }] } };
                    } else {
                        if (typeof fetchedData === 'object' && fetchedData.content) {
                            output = { status: "success", result: fetchedData };
                        } else {
                            output = { status: "success", result: { content: [{ type: 'text', text: typeof fetchedData === 'string' ? fetchedData : JSON.stringify(fetchedData) }] } };
                        }
                    }
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
            const errorMsgStr = `UrlFetch 错误: ${errorMessage}`;
            output = { status: "error", error: errorMsgStr, result: { content: [{ type: 'text', text: errorMsgStr }] } };
        }

        process.stdout.write(JSON.stringify(output, null, 2));
    });
}

main().catch(error => {
    const errorMsgStr = `未处理的插件错误: ${error.message || error}`;
    process.stdout.write(JSON.stringify({ status: "error", error: errorMsgStr, result: { content: [{ type: 'text', text: errorMsgStr }] } }));
    process.exit(1);
});