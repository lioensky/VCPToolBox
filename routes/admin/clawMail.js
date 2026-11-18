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

    // ===== V1.1/V2 补全端点（SDK 能力现成，仅补 HTTP 出口） =====

    // 发送新邮件：body { mailbox/user, to, cc?, bcc?, subject, body, html?, attachments? }
    router.post('/claw-mail/messages', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const result = await clawMail.adminSendMail(req.body || {});
        res.json({
            status: 'success',
            ...result
        });
    }));

    // 回复邮件：body { mailbox/user, body, html?, toAll?, attachments? }
    router.post('/claw-mail/messages/:mailId/reply', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const result = await clawMail.adminReplyMail({
            ...(req.body || {}),
            mailId: req.params.mailId
        });
        res.json({
            status: 'success',
            ...result
        });
    }));

    // 文件夹列表
    router.get('/claw-mail/folders', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const result = await clawMail.adminListFolders({
            mailbox: req.query.mailbox,
            user: req.query.user
        });
        res.json({
            status: 'success',
            ...result
        });
    }));

    // 搜索（keyword/from/to/subject/since/before/unreadOnly/fts/limit/fid）
    router.get('/claw-mail/search', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const result = await clawMail.adminSearchMails({
            mailbox: req.query.mailbox,
            user: req.query.user,
            keyword: req.query.keyword || req.query.q,
            from: req.query.from,
            to: req.query.to,
            subject: req.query.subject,
            since: req.query.since,
            before: req.query.before,
            unreadOnly: req.query.unreadOnly,
            fts: req.query.fts,
            limit: req.query.limit,
            fid: req.query.fid
        });
        res.json({
            status: 'success',
            ...result
        });
    }));

    // 标记已读/未读：body { read = true, mailbox?, user?, fid? }
    router.post('/claw-mail/messages/:mailId/read', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const body = req.body || {};
        const result = await clawMail.adminMarkMail({
            mailId: req.params.mailId,
            read: body.read === undefined ? true : body.read,
            mailbox: body.mailbox,
            user: body.user,
            fid: body.fid
        });
        res.json({
            status: 'success',
            ...result
        });
    }));

    // 移动到任意文件夹：body { target/targetFolderId, fid?, mailbox?, user? }
    router.post('/claw-mail/messages/:mailId/move', asyncHandler(async (req, res) => {
        const clawMail = getClawMailModule(pluginManager);
        const result = await clawMail.adminMoveMail({
            ...(req.body || {}),
            mailId: req.params.mailId
        });
        res.json({
            status: 'success',
            ...result
        });
    }));

    // 附件原始字节下载（流式回传，不走 JSON 信封）
    router.get('/claw-mail/messages/:mailId/attachments/:partId', async (req, res) => {
        try {
            const clawMail = getClawMailModule(pluginManager);
            const data = await clawMail.adminGetAttachment({
                mailId: req.params.mailId,
                partId: req.params.partId,
                mailbox: req.query.mailbox,
                user: req.query.user
            });
            res.setHeader('Content-Type', data.contentType || 'application/octet-stream');
            res.setHeader('Content-Length', data.size);
            res.setHeader(
                'Content-Disposition',
                `attachment; filename*=UTF-8''${encodeURIComponent(data.filename || 'attachment.bin')}`
            );
            res.send(data.buffer);
        } catch (error) {
            const statusCode = error.statusCode || 500;
            console.error('[AdminPanelRoutes][VCPClawMail] attachment download failed:', error);
            res.status(statusCode).json({
                status: 'error',
                error: error.message || '附件下载失败。'
            });
        }
    });

    return router;
};