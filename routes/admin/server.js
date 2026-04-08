const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;

    // POST to restart the server
    router.post('/server/restart', async (req, res) => {
        const { triggerRestart } = options;
        res.json({ message: '服务器重启命令已接纳。正在执行优雅关闭并请求进程管理器重启...' });

        setTimeout(async () => {
            console.log('[AdminPanelRoutes] Received restart command. Initiating shutdown...');

            // 强制清除Node.js模块缓存（尽力而为）
            const moduleKeys = Object.keys(require.cache);
            moduleKeys.forEach(key => {
                if (key.includes('TextChunker.js') || key.includes('VectorDBManager.js')) {
                    delete require.cache[key];
                }
            });

            if (typeof triggerRestart === 'function') {
                try {
                    await triggerRestart(1); // 传 1 以确保 PM2 检测到状态变化并自动拉起
                } catch (error) {
                    console.error('[AdminPanelRoutes] Graceful shutdown failed, falling back to process.exit(1):', error);
                    process.exit(1);
                }
            } else {
                console.warn('[AdminPanelRoutes] No triggerRestart callback found. Falling back to process.exit(1).');
                process.exit(1);
            }
            
            // 最后的防御：如果 15 秒后还没退出，强行硬退出
            setTimeout(() => {
                console.error('[AdminPanelRoutes] Shutdown timed out. Force exiting...');
                process.exit(1);
            }, 15000).unref();
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
