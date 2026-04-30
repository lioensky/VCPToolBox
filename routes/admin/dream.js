const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;
    const PROJECT_BASE_PATH = path.join(__dirname, '..', '..');
    const DREAM_LOGS_DIR = path.join(PROJECT_BASE_PATH, 'Plugin', 'AgentDream', 'dream_logs');

    // GET /dream-logs - list dream log files with summary metadata.
    router.get('/dream-logs', async (req, res) => {
        try {
            await fs.mkdir(DREAM_LOGS_DIR, { recursive: true });
            const files = await fs.readdir(DREAM_LOGS_DIR);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            const logs = [];
            for (const filename of jsonFiles) {
                try {
                    const filePath = path.join(DREAM_LOGS_DIR, filename);
                    const content = await fs.readFile(filePath, 'utf-8');
                    const data = JSON.parse(content);
                    const ops = data.operations || [];

                    logs.push({
                        filename,
                        agentName: data.agentName || '未知',
                        timestamp: data.timestamp || '',
                        operationCount: ops.length,
                        pendingCount: ops.filter(o => o.status === 'pending_review').length,
                        operationSummary: ops.map(o => ({
                            type: o.type,
                            status: o.status
                        }))
                    });
                } catch (e) {
                    console.error(`[AdminAPI] Skip corrupted log file ${filename}:`, e.message);
                }
            }

            logs.sort((a, b) => {
                const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return timeB - timeA;
            });

            res.json({ logs });
        } catch (error) {
            console.error('[AdminAPI] Error listing dream logs:', error);
            res.status(500).json({ error: 'Failed to list dream logs', details: error.message });
        }
    });

    // GET /dream-logs/:filename - read one dream log.
    router.get('/dream-logs/:filename', async (req, res) => {
        try {
            const filename = path.basename(req.params.filename || '');
            if (!filename.endsWith('.json') || filename !== req.params.filename) {
                return res.status(400).json({ error: 'Invalid filename' });
            }
            const logPath = path.join(DREAM_LOGS_DIR, filename);
            const content = await fs.readFile(logPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminAPI] Error reading dream log:', error);
            res.status(500).json({ error: 'Failed to read dream log', details: error.message });
        }
    });

    // POST /dream-logs/:filename/operations/:opId - approve or reject an AgentDream operation.
    router.post('/dream-logs/:filename/operations/:opId', async (req, res) => {
        const opId = req.params.opId;
        const filename = path.basename(req.params.filename || '');
        const { action } = req.body;

        if (!filename || !filename.endsWith('.json') || filename !== req.params.filename) {
            return res.status(400).json({ error: 'Invalid filename.' });
        }

        if (action !== 'approve' && action !== 'reject') {
            return res.status(400).json({ error: 'Invalid action. Use approve or reject.' });
        }

        try {
            const agentDream = pluginManager?.getServiceModule?.('AgentDream') || require('../../Plugin/AgentDream/AgentDream.js');
            if (!agentDream) {
                return res.status(500).json({ error: 'AgentDream service module unavailable.' });
            }

            const result = action === 'approve'
                ? await agentDream.approveDreamOperation(filename, opId)
                : await agentDream.rejectDreamOperation(filename, opId);

            res.json(result);
        } catch (error) {
            console.error('[AdminAPI] Error processing dream operation:', error);
            res.status(500).json({ error: 'Failed to process operation', details: error.message });
        }
    });

    return router;
};
