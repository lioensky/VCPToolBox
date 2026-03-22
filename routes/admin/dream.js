const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager, vectorDBManager } = options;
    const PROJECT_BASE_PATH = path.join(__dirname, '..', '..');
    const DREAM_LOGS_DIR = path.join(PROJECT_BASE_PATH, 'Plugin', 'AgentDream', 'logs');

    // 辅助: file:/// URL 转本地路径
    function _urlToFilePath(fileUrl) {
        if (fileUrl.startsWith('file:///')) {
            // Windows 下可能是 file:///C:/... 或者是 file:///H:/...
            // 处理路径分隔符
            let p = fileUrl.replace('file:///', '');
            if (process.platform === 'win32') {
                p = p.replace(/\//g, path.sep);
            } else {
                p = '/' + p;
            }
            return p;
        }
        return fileUrl;
    }

    // GET /dream-logs - 获取所有梦境日志文件列表
    router.get('/dream-logs', async (req, res) => {
        try {
            await fs.mkdir(DREAM_LOGS_DIR, { recursive: true });
            const files = await fs.readdir(DREAM_LOGS_DIR);
            const logFiles = files.filter(f => f.endsWith('.json'));
            res.json({ logs: logFiles });
        } catch (error) {
            console.error('[AdminAPI] Error listing dream logs:', error);
            res.status(500).json({ error: 'Failed to list dream logs', details: error.message });
        }
    });

    // GET /dream-logs/:filename - 获取特定梦境日志文件内容
    router.get('/dream-logs/:filename', async (req, res) => {
        try {
            const filename = req.params.filename;
            if (!filename.endsWith('.json')) return res.status(400).json({ error: 'Invalid filename' });
            const logPath = path.join(DREAM_LOGS_DIR, filename);
            const content = await fs.readFile(logPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminAPI] Error reading dream log:', error);
            res.status(500).json({ error: 'Failed to read dream log', details: error.message });
        }
    });

    // POST /dream-operation/:opId/reviewed - 标记并处理 AgentDream 操作
    router.post('/dream-operation/:opId/reviewed', async (req, res) => {
        const opId = req.params.opId;
        const { action, filename } = req.body; // action: 'approve' or 'reject'

        if (!filename || !filename.endsWith('.json')) {
            return res.status(400).json({ error: 'Invalid filename.' });
        }

        const filePath = path.join(DREAM_LOGS_DIR, filename);

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const dreamLog = JSON.parse(content);
            const operations = dreamLog.operations || [];
            const operation = operations.find(o => o.operationId === opId);

            if (!operation) {
                return res.status(404).json({ error: `操作 ${opId} 未找到。` });
            }
            if (operation.status !== 'pending_review') {
                return res.status(400).json({ error: `操作 ${opId} 已被处理 (${operation.status})，无法重复审批。` });
            }

            if (action === 'reject') {
                operation.status = 'rejected';
                operation.reviewedAt = new Date().toISOString();
                await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                return res.json({ status: 'success', message: `操作 ${opId} 已拒绝。`, operation });
            }

            // --- action === 'approve' ---
            let result = {};

            switch (operation.type) {
                case 'merge': {
                    const maidName = dreamLog.agentName || '未知';
                    const now = new Date();
                    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

                    try {
                        const writeResult = await pluginManager.executePlugin('DailyNoteWrite', JSON.stringify({
                            maidName: maidName,
                            dateString: dateStr,
                            contentText: operation.newContent || ''
                        }));
                        result.newDiary = writeResult;
                    } catch (e) {
                        operation.status = 'error';
                        operation.error = `创建合并日记失败: ${e.message}`;
                        operation.reviewedAt = new Date().toISOString();
                        await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                        return res.status(500).json({ error: operation.error });
                    }

                    // 删除源日记文件
                    const deleteResults = [];
                    for (const diaryUrl of (operation.sourceDiaries || [])) {
                        const diaryPath = _urlToFilePath(diaryUrl);
                        try {
                            await fs.unlink(diaryPath);
                            deleteResults.push({ path: diaryUrl, deleted: true });
                            // 更新向量库
                            if (vectorDBManager && typeof vectorDBManager.removeDocument === 'function') {
                                try { await vectorDBManager.removeDocument(diaryPath); } catch (e) { /* ignore */ }
                            }
                        } catch (e) {
                            deleteResults.push({ path: diaryUrl, deleted: false, error: e.message });
                        }
                    }
                    result.deletedSources = deleteResults;
                    break;
                }

                case 'delete': {
                    const targetPath = _urlToFilePath(operation.targetDiary || '');
                    try {
                        await fs.unlink(targetPath);
                        result.deleted = true;
                        // 更新向量库
                        if (vectorDBManager && typeof vectorDBManager.removeDocument === 'function') {
                            try { await vectorDBManager.removeDocument(targetPath); } catch (e) { /* ignore */ }
                        }
                    } catch (e) {
                        operation.status = 'error';
                        operation.error = `删除日记失败: ${e.message}`;
                        operation.reviewedAt = new Date().toISOString();
                        await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                        return res.status(500).json({ error: operation.error });
                    }
                    break;
                }

                case 'insight': {
                    const maidName = operation.suggestedMaid || dreamLog.agentName || '未知';
                    const dateStr = operation.suggestedDate || new Date().toISOString().split('T')[0];

                    try {
                        const writeResult = await pluginManager.executePlugin('DailyNoteWrite', JSON.stringify({
                            maidName: `[${maidName}的梦]${maidName}`,
                            dateString: dateStr,
                            contentText: operation.insightContent || ''
                        }));
                        result.newDiary = writeResult;
                    } catch (e) {
                        operation.status = 'error';
                        operation.error = `创建梦感悟失败: ${e.message}`;
                        operation.reviewedAt = new Date().toISOString();
                        await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                        return res.status(500).json({ error: operation.error });
                    }
                    break;
                }

                default:
                    return res.status(400).json({ error: `不支持的操作类型: ${operation.type}` });
            }

            operation.status = 'approved';
            operation.reviewedAt = new Date().toISOString();
            operation.result = result;
            await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
            res.json({ status: 'success', message: `操作 ${opId} 已批准并执行。`, operation });

        } catch (error) {
            console.error('[AdminAPI] Error processing dream operation:', error);
            res.status(500).json({ error: 'Failed to process operation', details: error.message });
        }
    });

    return router;
};
