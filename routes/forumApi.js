const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const FORUM_DIR = process.env.KNOWLEDGEBASE_ROOT_PATH ? path.join(process.env.KNOWLEDGEBASE_ROOT_PATH, 'VCP论坛') : path.join(__dirname, '..', 'dailynote', 'VCP论坛');

// ========== 安全配置 ==========
const FORUM_CONFIG = {
    MAX_CONTENT_LENGTH: 50000,      // 单条内容最大长度 50KB
    MAX_FILE_SIZE: 1024 * 1024 * 2, // 单个帖子文件最大 2MB
    MAX_MAID_LENGTH: 50,            // 用户名最大长度
    MAX_TITLE_LENGTH: 100,          // 标题最大长度
    MAX_FLOORS_PER_POST: 500,       // 单帖最大楼层数
    UID_PATTERN: /^[a-zA-Z0-9_-]+$/, // UID 允许的字符
    LOCK_TIMEOUT: 10000,            // 文件锁超时 10秒
    MAX_CONCURRENT_WRITES: 5,       // 最大并发写入数
};

// ========== 文件锁管理器 ==========
class FileLockManager {
    constructor() {
        this.locks = new Map(); // Map<filePath, { promise, resolve, queue }>
        this.writeCount = 0;
    }

    async acquireLock(filePath, timeout = FORUM_CONFIG.LOCK_TIMEOUT) {
        const normalizedPath = path.normalize(filePath);
        
        // 检查并发写入限制
        if (this.writeCount >= FORUM_CONFIG.MAX_CONCURRENT_WRITES) {
            // 等待直到有空闲槽位
            await new Promise(resolve => {
                const checkSlot = setInterval(() => {
                    if (this.writeCount < FORUM_CONFIG.MAX_CONCURRENT_WRITES) {
                        clearInterval(checkSlot);
                        resolve();
                    }
                }, 100);
                
                // 超时保护
                setTimeout(() => {
                    clearInterval(checkSlot);
                    resolve();
                }, timeout);
            });
        }

        if (!this.locks.has(normalizedPath)) {
            // 没有锁，直接创建并获取
            let resolveFunc;
            const promise = new Promise(resolve => { resolveFunc = resolve; });
            this.locks.set(normalizedPath, { 
                promise, 
                resolve: resolveFunc, 
                queue: [],
                acquiredAt: Date.now()
            });
            this.writeCount++;
            return true;
        }

        // 已有锁，加入等待队列
        const lock = this.locks.get(normalizedPath);
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                // 从队列中移除
                const idx = lock.queue.findIndex(item => item.resolve === resolve);
                if (idx !== -1) lock.queue.splice(idx, 1);
                reject(new Error('Lock acquisition timeout'));
            }, timeout);

            lock.queue.push({
                resolve: () => {
                    clearTimeout(timeoutId);
                    this.writeCount++;
                    resolve(true);
                }
            });
        });
    }

    releaseLock(filePath) {
        const normalizedPath = path.normalize(filePath);
        const lock = this.locks.get(normalizedPath);
        
        if (!lock) return;

        this.writeCount = Math.max(0, this.writeCount - 1);

        if (lock.queue.length > 0) {
            // 唤醒队列中的下一个等待者
            const next = lock.queue.shift();
            lock.acquiredAt = Date.now();
            next.resolve();
        } else {
            // 没有等待者，删除锁
            this.locks.delete(normalizedPath);
        }
    }

    // 自动清理过期锁（防止死锁）
    cleanup() {
        const now = Date.now();
        for (const [path, lock] of this.locks.entries()) {
            if (now - lock.acquiredAt > FORUM_CONFIG.LOCK_TIMEOUT * 2) {
                console.warn(`[FileLock] Force releasing stale lock: ${path}`);
                this.releaseLock(path);
            }
        }
    }
}

const fileLockManager = new FileLockManager();

// 定期清理过期锁
setInterval(() => fileLockManager.cleanup(), 30000);

// ========== 安全工具函数 ==========

/**
 * 验证 UID 格式
 */
function isValidUid(uid) {
    if (!uid || typeof uid !== 'string') return false;
    if (uid.length > 64) return false;
    return FORUM_CONFIG.UID_PATTERN.test(uid);
}

/**
 * 安全路径检查 - 防止路径遍历攻击
 */
function isPathSafe(targetPath, rootPath) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(rootPath);
    return resolvedTarget.startsWith(resolvedRoot + path.sep) || resolvedTarget === resolvedRoot;
}

/**
 * 检查是否为符号链接
 */
async function isSymlink(filePath) {
    try {
        const stats = await fs.lstat(filePath);
        return stats.isSymbolicLink();
    } catch {
        return false;
    }
}

/**
 * 清理用户输入 - 移除潜在危险字符
 */
function sanitizeInput(input, maxLength) {
    if (typeof input !== 'string') return '';
    // 移除控制字符，保留换行和制表符
    let sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (maxLength) {
        sanitized = sanitized.substring(0, maxLength);
    }
    return sanitized;
}

/**
 * 安全的文件名解析 - 带有输入验证
 */
function parsePostFilename(filename) {
    // 基础格式验证
    if (!filename || typeof filename !== 'string') return null;
    if (filename.length > 300) return null; // 文件名长度限制
    
    // 使用非贪婪匹配并限制每个字段长度
    const match = filename.match(/^\[(.{1,50})\]\[(.{1,100})\]\[(.{1,50})\]\[(.{1,30})\]\[([a-zA-Z0-9_-]{1,64})\]\.md$/);
    if (!match) return null;
    
    return {
        board: match[1],
        title: match[2],
        author: match[3],
        timestamp: match[4].replace(/:/g, '-'),
        uid: match[5],
        filename: filename
    };
}

/**
 * 安全地查找目标文件
 */
async function findPostFile(uid) {
    if (!isValidUid(uid)) {
        throw new Error('Invalid UID format');
    }

    await fs.mkdir(FORUM_DIR, { recursive: true });
    const files = await fs.readdir(FORUM_DIR);
    
    // 使用精确匹配而非 includes
    const uidPattern = `[${uid}].md`;
    const targetFile = files.find(file => file.endsWith(uidPattern));
    
    if (!targetFile) return null;
    
    const fullPath = path.join(FORUM_DIR, targetFile);
    
    // 安全检查
    if (!isPathSafe(fullPath, FORUM_DIR)) {
        throw new Error('Path traversal detected');
    }
    
    // 符号链接检查
    if (await isSymlink(fullPath)) {
        throw new Error('Cannot access symbolic link files');
    }
    
    return { filename: targetFile, fullPath };
}

/**
 * 带锁的文件操作包装器
 */
async function withFileLock(filePath, operation) {
    try {
        await fileLockManager.acquireLock(filePath);
        return await operation();
    } finally {
        fileLockManager.releaseLock(filePath);
    }
}

/**
 * 安全的楼层解析 - 使用限制性正则
 */
function parseFloors(content) {
    const floors = [];
    const floorPattern = /### 楼层 #(\d{1,4})\n\*\*回复者:\*\* (.{1,50})\s*\n\*\*时间:\*\* ([^\n]{1,50})\s*\n\n([\s\S]*?)(?=\n\n---\n### 楼层 #|$)/g;
    
    let match;
    let count = 0;
    const maxFloors = FORUM_CONFIG.MAX_FLOORS_PER_POST;
    
    while ((match = floorPattern.exec(content)) !== null && count < maxFloors) {
        floors.push({
            number: parseInt(match[1], 10),
            author: match[2].trim(),
            time: match[3].trim(),
            content: match[4].trim()
        });
        count++;
    }
    
    return floors;
}

// ========== API 路由 ==========

// GET /posts - 列出所有帖子
router.get('/posts', async (req, res) => {
    try {
        await fs.mkdir(FORUM_DIR, { recursive: true });
        const files = await fs.readdir(FORUM_DIR);
        const mdFiles = files.filter(file => file.endsWith('.md'));

        const postsPromises = mdFiles.map(async (file) => {
            try {
                const postMeta = parsePostFilename(file);
                if (!postMeta) return null;

                const fullPath = path.join(FORUM_DIR, file);
                
                // 安全检查
                if (!isPathSafe(fullPath, FORUM_DIR)) return null;
                if (await isSymlink(fullPath)) return null;
                
                // 检查文件大小
                const stats = await fs.stat(fullPath);
                if (stats.size > FORUM_CONFIG.MAX_FILE_SIZE) {
                    console.warn(`[Forum API] File too large, skipping: ${file}`);
                    return null;
                }
                
                const content = await fs.readFile(fullPath, 'utf-8');
                
                // 使用更安全的正则，带有长度限制
                const replyPattern = /\*\*回复者:\*\* (.{1,50})\s*\n\*\*时间:\*\* ([^\n]{1,50})\s*\n/g;
                let lastReplyBy = null;
                let lastReplyAt = null;
                let match;
                
                // 限制匹配次数防止 ReDoS
                let matchCount = 0;
                while ((match = replyPattern.exec(content)) !== null && matchCount < FORUM_CONFIG.MAX_FLOORS_PER_POST) {
                    lastReplyBy = match[1].trim();
                    lastReplyAt = match[2].trim();
                    matchCount++;
                }

                return {
                    ...postMeta,
                    lastReplyBy,
                    lastReplyAt,
                    modifiedAt: stats.mtime.toISOString(),
                    mtimeMs: stats.mtimeMs
                };
            } catch (err) {
                console.warn(`[Forum API] Error processing file ${file}:`, err.message);
                return null;
            }
        });

        const posts = (await Promise.all(postsPromises)).filter(Boolean);
        
        posts.sort((a, b) => {
            const timeA = typeof a.mtimeMs === 'number' ? a.mtimeMs : (a.lastReplyAt ? new Date(a.lastReplyAt).getTime() : new Date(a.timestamp.replace(/-/g, ':').replace('T', ' ')).getTime());
            const timeB = typeof b.mtimeMs === 'number' ? b.mtimeMs : (b.lastReplyAt ? new Date(b.lastReplyAt).getTime() : new Date(b.timestamp.replace(/-/g, ':').replace('T', ' ')).getTime());
            return timeB - timeA;
        });

        res.json({ success: true, posts });
    } catch (error) {
        console.error('[Forum API] Error getting posts:', error);
        res.status(500).json({ success: false, error: 'Failed to retrieve forum posts.' });
    }
});

// GET /post/:uid - 获取单个帖子内容
router.get('/post/:uid', async (req, res) => {
    const { uid } = req.params;
    
    // UID 验证
    if (!isValidUid(uid)) {
        return res.status(400).json({ success: false, error: 'Invalid UID format.' });
    }

    try {
        const fileInfo = await findPostFile(uid);
        
        if (!fileInfo) {
            return res.status(404).json({ success: false, error: `Post with UID ${uid} not found.` });
        }

        // 检查文件大小
        const stats = await fs.stat(fileInfo.fullPath);
        if (stats.size > FORUM_CONFIG.MAX_FILE_SIZE) {
            return res.status(413).json({ success: false, error: 'Post file is too large.' });
        }

        const content = await fs.readFile(fileInfo.fullPath, 'utf-8');
        res.json({ success: true, content });
    } catch (error) {
        console.error(`[Forum API] Error getting post ${uid}:`, error);
        
        if (error.message === 'Invalid UID format' || error.message === 'Path traversal detected') {
            return res.status(403).json({ success: false, error: error.message });
        }
        
        res.status(500).json({ success: false, error: 'Failed to retrieve post content.' });
    }
});

// POST /reply/:uid - 回复帖子
router.post('/reply/:uid', async (req, res) => {
    const { uid } = req.params;
    let { maid, content } = req.body;

    // ===== 输入验证 =====
    if (!isValidUid(uid)) {
        return res.status(400).json({ success: false, error: 'Invalid UID format.' });
    }

    if (!maid || !content) {
        return res.status(400).json({ success: false, error: 'Maid and content are required.' });
    }

    // 清理和限制输入
    maid = sanitizeInput(maid, FORUM_CONFIG.MAX_MAID_LENGTH);
    content = sanitizeInput(content, FORUM_CONFIG.MAX_CONTENT_LENGTH);

    if (!maid || !content) {
        return res.status(400).json({ success: false, error: 'Invalid maid or content after sanitization.' });
    }

    try {
        const fileInfo = await findPostFile(uid);
        
        if (!fileInfo) {
            return res.status(404).json({ success: false, error: `Post with UID ${uid} not found.` });
        }

        // 使用文件锁进行原子操作
        await withFileLock(fileInfo.fullPath, async () => {
            // 检查文件大小
            const stats = await fs.stat(fileInfo.fullPath);
            if (stats.size > FORUM_CONFIG.MAX_FILE_SIZE) {
                throw new Error('Post file has reached maximum size limit.');
            }

            const originalContent = await fs.readFile(fileInfo.fullPath, 'utf-8');

            // 安全的楼层计数
            const floorPattern = /### 楼层 #(\d+)/g;
            let floorCount = 0;
            let match;
            while ((match = floorPattern.exec(originalContent)) !== null && floorCount < FORUM_CONFIG.MAX_FLOORS_PER_POST) {
                floorCount++;
            }

            if (floorCount >= FORUM_CONFIG.MAX_FLOORS_PER_POST) {
                throw new Error('This post has reached the maximum number of replies.');
            }

            const nextFloor = floorCount + 1;
            const timestamp = new Date().toISOString();
            
            const replyContent = `

---
### 楼层 #${nextFloor}
**回复者:** ${maid}
**时间:** ${timestamp}

${content}
`;

            await fs.appendFile(fileInfo.fullPath, replyContent, 'utf-8');
        });

        res.json({ success: true, message: 'Reply posted successfully.' });

    } catch (error) {
        console.error(`[Forum API] Error replying to post ${uid}:`, error);
        
        if (error.message.includes('maximum') || error.message.includes('limit')) {
            return res.status(400).json({ success: false, error: error.message });
        }
        if (error.message === 'Lock acquisition timeout') {
            return res.status(503).json({ success: false, error: 'Server busy, please try again.' });
        }
        
        res.status(500).json({ success: false, error: 'Failed to post reply.' });
    }
});

// DELETE /post/:uid - 删除帖子或楼层
router.delete('/post/:uid', async (req, res) => {
    const { uid } = req.params;
    const { floor } = req.body;

    // UID 验证
    if (!isValidUid(uid)) {
        return res.status(400).json({ success: false, error: 'Invalid UID format.' });
    }

    // 楼层号验证
    if (floor !== undefined) {
        const floorNum = parseInt(floor, 10);
        if (isNaN(floorNum) || floorNum <= 0 || floorNum > FORUM_CONFIG.MAX_FLOORS_PER_POST) {
            return res.status(400).json({ success: false, error: 'Invalid floor number.' });
        }
    }

    try {
        const fileInfo = await findPostFile(uid);
        
        if (!fileInfo) {
            return res.status(404).json({ success: false, error: `Post with UID ${uid} not found.` });
        }

        if (floor) {
            // ===== 删除特定楼层 =====
            await withFileLock(fileInfo.fullPath, async () => {
                const fileContent = await fs.readFile(fileInfo.fullPath, 'utf-8');
                
                const replyDelimiter = '\n\n---\n\n## 评论区\n---';
                const mainContentDelimiterIndex = fileContent.indexOf(replyDelimiter);

                if (mainContentDelimiterIndex === -1) {
                    throw new Error('Post has no replies section.');
                }

                const mainContent = fileContent.substring(0, mainContentDelimiterIndex);
                let repliesContent = fileContent.substring(mainContentDelimiterIndex + replyDelimiter.length);
                
                const replies = repliesContent.trim() ? repliesContent.trim().split('\n\n---\n') : [];
                const floorToDelete = parseInt(floor, 10);

                if (floorToDelete <= 0 || floorToDelete > replies.length) {
                    throw new Error(`Invalid floor number: ${floor}.`);
                }

                replies.splice(floorToDelete - 1, 1);

                const newRepliesContent = replies.map((reply, index) => {
                    const currentFloor = index + 1;
                    return reply.trim().replace(/### 楼层 #\d+/, `### 楼层 #${currentFloor}`);
                }).join('\n\n---\n');

                let finalNewContent = mainContent + replyDelimiter;
                if (newRepliesContent) {
                    finalNewContent += '\n' + newRepliesContent;
                }

                await fs.writeFile(fileInfo.fullPath, finalNewContent, 'utf-8');
            });

            res.json({ success: true, message: `Floor #${floor} of post ${uid} deleted successfully.` });

        } else {
            // ===== 删除整个帖子 =====
            await withFileLock(fileInfo.fullPath, async () => {
                await fs.unlink(fileInfo.fullPath);
            });
            
            res.json({ success: true, message: `Post ${uid} deleted successfully.` });
        }

    } catch (error) {
        console.error(`[Forum API] Error during deletion for post ${uid}:`, error);
        
        if (error.message.includes('Invalid floor') || error.message.includes('no replies')) {
            return res.status(400).json({ success: false, error: error.message });
        }
        if (error.message === 'Lock acquisition timeout') {
            return res.status(503).json({ success: false, error: 'Server busy, please try again.' });
        }
        
        res.status(500).json({ success: false, error: 'Failed to process deletion request.' });
    }
});

// PATCH /post/:uid - 编辑帖子或楼层
router.patch('/post/:uid', async (req, res) => {
    const { uid } = req.params;
    let { floor, content } = req.body;

    // ===== 输入验证 =====
    if (!isValidUid(uid)) {
        return res.status(400).json({ success: false, error: 'Invalid UID format.' });
    }

    if (content === undefined || content === null) {
        return res.status(400).json({ success: false, error: 'Content for editing is required.' });
    }

    // 清理和限制内容
    content = sanitizeInput(content, FORUM_CONFIG.MAX_CONTENT_LENGTH);

    // 楼层号验证
    if (floor !== undefined) {
        const floorNum = parseInt(floor, 10);
        if (isNaN(floorNum) || floorNum <= 0 || floorNum > FORUM_CONFIG.MAX_FLOORS_PER_POST) {
            return res.status(400).json({ success: false, error: 'Invalid floor number.' });
        }
    }

    try {
        const fileInfo = await findPostFile(uid);
        
        if (!fileInfo) {
            return res.status(404).json({ success: false, error: `Post with UID ${uid} not found.` });
        }

        await withFileLock(fileInfo.fullPath, async () => {
            const fileContent = await fs.readFile(fileInfo.fullPath, 'utf-8');
            let newFileContent = '';

            const replyDelimiter = '\n\n---\n\n## 评论区\n---';
            const mainContentDelimiterIndex = fileContent.indexOf(replyDelimiter);

            if (floor) {
                // ===== 编辑特定楼层 =====
                if (mainContentDelimiterIndex === -1) {
                    throw new Error('Post has no replies section to edit.');
                }

                const mainContent = fileContent.substring(0, mainContentDelimiterIndex);
                let repliesContent = fileContent.substring(mainContentDelimiterIndex + replyDelimiter.length);
                const replies = repliesContent.trim() ? repliesContent.trim().split('\n\n---\n') : [];
                
                const floorToEdit = parseInt(floor, 10);
                if (floorToEdit <= 0 || floorToEdit > replies.length) {
                    throw new Error(`Invalid floor number: ${floor}.`);
                }

                const targetReply = replies[floorToEdit - 1];
                const metadataEndIndex = targetReply.indexOf('\n\n');
                if (metadataEndIndex === -1) {
                    throw new Error('Could not parse the reply to edit.');
                }
                const replyMetadata = targetReply.substring(0, metadataEndIndex);
                
                replies[floorToEdit - 1] = `${replyMetadata}\n\n${content}`;

                const newRepliesContent = replies.join('\n\n---\n');
                newFileContent = mainContent + replyDelimiter + '\n' + newRepliesContent;
                
            } else {
                // ===== 编辑主帖内容 =====
                const mainContentStartDelimiter = '\n---\n';
                const mainContentStartIndex = fileContent.indexOf(mainContentStartDelimiter);

                if (mainContentStartIndex === -1) {
                    throw new Error('Could not parse main post structure.');
                }
                
                const metadata = fileContent.substring(0, mainContentStartIndex);
                const repliesSection = mainContentDelimiterIndex !== -1 ? fileContent.substring(mainContentDelimiterIndex) : '';
                
                newFileContent = metadata + mainContentStartDelimiter + '\n' + content + repliesSection;
            }

            // 检查新内容大小
            if (Buffer.byteLength(newFileContent, 'utf-8') > FORUM_CONFIG.MAX_FILE_SIZE) {
                throw new Error('Resulting file would exceed maximum size limit.');
            }

            await fs.writeFile(fileInfo.fullPath, newFileContent, 'utf-8');
        });

        res.json({ success: true, message: `Post ${uid} was updated successfully.` });

    } catch (error) {
        console.error(`[Forum API] Error editing post ${uid}:`, error);
        
        if (error.message.includes('Invalid floor') || 
            error.message.includes('no replies') || 
            error.message.includes('Could not parse') ||
            error.message.includes('maximum size')) {
            return res.status(400).json({ success: false, error: error.message });
        }
        if (error.message === 'Lock acquisition timeout') {
            return res.status(503).json({ success: false, error: 'Server busy, please try again.' });
        }
        
        res.status(500).json({ success: false, error: 'Failed to process edit request.' });
    }
});

// ===== 管理接口：查看锁状态 =====
router.get('/admin/lock-status', (req, res) => {
    const locks = [];
    for (const [path, lock] of fileLockManager.locks.entries()) {
        locks.push({
            path: path.replace(FORUM_DIR, '[FORUM_DIR]'),
            queueLength: lock.queue.length,
            acquiredAt: new Date(lock.acquiredAt).toISOString()
        });
    }
    
    res.json({
        activeWrites: fileLockManager.writeCount,
        maxConcurrent: FORUM_CONFIG.MAX_CONCURRENT_WRITES,
        locks
    });
});

module.exports = router;