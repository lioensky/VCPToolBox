/**
 * LinuxShellExecutor - 六层安全防护的 Linux Shell 命令执行器
 *
 * 功能特性：
 * - 多主机 SSH 远程执行
 * - 支持密钥和密码认证
 * - 跳板机（Jump Host）支持
 * - 六层安全防护架构
 * - 四级权限分级（read/safe/write/danger）
 * - 预设诊断命令支持
 * - 输出格式化与截断
 *
 * 安全层级：
 * 1. 黑名单过滤 - 快速拦截已知危险命令
 * 2. 安全分级验证 - read/safe/write/danger 四级分类
 * 3. 管道链验证 - 检查管道命令组合的安全性
 * 4. AST语义分析 - 检测复杂攻击模式
 * 5. 沙箱隔离 - Docker/Firejail/Bubblewrap（仅本地）
 * 6. 资源限制 - rlimit/ulimit（CPU、内存、文件、进程数）
 * 7. 审计日志 - 记录所有操作
 *权限模型（v1.1.0）：
 * - read: 只读命令，自动放行，允许管道
 * - safe: 低风险命令，自动放行
 * - write: 写操作，需要确认
 * - danger: 高危命令，二次确认
 * - authCode: 授权码逃逸层，允许执行未知命令
 *
 * @version 1.2.0
 * @author VCP Team
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const util = require('util');
const { createSanitizedUserCommandEnv } = require('../../modules/sensitiveEnv');

// 加载配置
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

// 加载根目录配置（用于读取 DebugMode）
const rootConfigPath = path.join(__dirname, '..', '..', 'config.env');
require('dotenv').config({ path: rootConfigPath });

// 判断是否启用调试模式
const isDebugMode = () => {
    const debugMode = process.env.DebugMode;
    return debugMode && debugMode.toLowerCase() === 'true';
};

let loggerModule = null;

function isServerLoggerActive() {
    try {
        loggerModule = loggerModule || require('../../modules/logger');
        return Boolean(
            loggerModule.originalConsoleError &&
            console.error !== loggerModule.originalConsoleError
        );
    } catch (_) {
        return false;
    }
}

function logInfo(...args) {
    if (isServerLoggerActive()) {
        console.info(...args);
        return;
    }
    process.stderr.write(`${util.format(...args)}\n`);
}

function logWarn(...args) {
    if (isServerLoggerActive()) {
        console.warn(...args);
        return;
    }
    process.stderr.write(`${util.format(...args)}\n`);
}

function logDebug(...args) {
    if (!isDebugMode()) {
        return;
    }
    logInfo(...args);
}

function logDiagInfo(...args) {
    logDebug(...args);
}

// 加载白名单配置
let whitelist;
let whitelistLoadError = null;
try {
    whitelist = require('./whitelist.json');
    // 诊断日志：记录 whitelist 加载状态
    logDiagInfo(`[LinuxShellExecutor][DIAG] whitelist.json 加载成功`);
    logDiagInfo(`[LinuxShellExecutor][DIAG] forbiddenCharacters: ${JSON.stringify(whitelist.globalRestrictions?.forbiddenCharacters || [])}`);
    logDiagInfo(`[LinuxShellExecutor][DIAG] commands 数量: ${Object.keys(whitelist.commands || {}).length}`);
} catch (e) {
    whitelistLoadError = e.message;
    whitelist = { commands: {}, globalRestrictions: {} };
    // 诊断日志：记录加载失败
    console.error(`[LinuxShellExecutor][DIAG][ERROR] whitelist.json 加载失败: ${e.message}`);
    console.error(`[LinuxShellExecutor][DIAG][ERROR] 使用空白名单，所有验证将被跳过！`);
}

// 加载灰名单配置（需要验证的运维命令）
let graylist;
let graylistLoadError = null;
try {
    graylist = require('./graylist.json');
    logDiagInfo(`[LinuxShellExecutor][DIAG] graylist.json 加载成功`);
    logDiagInfo(`[LinuxShellExecutor][DIAG] graylist commands 数量: ${Object.keys(graylist.commands || {}).length}`);
} catch (e) {
    graylistLoadError = e.message;
    graylist = { commands: {}, globalRestrictions: {} };
    console.error(`[LinuxShellExecutor][DIAG][ERROR] graylist.json 加载失败: ${e.message}`);
}

// 加载安全分级配置（v0.4.0 新增）
let securityLevelsConfig;
let securityLevelsLoadError = null;
try {
    securityLevelsConfig = require('./securityLevels.json');
    logDiagInfo(`[LinuxShellExecutor][DIAG] securityLevels.json 加载成功`);
    logDiagInfo(`[LinuxShellExecutor][DIAG] 安全级别: ${Object.keys(securityLevelsConfig.securityLevels || {}).join(', ')}`);
} catch (e) {
    securityLevelsLoadError = e.message;
    securityLevelsConfig = { securityLevels: {}, pipeRules: {}, redirectRules: {} };
    console.error(`[LinuxShellExecutor][DIAG][ERROR] securityLevels.json 加载失败: ${e.message}`);
}

// 加载预设命令配置（v0.4.0 新增）
let presetsConfig;
let presetsLoadError = null;
try {
    presetsConfig = require('./presets.json');
    logDiagInfo(`[LinuxShellExecutor][DIAG] presets.json 加载成功`);
    logDiagInfo(`[LinuxShellExecutor][DIAG] 预设命令数量: ${Object.keys(presetsConfig.presets || {}).length}`);
} catch (e) {
    presetsLoadError = e.message;
    presetsConfig = { presets: {}, categories: {} };
    console.error(`[LinuxShellExecutor][DIAG][ERROR] presets.json 加载失败: ${e.message}`);
}

const HOSTS_CONFIG_PATH = path.join(__dirname, 'hosts.json');
const DEFAULT_HOSTS_TEMPLATE_MD5 = 'b1d6472eba3a65b9354a096ce21d3f3e';

function createLocalOnlyHostsConfig() {
    return {
        hosts: {
            local: {
                name: '本地执行',
                type: 'local',
                enabled: true,
                securityLevel: 'standard'
            }
        },
        defaultHost: 'local',
        globalSettings: {}
    };
}

function calculateHostsConfigMd5() {
    try {
        return crypto
            .createHash('md5')
            .update(fsSync.readFileSync(HOSTS_CONFIG_PATH))
            .digest('hex');
    } catch (e) {
        return null;
    }
}

function getDefaultHostsTemplateStatus() {
    if (!hostsConfigIsDefaultTemplate) return null;
    return {
        disabled: true,
        md5: hostsConfigMd5,
        reason: 'hosts.json 仍为仓库默认模板，SSH 远程执行功能未启动；请先写入真实主机配置。'
    };
}

// 加载主机配置
let hostsConfig;
let hostsConfigMd5 = calculateHostsConfigMd5();
let hostsConfigIsDefaultTemplate = hostsConfigMd5 === DEFAULT_HOSTS_TEMPLATE_MD5;
try {
    hostsConfig = hostsConfigIsDefaultTemplate
        ? createLocalOnlyHostsConfig()
        : require('./hosts.json');
    if (hostsConfigIsDefaultTemplate) {
        logWarn(`[LinuxShellExecutor] hosts.json MD5=${hostsConfigMd5}，仍为默认模板，SSH 远程执行功能已禁用。`);
    }
} catch (e) {
    hostsConfig = createLocalOnlyHostsConfig();
}

// 确保连接池配置包含默认值
if (hostsConfig) {
    if (!hostsConfig.globalSettings) {
        hostsConfig.globalSettings = {};
    }
    const gs = hostsConfig.globalSettings;
    if (gs.idleTimeout === undefined) gs.idleTimeout = 300000;
    if (gs.idleCheckInterval === undefined) gs.idleCheckInterval = 60000;
    if (gs.healthCheckInterval === undefined) gs.healthCheckInterval = 30000;
    if (gs.warmupHosts === undefined) gs.warmupHosts = [];
}

// SSH 管理器（延迟加载，优先使用共享模块）
let sshManager = null;
let sshLoadError = null;
let sshLastLoadAttemptAt = 0;
const SSH_RETRY_INTERVAL_MS = 3000;

function getSSHManager() {
    if (hostsConfigIsDefaultTemplate) {
        sshLoadError = 'hosts.json 仍为仓库默认模板，SSH 远程执行功能未启动。';
        return null;
    }
    // 负面记忆修复：允许在短冷却后自动重试加载共享模块
    if (sshLoadError) {
        const now = Date.now();
        if (now - sshLastLoadAttemptAt < SSH_RETRY_INTERVAL_MS) {
            return null;
        }
    }
    if (!sshManager) {
        sshLastLoadAttemptAt = Date.now();
        sshLoadError = null;
        // 使用全局共享 SSH 管理模块 (v1.2.3+)
        try {
            // 注意：通过 modules/SSHManager/index.js 入口统一派发
            const sharedModule = require('../../modules/SSHManager');
            const { getSSHManager: getSharedManager } = sharedModule;
            // 传递当前插件目录作为 basePath，以便正确解析相对路径的私钥
            sshManager = getSharedManager(hostsConfig, { basePath: __dirname });
            if (!sshManager) {
                const status = typeof sharedModule.getStatus === 'function' ? sharedModule.getStatus() : null;
                sshLoadError = (status && status.lastError) ? String(status.lastError) : '共享 SSHManager 返回 null（初始化失败）';
                console.error('[LinuxShellExecutor][ERROR] 共享 SSH 模块初始化失败:', sshLoadError);
                return null;
            }
            logInfo('[LinuxShellExecutor] 已成功连接至全局共享 SSHManager 模块');
        } catch (e) {
            sshLoadError = e.message;
            console.error('[LinuxShellExecutor][ERROR] 共享 SSH 模块加载失败:', e.message);
            console.error('[LinuxShellExecutor] 请确保 modules/SSHManager/ 目录完整且已安装 ssh2 依赖');
            return null;
        }
    }
    return sshManager;
}

function getSSHLoadError() {
    return sshLoadError;
}

function parseBooleanValue(value) {
    if (value === true || value === false) return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off', ''].includes(normalized)) return false;
    }
    return false;
}

function resolveAdminAuthCode(context = {}) {
    if (context && typeof context.decryptedAuthCode === 'string' && context.decryptedAuthCode) {
        return context.decryptedAuthCode;
    }
    if (typeof process.env.DECRYPTED_AUTH_CODE === 'string' && process.env.DECRYPTED_AUTH_CODE) {
        return process.env.DECRYPTED_AUTH_CODE;
    }
    return null;
}

// ============================================
// 第一层：黑名单过滤器
// ============================================
class BlacklistFilter {
    constructor() {
        this.forbiddenPatterns = (process.env.FORBIDDEN_PATTERNS || '')
            .split(',')
            .filter(Boolean)
            .map(p => {
                try {
                    return new RegExp(p, 'i');
                } catch (e) {
                    console.error(`无效的正则表达式: ${p}`);
                    return null;
                }
            })
            .filter(Boolean);
        
        this.forbiddenCommands = (process.env.FORBIDDEN_COMMANDS || '')
            .split(',')
            .filter(Boolean)
            .map(c => c.trim().toLowerCase());
    }
    
    check(command) {
        const lowerCmd = command.toLowerCase().trim();
        
        // 精确匹配检查
        for (const forbidden of this.forbiddenCommands) {
            if (lowerCmd === forbidden || lowerCmd.startsWith(forbidden + ' ')) {
                return {
                    passed: false,
                    reason: `命令 "${forbidden}" 被完全禁止`,
                    layer: 'blacklist',
                    severity: 'critical'
                };
            }
        }
        
        // 正则模式检查
        for (const pattern of this.forbiddenPatterns) {
            if (pattern.test(command)) {
                return {
                    passed: false,
                    reason: `命令匹配禁止模式: ${pattern.source}`,
                    layer: 'blacklist',
                    severity: 'critical'
                };
            }
        }
        
        return { passed: true };
    }
}

// ============================================
// 第二层：白名单验证器
// ============================================
class WhitelistValidator {
    constructor(whitelist) {
        this.commands = whitelist.commands || {};
        this.globalRestrictions = whitelist.globalRestrictions || {};
    }
    
    validate(command) {
        // 诊断日志：记录验证开始
        logDiagInfo(`[LinuxShellExecutor][DIAG] WhitelistValidator.validate() 被调用`);
        logDiagInfo(`[LinuxShellExecutor][DIAG] 命令: "${command.substring(0, 100)}${command.length > 100 ? '...' : ''}"`);
        logDiagInfo(`[LinuxShellExecutor][DIAG] globalRestrictions: ${JSON.stringify(this.globalRestrictions)}`);
        
        // 全局长度检查
        const maxLen = this.globalRestrictions.maxCommandLength || 1000;
        if (command.length > maxLen) {
            return {
                passed: false,
                reason: `命令长度超过限制 (${maxLen})`,
                layer: 'whitelist',
                severity: 'medium'
            };
        }
        
        // 检测是否包含管道（但排除禁止字符检查中的管道，因为管道是允许的）
        if (command.includes('|')) {
            return this.validatePipeline(command);
        }
        
        // 禁止字符检查（非管道命令）
        const forbiddenChars = this.globalRestrictions.forbiddenCharacters || [];
        // 诊断日志：记录禁止字符列表
        logDiagInfo(`[LinuxShellExecutor][DIAG] forbiddenChars 数组长度: ${forbiddenChars.length}`);
        logDiagInfo(`[LinuxShellExecutor][DIAG] forbiddenChars 内容: ${JSON.stringify(forbiddenChars)}`);
        
        for (const char of forbiddenChars) {
            if (command.includes(char)) {
                logDiagInfo(`[LinuxShellExecutor][DIAG] 检测到禁止字符: "${char}"`);
                return {
                    passed: false,
                    reason: `命令包含禁止字符: "${char}"`,
                    layer: 'whitelist',
                    severity: 'high'
                };
            }
        }
        logDiagInfo(`[LinuxShellExecutor][DIAG] 禁止字符检查通过`);
        
        // 解析命令
        const parsed = this.parseCommand(command);
        
        // 检查命令是否在白名单中
        const cmdConfig = this.commands[parsed.command];
        if (!cmdConfig) {
            return {
                passed: false,
                reason: `命令 "${parsed.command}" 不在白名单中`,
                layer: 'whitelist',
                severity: 'medium'
            };
        }
        
        // 检查参数
        for (const arg of parsed.args) {
            if (arg.startsWith('-')) {
                const argName = arg.split(/[=\s]/)[0];
                if (!cmdConfig.allowedArgs.some(a => a === argName || arg.startsWith(a))) {
                    return {
                        passed: false,
                        reason: `参数 "${arg}" 不被允许用于 "${parsed.command}"`,
                        layer: 'whitelist',
                        severity: 'medium'
                    };
                }
            }
        }
        
        // 检查路径
        if (!cmdConfig.noPathRequired && parsed.paths.length > 0) {
            for (const p of parsed.paths) {
                const result = this.validatePath(p, cmdConfig.pathRestrictions);
                if (!result.passed) {
                    return result;
                }
            }
        }
        
        return { passed: true, parsedCommand: parsed };
    }
    
    /**
     * 验证管道命令
     * 根据 whitelist.json 中的 globalRestrictions 配置验证管道
     */
    validatePipeline(command) {
        // 分割管道段
        const pipeSegments = command.split('|').map(s => s.trim()).filter(s => s.length > 0);
        
        // 检查管道深度
        const maxDepth = this.globalRestrictions.maxPipelineDepth || 3;
        if (pipeSegments.length > maxDepth) {
            return {
                passed: false,
                reason: `管道深度 (${pipeSegments.length}) 超过限制 (${maxDepth})`,
                layer: 'whitelist',
                severity: 'medium'
            };
        }
        
        const allowedPipeCommands = this.globalRestrictions.allowedPipeCommands || [];
        const forbiddenInPipe = this.globalRestrictions.forbiddenInPipe || [];
        
        // 验证每个管道段
        for (let i = 0; i < pipeSegments.length; i++) {
            const segment = pipeSegments[i];
            const parsed = this.parseCommand(segment);
            
            // 检查是否在禁止管道命令列表中
            if (forbiddenInPipe.includes(parsed.command)) {
                return {
                    passed: false,
                    reason: `命令 "${parsed.command}" 禁止在管道中使用`,
                    layer: 'whitelist',
                    severity: 'high'
                };
            }
            
            if (i === 0) {
                // 第一个命令：使用完整的单命令验证（但跳过禁止字符检查，因为管道符已被处理）
                const cmdConfig = this.commands[parsed.command];
                if (!cmdConfig) {
                    return {
                        passed: false,
                        reason: `命令 "${parsed.command}" 不在白名单中`,
                        layer: 'whitelist',
                        severity: 'medium'
                    };
                }
                
                // 检查参数
                for (const arg of parsed.args) {
                    if (arg.startsWith('-')) {
                        const argName = arg.split(/[=\s]/)[0];
                        if (!cmdConfig.allowedArgs.some(a => a === argName || arg.startsWith(a))) {
                            return {
                                passed: false,
                                reason: `参数 "${arg}" 不被允许用于 "${parsed.command}"`,
                                layer: 'whitelist',
                                severity: 'medium'
                            };
                        }
                    }
                }
                
                // 检查路径
                if (!cmdConfig.noPathRequired && parsed.paths.length > 0) {
                    for (const p of parsed.paths) {
                        const result = this.validatePath(p, cmdConfig.pathRestrictions);
                        if (!result.passed) {
                            return result;
                        }
                    }
                }
            } else {
                // 后续命令：必须在 allowedPipeCommands 中
                if (!allowedPipeCommands.includes(parsed.command)) {
                    return {
                        passed: false,
                        reason: `命令 "${parsed.command}" 不允许在管道中使用（允许的命令: ${allowedPipeCommands.join(', ')}）`,
                        layer: 'whitelist',
                        severity: 'medium'
                    };
                }
                
                // 后续命令也需要在白名单中有配置
                const cmdConfig = this.commands[parsed.command];
                if (cmdConfig) {
                    // 检查参数
                    for (const arg of parsed.args) {
                        if (arg.startsWith('-')) {
                            const argName = arg.split(/[=\s]/)[0];
                            if (!cmdConfig.allowedArgs.some(a => a === argName || arg.startsWith(a))) {
                                return {
                                    passed: false,
                                    reason: `管道中参数 "${arg}" 不被允许用于 "${parsed.command}"`,
                                    layer: 'whitelist',
                                    severity: 'medium'
                                };
                            }
                        }
                    }
                }
            }
        }
        
        return { passed: true, isPipeline: true, segments: pipeSegments.length };
    }
    
    parseCommand(command) {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0];
        const args = [];
        const paths = [];
        
        for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            if (part.startsWith('-')) {
                args.push(part);
            } else if (!part.startsWith('-') && part.length > 0) {
                paths.push(part);
            }
        }
        
        return { command: cmd, args, paths };
    }
    
    validatePath(inputPath, restrictions) {
        if (!restrictions) {
            return { passed: true };
        }
        
        const normalizedPath = path.normalize(inputPath);
        
        if (normalizedPath.includes('..')) {
            return {
                passed: false,
                reason: `路径包含目录遍历: "${inputPath}"`,
                layer: 'whitelist',
                severity: 'high'
            };
        }
        
        if (!inputPath.startsWith('/')) {
            return { passed: true };
        }
        
        if (restrictions.denied) {
            for (const denied of restrictions.denied) {
                if (inputPath.startsWith(denied) || inputPath === denied) {
                    return {
                        passed: false,
                        reason: `路径 "${inputPath}" 在拒绝列表中`,
                        layer: 'whitelist',
                        severity: 'high'
                    };
                }
            }
        }
        
        if (restrictions.allowed) {
            const isAllowed = restrictions.allowed.some(allowed => 
                inputPath.startsWith(allowed) || inputPath === allowed
            );
            if (!isAllowed) {
                return {
                    passed: false,
                    reason: `路径 "${inputPath}" 不在允许列表中`,
                    layer: 'whitelist',
                    severity: 'medium'
                };
            }
        }
        
        return { passed: true };
    }
}

// ============================================
// 第 2.5 层：灰名单验证器（需要管理员验证的运维命令）
// ============================================
class GraylistValidator {
    constructor(graylist) {
        this.commands = graylist.commands || {};
        this.globalRestrictions = graylist.globalRestrictions || {};
        this.riskLevels = graylist.riskLevels || {};
    }
    
    /**
     * 检查命令是否在灰名单中
     * @returns {object} { inGraylist: boolean, cmdConfig?: object, riskLevel?: string }
     */
    check(command) {
        logDiagInfo(`[LinuxShellExecutor][DIAG] GraylistValidator.check() 被调用`);
        logDiagInfo(`[LinuxShellExecutor][DIAG] 命令: "${command.substring(0, 100)}${command.length > 100 ? '...' : ''}"`);
        
        // 解析命令获取基础命令名
        const parsed = this.parseCommand(command);
        const cmdConfig = this.commands[parsed.command];
        
        if (!cmdConfig) {
            logDiagInfo(`[LinuxShellExecutor][DIAG] 命令 "${parsed.command}" 不在灰名单中`);
            return { inGraylist: false };
        }
        
        logDiagInfo(`[LinuxShellExecutor][DIAG] 命令 "${parsed.command}" 在灰名单中，风险级别: ${cmdConfig.riskLevel}`);
        return {
            inGraylist: true,
            cmdConfig,
            riskLevel: cmdConfig.riskLevel || 'medium',
            parsedCommand: parsed
        };
    }
    
    /**
     * 验证灰名单命令的参数和路径
     */
    validate(command) {
        logDiagInfo(`[LinuxShellExecutor][DIAG] GraylistValidator.validate() 被调用`);
        
        // 全局长度检查
        const maxLen = this.globalRestrictions.maxCommandLength || 2000;
        if (command.length > maxLen) {
            return {
                passed: false,
                reason: `命令长度超过限制 (${maxLen})`,
                layer: 'graylist',
                severity: 'medium'
            };
        }
        
        // 检测是否包含管道
        if (command.includes('|')) {
            return this.validatePipeline(command);
        }
        
        // 禁止字符检查
        const forbiddenChars = this.globalRestrictions.forbiddenCharacters || [];
        for (const char of forbiddenChars) {
            if (command.includes(char)) {
                return {
                    passed: false,
                    reason: `命令包含禁止字符: "${char}"`,
                    layer: 'graylist',
                    severity: 'high'
                };
            }
        }
        
        // 解析命令
        const parsed = this.parseCommand(command);
        
        // 检查命令是否在灰名单中
        const cmdConfig = this.commands[parsed.command];
        if (!cmdConfig) {
            return {
                passed: false,
                reason: `命令 "${parsed.command}" 不在灰名单中`,
                layer: 'graylist',
                severity: 'medium'
            };
        }
        
        // 检查参数
        for (const arg of parsed.args) {
            if (arg.startsWith('-')) {
                const argName = arg.split(/[=\s]/)[0];
                if (!cmdConfig.allowedArgs.some(a => a === argName || arg.startsWith(a))) {
                    return {
                        passed: false,
                        reason: `参数 "${arg}" 不被允许用于 "${parsed.command}"`,
                        layer: 'graylist',
                        severity: 'medium'
                    };
                }
            }
        }
        
        // 检查路径
        if (!cmdConfig.noPathRequired && parsed.paths.length > 0) {
            for (const p of parsed.paths) {
                const result = this.validatePath(p, cmdConfig.pathRestrictions);
                if (!result.passed) {
                    return result;
                }
            }
        }
        
        return {
            passed: true,
            parsedCommand: parsed,
            riskLevel: cmdConfig.riskLevel || 'medium'
        };
    }
    
    /**
     * 验证管道命令
     */
    validatePipeline(command) {
        const pipeSegments = command.split('|').map(s => s.trim()).filter(s => s.length > 0);
        
        // 检查管道深度
        const maxDepth = this.globalRestrictions.maxPipelineDepth || 5;
        if (pipeSegments.length > maxDepth) {
            return {
                passed: false,
                reason: `管道深度 (${pipeSegments.length}) 超过限制 (${maxDepth})`,
                layer: 'graylist',
                severity: 'medium'
            };
        }
        
        const allowedPipeCommands = this.globalRestrictions.allowedPipeCommands || [];
        const forbiddenInPipe = this.globalRestrictions.forbiddenInPipe || [];
        
        // 验证每个管道段
        for (let i = 0; i < pipeSegments.length; i++) {
            const segment = pipeSegments[i];
            const parsed = this.parseCommand(segment);
            
            // 检查是否在禁止管道命令列表中
            if (forbiddenInPipe.includes(parsed.command)) {
                return {
                    passed: false,
                    reason: `命令 "${parsed.command}" 禁止在管道中使用`,
                    layer: 'graylist',
                    severity: 'high'
                };
            }
            
            if (i === 0) {
                // 第一个命令：必须在灰名单中
                const cmdConfig = this.commands[parsed.command];
                if (!cmdConfig) {
                    return {
                        passed: false,
                        reason: `命令 "${parsed.command}" 不在灰名单中`,
                        layer: 'graylist',
                        severity: 'medium'
                    };
                }
                
                // 检查参数
                for (const arg of parsed.args) {
                    if (arg.startsWith('-')) {
                        const argName = arg.split(/[=\s]/)[0];
                        if (!cmdConfig.allowedArgs.some(a => a === argName || arg.startsWith(a))) {
                            return {
                                passed: false,
                                reason: `参数 "${arg}" 不被允许用于 "${parsed.command}"`,
                                layer: 'graylist',
                                severity: 'medium'
                            };
                        }
                    }
                }
            } else {
                // 后续命令：必须在 allowedPipeCommands 中
                if (!allowedPipeCommands.includes(parsed.command)) {
                    return {
                        passed: false,
                        reason: `命令 "${parsed.command}" 不允许在管道中使用`,
                        layer: 'graylist',
                        severity: 'medium'
                    };
                }
            }
        }
        
        return { passed: true, isPipeline: true, segments: pipeSegments.length };
    }
    
    parseCommand(command) {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0];
        const args = [];
        const paths = [];
        
        for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            if (part.startsWith('-')) {
                args.push(part);
            } else if (!part.startsWith('-') && part.length > 0) {
                paths.push(part);
            }
        }
        
        return { command: cmd, args, paths };
    }
    
    validatePath(inputPath, restrictions) {
        if (!restrictions) {
            return { passed: true };
        }
        
        const normalizedPath = path.normalize(inputPath);
        
        if (normalizedPath.includes('..')) {
            return {
                passed: false,
                reason: `路径包含目录遍历: "${inputPath}"`,
                layer: 'graylist',
                severity: 'high'
            };
        }
        
        if (!inputPath.startsWith('/')) {
            return { passed: true };
        }
        
        if (restrictions.denied) {
            for (const denied of restrictions.denied) {
                if (inputPath.startsWith(denied) || inputPath === denied) {
                    return {
                        passed: false,
                        reason: `路径 "${inputPath}" 在拒绝列表中`,
                        layer: 'graylist',
                        severity: 'high'
                    };
                }
            }
        }
        
        if (restrictions.allowed) {
            const isAllowed = restrictions.allowed.some(allowed =>
                inputPath.startsWith(allowed) || inputPath === allowed
            );
            if (!isAllowed) {
                return {
                    passed: false,
                    reason: `路径 "${inputPath}" 不在允许列表中`,
                    layer: 'graylist',
                    severity: 'medium'
                };
            }
        }
        
        return { passed: true };
    }
}

// ============================================
// 第 2.6 层：安全分级验证器（v0.4.0 新增）
// ============================================
class SecurityLevelValidator {
    constructor(config) {
        this.levels = config.securityLevels || {};
        this.pipeRules = config.pipeRules || {};
        this.redirectRules = config.redirectRules || {};
        this.specialOperators = config.specialOperators || {};
        this.commandAliases = config.commandAliases || {};
        this.globalSettings = config.globalSettings || {};}
    
    /**
     * Strip quoted content for safe pattern matching.
     * Replaces characters inside single/double quotes with underscores so that
     * pipe symbols (|), redirects (><), etc. inside quoted strings do not
     * trigger false positives in security checks.
     * Example: grep "Error:|init" f.log  =>  grep "_________" f.log
     */
    _stripQuotedContent(str) {
        let result = '';
        let inSingle = false;
        let inDouble = false;
        let escaped = false;
        for (let i = 0; i < str.length; i++) {
            const c = str[i];
            if (escaped) { result += '_'; escaped = false; continue; }
            if (c === '\\' && (inSingle || inDouble)) { result += '_'; escaped = true; continue; }
            if (c === "'" && !inDouble) { inSingle = !inSingle; result += c; continue; }
            if (c === '"' && !inSingle) { inDouble = !inDouble; result += c; continue; }
            result += (inSingle || inDouble) ? '_' : c;
        }
        return result;
    }

    /**
     * Split a string by delimiter while respecting single/double-quoted sections.
     * Prevents grep "a|b" from being split into two segments at the | inside quotes.
     */
    _splitUnquoted(str, delimiter) {
        const parts = [];
        let current = '';
        let inSingle = false;
        let inDouble = false;
        let escaped = false;
        for (let i = 0; i < str.length; i++) {
            const c = str[i];
            if (escaped) { current += c; escaped = false; continue; }
            if (c === '\\' && (inSingle || inDouble)) { current += c; escaped = true; continue; }
            if (c === "'" && !inDouble) { inSingle = !inSingle; current += c; continue; }
            if (c === '"' && !inSingle) { inDouble = !inDouble; current += c; continue; }
            if (!inSingle && !inDouble && c === delimiter) { parts.push(current); current = ''; continue; }
            current += c;
        }
        parts.push(current);
        return parts;
    }

    /**
     * 获取命令的安全级别
     */
    getCommandLevel(command) {
        const parsed = this.parseCommand(command);
        const baseCmd = parsed.command;
        const resolvedCmd = this.commandAliases[baseCmd] || baseCmd;
        
        for (const levelName of ['danger', 'write', 'safe', 'read']) {
            const levelConfig = this.levels[levelName];
            if (!levelConfig) continue;
            
            for (const cmdPattern of levelConfig.commands || []) {
                if (cmdPattern.includes(' ')) {
                    if (command.trim().startsWith(cmdPattern)) {
                        return { level: levelName, config: levelConfig, matched: true, pattern: cmdPattern };
                    }
                } else if (resolvedCmd === cmdPattern) {
                    return { level: levelName, config: levelConfig, matched: true, pattern: cmdPattern };
                }
            }
        }
        return { level: 'unknown', config: null, matched: false };
    }
    
    /**
     * 验证完整命令（包括管道和重定向）
     */
    validate(command) {
        // ROB-02: 验证特殊操作符
        for (const [opName, opConfig] of Object.entries(this.specialOperators)) {
            if (opConfig.allowed === false) {
                let pattern;
                switch(opName) {
                    case 'semicolon': pattern = /;/; break;
                    case 'backgroundAmp': pattern = /&(?![&>])/; break; // 排除 && 和重定向 &>
                    case 'subshell': pattern = /\$\(|\`/; break;
                    default: continue;
                }
                if (pattern.test(command)) {
                    return {
                        passed: false,
                        reason: `检测到禁止的特殊操作符: ${opName} (${opConfig.reason})`,
                        layer: 'securityLevel', severity: 'critical'
                    };
                }
            }
        }

        // Quote-aware pipe/redirect detection: ignore | and > inside quoted strings
        // e.g. grep "Error:|Warning:" file.log should NOT be treated as a pipeline
        const strippedForOp = this._stripQuotedContent(command);
        const hasRedirect = /[><]/.test(strippedForOp);
        const hasPipe = strippedForOp.includes('|');
        let segments = hasPipe ? this._splitUnquoted(command, '|').map(s => s.trim()).filter(s => s.length > 0) : [command.trim()];
        
        let highestRiskLevel = 'read';
        const levelPriority = { 'read': 0, 'safe': 1, 'write': 2, 'danger': 3, 'unknown': 4 };
        const segmentResults = [];
        
        for (let i = 0; i < segments.length; i++) {
            let segment = segments[i];
            const redirectMatch = segment.match(/(.+?)(\s*[><]+\s*.+)$/);
            let redirectPart = null;
            if (redirectMatch) {
                segment = redirectMatch[1].trim();
                redirectPart = redirectMatch[2].trim();
            }
            
            const levelResult = this.getCommandLevel(segment);
            segmentResults.push({ segment, ...levelResult, redirect: redirectPart, index: i });
            
            if (levelPriority[levelResult.level] > levelPriority[highestRiskLevel]) {
                highestRiskLevel = levelResult.level;
            }
        }
        
        const unknownCommands = segmentResults.filter(r => r.level === 'unknown');
        if (unknownCommands.length > 0) {
            return {
                passed: false,
                reason: `命令 "${unknownCommands[0].segment.split(/\s+/)[0]}" 不在任何安全级别中`,
                layer: 'securityLevel', severity: 'medium', highestRiskLevel: 'unknown', segments: segmentResults,
                isUnknown: true // 标记为未知命令，允许后续通过授权码逃逸
            };
        }
        
        if (hasPipe && segmentResults.length > 1) {
            const pipeValidation = this.validatePipeChain(segmentResults);
            if (!pipeValidation.passed) return pipeValidation;
        }
        
        if (hasRedirect) {
            const redirectValidation = this.validateRedirect(command, segmentResults);
            if (!redirectValidation.passed) return redirectValidation;
        }
        
        const levelConfig = this.levels[highestRiskLevel];
        return {
            passed: true, highestRiskLevel, requireConfirm: levelConfig?.requireConfirm || false,
            segments: segmentResults, hasPipe, hasRedirect, layer: 'securityLevel'
        };
    }
    
    validatePipeChain(segmentResults) {
        const allowedChains = this.pipeRules.allowedPipeChains || [];
        const maxDepth = this.pipeRules.maxPipelineDepth || 5;
        
        if (segmentResults.length > maxDepth) {
            return { passed: false, reason: `管道深度 (${segmentResults.length}) 超过限制 (${maxDepth})`, layer: 'securityLevel', severity: 'medium' };
        }
        
        for (let i = 0; i < segmentResults.length - 1; i++) {
            const chainPattern = `${segmentResults[i].level} -> ${segmentResults[i + 1].level}`;
            if (!allowedChains.includes(chainPattern)) {
                return {
                    passed: false,
                    reason: `不允许的管道链: ${chainPattern}`,
                    layer: 'securityLevel', severity: 'high',
                    suggestion: `允许的管道链: ${allowedChains.join(', ')}`
                };
            }
        }
        return { passed: true };
    }
    
    validateRedirect(command, segmentResults) {
        const redirectMatch = command.match(/[><]+\s*(.+)$/);
        if (!redirectMatch) return { passed: true };
        
        const targetPath = redirectMatch[1].trim();
        const lastSegment = segmentResults[segmentResults.length - 1];
        // ROB-01: 修正字段名对齐 securityLevels.json
        const allowedLevels = this.redirectRules.allowedRedirectLevels || ['write'];
        const forbiddenPaths = this.redirectRules.forbiddenPaths || [];
        
        if (!allowedLevels.includes(lastSegment.level)) {
            return { passed: false, reason: `安全级别 "${lastSegment.level}" 的命令不允许使用重定向`, layer: 'securityLevel', severity: 'high' };
        }
        
        for (const forbidden of forbiddenPaths) {
            if (targetPath.startsWith(forbidden)) {
                return { passed: false, reason: `重定向目标路径 "${targetPath}" 被禁止`, layer: 'securityLevel', severity: 'critical' };
            }
        }
        return { passed: true };
    }
    
    generateConfirmPrompt(validationResult, command) {
        const { highestRiskLevel, segments, requireConfirm } = validationResult;
        if (!requireConfirm) return null;
        
        const levelConfig = this.levels[highestRiskLevel];
        const isDoubleConfirm = requireConfirm === 'double';
        
        let prompt = `⚠️ ${isDoubleConfirm ? '【高危操作】' : '【需要确认】'}\n`;
        prompt += `命令: ${command}\n风险级别: ${highestRiskLevel.toUpperCase()} - ${levelConfig?.description || ''}\n`;
        
        if (segments.length > 1) {
            prompt += `管道命令分析:\n`;
            segments.forEach((seg, i) => { prompt += `  ${i + 1}. [${seg.level}] ${seg.segment.substring(0, 50)}\n`; });
        }
        
        prompt += isDoubleConfirm ? `\n此操作需要二次确认。` : `\n请确认是否执行此操作。`;
        return { prompt, requireConfirm, highestRiskLevel, isDoubleConfirm };
    }
    
    parseCommand(command) {
        const parts = command.trim().split(/\s+/);
        return { command: parts[0], args: parts.slice(1).filter(p => p.startsWith('-')), paths: parts.slice(1).filter(p => !p.startsWith('-')) };
    }
}

// ============================================
// 预设命令执行器（v0.4.0 新增）
// ============================================
class PresetExecutor {
    constructor(config) {
        this.presets = config.presets || {};
        this.categories = config.categories || {};
        this.globalSettings = config.globalSettings || {};
    }
    
    isPresetCommand(command) { return command.startsWith('preset:'); }

    /**
     * Shell 参数转义，防止参数注入
     * 将参数包裹在单引号中，并处理参数内部已有的单引号
     */
    shellEscape(arg) {
        if (arg === null || arg === undefined) return "''";
        const s = String(arg);
        if (s.length === 0) return "''";
        // 只有包含特殊字符时才转义，或者为了安全起见全部转义
        // 这里采用严格模式：单引号包裹，并将其内部的 ' 替换为 '\''
        return "'" + s.replace(/'/g, "'\\''") + "'";
    }
    
    parsePresetCommand(command) {
        const match = command.match(/^preset:(\w+)(?:\?(.+))?$/);
        if (!match) return { valid: false, error: '无效的预设命令格式' };
        
        const presetName = match[1];
        const preset = this.presets[presetName];
        if (!preset) return { valid: false, error: `预设 "${presetName}" 不存在`, availablePresets: Object.keys(this.presets) };
        
        const params = {};
        if (match[2]) {
            match[2].split('&').forEach(pair => {
                const [key, value] = pair.split('=');
                if (key && value) params[decodeURIComponent(key)] = decodeURIComponent(value);
            });
        }
        
        // 修复：处理 params 为对象的情况
        const presetParams = preset.params || {};
        if (typeof presetParams === 'object' && !Array.isArray(presetParams)) {
            // params 是对象格式（新格式）
            for (const [paramName, paramConfig] of Object.entries(presetParams)) {
                if (paramConfig.required && !params[paramName]) {
                    return { valid: false, error: `预设 "${presetName}" 缺少必需参数: ${paramName}` };
                }
            }
        } else if (Array.isArray(presetParams)) {
            // params 是数组格式（旧格式，向后兼容）
            const requiredParams = presetParams.filter(p => !p.endsWith('?'));
            for (const required of requiredParams) {
                if (!params[required]) return { valid: false, error: `预设 "${presetName}" 缺少必需参数: ${required}` };
            }
        }
        
        return { valid: true, presetName, preset, params };
    }
    
    expandPreset(presetName, params = {}) {
        const paramStr = Object.keys(params).length > 0 ? '?' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&') : '';
        const parsed = this.parsePresetCommand(`preset:${presetName}${paramStr}`);
        if (!parsed.valid) return { success: false, error: parsed.error };
        
        const { preset } = parsed;
        const commands = preset.commands.map(cmdTemplate => {
            let cmd = cmdTemplate;
            for (const [key, value] of Object.entries(params)) {
                const escapedValue = this.shellEscape(value);
                // 替换标准占位符 ${key}
                cmd = cmd.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), escapedValue);
                // 替换带默认值的占位符 ${key:-default}
                cmd = cmd.replace(new RegExp(`\\$\\{${key}:-[^}]*\\}`, 'g'), escapedValue);
            }
            // 处理未提供的带默认值的参数
            cmd = cmd.replace(/\$\{(\w+):-([^}]*)\}/g, (m, p, d) => {
                return params[p] !== undefined ? this.shellEscape(params[p]) : this.shellEscape(d);
            });
            // 清理未提供的可选参数
            cmd = cmd.replace(/\$\{(\w+)\??\}/g, "''");
            return cmd.trim();
        });
        
        return { success: true, presetName, description: preset.description, commands, outputFormat: preset.outputFormat || 'merged', timeout: preset.timeout || 30000 };
    }
    
    listPresets() {
        const result = {};
        for (const [name, preset] of Object.entries(this.presets)) {
            result[name] = { description: preset.description, category: preset.category, params: preset.params || [], commandCount: preset.commands.length };
        }
        return result;
    }
}

// ============================================
// 输出格式化器（v0.4.0 新增）
// ============================================
class OutputFormatter {
    constructor(options = {}) {
        this.maxOutputLines = options.maxOutputLines || 100;
        this.maxOutputSize = options.maxOutputSize || 1048576;
        this.tempDir = options.tempDir || path.join(__dirname, 'temp');
        this.tableCommands = ['ps', 'df', 'docker', 'ls', 'netstat', 'ss', 'lsof', 'top', 'free'];
    }
    
    async format(output, options = {}) {
        const outputFormat = options.outputFormat || 'formatted';
        const command = options.command || '';
        if (output === undefined || output === null) {
            return { output: '', truncated: false, originalLines: 0, originalSize: 0, format: 'raw' };
        }

        let result = { output, truncated: false, originalLines: output.split('\n').length, originalSize: output.length };
        
        const lines = output.split('\n');
        if (lines.length > this.maxOutputLines || output.length > this.maxOutputSize) {
            result = await this.truncateOutput(output, options);
        }
        
        switch (outputFormat) {
            case 'json':
                result.output = this.toJSON(result.output, command);
                result.format = 'json';
                break;
            case 'formatted':
                if (this.isTableCommand(command)) {
                    result.output = this.beautifyTable(result.output);result.format = 'table';
                } else {
                    result.format = 'text';
                }
                break;
            default:
                result.format = 'raw';
        }
        return result;
    }
    
    async truncateOutput(output, options = {}) {
        const lines = output.split('\n');
        const truncatedOutput = lines.slice(0, this.maxOutputLines).join('\n');
        
        let fullOutputPath = null;
        try {
            await fs.mkdir(this.tempDir, { recursive: true });
            const filename = `output_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.txt`;
            fullOutputPath = path.join(this.tempDir, filename);
            await fs.writeFile(fullOutputPath, output);
            setTimeout(async () => { try { await fs.unlink(fullOutputPath); } catch (e) {} }, 3600000);
        } catch (e) {
            console.error(`[OutputFormatter] 保存完整输出失败: ${e.message}`);
        }
        
        return {
            output: truncatedOutput, truncated: true, truncatedAt: this.maxOutputLines,
            originalLines: lines.length, originalSize: output.length, fullOutputPath,
            truncationMessage: `\n... 输出已截断（显示 ${this.maxOutputLines}/${lines.length} 行）`
        };
    }
    
    isTableCommand(command) { return this.tableCommands.includes(command.trim().split(/\s+/)[0]); }
    
    beautifyTable(output) {
        const lines = output.split('\n').filter(line => line.trim());
        if (lines.length < 2 || !lines[0].includes('  ')) return output;
        return this.alignColumns(lines);
    }
    
    alignColumns(lines) {
        const rows = lines.map(line => line.split(/\s{2,}/).map(cell => cell.trim()));
        const colWidths = [];
        for (const row of rows) {
            for (let i = 0; i < row.length; i++) {
                colWidths[i] = Math.max(colWidths[i] || 0, row[i].length);
            }
        }
        const formatted = rows.map(row => row.map((cell, i) => cell.padEnd(colWidths[i] || 0)).join('  '));
        if (formatted.length > 1) formatted.splice(1, 0, colWidths.map(w => '-'.repeat(w)).join('  '));
        return formatted.join('\n');
    }
    
    toJSON(output, command) {
        const baseCmd = command.trim().split(/\s+/)[0];
        const lines = output.split('\n').filter(l => l.trim());
        
        if (baseCmd === 'df' && lines.length > 1) {
            const filesystems = lines.slice(1).map(line => {
                const parts = line.split(/\s+/);
                return parts.length >= 6 ? { filesystem: parts[0], size: parts[1], used: parts[2], available: parts[3], usePercent: parts[4], mountPoint: parts[5] } : null;
            }).filter(Boolean);
            return JSON.stringify({ filesystems, count: filesystems.length }, null, 2);
        }
        
        return JSON.stringify({ lines, lineCount: lines.length }, null, 2);
    }
}

// ============================================
// 第三层：AST 语义分析器
// ============================================
class ASTAnalyzer {
    constructor() {
        this.riskPatterns = [
            {
                name: 'command_injection',
                pattern: /\$\(.*\)|`.*`|\$\{.*\}/,
                severity: 'critical',
                description: '检测到命令注入尝试'
            },
            {
                name: 'path_traversal',
                pattern: /\.\.\/|\.\.\\|\.\.\%2f|\.\.\%5c/i,
                severity: 'high',
                description: '检测到路径遍历尝试'
            },
            {
                name: 'encoded_payload',
                pattern: /base64\s+-d|base64\s+--decode|\%[0-9a-f]{2}/i,
                severity: 'high',
                description: '检测到编码载荷'
            },
            {
                name: 'network_exfiltration',
                pattern: /curl.*\|.*sh|wget.*\|.*sh|nc\s+-e|bash\s+-i.*\/dev\/tcp/i,
                severity: 'critical',
                description: '检测到网络数据外泄尝试'
            },
            {
                name: 'privilege_escalation',
                pattern: /\bsudo\b|\bsu\s+-|\bpkexec\b|\bdoas\b/,
                severity: 'critical',
                description: '检测到提权尝试'
            },
            {
                name: 'file_descriptor_manipulation',
                pattern: /\/dev\/tcp|\/dev\/udp|\/proc\/self/,
                severity: 'high',
                description: '检测到文件描述符操作'
            },
            {
                name: 'environment_manipulation',
                pattern: /export\s+PATH|export\s+LD_PRELOAD|export\s+LD_LIBRARY_PATH/,
                severity: 'high',
                description: '检测到环境变量操作'
            },
            {
                name: 'shell_escape',
                pattern: /\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\\[0-7]{3}/i,
                severity: 'medium',
                description: '检测到 Shell 转义序列'
            }
        ];
    }
    
    analyze(command) {
        const risks = [];
        
        for (const pattern of this.riskPatterns) {
            if (pattern.pattern.test(command)) {
                risks.push({
                    type: pattern.name,
                    severity: pattern.severity,
                    description: pattern.description,
                    layer: 'ast'
                });
            }
        }
        
        const structuralRisks = this.analyzeStructure(command);
        risks.push(...structuralRisks);
        
        return {
            passed: risks.filter(r => r.severity === 'critical').length === 0,
            risks,
            layer: 'ast'
        };
    }
    
    analyzeStructure(command) {
        const risks = [];
        
        const nestingDepth = (command.match(/\(/g) || []).length;
        if (nestingDepth > 3) {
            risks.push({
                type: 'deep_nesting',
                severity: 'medium',
                description: `命令嵌套深度过高: ${nestingDepth}`,
                layer: 'ast'
            });
        }
        
        const pipeCount = (command.match(/\|/g) || []).length;
        if (pipeCount > 5) {
            risks.push({
                type: 'excessive_pipes',
                severity: 'medium',
                description: `管道数量过多: ${pipeCount}`,
                layer: 'ast'
            });
        }
        
        return risks;
    }
}

// ============================================
// 第四层：沙箱管理器（仅本地执行）
// ============================================
class SandboxManager {
    constructor() {
        this.backend = process.env.SANDBOX_BACKEND || 'none';
        this.rlimitManager = new RlimitManager();
    }
    
    async execute(command, options = {}) {
        const timeout = options.timeout || parseInt(process.env.TIMEOUT_MS) || 30000;
        
        switch (this.backend) {
            case 'docker':
                return this.executeInDocker(command, { ...options, timeout });
            case 'firejail':
                return this.executeInFirejail(command, { ...options, timeout });
            case 'bubblewrap':
                return this.executeInBubblewrap(command, { ...options, timeout });
            case 'none':
            default:
                return this.executeDirectly(command, { ...options, timeout });
        }
    }
    
    async executeDirectly(command, options) {
        // 使用 ulimit 前缀包装命令以应用资源限制
        const ulimitPrefix = this.rlimitManager.getUlimitPrefix();
        const wrappedCommand = ulimitPrefix + command;
        return this.spawnWithTimeout('/bin/bash', ['-c', wrappedCommand], options.timeout, options.signal);
    }
    
    async executeInDocker(command, options) {
        const image = process.env.DOCKER_IMAGE || 'alpine:latest';
        const args = [
            'run', '--rm', '--network=none',
            '--memory=' + (options.memory || '256m'),
            '--cpus=' + (options.cpus || '0.5'),
            '--read-only', '--security-opt=no-new-privileges',
            '--cap-drop=ALL', '--user=65534:65534'
        ];
        
        // 添加 rlimit 资源限制参数
        const rlimitArgs = this.rlimitManager.getDockerArgs();
        args.push(...rlimitArgs);
        
        args.push(image, '/bin/sh', '-c', command);
        return this.spawnWithTimeout('docker', args, options.timeout, options.signal);
    }
    
    async executeInFirejail(command, options) {
        const args = [
            '--quiet', '--private', '--private-tmp', '--net=none',
            '--no3d', '--nodvd', '--nosound', '--notv', '--nou2f', '--novideo',
            '--noroot', '--caps.drop=all', '--seccomp'
        ];
        
        // 添加 rlimit 资源限制参数（使用 RlimitManager 生成）
        const rlimitArgs = this.rlimitManager.getFirejailArgs();
        args.push(...rlimitArgs);
        
        args.push(
            '--timeout=' + Math.ceil(options.timeout / 1000),
            '/bin/bash', '-c', command
        );
        return this.spawnWithTimeout('firejail', args, options.timeout, options.signal);
    }
    
    async executeInBubblewrap(command, options) {
        // Bubblewrap 不直接支持 rlimit，使用 ulimit 前缀
        const ulimitPrefix = this.rlimitManager.getUlimitPrefix();
        const wrappedCommand = ulimitPrefix + command;
        
        const args = [
            '--ro-bind', '/usr', '/usr',
            '--ro-bind', '/bin', '/bin',
            '--ro-bind', '/lib', '/lib',
            '--symlink', 'usr/lib', '/lib',
            '--proc', '/proc',
            '--dev', '/dev',
            '--tmpfs', '/tmp',
            '--tmpfs', '/run',
            '--unshare-all',
            '--die-with-parent',
            '--new-session',
            '/bin/sh', '-c', wrappedCommand
        ];
        
        try {
            await fs.access('/lib64');
            args.splice(6, 0, '--ro-bind', '/lib64', '/lib64');
        } catch (e) {}
        
        return this.spawnWithTimeout('bwrap', args, options.timeout, options.signal);
    }
    
    spawnWithTimeout(cmd, args, timeout, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                return reject(signal.reason instanceof Error ? signal.reason : new Error('命令执行已取消'));
            }

            let stdout = '';
            let stderr = '';
            let settled = false;
            
            const child = spawn(cmd, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: createSanitizedUserCommandEnv(),
                detached: process.platform !== 'win32'
            });

            const cleanup = () => {
                clearTimeout(timeoutId);
                if (signal && abortHandler) {
                    signal.removeEventListener('abort', abortHandler);
                }
            };
            const rejectOnce = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            const resolveOnce = (result) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(result);
            };
            const killChildTree = () => {
                if (process.platform !== 'win32' && child.pid) {
                    try {
                        process.kill(-child.pid, 'SIGKILL');
                        return;
                    } catch (_) {}
                }
                try {
                    child.kill('SIGKILL');
                } catch (_) {}
            };
            const abortHandler = () => {
                killChildTree();
                rejectOnce(signal.reason instanceof Error ? signal.reason : new Error('命令执行已取消'));
            };

            const timeoutId = setTimeout(() => {
                killChildTree();
                rejectOnce(new Error(`命令执行超时 (${timeout}ms)`));
            }, timeout);
            if (signal) {
                signal.addEventListener('abort', abortHandler, { once: true });
            }
            
            child.stdout.on('data', data => { stdout += data.toString(); });
            child.stderr.on('data', data => { stderr += data.toString(); });
            
            child.on('close', code => {
                if (code === 0) {
                    resolveOnce({ stdout, stderr, code });
                } else {
                    rejectOnce(new Error(`命令执行失败 (code: ${code}): ${stderr || stdout}`));
                }
            });
            
            child.on('error', err => {
                rejectOnce(new Error(`启动命令失败: ${err.message}`));
            });
        });
    }
}

// ============================================
// 第五层：资源限制管理器（rlimit）
// ============================================
class RlimitManager {
    constructor() {
        // 从环境变量读取限制配置
        this.limits = {
            cpu: parseInt(process.env.RLIMIT_CPU) || 30,           // CPU 时间（秒）
            fsize: parseInt(process.env.RLIMIT_FSIZE) || 10485760, // 文件大小（字节，10MB）
            nproc: parseInt(process.env.RLIMIT_NPROC) || 10,       // 最大进程数
            nofile: parseInt(process.env.RLIMIT_NOFILE) || 0,      // 最大文件描述符（0=继承系统默认，通常为1024）
            as: parseInt(process.env.RLIMIT_AS) || 0               // 虚拟内存（0=不限制；512MB 默认值会导致 Node.js V8 OOM）
        };
        
        this.enabled = process.env.ENABLE_RLIMIT !== 'false';
    }
    
    /**
     * 生成 ulimit 命令前缀
     * 用于在执行命令前设置资源限制
     */
    getUlimitPrefix() {
        if (!this.enabled) {
            return '';
        }
        
        // ulimit 参数说明：
        // -t: CPU 时间（秒）
        // -f: 文件大小（块，1块=512字节，所以需要除以512）
        // -n: 文件描述符数
        // -v: 虚拟内存（KB）
        // 注意：不设置 -u (nproc)。ulimit -u 限制的是当前用户的全局进程数，
        // 当 VCP 系统已运行大量进程时（通常 100+），设为 10 会导致所有后续
        // fork() 立即失败，报 "Resource temporarily unavailable"。
        const parts = [
            `-t ${this.limits.cpu}`,
            `-f ${Math.floor(this.limits.fsize / 512)}`,
            `-n ${this.limits.nofile}`,
            `-v ${Math.floor(this.limits.as / 1024)}`
        ];
        // nofile=0 → 继承父进程限制（系统默认通常为1024）
        if (this.limits.nofile > 0) {
            parts.push(`-n ${this.limits.nofile}`);
        }
        // as=0 → 不限制虚拟内存。Node.js V8 启动需要约 4GB 虚拟地址空间，
        // 512MB 默认值会触发 "Fatal process out of memory: SegmentedTable::InitializeTable"
        if (this.limits.as > 0) {
            parts.push(`-v ${Math.floor(this.limits.as / 1024)}`);
        }
        
        return `ulimit ${parts.join(' ')} 2>/dev/null; `;
    }
    
    /**
     * 获取当前限制配置
     */
    getLimits() {
        return { ...this.limits, enabled: this.enabled };
    }
    
    /**
     * 生成 Firejail 的 rlimit 参数
     */
    getFirejailArgs() {
        if (!this.enabled) {
            return [];
        }
        
        return [
            `--rlimit-cpu=${this.limits.cpu}`,
            `--rlimit-fsize=${this.limits.fsize}`,
            `--rlimit-nproc=${this.limits.nproc}`,
            `--rlimit-nofile=${this.limits.nofile}`,
            `--rlimit-as=${this.limits.as}`
        ];
    }
    
    /**
     * 生成 Docker 的资源限制参数
     */
    getDockerArgs() {
        if (!this.enabled) {
            return [];
        }
        
        return [
            `--ulimit`, `cpu=${this.limits.cpu}:${this.limits.cpu}`,
            `--ulimit`, `fsize=${this.limits.fsize}:${this.limits.fsize}`,
            `--ulimit`, `nproc=${this.limits.nproc}:${this.limits.nproc}`,
            `--ulimit`, `nofile=${this.limits.nofile}:${this.limits.nofile}`
            // Docker 不直接支持 AS 限制，使用 --memory 替代
        ];
    }
}

// ============================================
// 第六层：审计日志记录器
// ============================================
class AuditLogger {
    constructor() {
        this.logDir = process.env.AUDIT_LOG_DIR || path.join(__dirname, 'logs', 'audit');
        this.alertWebhook = process.env.ALERT_WEBHOOK;
        this.alertThreshold = parseInt(process.env.ALERT_THRESHOLD) || 5;
        this.failureWindow = new Map();
    }
    
    async init() {
        try {
            await fs.mkdir(this.logDir, { recursive: true });
        } catch (e) {
            console.error(`创建审计日志目录失败: ${e.message}`);
        }
    }
    
    async log(entry) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            id: crypto.randomUUID(),
            timestamp,
            ...entry,
            checksum: this.calculateChecksum(entry)
        };
        
        try {
            const logFile = path.join(this.logDir, `${timestamp.split('T')[0]}.jsonl`);
            await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n');
        } catch (e) {
            console.error(`写入审计日志失败: ${e.message}`);
        }
        
        if (entry.status === 'blocked' || entry.status === 'failed') {
            await this.checkAndAlert(entry);
        }
        
        return logEntry.id;
    }
    
    calculateChecksum(entry) {
        const content = JSON.stringify(entry);
        return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    }
    
    async checkAndAlert(entry) {
        const now = Date.now();
        const windowStart = now - 5 * 60 * 1000;
        
        for (const [key, time] of this.failureWindow) {
            if (time < windowStart) {
                this.failureWindow.delete(key);
            }
        }
        
        this.failureWindow.set(entry.id || now, now);
        
        if (this.failureWindow.size >= this.alertThreshold && this.alertWebhook) {
            await this.sendAlert({
                type: 'threshold_exceeded',
                message: `5分钟内检测到 ${this.failureWindow.size} 次安全事件`,
                latestEvent: entry
            });
            this.failureWindow.clear();
        }
    }
    
    async sendAlert(alert) {
        if (!this.alertWebhook) {
            console.error('[ALERT]', JSON.stringify(alert));
            return;
        }
        
        try {
            const response = await fetch(this.alertWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    timestamp: new Date().toISOString(),
                    source: 'LinuxShellExecutor',
                    ...alert
                })
            });
            
            if (!response.ok) {
                console.error('告警发送失败:', response.status);
            }
        } catch (error) {
            console.error('告警发送错误:', error.message);
        }
    }
}

// ============================================
// 主执行器
// ============================================
class LinuxShellExecutor {
    constructor() {
        this.blacklistFilter = new BlacklistFilter();
        this.whitelistValidator = new WhitelistValidator(whitelist);
        this.graylistValidator = new GraylistValidator(graylist);
        this.astAnalyzer = new ASTAnalyzer();
        this.sandboxManager = new SandboxManager();
        this.auditLogger = new AuditLogger();
        
        // v0.4.0 新增：安全分级验证器、预设执行器、输出格式化器
        this.securityLevelValidator = new SecurityLevelValidator(securityLevelsConfig);
        this.presetExecutor = new PresetExecutor(presetsConfig);
        this.outputFormatter = new OutputFormatter({
            maxOutputLines: parseInt(process.env.MAX_OUTPUT_LINES) || 100,
            maxOutputSize: parseInt(process.env.MAX_OUTPUT_SIZE) || 1048576,
            tempDir: path.join(__dirname, 'temp')
        });

        // MEU-4: 跨插件联动 - MonitorManager (逻辑注入)
        this.monitorManager = null;
        
        this.securityLevels = {
            basic: ['blacklist'],
            standard: ['blacklist', 'whitelist', 'sandbox'],
            high: ['blacklist', 'whitelist', 'ast', 'sandbox'],
            maximum: ['blacklist', 'whitelist', 'ast', 'sandbox', 'audit']
        };
    }

    /**
     * 命令静默化补丁：自动处理常见的二次确认交互（支持多发行版与环境）
     */
    _patchCommandForNonInteractive(command) {
        let patched = command.trim();
        // 注入更广泛的 CI/非交互环境变量，处理包管理器、Git 等常见阻塞源
        const envPrefix = "export DEBIAN_FRONTEND=noninteractive; export CI=true; export GIT_TERMINAL_PROMPT=0; ";

        // 1. apt/yum/dnf (Debian/RHEL)
        if (/\b(apt(-get)?|yum|dnf)\s+install\b/.test(patched) && !patched.includes('-y')) {
            patched = patched.replace(/\b(apt(-get)?|yum|dnf)\s+install\b/, '$& -y');
        }
        
        // 2. pacman/yay (Arch Linux)
        if (/\b(pacman|yay)\s+(-S|--sync)\b/.test(patched) && !patched.includes('--noconfirm')) {
            patched = patched.replace(/\b(pacman|yay)\s+(-S|--sync)\b/, '$& --noconfirm');
        }

        // 3. zypper (SUSE)
        if (/\bzypper\s+install\b/.test(patched) && !patched.includes('-n')) {
            patched = patched.replace(/\bzypper\s+install\b/, '$& -n');
        }

        // 4. npm/pip
        if (/\bnpm\s+install\b/.test(patched) && !patched.includes('-y') && !patched.includes('--yes')) {
            patched = patched.replace(/\bnpm\s+install\b/, '$& -y');
        }
        if (/\bpip\s+install\b/.test(patched) && !patched.includes('--no-input')) {
            patched = patched.replace(/\bpip\s+install\b/, '$& --no-input');
        }

        return envPrefix + patched;
    }

    /**
     * 交互阻塞检测：识别输出流中常见的阻塞特征
     */
    _detectInteractionBlock(output) {
        const patterns = [
            { name: 'sudo_password', regex: /\[sudo\] password for/i },
            { name: 'confirmation', regex: /\(y\/n\)\??/i },
            { name: 'choice_prompt', regex: /enter choice|select one/i },
            { name: 'resource_locked', regex: /Could not get lock|Resource temporarily unavailable|waiting for cache lock/i },
            { name: 'generic_prompt', regex: /:\s*$/ } // 以冒号结尾且无后续输出通常是提示符
        ];

        for (const p of patterns) {
            if (p.regex.test(output)) return p.name;
        }
        return null;
    }

    _shellTokenize(command) {
        const tokens = [];
        let current = '';
        let quote = null;
        let escaped = false;

        for (const char of command) {
            if (escaped) {
                current += char;
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (quote) {
                if (char === quote) {
                    quote = null;
                } else {
                    current += char;
                }
                continue;
            }
            if (char === '"' || char === "'") {
                quote = char;
                continue;
            }
            if (/\s/.test(char)) {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
                continue;
            }
            if (['|', ';', '&'].includes(char)) {
                if (current) {
                    tokens.push(current);
                }
                break;
            }
            current += char;
        }

        if (current) {
            tokens.push(current);
        }
        return tokens;
    }

    _extractTailContextLines(tokens) {
        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            if ((token === '-n' || token === '--lines') && tokens[i + 1]) {
                const parsed = Number.parseInt(tokens[i + 1], 10);
                if (Number.isFinite(parsed) && parsed >= 0) return parsed;
            }
            const shortMatch = token.match(/^-n(\d+)$/);
            if (shortMatch) return Number.parseInt(shortMatch[1], 10);
            const longMatch = token.match(/^--lines=(\d+)$/);
            if (longMatch) return Number.parseInt(longMatch[1], 10);
        }
        return 0;
    }

    _classifyLogFollowCommand(command) {
        const tokens = this._shellTokenize(command.trim());
        if (tokens.length === 0) return null;

        if (tokens[0] === 'tail') {
            const hasFollow = tokens.some(token =>
                token === '-f' ||
                token === '-F' ||
                token === '--follow' ||
                token.startsWith('--follow=')
            );
            if (!hasFollow) return null;

            const valueOptions = new Set([
                '-n',
                '--lines',
                '-c',
                '--bytes',
                '-s',
                '--sleep-interval',
                '--pid'
            ]);
            let skipNext = false;
            let logPath = null;
            for (let i = 1; i < tokens.length; i++) {
                const token = tokens[i];
                if (skipNext) {
                    skipNext = false;
                    continue;
                }
                if (valueOptions.has(token)) {
                    skipNext = true;
                    continue;
                }
                if (
                    token === '-f' ||
                    token === '-F' ||
                    token === '--follow' ||
                    token.startsWith('--follow=') ||
                    token.startsWith('-n') ||
                    token.startsWith('--lines=') ||
                    token.startsWith('-c') ||
                    token.startsWith('--bytes=')
                ) {
                    continue;
                }
                if (!token.startsWith('-')) {
                    logPath = token;
                }
            }
            if (!logPath) return null;
            return {
                type: 'tail',
                logPath,
                contextLines: this._extractTailContextLines(tokens)
            };
        }

        if (tokens[0] === 'journalctl') {
            const hasFollow = tokens.some(token => token === '-f' || token === '--follow');
            if (hasFollow) {
                return { type: 'journalctl' };
            }
        }

        return null;
    }

    _detectPrivilegeEscalation(command) {
        const patterns = [
            { name: 'sudo', regex: /(^|[\s;&|()])sudo(\s|$)/ },
            { name: 'pkexec', regex: /(^|[\s;&|()])pkexec(\s|$)/ },
            { name: 'doas', regex: /(^|[\s;&|()])doas(\s|$)/ },
            { name: 'su', regex: /(^|[\s;&|()])su(\s+-|\s|$)/ }
        ];
        const matched = patterns.find(item => item.regex.test(command));
        if (!matched) return null;

        return {
            command: matched.name,
            requiresNonInteractive: matched.name === 'sudo'
        };
    }

    _buildPrivilegeEscalationResponse(command, detection) {
        const hint = detection.command === 'sudo'
            ? '当前不支持交互式 sudo 密码输入；如确需执行，后续应走显式 allowlist 和 sudo -n 免交互策略。'
            : '当前不支持交互式提权命令。';
        return {
            status: 'interaction_required',
            blockType: 'privilege_escalation',
            command,
            privilegeCommand: detection.command,
            message: `检测到提权命令 ${detection.command}，已在执行前拦截。${hint}`
        };
    }

    async _startLogFileMonitor(hostId, logPath, command, options = {}) {
        if (!this.monitorManager) {
            throw new Error('长待机功能不可用（MonitorManager 未加载）');
        }
        const contextLines = options.contextLines !== undefined
            ? Number.parseInt(options.contextLines, 10)
            : 0;
        const afterContextLines = options.afterContextLines !== undefined
            ? Number.parseInt(options.afterContextLines, 10)
            : contextLines;
        const taskId = await this.monitorManager.startMonitor({
            hostId,
            logPath,
            rules: options.monitorRules || [],
            contextLines: Number.isFinite(contextLines) ? contextLines : 0,
            afterContextLines: Number.isFinite(afterContextLines) ? afterContextLines : 0
        });

        return {
            status: 'background',
            message: '日志跟随指令已转入 LinuxLogMonitor 监控',
            taskId,
            logPath,
            hostId,
            command,
            note: '该任务未进入普通 SSH 命令队列。'
        };
    }

    async _startMonitoredBackgroundCommand(hostConfig, hostId, patchedCommand, command, options = {}) {
        if (!this.monitorManager) {
            throw new Error('长待机功能不可用（MonitorManager 未加载）');
        }

        const logPath = `/tmp/vcp_shell_${Date.now()}.log`;
        const backgroundWrappedCmd = `nohup bash -lc ${JSON.stringify(patchedCommand)} > ${logPath} 2>&1 & echo $!`;

        let backgroundPid = '';
        if (hostConfig.type === 'ssh') {
            const manager = getSSHManager();
            if (!manager) throw new Error('SSH 模块未加载，无法启动后台任务');
            const bgOptions = {
                timeout: 10000,
                bypassExecutionQueue: true
            };
            if (options.usePool !== undefined) {
                bgOptions.usePool = options.usePool;
            }
            const bgExec = await manager.execute(hostId, backgroundWrappedCmd, bgOptions);
            backgroundPid = bgExec.stdout.trim();
        } else {
            const bgExec = await this.sandboxManager.executeDirectly(backgroundWrappedCmd, { timeout: 10000 });
            backgroundPid = bgExec.stdout.trim();
        }

        const taskId = await this.monitorManager.startMonitor({
            hostId,
            logPath,
            rules: [],
            contextLines: 0,
            afterContextLines: 0
        });

        return {
            status: 'background',
            message: '指令已成功在后台启动并转入长待机运行模式',
            taskId,
            pid: backgroundPid,
            logPath,
            hostId,
            command,
            note: '任务输出已重定向至临时日志。你可以通过 LinuxLogMonitor 插件查看实时状态。'
        };
    }

    /**
     * 柔性锁清理：用于解决包管理器死锁而不触发危险指令拦截
     * 逻辑：先尝试 fuser 杀掉占用进程，再清理锁文件
     */
    async _safeCleanupLocks(hostId) {
        const cleanupCmd = `
            # Debian/Ubuntu
            if [ -f /var/lib/dpkg/lock-frontend ]; then
                sudo fuser -k /var/lib/dpkg/lock-frontend || true
                sudo rm -f /var/lib/dpkg/lock-frontend
            fi
            # RedHat/CentOS
            if [ -f /var/run/yum.pid ]; then
                sudo kill -9 $(cat /var/run/yum.pid) || true
                sudo rm -f /var/run/yum.pid
            fi
            # 重新配置 dpkg 以防万一
            sudo dpkg --configure -a || true
        `.trim();
        
        const manager = getSSHManager();
        return manager ? manager.execute(hostId, cleanupCmd, { timeout: 15000 }) : null;
    }
    
    async init() {
        await this.auditLogger.init();
        
        // MEU-4: 初始化监控管理器（逻辑注入方案）
        try {
            const MonitorManager = require('../LinuxLogMonitor/core/MonitorManager');
            this.monitorManager = new MonitorManager({
                callbackBaseUrl: process.env.CALLBACK_BASE_URL || `http://localhost:${process.env.SERVER_PORT || 5000}`,
                pluginName: 'LinuxShellExecutor',
                debug: isDebugMode()
            });
            // 以只读模式初始化（用于信号发送和状态查询）
            await this.monitorManager.init({ mode: 'readonly' });
            logInfo('[LinuxShellExecutor] MonitorManager 逻辑注入成功');
        } catch (e) {
            console.error('[LinuxShellExecutor] MonitorManager 注入失败，长待机功能受限:', e.message);
        }
    }
    
    /**
     * 列出所有可用主机
     */
    listHosts() {
        const hosts = hostsConfig && hostsConfig.hosts && typeof hostsConfig.hosts === 'object'
            ? hostsConfig.hosts
            : { local: { name: '本地执行', type: 'local', enabled: true, securityLevel: 'standard' } };

        // 仅返回主机基础信息（不做连通性探测/过滤），适配 VCP 多进程模型。
        return Object.entries(hosts).map(([id, cfg]) => ({
            id,
            name: cfg.name,
            host: cfg.host || 'localhost',
            type: cfg.type || 'local',
            enabled: cfg.enabled !== false,
            securityLevel: cfg.securityLevel || 'standard',
            tags: cfg.tags
        }));
    }
    
    /**
     * 测试主机连接
     */
    async testConnection(hostId) {
        const manager = getSSHManager();
        if (!manager) {
            if (hostId === 'local') {
                return { success: true, hostId: 'local', message: '本地执行模式' };
            }
            const loadError = getSSHLoadError();
            return {
                success: false,
                hostId,
                error: 'SSH 模块未加载',
                detail: loadError || undefined,
                suggestion: '请先确认共享模块 modules/SSHManager 可正常加载；也可先调用 action=listHosts 查看缓存提示信息。'
            };
        }
        return manager.testConnection(hostId);
    }
    
    /**
     * 获取连接状态
     */
    async getConnectionStatus() {
        const manager = getSSHManager();
        if (manager) {
            const status = await manager.getStatus();
            const poolStats = typeof manager.getPoolStats === 'function' ? await manager.getPoolStats() : null;
            return { ...status, poolStats };
        }
        return { local: { name: '本地执行', enabled: true, type: 'local', connectionStatus: 'ready' }, poolStats: null };
    }
    
    /**
     * 执行命令
     */
    async execute(command, options = {}) {
        const startTime = Date.now();
        const hostId = options.hostId;
        const logFollowCommand = this._classifyLogFollowCommand(command);
        const isLongRunning = options.isLongRunning === true || Boolean(logFollowCommand);
        const bypassWhitelist = options.bypassWhitelist === true;

        // v1.1.5: 自动应用静默化补丁
        const patchedCommand = this._patchCommandForNonInteractive(command);

        // 迭代 v1.1.1: hostId 变为必需选项
        if (!hostId) {
            const availableHosts = this.listHosts().map(h => ({
                id: h.id,
                name: h.name,
                type: h.type,
                tags: h.tags
            }));

            const error = new Error('缺少必需参数: hostId');
            error.status = "discovery";
            error.assets = availableHosts;
            error.message = "请提供 hostId。可用的资产列表如下：";
            throw error;
        }
        
        // 想法2：资产引导系统。如果 hostId 不存在，返回资产发现列表
        if (!hostsConfig.hosts[hostId]) {
            const availableHosts = this.listHosts().map(h => ({
                id: h.id,
                name: h.name,
                type: h.type,
                tags: h.tags
            }));
            
            return {
                status: "discovery",
                error: `目标主机 "${hostId}" 未找到或未配置`,
                message: "请从以下可用资产中选择正确的 hostId 进行连接：",
                assets: availableHosts
            };
        }

        const hostConfig = hostsConfig.hosts[hostId];
        const securityLevel = options.securityLevel || hostConfig.securityLevel || process.env.DEFAULT_SECURITY_LEVEL || 'standard';
        const enabledLayers = this.securityLevels[securityLevel] || this.securityLevels.standard;
        
        // 检测是否为预设命令展开后的命令（通过 options.isPresetCommand 标记）
        const isPresetCommand = options.isPresetCommand === true;
        
        const auditEntry = {
            command,
            hostId,
            options,
            securityLevel,
            timestamp: new Date().toISOString(),
            status: 'pending',
            layers: []
        };
        
        try {
            const privilegeEscalation = this._detectPrivilegeEscalation(command);
            if (privilegeEscalation) {
                auditEntry.status = 'blocked';
                auditEntry.reason = `检测到提权命令: ${privilegeEscalation.command}`;
                auditEntry.layer = 'preflight';
                auditEntry.severity = 'critical';
                if (enabledLayers.includes('audit')) {
                    await this.auditLogger.log(auditEntry);
                }
                return this._buildPrivilegeEscalationResponse(command, privilegeEscalation);
            }

            // 第一层：黑名单过滤
            if (enabledLayers.includes('blacklist')) {
                const blacklistResult = this.blacklistFilter.check(command);
                auditEntry.layers.push({ name: 'blacklist', result: blacklistResult });
                if (!blacklistResult.passed) {
                    auditEntry.status = 'blocked';
                    auditEntry.reason = blacklistResult.reason;
                    auditEntry.layer = 'blacklist';
                    auditEntry.severity = blacklistResult.severity;
                    if (enabledLayers.includes('audit')) {
                        await this.auditLogger.log(auditEntry);
                    }
                    throw new Error(`[黑名单] ${blacklistResult.reason}`);
                }
            }
            
            // 第二层：白名单/灰名单验证
            // 诊断日志：记录安全层配置
            logDiagInfo(`[LinuxShellExecutor][DIAG] securityLevel: ${securityLevel}`);
            logDiagInfo(`[LinuxShellExecutor][DIAG] enabledLayers: ${JSON.stringify(enabledLayers)}`);
            logDiagInfo(`[LinuxShellExecutor][DIAG] whitelist 层是否启用: ${enabledLayers.includes('whitelist')}`);
            
            if (enabledLayers.includes('whitelist') && !isPresetCommand && !bypassWhitelist) {
                // 预设命令或管理员授权逃逸跳过白名单验证
                logDiagInfo(`[LinuxShellExecutor][DIAG] ${isPresetCommand ? '预设命令' : '授权逃逸'}，跳过白名单验证`);
                
                // 先检查是否在灰名单中（灰名单命令已在 main() 中验证过权限）
                const graylistCheck = this.graylistValidator.check(command);
                
                if (graylistCheck.inGraylist) {
                    // 灰名单命令：使用灰名单验证（验证参数和路径）
                    logDiagInfo(`[LinuxShellExecutor][DIAG] 命令在灰名单中，使用灰名单验证...`);
                    const graylistResult = this.graylistValidator.validate(command);
                    logDiagInfo(`[LinuxShellExecutor][DIAG] 灰名单验证结果: ${JSON.stringify(graylistResult)}`);
                    auditEntry.layers.push({ name: 'graylist', result: graylistResult });
                    if (!graylistResult.passed) {
                        auditEntry.status = 'blocked';
                        auditEntry.reason = graylistResult.reason;
                        auditEntry.layer = 'graylist';
                        auditEntry.severity = graylistResult.severity;
                        if (enabledLayers.includes('audit')) {
                            await this.auditLogger.log(auditEntry);
                        }
                        throw new Error(`[灰名单] ${graylistResult.reason}`);
                    }
                } else {
                    // 白名单命令：使用白名单验证
                    logDiagInfo(`[LinuxShellExecutor][DIAG] 开始白名单验证...`);
                    const whitelistResult = this.whitelistValidator.validate(command);
                    logDiagInfo(`[LinuxShellExecutor][DIAG] 白名单验证结果: ${JSON.stringify(whitelistResult)}`);
                    auditEntry.layers.push({ name: 'whitelist', result: whitelistResult });
                    if (!whitelistResult.passed) {
                        auditEntry.status = 'blocked';
                        auditEntry.reason = whitelistResult.reason;
                        auditEntry.layer = 'whitelist';
                        auditEntry.severity = whitelistResult.severity;
                        if (enabledLayers.includes('audit')) {
                            await this.auditLogger.log(auditEntry);
                        }
                        throw new Error(`[白名单] ${whitelistResult.reason}`);
                    }
                }
            }
            
            // 第三层：AST 语义分析
            if (enabledLayers.includes('ast')) {
                const astResult = this.astAnalyzer.analyze(command);
                auditEntry.layers.push({ name: 'ast', result: astResult });
                if (!astResult.passed) {
                    auditEntry.status = 'blocked';
                    auditEntry.reason = astResult.risks.map(r => r.description).join('; ');
                    auditEntry.layer = 'ast';
                    auditEntry.severity = 'critical';
                    if (enabledLayers.includes('audit')) {
                        await this.auditLogger.log(auditEntry);
                    }
                    throw new Error(`[AST分析] ${auditEntry.reason}`);
                }
            }
            
            // 执行命令
            let execResult;
            const timeout = options.timeout || parseInt(process.env.TIMEOUT_MS) || 30000;

            // MEU-4: 长待机指令逻辑
            if (isLongRunning) {
                if (logFollowCommand?.type === 'tail') {
                    return this._startLogFileMonitor(hostId, logFollowCommand.logPath, command, {
                        ...options,
                        contextLines: options.contextLines ?? logFollowCommand.contextLines,
                        afterContextLines: options.afterContextLines ?? logFollowCommand.contextLines
                    });
                }

                return this._startMonitoredBackgroundCommand(
                    hostConfig,
                    hostId,
                    patchedCommand,
                    command,
                    options
                );
            }
            
            if (hostConfig.type === 'ssh') {
                // SSH 远程执行
                const manager = getSSHManager();
                if (!manager) {
                    throw new Error('SSH 模块未加载，无法执行远程命令');
                }
                const execOptions = { timeout, signal: options.signal };
                if (options.usePool !== undefined) {
                    execOptions.usePool = options.usePool;
                }
                for (const key of [
                    'queueWaitTimeout',
                    'maxExecutionQueueLength',
                    'bypassExecutionQueue',
                    'disconnectOnCommandTimeout'
                ]) {
                    if (options[key] !== undefined) {
                        execOptions[key] = options[key];
                    }
                }
                execResult = await manager.execute(hostId, patchedCommand, execOptions);
            } else {
                // 本地执行（可选沙箱）
                if (enabledLayers.includes('sandbox')) {
                    execResult = await this.sandboxManager.execute(patchedCommand, {
                        timeout,
                        memory: options.memory || '256m',
                        cpus: options.cpus || '0.5',
                        signal: options.signal
                    });
                } else {
                    execResult = await this.sandboxManager.executeDirectly(patchedCommand, { timeout, signal: options.signal });
                }
            }

            // v1.1.5: 检查执行结果中的交互阻塞
            const blockType = this._detectInteractionBlock(execResult.stdout + execResult.stderr);
            if (blockType) {
                return {
                    status: "interaction_required",
                    blockType: blockType,
                    output: execResult.stdout,
                    stderr: execResult.stderr,
                    message: `检测到交互阻塞: ${blockType}。如果是资源锁竞争，请尝试调用柔性清理逻辑。`
                };
            }
            
            auditEntry.status = 'success';
            auditEntry.duration = Date.now() - startTime;
            auditEntry.outputLength = execResult.stdout.length;
            
            if (enabledLayers.includes('audit')) {
                await this.auditLogger.log(auditEntry);
            }
            
            // 获取 SSH 调试日志
            const manager = getSSHManager();
            const debugLogs = manager ? manager.getAndClearDebugLogs() : [];
            
            // 注意：不包含 status 字段，因为 main 函数会在外层包装 { status: 'success', result: ... }
            const result = {
                output: execResult.stdout,
                stderr: execResult.stderr,
                code: execResult.code,
                duration: auditEntry.duration,
                hostId,
                securityLevel,
                executionType: hostConfig.type
            };
            // 仅在 DebugMode=true 时包含调试日志
            if (isDebugMode() && debugLogs.length > 0) {
                result.debugLogs = debugLogs;
            }
            return result;
            
        } catch (error) {
            if (auditEntry.status === 'pending') {
                auditEntry.status = 'failed';
                auditEntry.error = error.message;
                auditEntry.duration = Date.now() - startTime;
                if (enabledLayers.includes('audit')) {
                    await this.auditLogger.log(auditEntry);
                }
            }
            
            throw error;
        }
    }
    
    /**
     * 断开所有 SSH 连接
     */
    async disconnectAll() {
        const manager = getSSHManager();
        if (manager && manager.isProxy && typeof manager.destroy === 'function') {
            manager.destroy();
            return;
        }
        if (manager && typeof manager.disconnectAll === 'function') {
            await manager.disconnectAll();
        }
    }
}

// ============================================
// 混合插件 Direct 入口
// ============================================
let pluginConfig = {};
let directExecutor = null;
let directExecutorInitPromise = null;

function applyRuntimeConfig(config = {}) {
    pluginConfig = config || {};
    if (pluginConfig.PORT && !process.env.SERVER_PORT) {
        process.env.SERVER_PORT = String(pluginConfig.PORT);
    }
    if (pluginConfig.PROJECT_BASE_PATH && !process.env.PROJECT_BASE_PATH) {
        process.env.PROJECT_BASE_PATH = String(pluginConfig.PROJECT_BASE_PATH);
    }
}

async function getExecutor() {
    if (directExecutor) return directExecutor;
    if (!directExecutorInitPromise) {
        directExecutorInitPromise = (async () => {
            const executor = new LinuxShellExecutor();
            await executor.init();
            directExecutor = executor;
            return executor;
        })().catch(error => {
            directExecutorInitPromise = null;
            throw error;
        });
    }
    return directExecutorInitPromise;
}

function extractBaseCommand(cmd) {
    const trimmed = cmd.trim();
    const firstPart = trimmed.includes('|') ? trimmed.split('|')[0].trim() : trimmed;
    return firstPart.split(/\s+/)[0];
}

function buildErrorResult(error) {
    const manager = getSSHManager();
    const debugLogs = manager ? manager.getAndClearDebugLogs() : [];

    let errorResult;
    if (error.status) {
        errorResult = {
            status: error.status,
            error: error.message,
            assets: error.assets,
            suggestion: error.suggestion
        };
    } else {
        errorResult = {
            status: 'error',
            error: error.message
        };
    }

    if (isDebugMode() && debugLogs.length > 0) {
        errorResult.debugLogs = debugLogs;
    }
    return errorResult;
}

async function runToolCall(args = {}, options = {}) {
    const executor = options.executor || await getExecutor();
    const authCode = resolveAdminAuthCode(options.context);
    const disconnectAfterCall = options.disconnectAfterCall === true;

    try {
        logDebug(`[LinuxShellExecutor] 解析后的参数: ${JSON.stringify(args)}`);

        const isSpecialAction = ['listHosts', 'testConnection', 'getStatus', 'listPresets'].includes(args.action);
        let commandsToExecute = [];
        let isPresetExecution = false;
        let presetInfo = null;

        if (!isSpecialAction && args.command) {
            if (executor.presetExecutor.isPresetCommand(args.command)) {
                logDebug(`[LinuxShellExecutor] 检测到预设命令: ${args.command}`);
                const parsed = executor.presetExecutor.parsePresetCommand(args.command);

                if (!parsed.valid) {
                    throw new Error(`预设命令解析失败: ${parsed.error}`);
                }

                const expanded = executor.presetExecutor.expandPreset(parsed.presetName, parsed.params);
                if (!expanded.success) {
                    throw new Error(`预设命令展开失败: ${expanded.error}`);
                }

                commandsToExecute = expanded.commands;
                isPresetExecution = true;
                presetInfo = {
                    name: expanded.presetName,
                    description: expanded.description,
                    outputFormat: expanded.outputFormat,
                    timeout: expanded.timeout
                };

                logDebug(`[LinuxShellExecutor] 预设 "${expanded.presetName}" 展开为 ${commandsToExecute.length} 条命令`);
            } else {
                commandsToExecute = [args.command];
            }

            for (const cmd of commandsToExecute) {
                const privilegeEscalation = executor._detectPrivilegeEscalation(cmd);
                if (privilegeEscalation) {
                    const result = executor._buildPrivilegeEscalationResponse(cmd, privilegeEscalation);
                    logWarn(`[LinuxShellExecutor] 提权命令已在入口拦截: ${privilegeEscalation.command}`);
                    return result;
                }
            }

            if (isPresetExecution && presetInfo) {
                const presetSecurityLevel = presetsConfig.presets[presetInfo.name]?.securityLevel || 'safe';
                logDebug(`[LinuxShellExecutor] 预设 "${presetInfo.name}" 使用预定义安全级别: ${presetSecurityLevel}`);

                if (presetSecurityLevel === 'write' || presetSecurityLevel === 'danger') {
                    const isDoubleConfirm = presetSecurityLevel === 'danger';

                    if (!args.requireAdmin) {
                        throw new Error(`预设 "${presetInfo.name}" 需要${isDoubleConfirm ? '二次' : ''}确认！\n安全级别: ${presetSecurityLevel.toUpperCase()}\n请提供 requireAdmin 参数（6位验证码）。`);
                    }

                    if (!authCode) {
                        throw new Error('无法获取管理员验证码。请确保主服务器配置正确。');
                    }

                    if (String(args.requireAdmin) !== authCode) {
                        throw new Error('管理员验证码错误。');
                    }

                    if (isDoubleConfirm && !args.doubleConfirm) {
                        throw new Error(`高危预设操作需要二次确认！请同时提供 doubleConfirm: true 参数。\n预设: ${presetInfo.name}\n风险级别: ${presetSecurityLevel}`);
                    }

                    logDebug(`[LinuxShellExecutor] 预设 "${presetInfo.name}" 验证成功`);
                } else {
                    logDebug(`[LinuxShellExecutor] 预设 "${presetInfo.name}" 为 ${presetSecurityLevel} 级别，自动放行`);
                }
            } else {
                for (const cmd of commandsToExecute) {
                    const baseCommand = extractBaseCommand(cmd);
                    logDebug(`[LinuxShellExecutor] 安全分级验证: "${baseCommand}"`);

                    const levelValidation = executor.securityLevelValidator.validate(cmd);

                    if (!levelValidation.passed) {
                        const isExecuteCommand = baseCommand === 'execute';

                        if ((levelValidation.isUnknown || isExecuteCommand) && args.requireAdmin && authCode && String(args.requireAdmin) === authCode) {
                            const astResult = executor.astAnalyzer.analyze(cmd);
                            if (!astResult.passed) {
                                const reasons = astResult.risks.map(r => r.description).join('; ');
                                logWarn(`[LinuxShellExecutor] 逃逸执行被 AST 拦截: ${reasons}`);
                                throw new Error(`[安全底线] 即使使用授权码，也禁止执行高危模式指令: ${reasons}`);
                            }

                            logWarn(`[LinuxShellExecutor] 未知命令 "${baseCommand}" 通过授权码验证及 AST 扫描，允许逃逸执行`);
                        } else {
                            if (levelValidation.isUnknown || isExecuteCommand) {
                                throw new Error(`[安全分级] ${levelValidation.reason}。如需强制执行，请提供正确的管理员验证码。`);
                            }
                            throw new Error(`[安全分级] ${levelValidation.reason}`);
                        }
                    }

                    const { highestRiskLevel, requireConfirm } = levelValidation;
                    logDebug(`[LinuxShellExecutor] 命令 "${baseCommand}" 安全级别: ${highestRiskLevel}, 需要确认: ${requireConfirm}`);

                    if (requireConfirm) {
                        const isDoubleConfirm = requireConfirm === 'double';

                        if (!args.requireAdmin) {
                            const confirmPrompt = executor.securityLevelValidator.generateConfirmPrompt(levelValidation, cmd);
                            throw new Error(`${confirmPrompt.prompt}\n请提供 requireAdmin 参数（6位验证码）。`);
                        }

                        if (!authCode) {
                            throw new Error('无法获取管理员验证码。请确保主服务器配置正确。');
                        }

                        if (String(args.requireAdmin) !== authCode) {
                            throw new Error('管理员验证码错误。');
                        }

                        if (isDoubleConfirm && !args.doubleConfirm) {
                            throw new Error(`高危操作需要二次确认！请同时提供 doubleConfirm: true 参数。\n命令: ${cmd}\n风险级别: ${highestRiskLevel}`);
                        }

                        logDebug(`[LinuxShellExecutor] ${highestRiskLevel} 级别命令验证成功`);
                    } else {
                        logDebug(`[LinuxShellExecutor] 命令 "${baseCommand}" 为 ${highestRiskLevel} 级别，自动放行`);
                    }
                }
            }
        }

        if (args.action === 'listHosts') {
            logDebug('[LinuxShellExecutor] 开始处理 listHosts 命令...');
            const result = { hosts: executor.listHosts() };
            const templateStatus = getDefaultHostsTemplateStatus();
            if (templateStatus) {
                result.sshDisabled = templateStatus;
            }
            return result;
        }

        if (args.action === 'testConnection') {
            const testResult = await executor.testConnection(args.hostId || 'local');
            const manager = getSSHManager();
            const debugLogs = manager ? manager.getAndClearDebugLogs() : [];
            const resultData = { ...testResult };
            const templateStatus = getDefaultHostsTemplateStatus();
            if (templateStatus) {
                resultData.sshDisabled = templateStatus;
            }
            if (isDebugMode() && debugLogs.length > 0) {
                resultData.debugLogs = debugLogs;
            }
            return resultData;
        }

        if (args.action === 'getStatus') {
            const result = { connections: await executor.getConnectionStatus() };
            const templateStatus = getDefaultHostsTemplateStatus();
            if (templateStatus) {
                result.sshDisabled = templateStatus;
            }
            return result;
        }

        if (args.action === 'listPresets') {
            return { presets: executor.presetExecutor.listPresets() };
        }

        if (!args.command) {
            throw new Error('缺少必需参数: command');
        }

        const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        let finalOutput = '';
        let allResults = [];
        const outputFormat = args.outputFormat || (presetInfo ? presetInfo.outputFormat : 'formatted');
        const hasExplicitUsePool = Object.prototype.hasOwnProperty.call(args, 'usePool');
        const explicitUsePool = hasExplicitUsePool ? parseBooleanValue(args.usePool) : undefined;

        for (let i = 0; i < commandsToExecute.length; i++) {
            const cmd = commandsToExecute[i];
            logInfo(`[LinuxShellExecutor][${requestId}] 执行命令 ${i + 1}/${commandsToExecute.length}: "${cmd.substring(0, 80)}..."`);

            const executeOptions = {
                hostId: args.hostId,
                timeout: presetInfo ? presetInfo.timeout : args.timeout,
                securityLevel: args.securityLevel,
                memory: args.memory,
                cpus: args.cpus,
                isPresetCommand: isPresetExecution,
                isLongRunning: parseBooleanValue(args.isLongRunning),
                contextLines: args.contextLines,
                afterContextLines: args.afterContextLines,
                queueWaitTimeout: args.queueWaitTimeout,
                maxExecutionQueueLength: args.maxExecutionQueueLength,
                disconnectOnCommandTimeout: args.disconnectOnCommandTimeout === undefined
                    ? undefined
                    : parseBooleanValue(args.disconnectOnCommandTimeout),
                bypassWhitelist: Boolean(args.requireAdmin && authCode && String(args.requireAdmin) === authCode),
                signal: options.context?.signal
            };
            if (hasExplicitUsePool) {
                executeOptions.usePool = explicitUsePool;
            } else if (isPresetExecution) {
                executeOptions.usePool = true;
            }

            const execResult = await executor.execute(cmd, executeOptions);

            if (execResult.status && execResult.status !== 'success') {
                logWarn(`[LinuxShellExecutor][${requestId}] 收到特殊返回状态: ${execResult.status}`);
                return execResult;
            }

            allResults.push({
                command: cmd,
                output: execResult.output,
                stderr: execResult.stderr,
                code: execResult.code,
                duration: execResult.duration
            });

            if (isPresetExecution && presetInfo.outputFormat === 'merged') {
                finalOutput += execResult.output + '\n';
            }
        }

        let formattedResult;
        if (isPresetExecution) {
            const combinedOutput = presetInfo.outputFormat === 'merged'
                ? finalOutput
                : allResults.map(r => r.output).join('\n---\n');

            formattedResult = await executor.outputFormatter.format(combinedOutput, {
                outputFormat,
                command: commandsToExecute[0]
            });

            formattedResult.preset = presetInfo;
            formattedResult.commandCount = commandsToExecute.length;
            formattedResult.results = presetInfo.outputFormat === 'separate' ? allResults : undefined;
        } else {
            const singleResult = allResults[0];
            formattedResult = await executor.outputFormatter.format(singleResult.output, {
                outputFormat,
                command: args.command
            });

            formattedResult.stderr = singleResult.stderr;
            formattedResult.code = singleResult.code;
            formattedResult.duration = singleResult.duration;
            formattedResult.hostId = args.hostId || hostsConfig.defaultHost || 'local';
            formattedResult.executionType = (hostsConfig.hosts[formattedResult.hostId] || {}).type || 'local';
        }

        logInfo(`[LinuxShellExecutor][${requestId}] 命令执行完成，输出长度: ${formattedResult.output?.length || 0} bytes`);
        if (formattedResult.truncated) {
            logWarn(`[LinuxShellExecutor][${requestId}] 输出已截断: ${formattedResult.originalLines} -> ${formattedResult.truncatedAt} 行`);
        }

        return formattedResult;
    } finally {
        if (disconnectAfterCall) {
            await executor.disconnectAll();
        }
    }
}

async function initialize(config = {}) {
    applyRuntimeConfig(config);
    logInfo('[LinuxShellExecutor] 初始化 hybrid direct 插件...');
    await getExecutor();
}

async function processToolCall(args = {}, context = {}) {
    try {
        return await runToolCall(args, { context, disconnectAfterCall: false });
    } catch (error) {
        const errorResult = buildErrorResult(error);
        if (errorResult.status && errorResult.status !== 'error') {
            return errorResult;
        }
        throw new Error(JSON.stringify(errorResult));
    }
}

async function shutdown() {
    if (directExecutor) {
        await directExecutor.disconnectAll();
        directExecutor = null;
        directExecutorInitPromise = null;
    }
}

async function readStdinWithTimeout(timeoutMs = 5000) {
    let input = '';
    return new Promise((resolve, reject) => {
        const inputTimeout = setTimeout(() => {
            reject(new Error('插件输入超时，未收到参数数据'));
        }, timeoutMs);

        process.stdin.on('data', chunk => {
            clearTimeout(inputTimeout);
            input += chunk;
            logDebug(`[LinuxShellExecutor] 收到输入: ${input.substring(0, 100)}...`);
        });

        process.stdin.on('end', () => {
            clearTimeout(inputTimeout);
            resolve(input);
        });
    });
}

async function main() {
    logInfo('[LinuxShellExecutor] 插件启动...');
    try {
        const input = await readStdinWithTimeout();
        logInfo('[LinuxShellExecutor] 输入结束，开始处理...');
        const args = JSON.parse(input);
        const result = await runToolCall(args, { disconnectAfterCall: true });
        if (result.status && result.status !== 'success') {
            console.log(JSON.stringify({ status: result.status, result }));
            return;
        }
        const finalResult = { status: 'success', result };
        logDebug(`[LinuxShellExecutor] 准备输出 JSON (${JSON.stringify(finalResult).length} bytes)`);
        console.log(JSON.stringify(finalResult));
    } catch (error) {
        const errorResult = buildErrorResult(error);
        console.log(JSON.stringify(errorResult));
        process.exitCode = error.status ? 0 : 1;
    }
}

module.exports = {
    initialize,
    processToolCall,
    shutdown,
    runToolCall
};

if (require.main === module) {
    main();
}
