const express = require('express');

function getClawMailModule(pluginManager) {
    const module = pluginManager && typeof pluginManager.getServiceModule === 'function'
        ? pluginManager.getServiceModule('VCPClawMail')
        : null;
    if (!module) {
        const error = new Error('VCPClawMail 插件未加载或不是可用的 hybridservice。');
        error.statusCode = 503;
        throw error;
    }
    return module;
}

function asyncHandler(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch(error => {
            const statusCode = error.statusCode || 500;
            console.error('[AdminPanelRoutes][VCPClawMail]', error);
            res.status(statusCode).json({
                status: 'error',
                error: error.message || 'VCPClawMail 管理接口执行失败。'
            });
        });
    };
}

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;

    router.get('/claw-mail/state', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const state = await clawMail.getAdminMailboxState({
            refresh: req.query.refresh === 'true'
        });
        res.json({
            status: 'success',
            ...state
        });
    }));

    router.get('/claw-mail/messages', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const result = await clawMail.adminListEmails({
            mailbox: req.query.mailbox,
            user: req.query.user,
            limit: req.query.limit,
            unreadOnly: req.query.unreadOnly,
            fid: req.query.fid,
            start: req.query.start,
            order: req.query.order,
            desc: req.query.desc
        });
        res.json({
            status: 'success',
            ...result
        });
    }));

    router.get('/claw-mail/messages/:mailId', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const result = await clawMail.adminReadMail({
            mailbox: req.query.mailbox,
            user: req.query.user,
            mailId: req.params.mailId,
            markRead: req.query.markRead,
            includeAttachmentContent: req.query.includeAttachmentContent,
            maxAttachments: req.query.maxAttachments
        });
        res.json({
            status: 'success',
            ...result
        });
    }));

    router.post('/claw-mail/messages/:mailId/trash', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const result = await clawMail.adminMoveToTrash({
            ...(req.body || {}),
            mailId: req.params.mailId,
            confirm: true
        });
        res.json({
            status: 'success',
            ...result
        });
    }));

    return router;
};