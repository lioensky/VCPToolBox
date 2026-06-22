

// Plugin/ImageServer/image-server.js
const express = require('express');
const path = require('path');
const fs = require('fs');

let serverImageKeyForAuth; // Stores Image_Key from config
let serverFileKeyForAuth; // Stores File_Key from config
let pluginDebugMode = false; // To store the debug mode state for this plugin

// 安全配置
const SECURITY_CONFIG = {
    // 允许的图片文件扩展名
    ALLOWED_IMAGE_EXTENSIONS: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'],
    // 允许的文件扩展名
    ALLOWED_FILE_EXTENSIONS: ['.txt', '.pdf', '.doc', '.docx', '.json', '.xml', '.csv', '.md', '.mp4', '.webp', '.mov', '.avi'],
    // 最大文件大小 (50MB)
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    // 异常检测配置
    ANOMALY_DETECTION: {
        TIME_WINDOW: 30 * 60 * 1000, // 30分钟
        MAX_UNIQUE_IPS: 5, // 最大不同IP数量
        LOCKDOWN_DURATION: 60 * 60 * 1000 // 锁定1小时
    }
};

// 安全状态管理
class SecurityManager {
    constructor() {
        this.ipAccessLog = new Map(); // IP访问记录
        this.isLocked = false; // 是否被锁定
        this.lockStartTime = null; // 锁定开始时间
        this.lockEndTime = null; // 锁定结束时间
        this.cleanupInterval = null; // 清理定时器
        
        // 启动清理定时器
        this.startCleanupTimer();
    }

    // 记录IP访问
    recordAccess(ip, serviceType) {
        const now = Date.now();
        const key = `${ip}_${serviceType}`;
        
        if (!this.ipAccessLog.has(key)) {
            this.ipAccessLog.set(key, []);
        }
        
        const accessTimes = this.ipAccessLog.get(key);
        accessTimes.push(now);
        
        // 清理过期记录
        this.cleanExpiredRecords(key);
        
        if (pluginDebugMode) {
            console.log(`[SecurityManager] IP ${ip} 访问 ${serviceType} 服务，当前访问次数: ${accessTimes.length}`);
        }
    }

    // 检查是否存在异常访问
    checkAnomalousAccess(serviceType) {
        const now = Date.now();
        const timeWindow = SECURITY_CONFIG.ANOMALY_DETECTION.TIME_WINDOW;
        
        // 获取时间窗口内的唯一IP
        const uniqueIPs = new Set();
        
        for (const [key, accessTimes] of this.ipAccessLog.entries()) {
            if (key.endsWith(`_${serviceType}`)) {
                const ip = key.split('_')[0];
                const recentAccesses = accessTimes.filter(time => now - time <= timeWindow);
                
                if (recentAccesses.length > 0) {
                    uniqueIPs.add(ip);
                }
            }
        }

        const uniqueIPCount = uniqueIPs.size;
        
        if (pluginDebugMode) {
            console.log(`[SecurityManager] ${serviceType} 服务在过去30分钟内有 ${uniqueIPCount} 个不同IP访问`);
        }

        // 检查是否超过阈值
        if (uniqueIPCount >= SECURITY_CONFIG.ANOMALY_DETECTION.MAX_UNIQUE_IPS) {
            this.triggerLockdown();
            return true;
        }
        
        return false;
    }

    // 触发锁定
    triggerLockdown() {
        if (this.isLocked) return; // 已经锁定，不重复触发
        
        this.isLocked = true;
        this.lockStartTime = Date.now();
        this.lockEndTime = this.lockStartTime + SECURITY_CONFIG.ANOMALY_DETECTION.LOCKDOWN_DURATION;
        
        console.warn(`[SecurityManager] 🚨 检测到异常访问模式！图床服务已锁定1小时`);
        console.warn(`[SecurityManager] 锁定时间: ${new Date(this.lockStartTime).toLocaleString()} - ${new Date(this.lockEndTime).toLocaleString()}`);
        
        // 设置自动解锁定时器
        setTimeout(() => {
            this.releaseLockdown();
        }, SECURITY_CONFIG.ANOMALY_DETECTION.LOCKDOWN_DURATION);
    }

    // 解除锁定
    releaseLockdown() {
        this.isLocked = false;
        this.lockStartTime = null;
        this.lockEndTime = null;
        
        console.log(`[SecurityManager] ✅ 图床服务锁定已解除，服务恢复正常`);
    }

    // 检查是否被锁定
    isServiceLocked() {
        if (!this.isLocked) return false;
        
        const now = Date.now();
        if (now >= this.lockEndTime) {
            this.releaseLockdown();
            return false;
        }
        
        return true;
    }

    // 获取锁定剩余时间
    getLockdownTimeRemaining() {
        if (!this.isLocked) return 0;
        
        const now = Date.now();
        const remaining = Math.max(0, this.lockEndTime - now);
        return Math.ceil(remaining / 1000 / 60); // 返回分钟数
    }

    // 清理过期记录
    cleanExpiredRecords(key = null) {
        const now = Date.now();
        const timeWindow = SECURITY_CONFIG.ANOMALY_DETECTION.TIME_WINDOW;
        
        if (key) {
            // 清理特定key的过期记录
            const accessTimes = this.ipAccessLog.get(key);
            if (accessTimes) {
                const validTimes = accessTimes.filter(time => now - time <= timeWindow);
                if (validTimes.length === 0) {
                    this.ipAccessLog.delete(key);
                } else {
                    this.ipAccessLog.set(key, validTimes);
                }
            }
        } else {
            // 清理所有过期记录
            for (const [k, accessTimes] of this.ipAccessLog.entries()) {
                const validTimes = accessTimes.filter(time => now - time <= timeWindow);
                if (validTimes.length === 0) {
                    this.ipAccessLog.delete(k);
                } else {
                    this.ipAccessLog.set(k, validTimes);
                }
            }
        }
    }

    // 启动清理定时器
    startCleanupTimer() {
        // 每5分钟清理一次过期记录
        this.cleanupInterval = setInterval(() => {
            this.cleanExpiredRecords();
            if (pluginDebugMode) {
                console.log(`[SecurityManager] 定期清理完成，当前记录数: ${this.ipAccessLog.size}`);
            }
        }, 5 * 60 * 1000);
    }

    // 停止清理定时器
    stopCleanupTimer() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    // 获取访问统计
    getAccessStats() {
        const stats = {
            totalRecords: this.ipAccessLog.size,
            isLocked: this.isLocked,
            lockTimeRemaining: this.getLockdownTimeRemaining(),
            recentIPs: new Set()
        };

        const now = Date.now();
        const timeWindow = SECURITY_CONFIG.ANOMALY_DETECTION.TIME_WINDOW;

        for (const [key, accessTimes] of this.ipAccessLog.entries()) {
            const ip = key.split('_')[0];
            const recentAccesses = accessTimes.filter(time => now - time <= timeWindow);
            if (recentAccesses.length > 0) {
                stats.recentIPs.add(ip);
            }
        }

        stats.recentIPCount = stats.recentIPs.size;
        stats.recentIPs = Array.from(stats.recentIPs);

        return stats;
    }
}

// 创建安全管理器实例
const securityManager = new SecurityManager();

/**
 * 安全路径验证中间件
 * 防止路径遍历攻击
 */
function createPathSecurityMiddleware(serviceType) {
    return (req, res, next) => {
        const requestedPath = req.path;
        
        // 检查路径中是否包含危险字符
        const dangerousPatterns = [
            /\.\./,           // 父目录遍历
            /\/\//,           // 双斜杠
            /\\/,             // 反斜杠
            /%2e%2e/i,        // URL编码的..
            /%2f/i,           // URL编码的/
            /%5c/i,           // URL编码的\
            /\0/,             // 空字节
            /[<>:"|?*]/       // Windows文件名非法字符
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(requestedPath)) {
                console.warn(`[PathSecurity] 🚨 检测到路径遍历攻击尝试: ${requestedPath} from IP: ${req.ip}`);
                return res.status(400).type('text/plain').send('Bad Request: Invalid path format detected.');
            }
        }

        // 验证文件扩展名
        const ext = path.extname(requestedPath).toLowerCase();
        const allowedExtensions = serviceType === 'Image' 
            ? SECURITY_CONFIG.ALLOWED_IMAGE_EXTENSIONS 
            : SECURITY_CONFIG.ALLOWED_FILE_EXTENSIONS;

        if (ext && !allowedExtensions.includes(ext)) {
            console.warn(`[PathSecurity] 🚨 不允许的文件类型访问: ${ext} from IP: ${req.ip}`);
            return res.status(403).type('text/plain').send('Forbidden: File type not allowed.');
        }

        if (pluginDebugMode) {
            console.log(`[PathSecurity] 路径验证通过: ${requestedPath}`);
        }

        next();
    };
}

/**
 * 创建安全监控中间件
 */
function createSecurityMonitoringMiddleware(serviceType) {
    return (req, res, next) => {
        const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
        
        // 检查服务是否被锁定
        if (securityManager.isServiceLocked()) {
            const remainingMinutes = securityManager.getLockdownTimeRemaining();
            console.warn(`[SecurityMonitoring] 🔒 服务已锁定，拒绝访问。剩余时间: ${remainingMinutes} 分钟`);
            return res.status(503).type('text/plain').send(`Service temporarily unavailable. Please try again in ${remainingMinutes} minutes.`);
        }

        // 记录访问
        securityManager.recordAccess(clientIP, serviceType);
        
        // 检查异常访问
        if (securityManager.checkAnomalousAccess(serviceType)) {
            const remainingMinutes = securityManager.getLockdownTimeRemaining();
            return res.status(503).type('text/plain').send(`Service temporarily locked due to suspicious activity. Please try again in ${remainingMinutes} minutes.`);
        }

        if (pluginDebugMode) {
            const stats = securityManager.getAccessStats();
            console.log(`[SecurityMonitoring] IP: ${clientIP}, 服务: ${serviceType}, 近期IP数: ${stats.recentIPCount}`);
        }

        next();
    };
}

/**
 * Creates an authentication middleware.
 * @param {() => string} getKey - A function that returns the correct key for authentication.
 * @param {string} serviceType - A string like 'Image' or 'File' for logging.
 * @returns {function} Express middleware.
 */
function createAuthMiddleware(getKey, serviceType) {
    return (req, res, next) => {
        const correctKey = getKey();
        if (!correctKey) {
            console.error(`[${serviceType}AuthMiddleware] ${serviceType} Key is not configured in plugin. Denying access.`);
            return res.status(500).type('text/plain').send(`Server Configuration Error: ${serviceType} key not set for plugin.`);
        }

        const pathSegmentWithKey = req.params.pathSegmentWithKey;
        if (pluginDebugMode) console.log(`[${serviceType}AuthMiddleware] req.params.pathSegmentWithKey: '${pathSegmentWithKey}'`);

        if (pathSegmentWithKey && pathSegmentWithKey.startsWith('pw=')) {
            const requestKey = pathSegmentWithKey.substring(3);
            
            const match = requestKey === correctKey;
            if (pluginDebugMode) console.log(`[${serviceType}AuthMiddleware] Key comparison result: ${match}`);

            if (match) {
                if (pluginDebugMode) console.log(`[${serviceType}AuthMiddleware] Authentication successful.`);
                next();
            } else {
                console.warn(`[${serviceType}AuthMiddleware] 🚨 认证失败: 无效密钥 from IP: ${req.ip}`);
                return res.status(401).type('text/plain').send(`Unauthorized: Invalid key for ${serviceType.toLowerCase()} access.`);
            }
        } else {
            console.warn(`[${serviceType}AuthMiddleware] 🚨 认证失败: 无效路径格式 from IP: ${req.ip}`);
            return res.status(400).type('text/plain').send(`Bad Request: Invalid ${serviceType.toLowerCase()} access path format.`);
        }
    };
}

/**
 * 创建安全的静态文件服务中间件
 */
function createSecureStaticMiddleware(rootDir, serviceType) {
    // 创建express.static中间件实例
    const staticMiddleware = express.static(rootDir, {
        dotfiles: 'deny',
        index: false,
        redirect: false,
        follow: false // 禁止跟随软链接，防止软链接攻击
    });

    return (req, res, next) => {
        const requestedFile = req.path;
        const fullPath = path.join(rootDir, requestedFile);
        
        // 确保请求的文件在允许的目录内
        const normalizedRoot = path.resolve(rootDir);
        const normalizedPath = path.resolve(fullPath);
        
        if (!normalizedPath.startsWith(normalizedRoot)) {
            console.warn(`[SecureStatic] 🚨 路径遍历攻击被阻止: ${requestedFile} -> ${normalizedPath} from IP: ${req.ip}`);
            return res.status(403).type('text/plain').send('Forbidden: Access denied.');
        }

        if (pluginDebugMode) {
            console.log(`[SecureStatic] 安全检查通过，请求文件: ${requestedFile}`);
        }

        // 先尝试 express.static 精确匹配
        staticMiddleware(req, res, () => {
            // 精确匹配失败 → 尝试图片格式回退（仅限 Image 服务）
            if (serviceType !== 'Image') return next();

            // 关键：req.path 是 URL 编码的，必须解码后才能匹配文件系统路径
            let decodedPath;
            try {
                decodedPath = decodeURIComponent(req.path);
            } catch (e) {
                return next(); // URL 解码失败，跳过回退
            }

            const ext = path.extname(decodedPath).toLowerCase();
            if (!ext) return next(); // 无扩展名，跳过

            const baseName = decodedPath.slice(0, -ext.length);
            const fallbackExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].filter(e => e !== ext);

            for (const tryExt of fallbackExts) {
                const tryPath = path.join(rootDir, baseName + tryExt);
                const normalizedTry = path.resolve(tryPath);
                // 安全检查：确保回退路径仍在允许目录内
                if (!normalizedTry.startsWith(normalizedRoot)) continue;
                if (fs.existsSync(tryPath)) {
                    if (pluginDebugMode) {
                        console.log(`[SecureStatic] 🔄 格式回退: ${decodedPath} -> ${baseName + tryExt}`);
                    }
                    return res.sendFile(normalizedTry);
                }
            }
            next(); // 所有回退格式都找不到 → 404
        });
    };
}

/**
 * 创建单数路径到复数路径的安全重定向中间件。
 * 只做 308 跳转，不直接提供文件；跳转后的复数路由仍会经过认证、路径安全校验和静态文件安全检查。
 */
function createSingularPathRedirectMiddleware(singularSegment, pluralSegment, serviceType) {
    return (req, res) => {
        const originalUrl = req.originalUrl || req.url || '';
        const pathSegmentWithKey = req.params.pathSegmentWithKey;
        const singularPrefix = `/${pathSegmentWithKey}/${singularSegment}`;
        const pluralPrefix = `/${pathSegmentWithKey}/${pluralSegment}`;
        
        if (!originalUrl.startsWith(singularPrefix)) {
            console.warn(`[${serviceType}Redirect] 🚨 单数路径重定向前缀异常: ${originalUrl} from IP: ${req.ip}`);
            return res.status(400).type('text/plain').send('Bad Request: Invalid redirect path format.');
        }

        const targetUrl = pluralPrefix + originalUrl.slice(singularPrefix.length);
        
        if (pluginDebugMode) {
            console.log(`[${serviceType}Redirect] ${originalUrl} -> ${targetUrl}`);
        }

        return res.redirect(308, targetUrl);
    };
}

/**
 * Registers the image and file server routes and middleware with the Express app.
 * @param {object} app - The Express application instance.
 * @param {object} pluginConfig - Configuration for this plugin.
 * @param {string} projectBasePath - The absolute path to the project's root directory.
 */
function registerRoutes(app, pluginConfig, projectBasePath) {
    pluginDebugMode = pluginConfig && pluginConfig.DebugMode === true;

    if (pluginDebugMode) console.log(`[ImageServerPlugin] Registering routes. DebugMode is ON.`);
    else console.log(`[ImageServerPlugin] Registering routes. DebugMode is OFF.`);

    if (!app || typeof app.use !== 'function') {
        console.error('[ImageServerPlugin] Express app instance is required.');
        return;
    }

    // Configure keys
    serverImageKeyForAuth = pluginConfig.Image_Key || null;
    serverFileKeyForAuth = pluginConfig.File_Key || null;

    if (!serverImageKeyForAuth) {
        console.error('[ImageServerPlugin] Image_Key configuration is missing.');
    }
    if (!serverFileKeyForAuth) {
        console.error('[ImageServerPlugin] File_Key configuration is missing.');
    }

    // Create middleware instances
    const imageAuthMiddleware = createAuthMiddleware(() => serverImageKeyForAuth, 'Image');
    const fileAuthMiddleware = createAuthMiddleware(() => serverFileKeyForAuth, 'File');
    
    // Create security middleware instances
    const imageSecurityMonitoring = createSecurityMonitoringMiddleware('Image');
    const fileSecurityMonitoring = createSecurityMonitoringMiddleware('File');
    const imagePathSecurity = createPathSecurityMiddleware('Image');
    const filePathSecurity = createPathSecurityMiddleware('File');

    // Helper for logging
    const maskKey = (key) => {
        if (!key) return "NOT_CONFIGURED";
        if (key.length > 6) return key.substring(0, 3) + "***" + key.slice(-3);
        if (key.length > 1) return key[0] + "***" + key.slice(-1);
        return "*";
    };

    // Register image service with enhanced security
    if (serverImageKeyForAuth) {
        const globalImageDir = path.join(projectBasePath, 'image');
        const secureImageStatic = createSecureStaticMiddleware(globalImageDir, 'Image');
        
        // 兼容 AI 偶尔漏写复数 s：/image/... -> /images/...
        // 注意：这里只重定向，不提供文件；实际访问仍由 /images 路由完成完整安全校验。
        app.use('/:pathSegmentWithKey/image',
            createSingularPathRedirectMiddleware('image', 'images', 'Image')
        );
        
        app.use('/:pathSegmentWithKey/images',
            imageSecurityMonitoring,
            imageAuthMiddleware,
            imagePathSecurity,
            secureImageStatic
        );
        
        console.log(`[ImageServerPlugin] 🔒 安全图片服务已注册. 访问路径: /pw=${maskKey(serverImageKeyForAuth)}/images/... 服务目录: ${globalImageDir}`);
        console.log(`[ImageServerPlugin] 🛡️ 安全功能: 路径遍历防护、IP监控、异常检测、自动锁定`);
    } else {
        console.warn(`[ImageServerPlugin] Image service NOT registered due to missing Image_Key.`);
    }

    // Register file service with enhanced security
    if (serverFileKeyForAuth) {
        const globalFileDir = path.join(projectBasePath, 'file');
        const secureFileStatic = createSecureStaticMiddleware(globalFileDir, 'File');
        
        // 兼容 AI 偶尔漏写复数 s：/file/... -> /files/...
        // 注意：这里只重定向，不提供文件；实际访问仍由 /files 路由完成完整安全校验。
        app.use('/:pathSegmentWithKey/file',
            createSingularPathRedirectMiddleware('file', 'files', 'File')
        );
        
        app.use('/:pathSegmentWithKey/files',
            fileSecurityMonitoring,
            fileAuthMiddleware,
            filePathSecurity,
            secureFileStatic
        );
        
        console.log(`[ImageServerPlugin] 🔒 安全文件服务已注册. 访问路径: /pw=${maskKey(serverFileKeyForAuth)}/files/... 服务目录: ${globalFileDir}`);
        console.log(`[ImageServerPlugin] 🛡️ 安全功能: 路径遍历防护、IP监控、异常检测、自动锁定`);
    } else {
        console.warn(`[ImageServerPlugin] File service NOT registered due to missing File_Key.`);
    }

    // 注册安全状态查询接口（仅在调试模式下）
    if (pluginDebugMode) {
        app.get('/security-status', (req, res) => {
            const stats = securityManager.getAccessStats();
            res.json({
                ...stats,
                config: SECURITY_CONFIG,
                message: '安全状态查询接口（仅调试模式可用）'
            });
        });
        console.log(`[ImageServerPlugin] 🔍 调试模式: 安全状态查询接口已启用 /security-status`);
    }

    // 输出安全配置信息
    console.log(`[ImageServerPlugin] 🔧 安全配置:`);
    console.log(`  - 异常检测时间窗口: ${SECURITY_CONFIG.ANOMALY_DETECTION.TIME_WINDOW / 1000 / 60} 分钟`);
    console.log(`  - 最大不同IP数: ${SECURITY_CONFIG.ANOMALY_DETECTION.MAX_UNIQUE_IPS}`);
    console.log(`  - 锁定持续时间: ${SECURITY_CONFIG.ANOMALY_DETECTION.LOCKDOWN_DURATION / 1000 / 60} 分钟`);
    console.log(`  - 允许的图片格式: ${SECURITY_CONFIG.ALLOWED_IMAGE_EXTENSIONS.join(', ')}`);
    console.log(`  - 允许的文件格式: ${SECURITY_CONFIG.ALLOWED_FILE_EXTENSIONS.join(', ')}`);
}

// 优雅关闭处理
process.on('SIGINT', () => {
    console.log('[ImageServerPlugin] 正在关闭安全管理器...');
    securityManager.stopCleanupTimer();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[ImageServerPlugin] 正在关闭安全管理器...');
    securityManager.stopCleanupTimer();
    process.exit(0);
});

module.exports = {
    registerRoutes,
    // 导出安全管理器供外部查询（可选）
    getSecurityStats: () => securityManager.getAccessStats(),
    // 手动触发锁定（紧急情况下使用）
    emergencyLockdown: () => securityManager.triggerLockdown(),
    // 手动解除锁定（管理员操作）
    releaseLockdown: () => securityManager.releaseLockdown()
};