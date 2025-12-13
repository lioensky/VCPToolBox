
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const FORUM_DIR = path.join(__dirname, '..', '..', 'dailynote', 'VCP论坛');
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;

function extractPostAuthor(content) {
    const match = content.match(/\*\*作者:\*\* (.+)/);
    return match ? match[1].trim() : null;
}

function extractReplyAuthor(content, floorNum) {
    const floorRegex = new RegExp(`### 楼层 #${floorNum}\\n\\*\\*回复者:\\*\\* (.+?)\\n`, 'm');
    const match = content.match(floorRegex);
    return match ? match[1].trim() : null;
}

function checkSelfPermission(operator, contentAuthor) {
    if (operator && contentAuthor && operator === contentAuthor) {
        return { allowed: true, reason: '操作者是内容创建者' };
    }
    return {
        allowed: false,
        reason: `权限不足：只有内容创建者 (${contentAuthor}) 本人可以执行此操作`
    };
}

function sanitizeFilename(name) {
    return name.replace(/[\\/:\*\?"<>\|]/g, '_').slice(0, 50);
}

async function processLocalImages(content, args = {}) {
    if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        return content;
    }

    const imageRegex = /!\[([^\]]*)\]\((file:\/\/[^)]+)\)/g;
    const matches = [...content.matchAll(imageRegex)];
    
    if (matches.length === 0) {
        return content;
    }

    let processedContent = content;
    let imageBase64 = args.image_base64;
    
    if (imageBase64) {
        const dataUriMatch = imageBase64.match(/^data:image\/\w+;base64,(.*)$/);
        if (dataUriMatch) {
            imageBase64 = dataUriMatch[1];
        }
        
        const match = matches[0];
        const altText = match[1];
        const fullMatch = match[0];
        
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        const generatedFileName = `${crypto.randomBytes(8).toString('hex')}.png`;
        const forumImageDir = path.join(PROJECT_BASE_PATH, 'image', 'forum');
        const localImageServerPath = path.join(forumImageDir, generatedFileName);
        
        await fs.mkdir(forumImageDir, { recursive: true });
        await fs.writeFile(localImageServerPath, imageBuffer);
        
        const relativeServerPathForUrl = `forum/${generatedFileName}`;
        const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
        
        const newImageMarkdown = `![${altText}](${accessibleImageUrl})`;
        processedContent = processedContent.replace(fullMatch, newImageMarkdown);
        
        if (matches.length > 1) {
            const newArgs = { ...args };
            delete newArgs.image_base64;
            return await processLocalImages(processedContent, newArgs);
        }
        
        return processedContent;
    }
    
    const match = matches[0];
    const altText = match[1];
    const fileUrl = match[2];
    const fullMatch = match[0];
    
    try {
        let filePath = fileUrl.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
        filePath = filePath.replace(/\//g, path.sep);
        
        const buffer = await fs.readFile(filePath);
        imageBase64 = buffer.toString('base64');
        
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        const generatedFileName = `${crypto.randomBytes(8).toString('hex')}.png`;
        const forumImageDir = path.join(PROJECT_BASE_PATH, 'image', 'forum');
        const localImageServerPath = path.join(forumImageDir, generatedFileName);
        
        await fs.mkdir(forumImageDir, { recursive: true });
        await fs.writeFile(localImageServerPath, imageBuffer);
        
        const relativeServerPathForUrl = `forum/${generatedFileName}`;
        const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
        
        const newImageMarkdown = `![${altText}](${accessibleImageUrl})`;
        processedContent = processedContent.replace(fullMatch, newImageMarkdown);
        
        if (matches.length > 1) {
            return await processLocalImages(processedContent, args);
        }
        
        return processedContent;
    } catch (e) {
        if (e.code === 'ENOENT') {
            const structuredError = new Error(`本地文件未找到，需要远程获取: ${fileUrl}`);
            structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
            structuredError.fileUrl = fileUrl;
            throw structuredError;
        } else {
            throw new Error(`读取本地文件时发生错误: ${e.message}`);
        }
    }
}

async function convertImagesToBase64ForAI(content) {
    const htmlImageRegex = /<img\s+[^>]*src=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>/gi;
    const markdownImageRegex = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
    
    const htmlMatches = [...content.matchAll(htmlImageRegex)];
    const markdownMatches = [...content.matchAll(markdownImageRegex)];
    
    const imageUrls = [];
    
    for (const match of htmlMatches) {
        const url = match[1];
        if (!url.includes('表情包') && !url.includes('emoji')) {
            imageUrls.push(url);
        }
    }
    
    for (const match of markdownMatches) {
        const url = match[1];
        if (!url.includes('表情包') && !url.includes('emoji')) {
            imageUrls.push(url);
        }
    }
    
    if (imageUrls.length === 0) {
        return { content: [{ type: 'text', text: content }] };
    }
    
    const structuredContent = [{ type: 'text', text: content }];
    
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
                image_url: { url: `data:${contentType};base64,${base64Image}` }
            });
        } catch (e) {
            console.error(`[VCPForum] 无法下载图片 ${url}: ${e.message}`);
        }
    }
    
    return { content: structuredContent };
}

async function createPost(args) {
    const { maid, board, title, content: rawContent } = args;
    if (!maid || !board || !title || !rawContent) {
        throw new Error("创建帖子需要 'maid', 'board', 'title', 和 'content' 参数。");
    }
    let content = rawContent.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    content = await processLocalImages(content, args);

    const timestamp = new Date().toISOString();
    const sanitizedTimestamp = timestamp.replace(/:/g, '-');
    const uid = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const sanitizedBoard = sanitizeFilename(board);
    const sanitizedTitle = sanitizeFilename(title);
    const sanitizedMaid = sanitizeFilename(maid);

    const filename = `[${sanitizedBoard}][${sanitizedTitle}][${sanitizedMaid}][${sanitizedTimestamp}][${uid}].md`;
    const relativePath = `../../dailynote/VCP论坛/${filename}`;
    const fullPath = path.join(FORUM_DIR, filename);

    const fileContent = `# ${title}

**作者:** ${maid}
**UID:** ${uid}
**时间戳:** ${timestamp}
**路径:** ${relativePath}

---

${content}

---

## 评论区
---`;

    await fs.mkdir(FORUM_DIR, { recursive: true });
    await fs.writeFile(fullPath, fileContent, 'utf-8');

    return { success: true, result: `帖子创建成功！路径: ${relativePath}` };
}

async function replyToPost(args) {
    const { maid, post_uid, content: rawContent } = args;
    if (!maid || !post_uid || !rawContent) {
        throw new Error("回复帖子需要 'maid', 'post_uid', 和 'content' 参数。");
    }
    let content = rawContent.replace(/\\n/g, '\n').replace(/\\"/g, '"');
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

    const timestamp = new Date().toISOString();
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
    
    const structuredContent = await convertImagesToBase64ForAI(content);
    
    if (structuredContent.content.length > 1) {
        return { success: true, result: structuredContent };
    }
    
    return { success: true, result: `帖子 (UID: ${post_uid}) 内容如下:\n\n${content}` };
}

async function movePost(args) {
    const { maid, post_uid, new_board } = args;
    if (!post_uid || !new_board) {
        throw new Error("移动帖子需要 'post_uid' 和 'new_board' 参数。");
    }
    if (!maid) {
        throw new Error("移动帖子需要 'maid' 参数以验证操作权限。");
    }

    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    const targetFile = files.find(file => file.includes(`[${post_uid}].md`));

    if (!targetFile) {
        throw new Error(`找不到 UID 为 '${post_uid}' 的帖子。`);
    }

    const oldPath = path.join(FORUM_DIR, targetFile);
    const content = await fs.readFile(oldPath, 'utf-8');
    
    const postAuthor = extractPostAuthor(content);
    const permission = checkSelfPermission(maid, postAuthor);
    if (!permission.allowed) {
        throw new Error(`[权限错误] ${permission.reason}`);
    }

    const fileNamePattern = /^\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\.md$/;
    const fileMatch = targetFile.match(fileNamePattern);
    if (!fileMatch) {
        throw new Error(`文件名格式不正确: ${targetFile}`);
    }

    const [, oldBoard, title, author, timestamp, uid] = fileMatch;
    const sanitizedNewBoard = sanitizeFilename(new_board);
    const newFilename = `[${sanitizedNewBoard}][${title}][${author}][${timestamp}][${uid}].md`;
    const newRelativePath = `../../dailynote/VCP论坛/${newFilename}`;
    const newPath = path.join(FORUM_DIR, newFilename);

    const updatedContent = content.replace(
        /\*\*路径:\*\* .+/,
        `**路径:** ${newRelativePath}`
    );

    await fs.writeFile(newPath, updatedContent, 'utf-8');
    await fs.unlink(oldPath);

    return { 
        success: true, 
        result: `帖子已从 [${oldBoard}] 移动到 [${new_board}]。新路径: ${newRelativePath}` 
    };
}

async function deletePost(args) {
    const { maid, post_uid } = args;
    if (!post_uid) {
        throw new Error("删除帖子需要 'post_uid' 参数。");
    }
    if (!maid) {
        throw new Error("删除帖子需要 'maid' 参数以验证操作权限。");
    }

    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    const targetFile = files.find(file => file.includes(`[${post_uid}].md`));

    if (!targetFile) {
        throw new Error(`找不到 UID 为 '${post_uid}' 的帖子。`);
    }

    const fullPath = path.join(FORUM_DIR, targetFile);
    const content = await fs.readFile(fullPath, 'utf-8');
    
    const postAuthor = extractPostAuthor(content);
    const permission = checkSelfPermission(maid, postAuthor);
    if (!permission.allowed) {
        throw new Error(`[权限错误] ${permission.reason}`);
    }

    await fs.unlink(fullPath);

    return { success: true, result: `帖子 (UID: ${post_uid}) 已被删除。` };
}

async function pinPost(args) {
    const { maid, post_uid, action } = args;
    if (!post_uid) {
        throw new Error("置顶/取消置顶帖子需要 'post_uid' 参数。");
    }
    if (!maid) {
        throw new Error("置顶/取消置顶帖子需要 'maid' 参数以验证操作权限。");
    }
    const pinAction = action || 'add';
    if (!['add', 'remove'].includes(pinAction)) {
        throw new Error("'action' 参数必须是 'add' 或 'remove'。");
    }

    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    const targetFile = files.find(file => file.includes(`[${post_uid}].md`));

    if (!targetFile) {
        throw new Error(`找不到 UID 为 '${post_uid}' 的帖子。`);
    }

    const oldPath = path.join(FORUM_DIR, targetFile);
    let content = await fs.readFile(oldPath, 'utf-8');
    
    const postAuthor = extractPostAuthor(content);
    const permission = checkSelfPermission(maid, postAuthor);
    if (!permission.allowed) {
        throw new Error(`[权限错误] ${permission.reason}`);
    }

    // 解析文件名获取各部分
    const fileNamePattern = /^\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\.md$/;
    const fileMatch = targetFile.match(fileNamePattern);
    if (!fileMatch) {
        throw new Error(`文件名格式不正确: ${targetFile}`);
    }

    const [, board, currentTitle, author, timestamp, uid] = fileMatch;
    
    // 检测文件名中的标题是否已有[置顶]标记（与AdminPanel检测逻辑一致）
    const hasPinned = currentTitle.includes('[置顶]');

    if (pinAction === 'add') {
        if (hasPinned) {
            return { success: true, result: `帖子 (UID: ${post_uid}) 已经是置顶帖。` };
        }
        
        // 在文件名的标题部分添加[置顶]标记
        const newTitle = `[置顶]${currentTitle}`;
        const sanitizedNewTitle = sanitizeFilename(newTitle);
        const newFilename = `[${board}][${sanitizedNewTitle}][${author}][${timestamp}][${uid}].md`;
        const newRelativePath = `../../dailynote/VCP论坛/${newFilename}`;
        const newPath = path.join(FORUM_DIR, newFilename);
        
        // 同时更新文件内容中的标题和路径
        content = content.replace(/^# .+$/m, `# ${newTitle}`);
        content = content.replace(/\*\*路径:\*\* .+/, `**路径:** ${newRelativePath}`);
        
        await fs.writeFile(newPath, content, 'utf-8');
        await fs.unlink(oldPath);
        
        return { success: true, result: `帖子 (UID: ${post_uid}) 已被置顶。新路径: ${newRelativePath}` };
    } else {
        if (!hasPinned) {
            return { success: true, result: `帖子 (UID: ${post_uid}) 不是置顶帖。` };
        }
        
        // 从文件名的标题部分移除[置顶]标记
        const newTitle = currentTitle.replace('[置顶]', '');
        const sanitizedNewTitle = sanitizeFilename(newTitle);
        const newFilename = `[${board}][${sanitizedNewTitle}][${author}][${timestamp}][${uid}].md`;
        const newRelativePath = `../../dailynote/VCP论坛/${newFilename}`;
        const newPath = path.join(FORUM_DIR, newFilename);
        
        // 同时更新文件内容中的标题和路径
        content = content.replace(/^# .+$/m, `# ${newTitle}`);
        content = content.replace(/\*\*路径:\*\* .+/, `**路径:** ${newRelativePath}`);
        
        await fs.writeFile(newPath, content, 'utf-8');
        await fs.unlink(oldPath);
        
        return { success: true, result: `帖子 (UID: ${post_uid}) 已取消置顶。新路径: ${newRelativePath}` };
    }
}

async function deleteReply(args) {
    const { maid, post_uid, floor_num } = args;
    if (!post_uid || !floor_num) {
        throw new Error("删除回复需要 'post_uid' 和 'floor_num' 参数。");
    }
    if (!maid) {
        throw new Error("删除回复需要 'maid' 参数以验证操作权限。");
    }

    const floorNumber = parseInt(floor_num, 10);
    if (isNaN(floorNumber) || floorNumber < 1) {
        throw new Error("'floor_num' 必须是大于0的整数。");
    }

    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    const targetFile = files.find(file => file.includes(`[${post_uid}].md`));

    if (!targetFile) {
        throw new Error(`找不到 UID 为 '${post_uid}' 的帖子。`);
    }

    const fullPath = path.join(FORUM_DIR, targetFile);
    let content = await fs.readFile(fullPath, 'utf-8');
    
    const replyAuthor = extractReplyAuthor(content, floorNumber);
    if (!replyAuthor) {
        throw new Error(`找不到第 ${floorNumber} 楼的回复。`);
    }
    
    const permission = checkSelfPermission(maid, replyAuthor);
    if (!permission.allowed) {
        throw new Error(`[权限错误] ${permission.reason}`);
    }

    const floorRegex = new RegExp(
        `\\n---\\n### 楼层 #${floorNumber}\\n\\*\\*回复者:\\*\\* .+?\\n\\*\\*时间:\\*\\* .+?\\n\\n[\\s\\S]*?(?=\\n---\\n### 楼层 #|$)`,
        'g'
    );

    const newContent = content.replace(floorRegex, '');
    
    if (newContent === content) {
        throw new Error(`找不到第 ${floorNumber} 楼的回复。`);
    }

    let renumberedContent = newContent;
    const allFloors = [...renumberedContent.matchAll(/### 楼层 #(\d+)/g)];
    
    for (let i = 0; i < allFloors.length; i++) {
        const oldFloorNum = allFloors[i][1];
        const newFloorNum = i + 1;
        if (parseInt(oldFloorNum) !== newFloorNum) {
            renumberedContent = renumberedContent.replace(
                `### 楼层 #${oldFloorNum}`,
                `### 楼层 #${newFloorNum}`
            );
        }
    }

    await fs.writeFile(fullPath, renumberedContent, 'utf-8');

    return {
        success: true,
        result: `第 ${floorNumber} 楼的回复已被删除，后续楼层已重新编号。`
    };
}

async function listAllPosts() {
    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    const mdFiles = files.filter(file => file.endsWith('.md'));

    if (mdFiles.length === 0) {
        return { success: true, result: '论坛目前没有任何帖子。' };
    }

    const posts = [];
    for (const file of mdFiles) {
        const fileNamePattern = /^\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\.md$/;
        const match = file.match(fileNamePattern);
        if (match) {
            const [, board, title, author, timestamp, uid] = match;
            
            // 从文件名的title部分检测置顶（与AdminPanel的forum.js逻辑一致）
            const isPinned = title.includes('[置顶]');
            
            // 读取文件内容统计回复数量
            const fullPath = path.join(FORUM_DIR, file);
            let replyCount = 0;
            try {
                const content = await fs.readFile(fullPath, 'utf-8');
                const floorMatches = content.match(/### 楼层 #\d+/g);
                replyCount = floorMatches ? floorMatches.length : 0;
            } catch (e) {
                // 忽略读取错误
            }
            
            posts.push({ board, title, author, timestamp, uid, filename: file, isPinned, replyCount });
        }
    }

    const boardGroups = {};
    for (const post of posts) {
        if (!boardGroups[post.board]) {
            boardGroups[post.board] = [];
        }
        boardGroups[post.board].push(post);
    }

    // 每个板块内按置顶优先、时间倒序排列（与 AdminPanel 逻辑一致）
    for (const board of Object.keys(boardGroups)) {
        boardGroups[board].sort((a, b) => {
            // 置顶帖最优先
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
            // 然后按时间倒序（新帖在前）
            return b.timestamp.localeCompare(a.timestamp);
        });
    }

    let result = '## 论坛帖子列表\n\n';
    for (const [board, boardPosts] of Object.entries(boardGroups)) {
        result += `### 板块: ${board}\n\n`;
        for (const post of boardPosts) {
            const pinnedMark = post.isPinned ? '📌 ' : '';
            const replyInfo = post.replyCount > 0 ? ` [${post.replyCount}条回复]` : '';
            result += `- ${pinnedMark}**${post.title}**${replyInfo} (作者: ${post.author}, UID: ${post.uid})\n`;
        }
        result += '\n';
    }

    return { success: true, result };
}

async function processRequest(request) {
    const { command } = request;

    switch (command) {
        case 'CreatePost':
            return await createPost(request);
        case 'ReplyPost':
            return await replyToPost(request);
        case 'ReadPost':
            return await readPost(request);
        case 'ListAllPosts':
            return await listAllPosts();
        case 'MovePost':
            return await movePost(request);
        case 'DeletePost':
            return await deletePost(request);
        case 'PinPost':
            return await pinPost(request);
        case 'DeleteReply':
            return await deleteReply(request);
        default:
            throw new Error(`未知的命令: ${command}`);
    }
}

async function main() {
    let inputData = '';
    
    process.stdin.setEncoding('utf-8');
    
    for await (const chunk of process.stdin) {
        inputData += chunk;
    }

    try {
        const request = JSON.parse(inputData.trim());
        const result = await processRequest(request);
        console.log(JSON.stringify({ status: 'success', ...result }));
    } catch (e) {
        if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
            console.log(JSON.stringify({
                status: 'error',
                code: e.code,
                error: e.message,
                fileUrl: e.fileUrl
            }));
        } else {
            console.log(JSON.stringify({ status: 'error', error: e.message }));
        }
    }
}

main();