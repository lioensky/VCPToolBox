const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// 记录每个日志文件的 inode，用于检测日志轮转
const logFileInodes = new Map();

module.exports = function(options) {
    const router = express.Router();
    const { getCurrentServerLogPath } = options;

    router.get('/server-log', async (req, res) => {
        const logPath = getCurrentServerLogPath();
        if (!logPath) {
            return res.status(503).json({ error: 'Server log path not available.', content: '服务器日志路径当前不可用，可能仍在初始化中。' });
        }
        try {
            const stats = await fs.stat(logPath);
            const currentInode = stats.ino;
            const fileSize = stats.size;

            // 检查是否请求增量读取
            const incremental = req.query.incremental === 'true';
            const offset = parseInt(req.query.offset || '0', 10);

            // 检测日志轮转（inode 变化或文件变小）
            const lastInode = logFileInodes.get(logPath);
            if (incremental && lastInode && (currentInode !== lastInode || offset > fileSize)) {
                logFileInodes.set(logPath, currentInode);
                return res.json({
                    needFullReload: true,
                    path: logPath,
                    offset: 0
                });
            }

            logFileInodes.set(logPath, currentInode);

            let content = '';
            let newOffset = 0;

            const fd = await fs.open(logPath, 'r');
            try {
                if (incremental && offset >= 0 && offset <= fileSize) {
                    // 增量读取：从 offset 位置开始
                    const bufferSize = fileSize - offset;
                    if (bufferSize > 0) {
                        const buffer = Buffer.alloc(bufferSize);
                        const { bytesRead } = await fd.read(buffer, 0, bufferSize, offset);
                        content = buffer.toString('utf-8', 0, bytesRead);
                    }
                    newOffset = fileSize;
                } else {
                    // 完整读取（但限制大小）
                    const maxReadSize = 2 * 1024 * 1024; // 2MB
                    let startPos = 0;
                    let readSize = fileSize;

                    if (fileSize > maxReadSize) {
                        startPos = fileSize - maxReadSize;
                        readSize = maxReadSize;
                    }

                    const buffer = Buffer.alloc(readSize);
                    const { bytesRead } = await fd.read(buffer, 0, readSize, startPos);
                    content = buffer.toString('utf-8', 0, bytesRead);

                    // 如果是截断读取，跳过第一行（可能不完整）
                    if (startPos > 0) {
                        const firstNewline = content.indexOf('\n');
                        if (firstNewline !== -1) {
                            content = content.substring(firstNewline + 1);
                        }
                    }
                    newOffset = fileSize;
                }
            } finally {
                await fd.close();
            }

            res.json({
                content: content,
                offset: newOffset,
                path: logPath,
                fileSize: fileSize,
                needFullReload: false
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.warn(`[AdminPanelRoutes API] /server-log - Log file not found at: ${logPath}`);
                res.status(404).json({ error: 'Log file not found.', content: `日志文件 ${logPath} 未找到。它可能尚未创建或已被删除。`, path: logPath });
            } else {
                console.error(`[AdminPanelRoutes API] Error reading server log file ${logPath}:`, error);
                res.status(500).json({ error: 'Failed to read server log file', details: error.message, content: `读取日志文件 ${logPath} 失败。`, path: logPath });
            }
        }
    });

    // 清空日志文件
    router.post('/server-log/clear', async (req, res) => {
        const logPath = getCurrentServerLogPath();
        if (!logPath) {
            return res.status(503).json({ error: 'Server log path not available.' });
        }
        try {
            await fs.writeFile(logPath, '', 'utf-8');
            const stats = await fs.stat(logPath);
            logFileInodes.set(logPath, stats.ino);
            res.json({ success: true, message: '日志已清空' });
        } catch (error) {
            console.error(`[AdminPanelRoutes API] Error clearing server log file ${logPath}:`, error);
            res.status(500).json({ error: 'Failed to clear server log file', details: error.message });
        }
    });

    return router;
};
