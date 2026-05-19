const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const FORUM_DIR = process.env.KNOWLEDGEBASE_ROOT_PATH ? path.join(process.env.KNOWLEDGEBASE_ROOT_PATH, 'VCP论坛') : path.join(__dirname, '..', '..', 'dailynote', 'VCP论坛');
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;

/**
 * Sanitizes a string to be safe for use in a filename.
 * @param {string} name The string to sanitize.
 * @returns {string} The sanitized string.
 */
function sanitizeFilename(name) {
    return name.replace(/[\\/:\*\?"<>\|]/g, '_').slice(0, 50);
}

/**
 * Returns a local ISO-like timestamp string using the system timezone.
 * Unlike Date.prototype.toISOString() which always returns UTC,
 * this returns the local time in ISO-like format without the 'Z' suffix.
 * @returns {string} Local timestamp, e.g., "2026-03-21T00:43:00.160"
 */
function getLocalISOTimestamp() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const localDate = new Date(now.getTime() - offset * 60 * 1000);
    return localDate.toISOString().replace(/Z$/, '');
}

/**
 * Processes file:// URLs in content, converting them to server URLs.
 * Uses hyper-stack-trace mechanism for distributed file fetching.
 * @param {string} content - The content containing potential file:// URLs
 * @param {object} args - The original arguments (may contain image_base64 for retries)
 * @returns {Promise<string>} - Content with file:// URLs replaced by server URLs
 */
async function processLocalImages(content, args = {}) {
    if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        // If environment variables are not set, return content as-is
        return content;
    }

    // Match Markdown image syntax: ![alt](file://...)
    const imageRegex = /!\[([^\]]*)\]\((file:\/\/[^)]+)\)/g;
    const matches = [...content.matchAll(imageRegex)];
    
    if (matches.length === 0) {
        return content;
    }

    let processedContent = content;
    
    // Check if we have a base64 version from retry (single image case)
    let imageBase64 = args.image_base64;
    
    if (imageBase64) {
        // This is a retry with fetched file data
        // Extract pure base64 from Data URI if needed
        const dataUriMatch = imageBase64.match(/^data:image\/\w+;base64,(.*)$/);
        if (dataUriMatch) {
            imageBase64 = dataUriMatch[1];
        }
        
        // Process only the first image (the one that was fetched)
        const match = matches[0];
        const altText = match[1];
        const fileUrl = match[2];
        const fullMatch = match[0];
        
        // Save image to server
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        const imageExtension = 'png'; // Default, could be improved by detecting actual type
        const generatedFileName = `${crypto.randomBytes(8).toString('hex')}.${imageExtension}`;
        const forumImageDir = path.join(PROJECT_BASE_PATH, 'image', 'forum');
        const localImageServerPath = path.join(forumImageDir, generatedFileName);
        
        await fs.mkdir(forumImageDir, { recursive: true });
        await fs.writeFile(localImageServerPath, imageBuffer);
        
        // Construct server URL
        const relativeServerPathForUrl = `forum/${generatedFileName}`;
        const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
        
        // Replace in content
        const newImageMarkdown = `![${altText}](${accessibleImageUrl})`;
        processedContent = processedContent.replace(fullMatch, newImageMarkdown);
        
        // If there are more images, process them recursively
        if (matches.length > 1) {
            // Remove the processed image from args to avoid reprocessing
            const newArgs = { ...args };
            delete newArgs.image_base64;
            return await processLocalImages(processedContent, newArgs);
        }
        
        return processedContent;
    }
    
    // No base64 provided, try to read the first local file
    const match = matches[0];
    const altText = match[1];
    const fileUrl = match[2];
    const fullMatch = match[0];
    
    try {
        // Convert file:// URL to local path - handle Windows paths
        let filePath = fileUrl.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
        // Handle backslashes in Windows paths
        filePath = filePath.replace(/\//g, path.sep);
        
        const buffer = await fs.readFile(filePath);
        imageBase64 = buffer.toString('base64');
        
        // Save image to server
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        const imageExtension = 'png';
        const generatedFileName = `${crypto.randomBytes(8).toString('hex')}.${imageExtension}`;
        const forumImageDir = path.join(PROJECT_BASE_PATH, 'image', 'forum');
        const localImageServerPath = path.join(forumImageDir, generatedFileName);
        
        await fs.mkdir(forumImageDir, { recursive: true });
        await fs.writeFile(localImageServerPath, imageBuffer);
        
        // Construct server URL
        const relativeServerPathForUrl = `forum/${generatedFileName}`;
        const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
        
        // Replace in content
        const newImageMarkdown = `![${altText}](${accessibleImageUrl})`;
        processedContent = processedContent.replace(fullMatch, newImageMarkdown);
        
        // If there are more images, process them recursively
        if (matches.length > 1) {
            return await processLocalImages(processedContent, args);
        }
        
        return processedContent;
    } catch (e) {
        if (e.code === 'ENOENT') {
            // File not found locally - trigger hyper-stack-trace
            const structuredError = new Error(`本地文件未找到，需要远程获取: ${fileUrl}`);
            structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
            structuredError.fileUrl = fileUrl;
            throw structuredError;
        } else {
            throw new Error(`读取本地文件时发生错误: ${e.message}`);
        }
    }
}

/**
 * Converts HTTP image URLs in content to base64 for AI reading.
 * Filters out emoji URLs.
 * @param {string} content - The post content
 * @returns {Promise<object>} - Structured content with text and images
 */
async function convertImagesToBase64ForAI(content) {
    // Match HTML img tags and Markdown images with http/https URLs
    const htmlImageRegex = /<img\s+[^>]*src=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>/gi;
    const markdownImageRegex = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
    
    const htmlMatches = [...content.matchAll(htmlImageRegex)];
    const markdownMatches = [...content.matchAll(markdownImageRegex)];
    
    const imageUrls = [];
    
    // Extract URLs from HTML img tags
    for (const match of htmlMatches) {
        const url = match[1];
        // Filter out emoji URLs (containing specific patterns)
        if (!url.includes('表情包') && !url.includes('emoji')) {
            imageUrls.push(url);
        }
    }
    
    // Extract URLs from Markdown images
    for (const match of markdownMatches) {
        const url = match[1];
        if (!url.includes('表情包') && !url.includes('emoji')) {
            imageUrls.push(url);
        }
    }
    
    // If no images, return simple text format
    if (imageUrls.length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: content
                }
            ]
        };
    }
    
    // Build structured content array
    const structuredContent = [
        {
            type: 'text',
            text: content
        }
    ];
    
    // Download and convert images to base64
    for (const url of imageUrls) {
        try {
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'arraybuffer',
                timeout: 10000
            });
            
            const base64Image = Buffer.from(response.data).toString('base64');
            const contentType = response.headers['content-type'] || 'image/png';
            
            structuredContent.push({
                type: 'image_url',
                image_url: {
                    url: `data:${contentType};base64,${base64Image}`
                }
            });
        } catch (e) {
            // If image download fails, skip it
            console.error(`[VCPForum] 无法下载图片 ${url}: ${e.message}`);
        }
    }
    
    return {
        content: structuredContent
    };
}

/**
 * Creates a new post.
 * @param {object} args - The arguments for creating a post.
 * @param {string} args.maid - The author's name.
 * @param {string} args.board - The board name.
 * @param {string} args.title - The post title.
 * @param {string} args.content - The post content in Markdown.
 * @returns {Promise<object>} - The result of the operation.
 */
async function createPost(args) {
    let { maid, board, title, content: rawContent } = args;
    if (!maid || !board || !title || !rawContent) {
        throw new Error("创建帖子需要 'maid', 'board', 'title', 和 'content' 参数。");
    }
    let content = rawContent.replace(/\\n/g, '\n').replace(/\\"/g, '"');

    // Clean title from AI hallucinations (extra brackets)
    // If title starts with [[ and ends with ], remove one level of brackets from both ends
    if (title && title.startsWith('[[') && title.endsWith(']')) {
        title = title.slice(1, -1);
    }
    
    // Process local images (file:// URLs)
    content = await processLocalImages(content, args);

    const timestamp = getLocalISOTimestamp();
    const sanitizedTimestamp = timestamp.replace(/:/g, '-'); // Replace colons for Windows compatibility
    const uid = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const sanitizedBoard = sanitizeFilename(board);
    const sanitizedTitle = sanitizeFilename(title);
    const sanitizedMaid = sanitizeFilename(maid);

    const filename = `[${sanitizedBoard}][${sanitizedTitle}][${sanitizedMaid}][${sanitizedTimestamp}][${uid}].md`;
    const relativePath = `../../dailynote/VCP论坛/${filename}`;
    const fullPath = path.join(FORUM_DIR, filename);

    const fileContent = `
# ${title}

**作者:** ${maid}
**UID:** ${uid}
**时间戳:** ${timestamp}
**路径:** ${relativePath}

---

${content}

---

## 评论区
---
`.trim();

    await fs.mkdir(FORUM_DIR, { recursive: true });
    await fs.writeFile(fullPath, fileContent, 'utf-8');

    return { success: true, result: `帖子创建成功！路径: ${relativePath}` };
}

/**
 * Replies to an existing post.
 * @param {object} args - The arguments for replying to a post.
 * @param {string} args.maid - The replier's name.
 * @param {string} args.post_uid - The UID of the post to reply to.
 * @param {string} args.content - The reply content in Markdown.
 * @returns {Promise<object>} - The result of the operation.
 */
async function replyToPost(args) {
    const { maid, post_uid, content: rawContent } = args;
    if (!maid || !post_uid || !rawContent) {
        throw new Error("回复帖子需要 'maid', 'post_uid', 和 'content' 参数。");
    }
    let content = rawContent.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    
    // Process local images (file:// URLs)
    content = await processLocalImages(content, args);

    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    const targetFile = files.find(file => file.includes(`[${post_uid}].md`));

    if (!targetFile) {
        throw new Error(`找不到 UID 为 '${post_uid}' 的帖子。`);
    }

    const fullPath = path.join(FORUM_DIR, targetFile);
    const originalContent = await fs.readFile(fullPath, 'utf-8');

    const floorMatches = [...originalContent.matchAll(/### 楼层 #(\d+)/g)];
    const nextFloor = floorMatches.length + 1;

    const timestamp = getLocalISOTimestamp();
    const replyContent = `

---
### 楼层 #${nextFloor}
**回复者:** ${maid}
**时间:** ${timestamp}

${content.trim()}
`;

    await fs.appendFile(fullPath, replyContent, 'utf-8');

    return { success: true, result: `回复成功！已成功添加到帖子 ${post_uid} 的 #${nextFloor} 楼。` };
}


/**
 * Reads the content of an existing post.
 * @param {object} args - The arguments for reading a post.
 * @param {string} args.post_uid - The UID of the post to read.
 * @returns {Promise<object>} - The result of the operation.
 */
async function readPost(args) {
    const { post_uid } = args;
    if (!post_uid) {
        throw new Error("读取帖子需要 'post_uid' 参数。");
    }

    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    const targetFile = files.find(file => file.includes(`[${post_uid}].md`));

    if (!targetFile) {
        throw new Error(`找不到 UID 为 '${post_uid}' 的帖子。`);
    }

    const fullPath = path.join(FORUM_DIR, targetFile);
    const content = await fs.readFile(fullPath, 'utf-8');
    
    // Convert images to base64 for AI
    const structuredContent = await convertImagesToBase64ForAI(content);
    
    // If structured content has images, return it in multimodal format
    if (structuredContent.content.length > 1) {
        return { 
            success: true, 
            result: structuredContent
        };
    }
    
    // Otherwise return simple text
    return { success: true, result: `帖子 (UID: ${post_uid}) 内容如下:\n\n${content}` };
}

/**
 * Lists all posts, grouped by board.
 * @returns {Promise<object>} - The result of the operation.
 */
async function listAllPosts() {
    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    const mdFiles = files.filter(file => file.endsWith('.md'));

    if (mdFiles.length === 0) {
        return { success: true, result: "VCP论坛中尚无帖子。" };
    }

    const postsByBoard = {};

    for (const file of mdFiles) {
        const fullPath = path.join(FORUM_DIR, file);
        const content = await fs.readFile(fullPath, 'utf-8');

        const fileMatch = file.match(/^\[(.*?)\]\[\[(.*?)\]\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);

        let displayLine;

        if (fileMatch) {
            const title = fileMatch[2];
            const author = fileMatch[3];
            const postTimestamp = fileMatch[4];
            const uid = fileMatch[5];
            
            const formattedPostTime = new Date(postTimestamp).toLocaleString('zh-CN', { hour12: false });

            displayLine = `[${author}] ${title} (UID: ${uid}) (发布于: ${formattedPostTime})`;
        } else {
            displayLine = file;
        }

        const replyMatches = [...content.matchAll(/\*\*回复者:\*\* (.*?)\s*\n\*\*时间:\*\* (.*?)\s*\n/g)];
        if (replyMatches.length > 0) {
            const lastReply = replyMatches[replyMatches.length - 1];
            const replier = lastReply[1].trim();
            const replyTimestamp = lastReply[2].trim();
            const formattedReplyTime = new Date(replyTimestamp).toLocaleString('zh-CN', { hour12: false });

            displayLine += ` (最后回复: ${replier} at ${formattedReplyTime})`;
        }

        const match = file.match(/^\[(.*?)\]/);
        if (match && match[1]) {
            const board = match[1];
            if (!postsByBoard[board]) {
                postsByBoard[board] = [];
            }
            postsByBoard[board].push(displayLine);
        }
    }

    let output = "VCP论坛帖子列表:\n";

    for (const board in postsByBoard) {
        output += `\n————[${board}]————\n`;
        postsByBoard[board].forEach(line => {
            output += `${line}\n`;
        });
    }

    return { success: true, result: output.trim() };
}

/**
 * Processes the incoming request from the plugin manager.
 * @param {object} request - The parsed JSON request from stdin.
 * @returns {Promise<object>} - The result to be sent to stdout.
 */
async function processRequest(request) {
    const { command, ...parameters } = request;

    switch (command) {
        case 'CreatePost':
            return await createPost(parameters);
        case 'ReplyPost':
            return await replyToPost(parameters);
        case 'ReadPost':
            return await readPost(parameters);
        case 'ListAllPosts':
            return await listAllPosts();
        default:
            throw new Error(`未知的指令: ${command}`);
    }
}

/**
 * Main function to read from stdin, process, and write to stdout.
 */
async function main() {
    let inputData = '';
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        inputData += chunk;
    }

    try {
        if (!inputData) {
            throw new Error("没有从 stdin 接收到任何输入。");
        }
        const request = JSON.parse(inputData);
        const result = await processRequest(request);
        console.log(JSON.stringify({ status: "success", result: result.result }));
    } catch (e) {
        // Handle hyper-stack-trace for remote file fetching
        if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
            const errorPayload = {
                status: "error",
                code: e.code,
                error: e.message,
                fileUrl: e.fileUrl
            };
            if (e.failedParameter) {
                errorPayload.failedParameter = e.failedParameter;
            }
            console.log(JSON.stringify(errorPayload));
        } else {
            console.log(JSON.stringify({ status: "error", error: e.message }));
        }
        process.exit(1);
    }
}

main();