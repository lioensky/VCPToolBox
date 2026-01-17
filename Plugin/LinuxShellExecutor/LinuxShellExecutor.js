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
 * @version 1.1.9
 * @author VCP Team
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

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

// 加载白名单配置
let whitelist;
let whitelistLoadError = null;
try {
    whitelist = require('./whitelist.json');
    // 诊断日志：记录 whitelist 加载状态
    console.error(`[LinuxShellExecutor][DIAG] whitelist.json 加载成功`);
    console.error(`[LinuxShellExecutor][DIAG] forbiddenCharacters: ${JSON.stringify(whitelist.globalRestrictions?.forbiddenCharacters || [])}`);
    console.error(`[LinuxShellExecutor][DIAG] commands 数量: ${Object.keys(whitelist.commands || {}).length}`);
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
    console.error(`[LinuxShellExecutor][DIAG] graylist.json 加载成功`);
    console.error(`[LinuxShellExecutor][DIAG] graylist commands 数量: ${Object.keys(graylist.commands || {}).length}`);
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
    console.error(`[LinuxShellExecutor][DIAG] securityLevels.json 加载成功`);
    console.error(`[LinuxShellExecutor][DIAG] 安全级别: ${Object.keys(securityLevelsConfig.securityLevels || {}).join(', ')}`);
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
    console.error(`[LinuxShellExecutor][DIAG] presets.json 加载成功`);
    console.error(`[LinuxShellExecutor][DIAG] 预设命令数量: ${Object.keys(presetsConfig.presets || {}).length}`);
} catch (e) {
    presetsLoadError = e.message;
    presetsConfig = { presets: {}, categories: {} };
    console.error(`[LinuxShellExecutor][DIAG][ERROR] presets.json 加载失败: ${e.message}`);
}

// 加载主机配置
let hostsConfig;
try {
    hostsConfig = require('./hosts.json');
} catch (e) {
    hostsConfig = { 
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

// SSH 管理器（延迟加载，优先使用共享模块）
let sshManager = null;
let sshLoadError = null;
let sshLastLoadAttemptAt = 0;
const SSH_RETRY_INTERVAL_MS = 3000;

function getSSHManager() {
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
            console.error('[LinuxShellExecutor] 已成功连接至全局共享 SSHManager 模块');
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
        console.error(`[LinuxShellExecutor][DIAG] WhitelistValidator.validate() 被调用`);
        console.error(`[LinuxShellExecutor][DIAG] 命令: "${command.substring(0, 100)}${command.length > 100 ? '...' : ''}"`);
        console.error(`[LinuxShellExecutor][DIAG] globalRestrictions: ${JSON.stringify(this.globalRestrictions)}`);
        
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
        console.error(`[LinuxShellExecutor][DIAG] forbiddenChars 数组长度: ${forbiddenChars.length}`);
        console.error(`[LinuxShellExecutor][DIAG] forbiddenChars 内容: ${JSON.stringify(forbiddenChars)}`);
        
        for (const char of forbiddenChars) {
            if (command.includes(char)) {
                console.error(`[LinuxShellExecutor][DIAG] 检测到禁止字符: "${char}"`);
                return {
                    passed: false,
                    reason: `命令包含禁止字符: "${char}"`,
                    layer: 'whitelist',
                    severity: 'high'
                };
            }
        }
        console.error(`[LinuxShellExecutor][DIAG] 禁止字符检查通过`);
        
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
        console.error(`[LinuxShellExecutor][DIAG] GraylistValidator.check() 被调用`);
        console.error(`[LinuxShellExecutor][DIAG] 命令: "${command.substring(0, 100)}${command.length > 100 ? '...' : ''}"`);
        
        // 解析命令获取基础命令名
        const parsed = this.parseCommand(command);
        const cmdConfig = this.commands[parsed.command];
        
        if (!cmdConfig) {
            console.error(`[LinuxShellExecutor][DIAG] 命令 "${parsed.command}" 不在灰名单中`);
            return { inGraylist: false };
        }
        
        console.error(`[LinuxShellExecutor][DIAG] 命令 "${parsed.command}" 在灰名单中，风险级别: ${cmdConfig.riskLevel}`);
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
        console.error(`[LinuxShellExecutor][DIAG] GraylistValidator.validate() 被调用`);
        
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

        const hasRedirect = /[><]/.test(command);
        const hasPipe = command.includes('|');
        let segments = hasPipe ? command.split('|').map(s => s.trim()).filter(s => s.length > 0) : [command.trim()];
        
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
        return this.spawnWithTimeout('/bin/bash', ['-c', wrappedCommand], options.timeout);
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
        return this.spawnWithTimeout('docker', args, options.timeout);
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
        return this.spawnWithTimeout('firejail', args, options.timeout);
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
        
        return this.spawnWithTimeout('bwrap', args, options.timeout);
    }
    
    spawnWithTimeout(cmd, args, timeout) {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            
            const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            
            const timeoutId = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`命令执行超时 (${timeout}ms)`));
            }, timeout);
            
            child.stdout.on('data', data => { stdout += data.toString(); });
            child.stderr.on('data', data => { stderr += data.toString(); });
            
            child.on('close', code => {
                clearTimeout(timeoutId);
                if (code === 0) {
                    resolve({ stdout, stderr, code });
                } else {
                    reject(new Error(`命令执行失败 (code: ${code}): ${stderr || stdout}`));
                }
            });
            
            child.on('error', err => {
                clearTimeout(timeoutId);
                reject(new Error(`启动命令失败: ${err.message}`));
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
            nofile: parseInt(process.env.RLIMIT_NOFILE) || 64,     // 最大文件描述符
            as: parseInt(process.env.RLIMIT_AS) || 536870912       // 虚拟内存（字节，512MB）
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
        // -u: 用户进程数
        // -n: 文件描述符数
        // -v: 虚拟内存（KB）
        const parts = [
            `-t ${this.limits.cpu}`,
            `-f ${Math.floor(this.limits.fsize / 512)}`,
            `-u ${this.limits.nproc}`,
            `-n ${this.limits.nofile}`,
            `-v ${Math.floor(this.limits.as / 1024)}`
        ];
        
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
            console.error('[LinuxShellExecutor] MonitorManager 逻辑注入成功');
        } catch (e) {
            console.error('[LinuxShellExecutor] MonitorManager 注入失败，长待机功能受限:', e.message);
        }
    }
    
    /**
     * 列出所有可用主机
     */
    listHosts(onlyConnectable = false) {
        const manager = getSSHManager();
        if (manager) {
            return manager.listHosts(onlyConnectable);
        }
        const loadError = getSSHLoadError();
        return [{
            id: 'local',
            name: '本地执行',
            type: 'local',
            enabled: true,
            securityLevel: 'standard',
            status: {
                online: true,
                latency: 0,
                lastCheck: new Date().toISOString(),
                message: loadError ? `SSH 模块未加载（仅本地可用）：${loadError}` : '本地执行'
            }
        }];
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
    getConnectionStatus() {
        const manager = getSSHManager();
        if (manager) {
            return manager.getStatus();
        }
        return { local: { name: '本地执行', enabled: true, type: 'local', connectionStatus: 'ready' } };
    }
    
    /**
     * 执行命令
     */
    async execute(command, options = {}) {
        const startTime = Date.now();
        const hostId = options.hostId;
        const isLongRunning = options.isLongRunning === true;
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
            console.error(`[LinuxShellExecutor][DIAG] securityLevel: ${securityLevel}`);
            console.error(`[LinuxShellExecutor][DIAG] enabledLayers: ${JSON.stringify(enabledLayers)}`);
            console.error(`[LinuxShellExecutor][DIAG] whitelist 层是否启用: ${enabledLayers.includes('whitelist')}`);
            
            if (enabledLayers.includes('whitelist') && !isPresetCommand && !bypassWhitelist) {
                // 预设命令或管理员授权逃逸跳过白名单验证
                console.error(`[LinuxShellExecutor][DIAG] ${isPresetCommand ? '预设命令' : '授权逃逸'}，跳过白名单验证`);
                
                // 先检查是否在灰名单中（灰名单命令已在 main() 中验证过权限）
                const graylistCheck = this.graylistValidator.check(command);
                
                if (graylistCheck.inGraylist) {
                    // 灰名单命令：使用灰名单验证（验证参数和路径）
                    console.error(`[LinuxShellExecutor][DIAG] 命令在灰名单中，使用灰名单验证...`);
                    const graylistResult = this.graylistValidator.validate(command);
                    console.error(`[LinuxShellExecutor][DIAG] 灰名单验证结果: ${JSON.stringify(graylistResult)}`);
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
                    console.error(`[LinuxShellExecutor][DIAG] 开始白名单验证...`);
                    const whitelistResult = this.whitelistValidator.validate(command);
                    console.error(`[LinuxShellExecutor][DIAG] 白名单验证结果: ${JSON.stringify(whitelistResult)}`);
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
                if (!this.monitorManager) {
                    throw new Error('长待机功能不可用（MonitorManager 未加载）');
                }

                // 想法4：如果是查看日志类指令，引导直接使用 logs 功能
                if (command.includes('tail -f') || command.includes('journalctl -f')) {
                    const logPathMatch = command.match(/(?:\/|[\w.-])[^\s]*/g);
                    const suggestedLogPath = logPathMatch ? logPathMatch[logPathMatch.length - 1] : '';
                    return {
                        status: "suggestion",
                        message: "检测到日志查看指令，建议使用 LinuxLogMonitor 插件以获得更好的流式体验和异常检测能力。",
                        suggestion: `请调用 LinuxLogMonitor.start { hostId: "${hostId}", logPath: "${suggestedLogPath}" }`
                    };
                }

                // 通过 MonitorManager 启动异步任务
                const logPath = `/tmp/vcp_shell_${Date.now()}.log`;
                
                // 构造后台执行指令：使用 nohup 运行并将输出重定向到 logPath
                // 使用 bash -lc 确保加载用户环境变量
                const backgroundWrappedCmd = `nohup bash -lc ${JSON.stringify(patchedCommand)} > ${logPath} 2>&1 & echo $!`;
                
                let backgroundPid = '';
                if (hostConfig.type === 'ssh') {
                    const manager = getSSHManager();
                    if (!manager) throw new Error('SSH 模块未加载，无法启动后台任务');
                    const bgExec = await manager.execute(hostId, backgroundWrappedCmd, { timeout: 10000 });
                    backgroundPid = bgExec.stdout.trim();
                } else {
                    const bgExec = await this.sandboxManager.executeDirectly(backgroundWrappedCmd, { timeout: 10000 });
                    backgroundPid = bgExec.stdout.trim();
                }

                const taskId = await this.monitorManager.startMonitor({
                    hostId,
                    logPath,
                    rules: [],
                    contextLines: 0
                });

                return {
                    status: "background",
                    message: "指令已成功在后台启动并转入长待机运行模式",
                    taskId: taskId,
                    pid: backgroundPid,
                    logPath: logPath,
                    hostId: hostId,
                    command: command,
                    note: "任务输出已重定向至临时日志。你可以通过 LinuxLogMonitor 插件查看实时状态。"
                };
            }
            
            if (hostConfig.type === 'ssh') {
                // SSH 远程执行
                const manager = getSSHManager();
                if (!manager) {
                    throw new Error('SSH 模块未加载，无法执行远程命令');
                }
                execResult = await manager.execute(hostId, patchedCommand, { timeout });
            } else {
                // 本地执行（可选沙箱）
                if (enabledLayers.includes('sandbox')) {
                    execResult = await this.sandboxManager.execute(patchedCommand, {
                        timeout,
                        memory: options.memory || '256m',
                        cpus: options.cpus || '0.5'
                    });
                } else {
                    execResult = await this.sandboxManager.executeDirectly(patchedCommand, { timeout });
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
        if (manager) {
            await manager.disconnectAll();
        }
    }
}

// ============================================
// 主入口
// ============================================
async function main() {
    console.error('[LinuxShellExecutor] 插件启动...');
    
    const executor = new LinuxShellExecutor();
    await executor.init();
    
    console.error('[LinuxShellExecutor] 等待输入...');
    
    let input = '';
    
    // 设置输入超时（5秒内没有输入则报错）
    const inputTimeout = setTimeout(() => {
        console.error('[LinuxShellExecutor] 输入超时，未收到任何数据');
        console.log(JSON.stringify({
            status: 'error',
            error: '插件输入超时，未收到参数数据'
        }));
        process.exit(1);
    }, 5000);
    
    process.stdin.on('data', chunk => {
        clearTimeout(inputTimeout);
        input += chunk;
        console.error(`[LinuxShellExecutor] 收到输入: ${input.substring(0, 100)}...`);
    });
    
    process.stdin.on('end', async () => {
        console.error('[LinuxShellExecutor] 输入结束，开始处理...');
        try {
            const args = JSON.parse(input);
            console.error(`[LinuxShellExecutor] 解析后的参数: ${JSON.stringify(args)}`);

            const parseBoolean = (value) => {
                if (value === true || value === false) return value;
                if (typeof value === 'number') return value !== 0;
                if (typeof value === 'string') {
                    const normalized = value.trim().toLowerCase();
                    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
                    if (['false', '0', 'no', 'n', 'off', ''].includes(normalized)) return false;
                }
                return false;
            };
            
            // ============================================
            // 四级权限控制逻辑（v0.4.0）
            // - read: 只读命令，自动放行，允许管道
            // - safe: 低风险命令，自动放行
            // - write: 写操作，需要确认
            // - danger: 高危命令，二次确认
            // ============================================
            
            // 辅助函数：提取命令的基础命令名（处理管道情况）
            const extractBaseCommand = (cmd) => {
                const trimmed = cmd.trim();
                // 如果包含管道，取第一个命令
                const firstPart = trimmed.includes('|') ? trimmed.split('|')[0].trim() : trimmed;
                // 取第一个空格前的部分作为命令名
                return firstPart.split(/\s+/)[0];
            };
            
            // 特殊命令（listHosts, testConnection, getStatus, listPresets）不需要安全验证
            const isSpecialAction = ['listHosts', 'testConnection', 'getStatus', 'listPresets'].includes(args.action);
            
            // v0.4.0: 预设命令处理
            let commandsToExecute = [];
            let isPresetExecution = false;
            let presetInfo = null;
            
            if (!isSpecialAction && args.command) {
                // 检查是否是预设命令
                if (executor.presetExecutor.isPresetCommand(args.command)) {
                    console.error(`[LinuxShellExecutor] 检测到预设命令: ${args.command}`);
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
                    
                    console.error(`[LinuxShellExecutor] 预设 "${expanded.presetName}" 展开为 ${commandsToExecute.length} 条命令`);
                } else {
                    commandsToExecute = [args.command];
                }
                
                // v0.4.0: 预设命令使用独立的安全级别（从 presets.json 读取）
                // 如果是预设命令，使用预设定义的安全级别，跳过逐命令验证
                if (isPresetExecution && presetInfo) {
                    const presetSecurityLevel = presetsConfig.presets[presetInfo.name]?.securityLevel || 'safe';
                    console.error(`[LinuxShellExecutor] 预设 "${presetInfo.name}" 使用预定义安全级别: ${presetSecurityLevel}`);
                    
                    // 根据预设的安全级别决定是否需要验证
                    if (presetSecurityLevel === 'write' || presetSecurityLevel === 'danger') {
                        const realCode = process.env.DECRYPTED_AUTH_CODE;
                        const isDoubleConfirm = presetSecurityLevel === 'danger';
                        
                        if (!args.requireAdmin) {
                            throw new Error(`⚠️ 预设 "${presetInfo.name}" 需要${isDoubleConfirm ? '二次' : ''}确认！\n安全级别: ${presetSecurityLevel.toUpperCase()}\n请提供 requireAdmin 参数（6位验证码）。`);
                        }
                        
                        if (!realCode) {
                            throw new Error('无法获取管理员验证码。请确保主服务器配置正确。');
                        }
                        
                        if (String(args.requireAdmin) !== realCode) {
                            throw new Error('管理员验证码错误。');
                        }
                        
                        if (isDoubleConfirm && !args.doubleConfirm) {
                            throw new Error(`⚠️ 高危预设操作需要二次确认！请同时提供 doubleConfirm: true 参数。\n预设: ${presetInfo.name}\n风险级别: ${presetSecurityLevel}`);
                        }
                        
                        console.error(`[LinuxShellExecutor] 预设 "${presetInfo.name}" 验证成功`);
                    } else {
                        // read/safe 级别：自动放行
                        console.error(`[LinuxShellExecutor] 预设 "${presetInfo.name}" 为 ${presetSecurityLevel} 级别，自动放行`);
                    }
                } else {
                    // 非预设命令：逐命令进行安全分级验证
                    for (const cmd of commandsToExecute) {
                        const baseCommand = extractBaseCommand(cmd);
                        console.error(`[LinuxShellExecutor] 安全分级验证: "${baseCommand}"`);
                        
                        // 使用新的安全分级验证器
                        const levelValidation = executor.securityLevelValidator.validate(cmd);
                        
                        if (!levelValidation.passed) {
                            // 修正：显式识别 execute 命令名，或处理 isUnknown 逻辑
                            const isExecuteCommand = baseCommand === 'execute';
                            
                            // 想法1：对于未知命令或显式的 execute 命令，如果提供了正确的授权码，允许逃逸执行
                            if ((levelValidation.isUnknown || isExecuteCommand) && args.requireAdmin) {
                                const realCode = process.env.DECRYPTED_AUTH_CODE;
                                if (realCode && String(args.requireAdmin) === realCode) {
                                    // 加固：即使是逃逸执行，也必须通过 AST 语义分析，防止执行极度危险的操作
                                    const astResult = executor.astAnalyzer.analyze(cmd);
                                    if (!astResult.passed) {
                                        const reasons = astResult.risks.map(r => r.description).join('; ');
                                        console.error(`[LinuxShellExecutor] 逃逸执行被 AST 拦截: ${reasons}`);
                                        throw new Error(`[安全底线] 即使使用授权码，也禁止执行高危模式指令: ${reasons}`);
                                    }
                                    
                                    console.error(`[LinuxShellExecutor] 未知命令 "${baseCommand}" 通过授权码验证及 AST 扫描，允许逃逸执行`);
                                    // 逃逸成功，继续执行
                                } else {
                                    throw new Error(`[安全分级] ${levelValidation.reason}。如需强制执行，请提供正确的管理员验证码。`);
                                }
                            } else {
                                throw new Error(`[安全分级] ${levelValidation.reason}`);
                            }
                        }
                        
                        const { highestRiskLevel, requireConfirm } = levelValidation;
                        console.error(`[LinuxShellExecutor] 命令 "${baseCommand}" 安全级别: ${highestRiskLevel}, 需要确认: ${requireConfirm}`);
                        
                        // 根据安全级别决定是否需要验证
                        if (requireConfirm) {
                            const realCode = process.env.DECRYPTED_AUTH_CODE;
                            const isDoubleConfirm = requireConfirm === 'double';
                            
                            if (!args.requireAdmin) {
                                const confirmPrompt = executor.securityLevelValidator.generateConfirmPrompt(levelValidation, cmd);
                                throw new Error(`${confirmPrompt.prompt}\n请提供 requireAdmin 参数（6位验证码）。`);
                            }
                            
                            if (!realCode) {
                                throw new Error('无法获取管理员验证码。请确保主服务器配置正确。');
                            }
                            
                            if (String(args.requireAdmin) !== realCode) {
                                throw new Error('管理员验证码错误。');
                            }
                            
                            // 二次确认：需要额外的 doubleConfirm 参数
                            if (isDoubleConfirm && !args.doubleConfirm) {
                                throw new Error(`⚠️ 高危操作需要二次确认！请同时提供 doubleConfirm: true 参数。\n命令: ${cmd}\n风险级别: ${highestRiskLevel}`);
                            }
                            
                            console.error(`[LinuxShellExecutor] ${highestRiskLevel} 级别命令验证成功`);
                        } else {
                            // read/safe 级别：自动放行
                            console.error(`[LinuxShellExecutor] 命令 "${baseCommand}" 为 ${highestRiskLevel} 级别，自动放行`);
                        }
                    }
                }
            }
            
            // 特殊命令处理
            if (args.action === 'listHosts') {
                console.error(`[LinuxShellExecutor] 开始处理 listHosts 命令...`);
                try {
                    console.error(`[LinuxShellExecutor] 调用 executor.listHosts()...`);
                    const onlyConnectable = parseBoolean(args.onlyConnectable);
                    const allHosts = executor.listHosts(false);
                    const hosts = onlyConnectable
                        ? allHosts.filter(h => h && (h.status?.online === true || h.type === 'local' || h.id === 'local'))
                        : allHosts;

                    console.error(`[LinuxShellExecutor] listHosts 返回: ${JSON.stringify(hosts)}`);

                    const result = { hosts };
                    if (onlyConnectable) {
                        const filteredHostIds = allHosts
                            .filter(h => h && h.type !== 'local' && h.id !== 'local')
                            .filter(h => !h.status || h.status.online !== true)
                            .map(h => h.id)
                            .filter(Boolean);

                        result.notice = '当前为毫秒级缓存结果（host_status.json），不会主动探测网络连通性；仅展示缓存中标记为可连接的主机。';
                        result.cache = {
                            source: 'modules/SSHManager/host_status.json',
                            mode: 'connectable-only',
                            filteredCount: filteredHostIds.length,
                            filteredHostIds
                        };
                        result.refreshHint = {
                            message: '如需刷新可连接缓存，请对目标主机逐个调用 action=testConnection（成功/失败都会写入缓存），再重新 listHosts(onlyConnectable=true)。',
                            example: {
                                action: 'testConnection',
                                hostId: filteredHostIds[0] || 'your-host-id'
                            }
                        };
                    }

                    // 修复：使用 VCP 期望的 result 字段包装数据
                    const output = JSON.stringify({ status: 'success', result });
                    console.error(`[LinuxShellExecutor] 准备输出到 stdout: ${output}`);
                    console.log(output);
                    console.error(`[LinuxShellExecutor] stdout 输出完成，准备退出`);
                    process.exit(0);
                } catch (listHostsError) {
                    console.error(`[LinuxShellExecutor] listHosts 异常: ${listHostsError.message}`);
                    console.error(`[LinuxShellExecutor] 异常堆栈: ${listHostsError.stack}`);
                    console.log(JSON.stringify({ status: 'error', error: listHostsError.message }));
                    process.exit(1);
                }
                return;
            }
            
            if (args.action === 'testConnection') {
                const testResult = await executor.testConnection(args.hostId || 'local');
                // 获取调试日志（仅在 DebugMode=true 时包含）
                const manager = getSSHManager();
                const debugLogs = manager ? manager.getAndClearDebugLogs() : [];
                // 修复：使用 VCP 期望的 result 字段包装数据
                const resultData = { ...testResult };
                if (isDebugMode() && debugLogs.length > 0) {
                    resultData.debugLogs = debugLogs;
                }
                console.log(JSON.stringify({
                    status: 'success',
                    result: resultData
                }));
                // 断开连接并退出
                await executor.disconnectAll();
                process.exit(0);
                return;
            }
            
            if (args.action === 'getStatus') {
                // 修复：使用 VCP 期望的 result 字段包装数据
                console.log(JSON.stringify({ status: 'success', result: { connections: executor.getConnectionStatus() } }));
                process.exit(0);
                return;
            }
            
            // v0.4.0: 列出所有预设命令
            if (args.action === 'listPresets') {
                const presets = executor.presetExecutor.listPresets();
                console.log(JSON.stringify({ status: 'success', result: { presets } }));
                process.exit(0);
                return;
            }
            
            // 执行命令
            if (!args.command) {
                throw new Error('缺少必需参数: command');
            }
            
            // 诊断日志：记录即将执行的命令
            const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
            
            // v0.4.0: 支持预设命令批量执行
            let finalOutput = '';
            let allResults = [];
            const outputFormat = args.outputFormat || (presetInfo ? presetInfo.outputFormat : 'formatted');
            
            for (let i = 0; i < commandsToExecute.length; i++) {
                const cmd = commandsToExecute[i];
                console.error(`[LinuxShellExecutor][${requestId}] 执行命令 ${i + 1}/${commandsToExecute.length}: "${cmd.substring(0, 80)}..."`);
                
                const execResult = await executor.execute(cmd, {
                    hostId: args.hostId,
                    timeout: presetInfo ? presetInfo.timeout : args.timeout,
                    securityLevel: args.securityLevel,
                    memory: args.memory,
                    cpus: args.cpus,
                    isPresetCommand: isPresetExecution,  // 标记为预设命令
                    usePool: isPresetExecution,          // 预设批量执行时启用临时连接池
                    bypassWhitelist: args.requireAdmin && process.env.DECRYPTED_AUTH_CODE && String(args.requireAdmin) === process.env.DECRYPTED_AUTH_CODE
                });
                
                // 检查非标准成功返回（如资产发现、后台运行、交互请求等）
                if (execResult.status && execResult.status !== 'success') {
                    console.error(`[LinuxShellExecutor][${requestId}] 收到特殊返回状态: ${execResult.status}`);
                    console.log(JSON.stringify({ status: execResult.status, result: execResult }));
                    await executor.disconnectAll();
                    process.exit(0);
                    return;
                }

                allResults.push({
                    command: cmd,
                    output: execResult.output,
                    stderr: execResult.stderr,
                    code: execResult.code,
                    duration: execResult.duration
                });
                
                // 合并输出
                if (isPresetExecution && presetInfo.outputFormat === 'merged') {
                    finalOutput += execResult.output + '\n';
                }
            }
            
            // v0.4.0: 输出格式化
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
            
            // 诊断日志：记录执行结果
            console.error(`[LinuxShellExecutor][${requestId}] 命令执行完成，输出长度: ${formattedResult.output?.length || 0} bytes`);
            if (formattedResult.truncated) {
                console.error(`[LinuxShellExecutor][${requestId}] 输出已截断: ${formattedResult.originalLines} -> ${formattedResult.truncatedAt} 行`);
            }
            
            // 修复：使用 VCP 期望的 result 字段包装数据
            const finalResult = { status: 'success', result: formattedResult };
            console.error(`[LinuxShellExecutor][${requestId}] 准备输出 JSON (${JSON.stringify(finalResult).length} bytes)`);
            console.log(JSON.stringify(finalResult));
            
            // 清理连接并退出
            await executor.disconnectAll();
            process.exit(0);
            
        } catch (error) {
            // 获取调试日志（仅在 DebugMode=true 时包含）
            const manager = getSSHManager();
            const debugLogs = manager ? manager.getAndClearDebugLogs() : [];
            
            // 重要：优先识别并透传带有 status 属性的错误对象（如 discovery）
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
            console.log(JSON.stringify(errorResult));
            process.exit(error.status ? 0 : 1);
        }
    });
}

main();
