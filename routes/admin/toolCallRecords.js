const express = require('express');
const toolCallRecordStore = require('../../modules/toolCallRecordStore');

module.exports = function() {
    const router = express.Router();

    router.get('/tool-call-records/status', (req, res) => {
        try {
            toolCallRecordStore.initialize();
            res.json({
                status: 'success',
                store: toolCallRecordStore.getStatus()
            });
        } catch (error) {
            console.error('[ToolCallRecords Admin] Failed to get status:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.get('/tool-call-records/config', (req, res) => {
        try {
            toolCallRecordStore.initialize();
            res.json({
                status: 'success',
                config: toolCallRecordStore.getConfig()
            });
        } catch (error) {
            console.error('[ToolCallRecords Admin] Failed to get config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.post('/tool-call-records/config', (req, res) => {
        try {
            const payload = req.body?.config && typeof req.body.config === 'object'
                ? req.body.config
                : req.body;
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return res.status(400).json({ status: 'error', error: 'Invalid config payload.' });
            }

            toolCallRecordStore.initialize();
            const config = toolCallRecordStore.saveConfig(payload);
            res.json({
                status: 'success',
                message: '工具调用记录配置已保存并热更新。',
                config
            });
        } catch (error) {
            console.error('[ToolCallRecords Admin] Failed to save config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.get('/tool-call-records', (req, res) => {
        try {
            toolCallRecordStore.initialize();
            const result = toolCallRecordStore.queryRecords({
                id: req.query.id,
                toolName: req.query.toolName || req.query.tool_name,
                callerSignature: req.query.callerSignature || req.query.caller || req.query.maid || req.query.valet,
                callerType: req.query.callerType || req.query.caller_type,
                status: req.query.status,
                success: req.query.success,
                from: req.query.from || req.query.startFrom,
                to: req.query.to || req.query.endTo,
                search: req.query.search || req.query.q,
                limit: req.query.limit,
                offset: req.query.offset,
                order: req.query.order,
                detail: req.query.detail
            });
            res.json(result);
        } catch (error) {
            console.error('[ToolCallRecords Admin] Failed to query records:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.get('/tool-call-records/:id', (req, res) => {
        try {
            toolCallRecordStore.initialize();
            const record = toolCallRecordStore.getRecordById(req.params.id);
            if (!record) {
                return res.status(404).json({ status: 'error', error: 'Record not found.' });
            }
            res.json({ status: 'success', record });
        } catch (error) {
            console.error('[ToolCallRecords Admin] Failed to get record:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.post('/tool-call-records/cleanup-expired', async (req, res) => {
        try {
            toolCallRecordStore.initialize();
            const result = await toolCallRecordStore.cleanupExpired();
            res.json({
                ...result,
                message: result.skipped ? '未配置过期时间，已跳过清理。' : `已清理 ${result.deleted || 0} 条过期工具调用记录。`
            });
        } catch (error) {
            console.error('[ToolCallRecords Admin] Failed to cleanup expired records:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.post('/tool-call-records/clear-all', async (req, res) => {
        try {
            toolCallRecordStore.initialize();
            const confirm = req.body?.confirm === true || req.body?.confirm === 'true';
            if (!confirm) {
                return res.status(400).json({
                    status: 'error',
                    error: 'clear-all requires { "confirm": true }.'
                });
            }
            const result = await toolCallRecordStore.clearAll();
            res.json({
                ...result,
                message: `已清空 ${result.deleted || 0} 条工具调用记录。`
            });
        } catch (error) {
            console.error('[ToolCallRecords Admin] Failed to clear records:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    return router;
};