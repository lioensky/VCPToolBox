const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;

    // POST to restart the server
    router.post('/server/restart', async (req, res) => {
        res.json({ message: '服务器重启命令已发送。服务器正在关闭，如果由进程管理器（如 PM2）管理，它应该会自动重启。' });

        setTimeout(() => {
            console.log('[AdminPanelRoutes] Received restart command. Shutting down...');

            // 强制清除Node.js模块缓存
            const moduleKeys = Object.keys(require.cache);
            moduleKeys.forEach(key => {
                if (key.includes('TextChunker.js') || key.includes('VectorDBManager.js')) {
                    delete require.cache[key];
                }
            });

            process.exit(1);
        }, 1000);
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
