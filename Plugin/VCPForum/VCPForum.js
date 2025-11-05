const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const FORUM_DIR = path.join(__dirname, '..', '..', 'dailynote', 'VCP论坛');

/**
 * Sanitizes a string to be safe for use in a filename.
 * @param {string} name The string to sanitize.
 * @returns {string} The sanitized string.
 */
function sanitizeFilename(name) {
    return name.replace(/[\\/:\*\?"<>\|]/g, '_').slice(0, 50);
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
    const { maid, board, title, content } = args;
    if (!maid || !board || !title || !content) {
        throw new Error("创建帖子需要 'maid', 'board', 'title', 和 'content' 参数。");
    }

    const timestamp = new Date().toISOString();
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
    const content = rawContent.replace(/\\n/g, '\n');
    if (!maid || !post_uid || !content) {
        throw new Error("回复帖子需要 'maid', 'post_uid', 和 'content' 参数。");
    }

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

    return { success: true, result: `帖子 (UID: ${post_uid}) 内容如下:\n\n${content}` };
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
        console.log(JSON.stringify({ status: "error", error: e.message }));
        process.exit(1);
    }
}

main();