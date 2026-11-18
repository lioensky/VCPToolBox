const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;

    let restartInFlight = false;

    // POST to restart the server
    router.post('/server/restart', async (req, res) => {
        const { triggerRestart } = options;

        if (restartInFlight) {
            return res.status(202).json({
                status: 'restarting',
                message: '服务器已在执行优雅重启流程，请勿重复触发。'
            });
        }

        if (typeof triggerRestart !== 'function') {
            console.warn('[AdminPanelRoutes] No triggerRestart callback found.');
            return res.status(500).json({
                status: 'error',
                message: '服务器未配置重启处理器，无法执行优雅重启。'
            });
        }

        restartInFlight = true;
        res.status(202).json({
            status: 'accepted',
            message: '服务器重启命令已接纳。正在进入优雅排空与重启流程...'
        });

        setImmediate(async () => {
            console.log('[AdminPanelRoutes][RESTART_V2_SENTINEL_20260424] Received restart command. Initiating controlled shutdown...');
            try {
                await triggerRestart(1); // 传 1 以确保 PM2 检测到状态变化并自动拉起
            } catch (error) {
                restartInFlight = false;
                console.error('[AdminPanelRoutes] Graceful restart failed:', error);
            }
        });
    });

    // 验证登录端点
    router.post('/verify-login', (req, res) => {
        if (req.headers.authorization) {
            const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
            const cookieOptions = [
                `admin_auth=${encodeURIComponent(req.headers.authorization)}`,
                'Path=/',
                'HttpOnly',
                'SameSite=Strict',
                'Max-Age=86400'
            ];

            if (isSecure) {
                cookieOptions.push('Secure');
            }

            res.setHeader('Set-Cookie', cookieOptions.join('; '));
        }

        res.status(200).json({
            status: 'success',
            message: 'Authentication successful'
        });
    });

    // 登出端点
    router.post('/logout', (req, res) => {
        res.setHeader('Set-Cookie', 'admin_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        res.status(200).json({ status: 'success', message: 'Logged out' });
    });

    // 检查认证状态端点
    router.get('/check-auth', (req, res) => {
        res.status(200).json({ authenticated: true });
    });

    return router;
};
