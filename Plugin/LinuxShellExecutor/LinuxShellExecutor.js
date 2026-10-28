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

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const util = require('util');
const { createSanitizedUserCommandEnv } = require('../../modules/sensitiveEnv');
const { taskStore } = require('./core/TaskStore');
const HostOutputFormatter = require('./core/OutputFormatter');

// 次世代执行参数
const DEFAULT_SYNC_TIMEOUT_MS = 30000;
const MAX_SYNC_WAIT_MS = 55000;
const TASK_PROBE_INTERVAL_MS = 3000;
const TASK_PROBE_MAX_AGE_MS = 30 * 60 * 1000;

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
const DEFAULT_HOSTS_TEMPLATE_MD5 = '30e87419ff3817a98da972ffe69c4752';

function createLocalOnlyHostsConfig() {
    return {
        hosts: {
            local: {
                name: '本地执行',
                type: 'local',
                enabled: true
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
    // 注意：即使 hosts.json 仍是默认模板，也需要初始化共享 SSHManager，
    // 因为本地虚拟终端 / 本地执行链路依赖它；此时配置中只有 local 主机，
    // 不会意外启用任何远程 SSH 目标。
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

    /**
     * 检查命令是否在白名单中
     * @returns {object} { inWhitelist: boolean, cmdConfig?: object, parsedCommand?: object }
     */
    check(command) {
        const parsed = this.parseCommand(command);
        const cmdConfig = this.commands[parsed.command];
        if (!cmdConfig) return { inWhitelist: false };
        return { inWhitelist: true, cmdConfig, parsedCommand: parsed };
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

        // 子命令约束：如果 allowedArgs 包含非flag项（如 systemctl 的 status、docker 的 ps），
        // 则第一个位置参数必须匹配，否则拒绝（降级到灰名单需验证码）
        const subcommandArgs = (cmdConfig.allowedArgs || []).filter(a => !a.startsWith('-'));
        if (subcommandArgs.length > 0 && parsed.paths.length > 0) {
            const positionalStr = parsed.paths.join(' ');
            const matchedSubcommand = subcommandArgs.some(sc => positionalStr === sc || positionalStr.startsWith(sc + ' '));
            if (!matchedSubcommand) {
                return {
                    passed: false,
                    reason: `子命令 "${parsed.paths[0]}" 不被允许用于 "${parsed.command}"`,
                    layer: 'whitelist',
                    severity: 'medium'
                };
            }
        }

        // 查询约束：如果配置了 allowedQueries（如 mysql -e），-e 内容必须匹配允许的查询
        if (cmdConfig.allowedQueries && cmdConfig.allowedQueries.length > 0) {
            const hasExecuteFlag = parsed.args.some(a => a.startsWith('-e'));
            if (hasExecuteFlag) {
                const commandUpper = command.toUpperCase();
                const queryMatched = cmdConfig.allowedQueries.some(q => commandUpper.includes(q.toUpperCase()));
                if (!queryMatched) {
                    return {
                        passed: false,
                        reason: `查询不在允许的查询列表中`,
                        layer: 'whitelist',
                        severity: 'medium'
                    };
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
        this.specialOperators = config.specialOperators || {};
    }

    /**
     * 检查特殊操作符（普适硬护栏，不可通过授权码绕过）
     * 检查分号(semicolon)、后台执行(backgroundAmp)、子shell(subshell)
     * 允许 && 和 ||
     */
    checkSpecialOperators(command) {
        for (const [opName, opConfig] of Object.entries(this.specialOperators)) {
            if (opConfig.allowed === false) {
                let pattern;
                switch (opName) {
                    case 'semicolon': pattern = /;/; break;
                    case 'backgroundAmp': pattern = /(?<!&)&(?![&>])/; break;
                    case 'subshell': pattern = /\$\(|`/; break;
                    default: continue;
                }
                if (pattern.test(command)) {
                    return {
                        passed: false,
                        reason: `检测到禁止的特殊操作符: ${opName} (${opConfig.reason})`,
                        opName,
                        layer: 'securityLevel',
                        severity: 'critical'
                    };
                }
            }
        }
        return { passed: true };
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
        this.auditLogger = new AuditLogger();

        // 安全分级验证器、预设执行器
        this.securityLevelValidator = new SecurityLevelValidator(securityLevelsConfig);
        this.presetExecutor = new PresetExecutor(presetsConfig);

        // 后台任务静默探针定时器
        this.taskProbeTimers = new Map();
        
        this.securityLevels = {
            basic: ['blacklist'],
            standard: ['blacklist', 'whitelist', 'ast'],
            high: ['blacklist', 'whitelist', 'ast'],
            maximum: ['blacklist', 'whitelist', 'ast', 'audit']
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

    _detectPrivilegeEscalation(command) {
        const patterns = [
            { name: 'sudo', regex: /(^|[\s;&|()])sudo(\s|$)/ },
            { name: 'pkexec', regex: /(^|[\s;&|()])pkexec(\s|$)/ },
            { name: 'doas', regex: /(^|[\s;&|()])doas(\s|$)/ },
            { name: 'su', regex: /(^|[\s;&|()])su(\s+-|\s|$)/ }
        ];
        const matched = patterns.find((item) => item.regex.test(command));
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

    async init() {
        await this.auditLogger.init();

        // v2.0：任务哨兵由 TaskStore 独立管理，不再注入 LinuxLogMonitor。
        const stats = taskStore.getStats();
        logInfo(`[LinuxShellExecutor] 任务追踪器就绪: ${stats.total} 个历史任务 (${stats.stateFile})`);
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
    
    _validateHost(hostId) {
        const config = hostsConfig && hostsConfig.hosts ? hostsConfig.hosts[hostId] : null;
        if (!config) {
            return {
                hostId,
                status: 'error',
                durationMs: 1,
                output: `目标主机 "${hostId}" 未在 hosts.json 中配置或不可达`,
                suggestion: '可调用 action=listHosts 查看可用主机与标签。'
            };
        }
        if (config.enabled === false) {
            return {
                hostId,
                status: 'error',
                durationMs: 1,
                output: `目标主机 "${hostId}" 已禁用（enabled: false）`,
                suggestion: '请在 hosts.json 中将该主机 enabled 设为 true 后重试。'
            };
        }
        return null;
    }

    /**
     * v2.0 统一安全校验：所有执行入口（普通命令、脱钩任务、虚拟终端、预设）
     * 在进入执行队列前都必须通过同一套授权管线。
     *
     * 顺序：提权前置拦截 → 特殊操作符 → 黑名单 → 白名单/灰名单/授权码逃逸
     *       → AST 语义分析 → 审计。
     */
    async validateCommandSecurity(command, options = {}) {
        const hostId = options.hostId || 'local';
        const hostConfig = options.hostConfig || {};
        const requestedLevel = String(
            options.securityLevel
            || hostConfig.securityLevel
            || process.env.DEFAULT_SECURITY_LEVEL
            || 'standard'
        ).toLowerCase();
        const securityLevel = this.securityLevels[requestedLevel]
            ? requestedLevel
            : 'standard';
        const enabledLayers = this.securityLevels[securityLevel] || this.securityLevels.standard;

        const authCode = options.authCode || null;
        const requireAdmin = options.requireAdmin;
        const doubleConfirm = options.doubleConfirm === true;
        const authOk = Boolean(
            authCode
            && requireAdmin
            && String(requireAdmin) === String(authCode)
        );

        const isPresetCommand = options.isPresetCommand === true;
        const presetSecurityLevel = String(options.presetSecurityLevel || 'safe').toLowerCase();
        const presetName = options.presetName || '';

        const auditEntry = {
            command,
            hostId,
            securityLevel,
            timestamp: new Date().toISOString(),
            status: 'pending',
            layers: []
        };

        const reject = async (layer, reason, severity = 'high', message = reason) => {
            auditEntry.status = 'blocked';
            auditEntry.reason = reason;
            auditEntry.layer = layer;
            auditEntry.severity = severity;
            // 拦截事件始终落审计，避免攻击探测无痕。
            try {
                await this.auditLogger.log(auditEntry);
            } catch (_) {}

            return {
                ok: false,
                securityLevel,
                enabledLayers,
                block: {
                    hostId,
                    status: 'error',
                    durationMs: 0,
                    output: message,
                    security: {
                        layer,
                        reason,
                        severity,
                        securityLevel
                    }
                }
            };
        };

        // 1. 提权前置拦截（sudo / su / pkexec / doas）
        const privilegeEscalation = this._detectPrivilegeEscalation(command);
        if (privilegeEscalation) {
            const response = this._buildPrivilegeEscalationResponse(command, privilegeEscalation);
            return reject(
                'preflight',
                `检测到提权命令: ${privilegeEscalation.command}`,
                'critical',
                response.message
            );
        }

        // 预设命令：管理员在 presets.json 中维护的可信模板。
        // 允许携带管道、重定向、SQL 分号等模板语法，因此跳过
        // 黑/白/灰名单、特殊操作符与 AST 文本规则；仍保留提权前置拦截、
        // 预设 securityLevel 验证（write/danger）与审计。
        if (isPresetCommand) {
            if (presetSecurityLevel === 'write' || presetSecurityLevel === 'danger') {
                const needsDoubleConfirm = presetSecurityLevel === 'danger';
                const presetLabel = presetName ? `预设 "${presetName}"` : '预设命令';

                if (!requireAdmin) {
                    return reject(
                        'preset',
                        `${presetLabel} 需要${needsDoubleConfirm ? '二次' : ''}确认`,
                        'high',
                        `${presetLabel} 需要${needsDoubleConfirm ? '二次' : ''}确认！\n安全级别: ${presetSecurityLevel.toUpperCase()}\n请提供 requireAdmin 参数（6位验证码）。`
                    );
                }
                if (!authCode) {
                    return reject(
                        'preset',
                        '无法获取管理员验证码',
                        'high',
                        '无法获取管理员验证码。请确保主服务器配置正确。'
                    );
                }
                if (String(requireAdmin) !== String(authCode)) {
                    return reject('preset', '管理员验证码错误', 'high', '管理员验证码错误。');
                }
                if (needsDoubleConfirm && !doubleConfirm) {
                    return reject(
                        'preset',
                        '高危预设需要二次确认',
                        'critical',
                        `${presetLabel} 属于高危操作，需要二次确认！请同时提供 doubleConfirm: true 参数。`
                    );
                }
            }

            auditEntry.layers.push({
                name: 'preset',
                result: {
                    passed: true,
                    reason: '预设模板跳过黑/白/灰名单、特殊操作符与 AST'
                }
            });
            auditEntry.status = 'allowed';
            return {
                ok: true,
                securityLevel,
                enabledLayers,
                auditEntry
            };
        }

        // 2. 特殊操作符硬护栏（不可通过授权码绕过）
        const specialOpResult = this.securityLevelValidator.checkSpecialOperators(command);
        auditEntry.layers.push({ name: 'specialOperators', result: specialOpResult });
        if (!specialOpResult.passed) {
            return reject(
                'securityLevel',
                specialOpResult.reason,
                'critical',
                `[安全分级] ${specialOpResult.reason}。该操作不可通过授权码绕过。`
            );
        }

        // 3. 黑名单
        if (enabledLayers.includes('blacklist')) {
            const blacklistResult = this.blacklistFilter.check(command);
            auditEntry.layers.push({ name: 'blacklist', result: blacklistResult });
            if (!blacklistResult.passed) {
                return reject(
                    'blacklist',
                    blacklistResult.reason,
                    blacklistResult.severity || 'critical',
                    `[黑名单] ${blacklistResult.reason}`
                );
            }
        }

        // 4. 白名单 / 灰名单 / 未知命令授权码逃逸
        if (enabledLayers.includes('whitelist')) {
            const whitelistCheck = this.whitelistValidator.check(command);
            const graylistCheck = this.graylistValidator.check(command);

            let whitelistPassed = false;
            let whitelistFailResult = null;

            if (whitelistCheck.inWhitelist) {
                const whitelistResult = this.whitelistValidator.validate(command);
                auditEntry.layers.push({ name: 'whitelist', result: whitelistResult });
                if (whitelistResult.passed) {
                    whitelistPassed = true;
                } else {
                    whitelistFailResult = whitelistResult;
                }
            }

            if (!whitelistPassed) {
                if (graylistCheck.inGraylist) {
                    const riskLevel = graylistCheck.riskLevel;
                    const riskLevelConfig = this.graylistValidator.riskLevels[riskLevel] || {};
                    const needsDoubleConfirm = riskLevelConfig.doubleConfirm === true;

                    if (!authOk) {
                        let authMsg;
                        if (!requireAdmin) {
                            authMsg = `[灰名单] 命令 "${graylistCheck.parsedCommand.command}" 需要管理员验证码（风险级别: ${riskLevel}）。请提供 requireAdmin 参数（6位验证码）。`;
                        } else if (!authCode) {
                            authMsg = '无法获取管理员验证码。请确保主服务器配置正确。';
                        } else {
                            authMsg = '管理员验证码错误。';
                        }
                        return reject('graylist', authMsg, 'high', authMsg);
                    }

                    const graylistResult = this.graylistValidator.validate(command);
                    auditEntry.layers.push({ name: 'graylist', result: graylistResult });
                    if (!graylistResult.passed) {
                        return reject(
                            'graylist',
                            graylistResult.reason,
                            graylistResult.severity || 'high',
                            `[灰名单] ${graylistResult.reason}`
                        );
                    }

                    if (needsDoubleConfirm && !doubleConfirm) {
                        return reject(
                            'graylist',
                            '高危操作需要二次确认',
                            'critical',
                            `[灰名单] 高危操作需要二次确认！请同时提供 doubleConfirm: true 参数。\n命令: ${command}\n风险级别: ${riskLevel}`
                        );
                    }
                } else if (whitelistCheck.inWhitelist) {
                    // 在白名单中但参数/路径/管道不合法，且不在灰名单中：不可用授权码逃逸。
                    return reject(
                        'whitelist',
                        whitelistFailResult.reason,
                        whitelistFailResult.severity || 'high',
                        `[白名单] ${whitelistFailResult.reason}`
                    );
                } else {
                    // 不在任何名单中：必须提供有效管理员验证码。
                    if (!authOk) {
                        let authMsg;
                        if (!requireAdmin) {
                            authMsg = `[安全分级] 命令 "${extractBaseCommand(command)}" 不在任何名单中，如需执行请提供正确的管理员验证码。`;
                        } else if (!authCode) {
                            authMsg = '无法获取管理员验证码。请确保主服务器配置正确。';
                        } else {
                            authMsg = '管理员验证码错误。';
                        }
                        return reject('securityLevel', authMsg, 'medium', authMsg);
                    }

                    logWarn(`[LinuxShellExecutor] 未知命令 "${extractBaseCommand(command)}" 通过授权码逃逸`);
                    auditEntry.layers.push({
                        name: 'securityLevel',
                        result: { passed: true, reason: '未知命令通过授权码逃逸' }
                    });
                }
            }
        }

        // 5. AST 语义分析
        if (enabledLayers.includes('ast')) {
            const astResult = this.astAnalyzer.analyze(command);
            auditEntry.layers.push({ name: 'ast', result: astResult });
            if (!astResult.passed) {
                const reason = astResult.risks.map((risk) => risk.description).join('; ');
                return reject('ast', reason, 'critical', `[AST分析] ${reason}`);
            }
        }

        auditEntry.status = 'allowed';
        return {
            ok: true,
            securityLevel,
            enabledLayers,
            auditEntry
        };
    }

    /**
     * 低层命令执行：SSH 主机交给共享 SSHManager；本地主机使用独立 bash。
     * 注意：本地超时只终止等待脚本，不会杀死已 nohup 脱钩的后台任务。
     */
    async _runRaw(hostId, command, options = {}) {
        const hostConfig = (hostsConfig && hostsConfig.hosts ? hostsConfig.hosts[hostId] : null) || {};
        const timeout = Math.max(5000, Number(options.timeout) || getDefaultSyncTimeout());

        if (hostConfig.type === 'ssh') {
            const manager = getSSHManager();
            if (!manager) {
                throw new Error(getSSHLoadError() || 'SSH 模块未加载，无法执行远程命令');
            }
            const execOptions = {
                timeout,
                signal: options.signal,
                disconnectOnCommandTimeout: options.disconnectOnCommandTimeout === true,
                bypassExecutionQueue: options.bypassExecutionQueue !== false
            };
            if (options.terminalId) {
                execOptions.terminalId = options.terminalId;
            }
            if (options.usePool !== undefined) {
                execOptions.usePool = options.usePool;
            }
            if (options.queueWaitTimeout !== undefined) {
                execOptions.queueWaitTimeout = options.queueWaitTimeout;
            }
            if (options.maxExecutionQueueLength !== undefined) {
                execOptions.maxExecutionQueueLength = options.maxExecutionQueueLength;
            }
            return manager.execute(hostId, command, execOptions);
        }

        return this._runLocalCommand(command, options);
    }

    _runLocalCommand(command, options = {}) {
        const { spawn } = require('child_process');
        const timeout = Math.max(1000, Number(options.timeout) || getDefaultSyncTimeout());
        const signal = options.signal;

        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(signal.reason instanceof Error ? signal.reason : new Error('本地命令已取消'));
                return;
            }

            let stdout = '';
            let stderr = '';
            let settled = false;
            let timer = null;

            const child = spawn('/bin/bash', ['-c', command], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: createSanitizedUserCommandEnv(),
                detached: false
            });

            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (signal && abortHandler) {
                    signal.removeEventListener('abort', abortHandler);
                }
            };
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve(result);
            };
            const abortHandler = () => {
                // 只结束等待脚本；已 nohup 的后台任务继续运行。
                try { child.kill('SIGKILL'); } catch (_) {}
                finish(signal.reason instanceof Error ? signal.reason : new Error('本地命令已取消'));
            };

            if (signal) {
                signal.addEventListener('abort', abortHandler, { once: true });
            }

            timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (_) {}
                const error = new Error(`本地命令等待超时 (${timeout}ms)`);
                error.code = 'LOCAL_COMMAND_TIMEOUT';
                finish(error);
            }, timeout);

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            child.on('error', (error) => {
                finish(new Error(`本地执行失败: ${error.message}`));
            });
            child.on('close', (code) => {
                finish(null, {
                    stdout,
                    stderr,
                    code,
                    hostId: 'local',
                    executionType: 'local'
                });
            });
        });
    }

    /**
     * 标准命令执行：POSIX 原子回执包装 + 同步等待阈值 + 超时无损脱钩。
     */
    async _executeDetachedCommand(hostId, command, options = {}) {
        const startedAt = Date.now();
        const hostConfig = (hostsConfig.hosts && hostsConfig.hosts[hostId]) || {};
        const validation = this._validateHost(hostId);
        if (validation) return validation;

        const execCommand = this._patchCommandForNonInteractive(command);
        const task = taskStore.createTask({
            hostId,
            command,
            execCommand,
            terminalId: options.terminalId || 'default',
            timeout: options.timeout,
            mode: 'detached'
        });

        const immediate = options.isLongRunning === true;
        const syncWaitMs = immediate
            ? 0
            : Math.max(0, Math.min(Number(options.timeout) || getDefaultSyncTimeout(), MAX_SYNC_WAIT_MS));
        const startCommand = immediate
            ? taskStore.buildStartCommand(task)
            : taskStore.buildStartAndWaitCommand(task, syncWaitMs);

        let raw;
        try {
            raw = await this._runRaw(hostId, startCommand, {
                timeout: syncWaitMs + 10000,
                signal: options.signal,
                bypassExecutionQueue: true,
                disconnectOnCommandTimeout: false,
                usePool: options.usePool,
                terminalId: options.terminalId
            });
        } catch (error) {
            taskStore.updateTask(task.runId, {
                status: 'error',
                endTime: Date.now(),
                lastOutput: error.message
            });
            return {
                hostId,
                status: 'error',
                durationMs: Date.now() - startedAt,
                output: error.message,
                taskId: task.runId,
                executionType: hostConfig.type || 'local'
            };
        }

        if (immediate) {
            taskStore.updateTask(task.runId, {
                status: 'running_detached',
                lastCheckedAt: Date.now()
            });
            this._scheduleTaskProbeLoop(task);
            return {
                hostId,
                status: 'detached',
                durationMs: Date.now() - startedAt,
                taskId: task.runId,
                output: buildDetachedBody(task, '', 0, true),
                executionType: hostConfig.type || 'local'
            };
        }

        const parsed = parseWrapperStdout(raw.stdout);

        if (parsed.ready) {
            let receipt = {};
            try {
                receipt = JSON.parse(parsed.receipt);
            } catch (_) {}
            const exitCode = Number.isFinite(Number(receipt.exit))
                ? Number(receipt.exit)
                : (raw.code || 0);
            const endTime = normalizeReceiptTime(receipt.ts);
            taskStore.updateTask(task.runId, {
                status: 'completed',
                exitCode,
                endTime,
                lastOutput: parsed.log || '',
                lastCheckedAt: Date.now()
            });
            return {
                hostId,
                status: 'completed',
                exitCode,
                durationMs: Math.max(0, endTime - task.startTime),
                output: parsed.log || '',
                taskId: task.runId,
                command,
                executionType: hostConfig.type || 'local'
            };
        }

        if (!parsed.timedOut) {
            const detail = (raw.stderr && raw.stderr.trim())
                || parsed.log
                || raw.stdout
                || '未知错误';
            taskStore.updateTask(task.runId, {
                status: 'error',
                endTime: Date.now(),
                lastOutput: detail
            });
            return {
                hostId,
                status: 'error',
                durationMs: Date.now() - startedAt,
                output: `任务启动失败: ${detail}`,
                taskId: task.runId,
                executionType: hostConfig.type || 'local'
            };
        }

        taskStore.updateTask(task.runId, {
            status: 'running_detached',
            lastOutput: parsed.log || '',
            lastCheckedAt: Date.now()
        });
        this._scheduleTaskProbeLoop(task);

        return {
            hostId,
            status: 'detached',
            durationMs: Date.now() - startedAt,
            taskId: task.runId,
            output: buildDetachedBody(task, parsed.log, syncWaitMs),
            executionType: hostConfig.type || 'local'
        };
    }

    /**
     * 显式 terminalId 的命令：在持久 PTY / SSH Channel 中前台运行，支持按键穿透。
     */
    async _executeInteractiveCommand(hostId, command, options = {}) {
        const startedAt = Date.now();
        const terminalId = options.terminalId || 'default';
        const hostConfig = (hostsConfig.hosts && hostsConfig.hosts[hostId]) || {};
        const manager = getSSHManager();

        if (!manager || typeof manager.openTerminal !== 'function') {
            return {
                hostId,
                status: 'error',
                durationMs: Date.now() - startedAt,
                terminalId,
                output: '当前 SSH 连接模式不支持虚拟终端（需要 direct 模式且 SSHManager 支持 Channel 会话）。'
            };
        }

        try {
            const session = await manager.openTerminal(hostId, terminalId, {
                signal: options.signal
            });
            const waitMs = Math.max(
                200,
                Math.min(Number(options.timeout) || 500, MAX_SYNC_WAIT_MS)
            );
            const result = await session.run(command, { timeout: waitMs });

            if (result.completed) {
                return {
                    hostId,
                    status: 'completed',
                    exitCode: result.exitCode,
                    durationMs: result.durationMs,
                    output: result.output,
                    terminalId,
                    command,
                    executionType: hostConfig.type || 'local'
                };
            }

            return {
                hostId,
                status: 'running',
                durationMs: Date.now() - startedAt,
                output: result.output,
                terminalId,
                command,
                note: `命令仍在终端 [${terminalId}] 前台运行。可调用 action:'queryVisible' 查看画面，action:'sendKey' 注入 Ctrl+C，或 action:'pasteText' 写入 stdin。`,
                executionType: hostConfig.type || 'local'
            };
        } catch (error) {
            return {
                hostId,
                status: 'error',
                durationMs: Date.now() - startedAt,
                terminalId,
                output: error.message,
                executionType: hostConfig.type || 'local'
            };
        }
    }

    async _probeTask(task, options = {}) {
        if (!task) {
            throw new Error('任务不存在');
        }
        if (!['running', 'running_detached', 'detached'].includes(task.status)) {
            return {
                ready: task.status === 'completed',
                task,
                log: task.lastOutput || ''
            };
        }

        const probeCommand = taskStore.buildProbeCommand(task, {
            tailBytes: options.tailBytes
        });

        let raw;
        try {
            raw = await this._runRaw(task.hostId, probeCommand, {
                timeout: 15000,
                bypassExecutionQueue: true,
                disconnectOnCommandTimeout: false
            });
        } catch (error) {
            if (options.silent) {
                return { ready: false, task, error, log: task.lastOutput || '' };
            }
            throw error;
        }

        const parsed = parseProbeStdout(raw.stdout);

        if (parsed.ready) {
            let receipt = {};
            try {
                receipt = JSON.parse(parsed.receipt);
            } catch (_) {}
            const exitCode = Number.isFinite(Number(receipt.exit))
                ? Number(receipt.exit)
                : 0;
            const endTime = normalizeReceiptTime(receipt.ts);
            const updated = taskStore.updateTask(task.runId, {
                status: 'completed',
                exitCode,
                endTime,
                lastOutput: parsed.log || '',
                lastCheckedAt: Date.now()
            });
            this._stopTaskProbeLoop(task.runId);
            return {
                ready: true,
                receipt,
                task: updated,
                log: parsed.log || ''
            };
        }

        const updated = taskStore.updateTask(task.runId, {
            status: 'running_detached',
            lastOutput: parsed.log || '',
            lastCheckedAt: Date.now()
        });
        return {
            ready: false,
            task: updated,
            log: parsed.log || ''
        };
    }

    _scheduleTaskProbeLoop(task) {
        if (!task || !task.runId) return;
        if (!this.taskProbeTimers) this.taskProbeTimers = new Map();
        if (this.taskProbeTimers.has(task.runId)) return;

        const scheduledAt = Date.now();
        const timer = setInterval(() => {
            const current = taskStore.getTask(task.runId);
            if (
                !current
                || current.status !== 'running_detached'
                || Date.now() - scheduledAt > TASK_PROBE_MAX_AGE_MS
            ) {
                this._stopTaskProbeLoop(task.runId);
                return;
            }
            this._probeTask(current, { silent: true }).catch((error) => {
                logDebug(`[LinuxShellExecutor] 后台任务探针失败 ${task.runId}: ${error.message}`);
            });
        }, TASK_PROBE_INTERVAL_MS);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        this.taskProbeTimers.set(task.runId, timer);
    }

    _stopTaskProbeLoop(runId) {
        if (!this.taskProbeTimers) return;
        const timer = this.taskProbeTimers.get(runId);
        if (timer) {
            clearInterval(timer);
            this.taskProbeTimers.delete(runId);
        }
    }

    _stopAllTaskProbes() {
        if (!this.taskProbeTimers) return;
        for (const timer of this.taskProbeTimers.values()) {
            clearInterval(timer);
        }
        this.taskProbeTimers.clear();
    }

    /**
     * 单主机多命令执行 + 结果聚合。
     */
    async _executeHostCommands(hostId, commands, args, presetInfo, options = {}) {
        const validation = this._validateHost(hostId);
        if (validation) return validation;

        const hostConfig = (hostsConfig.hosts && hostsConfig.hosts[hostId]) || {};
        const explicitTerminal = args.terminalId !== undefined
            && args.terminalId !== null
            && String(args.terminalId).trim() !== '';
        const forceNewChannel = parseBooleanValue(args.forceNewChannel);
        const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

        let terminalId = explicitTerminal ? String(args.terminalId).trim() : 'default';
        if (forceNewChannel) {
            terminalId = explicitTerminal
                ? `${terminalId}_sub_${suffix}`
                : `default_sub_${suffix}`;
        } else if (!explicitTerminal) {
            const manager = getSSHManager();
            if (manager && typeof manager.isTerminalBusy === 'function') {
                const busyResult = manager.isTerminalBusy(hostId, 'default');
                const busy = busyResult && typeof busyResult.then === 'function'
                    ? await busyResult
                    : busyResult;
                if (busy) {
                    terminalId = `default_sub_${suffix}`;
                }
            }
        }

        const interactiveFlag = args.interactive === undefined
            ? explicitTerminal
            : parseBooleanValue(args.interactive);
        const interactive = options.interactiveOnly === true
            || (explicitTerminal && interactiveFlag);

        const requestedTimeout = clampTimeout(args.timeout, presetInfo ? presetInfo.timeout : undefined);
        const isLongRunning = parseBooleanValue(args.isLongRunning);
        const blocks = [];

        for (const cmd of commands) {
            const security = await this.validateCommandSecurity(cmd, {
                hostId,
                hostConfig,
                authCode: options.authCode,
                requireAdmin: args.requireAdmin,
                doubleConfirm: parseBooleanValue(args.doubleConfirm),
                securityLevel: args.securityLevel,
                isPresetCommand: Boolean(presetInfo),
                presetSecurityLevel: presetInfo ? presetInfo.securityLevel : undefined,
                presetName: presetInfo ? presetInfo.name : undefined
            });

            if (!security.ok) {
                blocks.push(security.block);
                break;
            }

            let block;
            if (interactive) {
                const interactiveTimeout = options.interactiveOnly === true
                    ? Math.max(200, Math.min(Number(args.startDelayMs) || 500, 5000))
                    : requestedTimeout;
                block = await this._executeInteractiveCommand(hostId, cmd, {
                    terminalId,
                    timeout: interactiveTimeout,
                    startOnly: options.interactiveOnly === true,
                    signal: options.signal
                });
            } else {
                block = await this._executeDetachedCommand(hostId, cmd, {
                    terminalId,
                    timeout: requestedTimeout,
                    isLongRunning,
                    signal: options.signal,
                    usePool: args.usePool
                });
            }

            blocks.push(block);

            if (security.auditEntry && security.enabledLayers.includes('audit')) {
                security.auditEntry.status = block.status === 'error'
                    ? 'failed'
                    : (block.status === 'completed' ? 'success' : block.status);
                security.auditEntry.duration = block.durationMs;
                security.auditEntry.outputLength = (block.output || '').length;
                try {
                    await this.auditLogger.log(security.auditEntry);
                } catch (_) {}
            }

            if (block.status === 'error' || block.status === 'detached' || block.status === 'running') {
                break;
            }
        }

        if (blocks.length === 1) {
            return {
                ...blocks[0],
                hostId,
                terminalId: blocks[0].terminalId || terminalId,
                executionType: hostConfig.type || 'local',
                preset: presetInfo || undefined
            };
        }

        const errors = blocks.filter((block) => block.status === 'error');
        const detached = blocks.find((block) => block.status === 'detached');
        const running = blocks.find((block) => block.status === 'running');
        const last = blocks[blocks.length - 1];
        const outputParts = blocks.map((block) => block.output).filter(Boolean);

        let status = 'completed';
        let exitCode = last.exitCode === undefined ? 0 : last.exitCode;
        let taskId = null;
        let note = null;

        if (errors.length > 0) {
            status = 'error';
        } else if (detached) {
            status = 'detached';
            taskId = detached.taskId;
            note = detached.note;
        } else if (running) {
            status = 'running';
            taskId = running.taskId;
            note = running.note;
        }

        return {
            hostId,
            status,
            exitCode: status === 'completed' ? exitCode : undefined,
            durationMs: blocks.reduce((sum, block) => sum + (block.durationMs || 0), 0),
            output: outputParts.join('\n\n---\n\n'),
            taskId,
            terminalId,
            note,
            commandCount: blocks.length,
            preset: presetInfo || undefined,
            executionType: hostConfig.type || 'local'
        };
    }

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

// ============================================
// 次世代辅助函数
// ============================================

function normalizeActionName(action) {
    return String(action || '').trim().toLowerCase().replace(/[_\-\s]/g, '');
}

function parseHostTokens(input) {
    if (input === undefined || input === null) return [];
    if (Array.isArray(input)) {
        throw new Error('hostId 仅支持逗号分隔字符串，例如 "local,nas,server"；不再支持数组形式。');
    }
    const tokens = [];
    for (const part of String(input).split(/[,\s]+/)) {
        const token = part.trim();
        if (token) tokens.push(token);
    }
    return tokens;
}

/**
 * 多机入参归一化：
 * - 逗号分隔字符串: "local,nas,server"（仅支持此形式，数组已移除）
 * - 空白分隔: "local nas server"
 * - 标签: "@dev" / "tag:linux"（无前缀时若命中标签也会展开）
 * 返回 { targets, invalid }，无效主机不抛错，改为独立 error 块。
 */
function normalizeTargetHosts(input) {
    const tokens = parseHostTokens(input);
    const configuredHosts = (hostsConfig && hostsConfig.hosts) || {};
    const targets = [];
    const invalid = [];
    const seen = new Set();

    const pushHost = (hostId, source) => {
        if (seen.has(hostId)) return;
        seen.add(hostId);
        targets.push({ hostId, source });
    };

    for (const token of tokens) {
        if (configuredHosts[token]) {
            pushHost(token, 'id');
            continue;
        }

        const tag = token.replace(/^@/, '').replace(/^tag:/i, '').trim();
        if (!tag) {
            invalid.push(token);
            continue;
        }

        const matched = Object.entries(configuredHosts).filter(([, config]) => {
            return Array.isArray(config && config.tags) && config.tags.includes(tag);
        });

        if (matched.length > 0) {
            for (const [hostId] of matched) {
                pushHost(hostId, `tag:${tag}`);
            }
        } else {
            invalid.push(token);
        }
    }

    return { targets, invalid, tokens };
}

function getDefaultSyncTimeout() {
    const envTimeout = Number(process.env.TIMEOUT_MS);
    if (Number.isFinite(envTimeout) && envTimeout > 0) {
        return Math.max(1000, Math.min(envTimeout, MAX_SYNC_WAIT_MS));
    }
    return DEFAULT_SYNC_TIMEOUT_MS;
}

function clampTimeout(value, fallback) {
    const source = value !== undefined && value !== null && value !== ''
        ? value
        : fallback;
    const candidate = Number(source);
    if (!Number.isFinite(candidate) || candidate <= 0) {
        return getDefaultSyncTimeout();
    }
    return Math.max(500, Math.min(candidate, MAX_SYNC_WAIT_MS));
}

function clampLines(value, fallback = 50, max = 1000) {
    const candidate = Number(value);
    if (!Number.isFinite(candidate) || candidate <= 0) return fallback;
    return Math.max(1, Math.min(Math.round(candidate), max));
}

function normalizeReceiptTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return Date.now();
    }
    // 兼容旧版秒级回执
    return timestamp > 1e12 ? timestamp : timestamp * 1000;
}

function tailLines(text, lines) {
    const max = Math.max(1, Number(lines) || 50);
    const clean = String(text === undefined || text === null ? '' : text).replace(/\s+$/, '');
    if (!clean) return '';
    const all = clean.split('\n');
    return all.slice(-max).join('\n');
}

function truncateSingleLine(text, max = 200) {
    const clean = String(text === undefined || text === null ? '' : text)
        .replace(/\s+/g, ' ')
        .trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max)}...`;
}

function parseWrapperStdout(stdout) {
    const text = String(stdout || '');
    const readyToken = '__VCP_READY__';
    const timeoutToken = '__VCP_TIMEOUT__';
    const logToken = '__VCP_LOG__';

    const readyIndex = text.indexOf(readyToken);
    if (readyIndex >= 0) {
        const afterReady = text.slice(readyIndex + readyToken.length);
        const logIndex = afterReady.indexOf(logToken);
        const receipt = (logIndex >= 0 ? afterReady.slice(0, logIndex) : afterReady).trim();
        let log = logIndex >= 0 ? afterReady.slice(logIndex + logToken.length) : '';
        log = log.replace(/^\r?\n/, '');
        return { ready: true, timedOut: false, receipt, log };
    }

    const timeoutIndex = text.indexOf(timeoutToken);
    if (timeoutIndex >= 0) {
        const log = text
            .slice(timeoutIndex + timeoutToken.length)
            .replace(/^\r?\n/, '');
        return { ready: false, timedOut: true, receipt: '', log };
    }

    return { ready: false, timedOut: false, receipt: '', log: text };
}

function parseProbeStdout(stdout) {
    const text = String(stdout || '');
    const readyToken = '__VCP_READY__';
    const pendingToken = '__VCP_PENDING__';
    const logToken = '__VCP_LOG__';

    const logIndex = text.indexOf(logToken);
    const log = logIndex >= 0
        ? text.slice(logIndex + logToken.length).replace(/^\r?\n/, '')
        : '';

    const readyIndex = text.indexOf(readyToken);
    if (readyIndex >= 0) {
        const afterReadyStart = readyIndex + readyToken.length;
        const afterReady = text.slice(afterReadyStart);
        const receiptEnd = logIndex >= 0
            ? Math.max(0, logIndex - afterReadyStart)
            : afterReady.length;
        const receipt = afterReady.slice(0, receiptEnd).trim();
        return { ready: true, pending: false, receipt, log };
    }

    return {
        ready: false,
        pending: text.indexOf(pendingToken) >= 0,
        receipt: '',
        log
    };
}

function buildDetachedBody(task, partialLog, waitMs, immediate = false) {
    const header = immediate
        ? '[LONG-RUNNING] 指令已立即转入主机后台脱钩运行。'
        : `[TIMEOUT] 命令同步等待已超过 ${waitMs}ms 阈值，已无缝转入主机后台脱钩运行。`;
    const lines = [header, `日志哨兵: ${task.logPath}`];
    if (task.receiptPath) {
        lines.push(`回执哨兵: ${task.receiptPath}`);
    }
    lines.push("提示: 进程在后台继续执行，可调用 action: 'queryTask' 查询输出，或通过 SendInteractiveKey 发送控制信号。");

    const notice = lines.join('\n');
    const partial = String(partialLog || '').trim();
    return partial ? `${partial}\n\n${notice}` : notice;
}

function makeMultiToolResult(blocks, extra = {}) {
    const normalized = (blocks || []).filter(Boolean);
    const text = HostOutputFormatter.renderBlocks(normalized);
    return HostOutputFormatter.buildToolResult(text, normalized, extra);
}

function makeToolResult(block, extra = {}) {
    return makeMultiToolResult(block ? [block] : [], extra);
}

function controlSequenceLabel(sequence) {
    const labels = {
        '\x03': '\\x03',
        '\x04': '\\x04',
        '\x1a': '\\x1a',
        '\x0c': '\\x0c',
        '\x15': '\\x15',
        '\r': '\\r',
        '\x1b': '\\x1b',
        '\t': '\\t',
        '\x7f': '\\x7f',
        ' ': '<space>'
    };
    if (labels[sequence]) return labels[sequence];
    try {
        return JSON.stringify(sequence).slice(1, -1);
    } catch (_) {
        return String(sequence);
    }
}

function signalNameForKey(key) {
    const normalized = String(key || '').toLowerCase();
    if (normalized === 'ctrl+c') return 'SIGINT';
    if (normalized === 'ctrl+d') return 'EOF';
    if (normalized === 'ctrl+z') return 'SIGTSTP';
    return normalized.toUpperCase();
}

function buildTaskBlock(task, { lines = 50, log = null } = {}) {
    const output = tailLines(log === null ? task.lastOutput : log, lines);
    const base = {
        hostId: task.hostId,
        taskId: task.runId,
        maxLines: lines,
        output
    };

    switch (task.status) {
        case 'completed': {
            const exitCode = task.exitCode === undefined || task.exitCode === null ? 0 : task.exitCode;
            const duration = task.durationMs || 0;
            return {
                ...base,
                status: 'completed',
                exitCode,
                durationMs: duration,
                meta: `completed, exit: ${exitCode}, totalDuration: ${duration}ms`
            };
        }
        case 'cancelled':
            return {
                ...base,
                status: 'cancelled',
                durationMs: task.durationMs || 0,
                output: output || '任务已取消。'
            };
        case 'error':
            return {
                ...base,
                status: 'error',
                durationMs: task.durationMs || 0,
                output: output || '任务执行失败。'
            };
        default:
            return {
                ...base,
                status: 'running',
                durationMs: Math.max(0, Date.now() - task.startTime),
                note: '任务仍在主机后台运行，可再次 queryTask 查看进度，或 cancelTask 终止。'
            };
    }
}

// ============================================
// Action 处理器
// ============================================

function handleListHosts(executor) {
    const result = { hosts: executor.listHosts() };
    const templateStatus = getDefaultHostsTemplateStatus();
    if (templateStatus) {
        result.sshDisabled = templateStatus;
    }
    return result;
}

async function handleTestConnection(executor, args = {}) {
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

async function handleGetStatus(executor) {
    const result = { connections: await executor.getConnectionStatus() };
    const templateStatus = getDefaultHostsTemplateStatus();
    if (templateStatus) {
        result.sshDisabled = templateStatus;
    }
    return result;
}

async function handleExecuteCommand(executor, args = {}, options = {}) {
    if (!args.command || typeof args.command !== 'string') {
        throw new Error('缺少必需参数: command');
    }

    const defaultHost = (hostsConfig && hostsConfig.defaultHost) || 'local';
    const normalized = normalizeTargetHosts(
        args.hostId === undefined || args.hostId === null || args.hostId === ''
            ? defaultHost
            : args.hostId
    );

    let targets = normalized.targets.map((target) => target.hostId);
    if (targets.length === 0 && normalized.invalid.length === 0) {
        targets = [defaultHost];
    }

    let commandsToExecute = [args.command];
    let presetInfo = null;
    if (executor.presetExecutor && executor.presetExecutor.isPresetCommand(args.command)) {
        const parsed = executor.presetExecutor.parsePresetCommand(args.command);
        if (!parsed.valid) {
            throw new Error(`预设命令解析失败: ${parsed.error}`);
        }
        const expanded = executor.presetExecutor.expandPreset(parsed.presetName, parsed.params);
        if (!expanded.success) {
            throw new Error(`预设命令展开失败: ${expanded.error}`);
        }
        commandsToExecute = expanded.commands;
        const presetDefinition = (presetsConfig.presets || {})[expanded.presetName] || {};
        presetInfo = {
            name: expanded.presetName,
            description: expanded.description,
            outputFormat: expanded.outputFormat,
            timeout: expanded.timeout,
            securityLevel: presetDefinition.securityLevel || 'safe'
        };
    }

    const settled = await Promise.allSettled(
        targets.map((hostId) => executor._executeHostCommands(
            hostId,
            commandsToExecute,
            args,
            presetInfo,
            {
                interactiveOnly: options.interactiveOnly === true,
                signal: options.signal,
                authCode: options.authCode || null
            }
        ))
    );

    const blocks = settled.map((entry, index) => {
        if (entry.status === 'fulfilled') {
            return entry.value;
        }
        const reason = entry.reason;
        return {
            hostId: targets[index],
            status: 'error',
            durationMs: 0,
            output: reason && reason.message ? reason.message : String(reason)
        };
    });

    for (const invalidHost of normalized.invalid) {
        blocks.push({
            hostId: invalidHost,
            status: 'error',
            durationMs: 1,
            output: `目标主机 "${invalidHost}" 未在 hosts.json 中配置或不可达`
        });
    }

    logInfo(
        `[LinuxShellExecutor] 广播完成: ${targets.length} 台已派发, ${normalized.invalid.length} 台无效`
    );

    return makeMultiToolResult(blocks, {
        hosts: targets,
        invalidHosts: normalized.invalid,
        preset: presetInfo || undefined,
        commandCount: commandsToExecute.length
    });
}

async function handleQueryTask(executor, args = {}) {
    const requestedId = args.taskId || args.runId;
    const task = taskStore.getTask(requestedId);
    if (!task) {
        return makeToolResult({
            hostId: args.hostId || 'local',
            status: 'error',
            durationMs: 0,
            output: `未找到任务: ${requestedId || '(缺少 taskId)'}`
        });
    }

    const lines = clampLines(args.lines, 50);
    let current = task;
    let log = task.lastOutput || '';

    const needsProbe = ['running', 'running_detached', 'detached'].includes(task.status)
        || args.refresh === true;

    if (needsProbe) {
        try {
            const probe = await executor._probeTask(task, { tailBytes: 1024 * 1024 });
            current = probe.task || task;
            log = probe.log || log;
        } catch (error) {
            return makeToolResult({
                hostId: task.hostId,
                status: 'error',
                durationMs: 0,
                output: `任务探针失败: ${error.message}`,
                taskId: task.runId
            });
        }
    }

    return makeToolResult(buildTaskBlock(current, { lines, log }), {
        taskId: task.runId,
        status: current.status
    });
}

async function handleListTasks(executor, args = {}) {
    const tasks = taskStore.listTasks({
        hostId: args.hostId,
        status: args.status,
        limit: clampLines(args.limit, 20, 200)
    });

    if (tasks.length === 0) {
        return makeToolResult({
            hostId: args.hostId || 'tasks',
            status: 'list',
            meta: '0 tasks',
            durationMs: 0,
            output: '当前没有登记的任务。'
        });
    }

    const blocks = tasks.map((task) => {
        const metaLines = [
            `任务: ${task.runId}`,
            `主机: ${task.hostId}${task.terminalId ? `, 终端: ${task.terminalId}` : ''}`,
            `命令: ${truncateSingleLine(task.command, 200)}`
        ];

        if (task.status === 'completed') {
            metaLines.push(`状态: completed (exit ${task.exitCode === null ? 0 : task.exitCode})`);
            const tail = tailLines(task.lastOutput, 8);
            if (tail) metaLines.push('', tail);
            return {
                hostId: task.hostId,
                status: 'completed',
                exitCode: task.exitCode === null ? 0 : task.exitCode,
                durationMs: task.durationMs || 0,
                output: metaLines.join('\n'),
                maxLines: 20
            };
        }

        if (task.status === 'cancelled' || task.status === 'error') {
            metaLines.push(`状态: ${task.status}`);
            const tail = tailLines(task.lastOutput, 8);
            if (tail) metaLines.push('', tail);
            return {
                hostId: task.hostId,
                status: task.status,
                durationMs: task.durationMs || 0,
                output: metaLines.join('\n'),
                taskId: task.runId,
                maxLines: 20
            };
        }

        metaLines.push('状态: running_detached');
        const tail = tailLines(task.lastOutput, 8);
        if (tail) metaLines.push('', tail);
        return {
            hostId: task.hostId,
            status: 'running',
            durationMs: Math.max(0, Date.now() - task.startTime),
            output: metaLines.join('\n'),
            taskId: task.runId,
            maxLines: 20
        };
    });

    return makeMultiToolResult(blocks, { count: tasks.length });
}

async function handleCancelTask(executor, args = {}) {
    const requestedId = args.taskId || args.runId;
    const task = taskStore.getTask(requestedId);
    if (!task) {
        return makeToolResult({
            hostId: args.hostId || 'local',
            status: 'error',
            durationMs: 0,
            output: `未找到任务: ${requestedId || '(缺少 taskId)'}`
        });
    }

    if (task.status === 'completed') {
        return makeToolResult({
            hostId: task.hostId,
            status: 'completed',
            exitCode: task.exitCode === undefined ? 0 : task.exitCode,
            durationMs: task.durationMs || 0,
            output: `任务已自然结束，无需取消。\n任务: ${task.runId}`,
            taskId: task.runId
        });
    }

    if (task.status === 'cancelled') {
        return makeToolResult({
            hostId: task.hostId,
            status: 'cancelled',
            durationMs: task.durationMs || 0,
            output: `任务已处于取消状态。\n任务: ${task.runId}`,
            taskId: task.runId
        });
    }

    const startedAt = Date.now();
    try {
        const raw = await executor._runRaw(
            task.hostId,
            taskStore.buildCancelCommand(task),
            {
                timeout: 15000,
                bypassExecutionQueue: true,
                disconnectOnCommandTimeout: false
            }
        );

        const pidMatch = String(raw.stdout || '').match(/__VCP_PID__([^\r\n]*)/);
        const pid = pidMatch ? pidMatch[1].trim() : '';

        taskStore.updateTask(task.runId, {
            status: 'cancelled',
            endTime: Date.now(),
            lastCheckedAt: Date.now()
        });
        executor._stopTaskProbeLoop(task.runId);

        return makeToolResult({
            hostId: task.hostId,
            status: 'cancelled',
            taskId: task.runId,
            durationMs: Date.now() - startedAt,
            output: `已向进程树 (PID: ${pid || '未知'}) 发送 SIGTERM/SIGKILL 终止信号，已清理临时任务哨兵文件。`
        });
    } catch (error) {
        return makeToolResult({
            hostId: task.hostId,
            status: 'error',
            taskId: task.runId,
            durationMs: Date.now() - startedAt,
            output: `取消任务失败: ${error.message}`
        });
    }
}

async function handleSendKey(executor, args = {}) {
    const hostId = args.hostId || 'local';
    const terminalId = args.terminalId || 'default';
    const key = args.key || args.sendKey || args.signal || 'ctrl+c';
    const repeat = Math.max(1, Math.min(50, Number(args.repeat) || 1));
    const manager = getSSHManager();

    if (!manager || typeof manager.sendTerminalKey !== 'function') {
        return makeToolResult({
            hostId,
            status: 'error',
            terminalId,
            durationMs: 0,
            output: '当前 SSH 连接模式不支持虚拟终端按键注入。'
        });
    }

    const startedAt = Date.now();
    try {
        const result = await manager.sendTerminalKey(hostId, terminalId, key, repeat);
        return makeToolResult({
            hostId,
            status: 'signal',
            signal: signalNameForKey(result.key),
            terminalId,
            durationMs: Date.now() - startedAt,
            output: `已向终端 [${terminalId}] 注入控制键: ${result.key} (${controlSequenceLabel(result.sequence)}) (${result.count} 次)。`
        });
    } catch (error) {
        return makeToolResult({
            hostId,
            status: 'error',
            terminalId,
            durationMs: Date.now() - startedAt,
            output: error.message
        });
    }
}

async function handlePasteText(executor, args = {}) {
    const hostId = args.hostId || 'local';
    const terminalId = args.terminalId || 'default';
    const text = args.text !== undefined ? args.text : args.input;
    const manager = getSSHManager();

    if (text === undefined || text === null) {
        return makeToolResult({
            hostId,
            status: 'error',
            terminalId,
            durationMs: 0,
            output: '缺少必需参数: text'
        });
    }

    if (!manager || typeof manager.writeTerminal !== 'function') {
        return makeToolResult({
            hostId,
            status: 'error',
            terminalId,
            durationMs: 0,
            output: '当前 SSH 连接模式不支持虚拟终端 stdin 注入。'
        });
    }

    const submit = args.submit === undefined ? true : parseBooleanValue(args.submit);
    const startedAt = Date.now();

    try {
        const result = await manager.writeTerminal(hostId, terminalId, String(text), submit);
        return makeToolResult({
            hostId,
            status: 'stdin_injected',
            terminalId,
            durationMs: Date.now() - startedAt,
            output: `已向终端 [${terminalId}] 写入 ${result.chars} 个字符${submit ? '并追加回车' : ''}。`
        });
    } catch (error) {
        return makeToolResult({
            hostId,
            status: 'error',
            terminalId,
            durationMs: Date.now() - startedAt,
            output: error.message
        });
    }
}

async function handleQueryVisible(executor, args = {}) {
    const hostId = args.hostId || 'local';
    const terminalId = args.terminalId || 'default';
    const lines = clampLines(args.lines, 20, 500);
    const manager = getSSHManager();

    // 模式 1：查看脱钩任务日志尾部
    if (args.taskId) {
        const task = taskStore.getTask(args.taskId);
        if (!task) {
            return makeToolResult({
                hostId,
                status: 'error',
                durationMs: 0,
                output: `未找到任务: ${args.taskId}`
            });
        }

        let log = task.lastOutput || '';
        if (['running', 'running_detached', 'detached'].includes(task.status)) {
            try {
                const probe = await executor._probeTask(task, { tailBytes: 1024 * 1024 });
                log = probe.log || log;
            } catch (error) {
                return makeToolResult({
                    hostId: task.hostId,
                    status: 'error',
                    taskId: task.runId,
                    durationMs: 0,
                    output: `任务探针失败: ${error.message}`
                });
            }
        }

        return makeToolResult({
            hostId: task.hostId,
            status: 'visible_buffer',
            taskId: task.runId,
            durationMs: 0,
            maxLines: lines,
            output: tailLines(log, lines) || '(任务当前无输出)'
        });
    }

    // 模式 2：查看虚拟终端滑动缓冲区
    if (!manager || typeof manager.getTerminalVisible !== 'function') {
        return makeToolResult({
            hostId,
            status: 'error',
            terminalId,
            durationMs: 0,
            output: '当前 SSH 连接模式不支持虚拟终端。'
        });
    }

    const output = manager.getTerminalVisible(hostId, terminalId, lines);
    if (output === null || output === undefined) {
        return makeToolResult({
            hostId,
            status: 'error',
            terminalId,
            durationMs: 0,
            output: `终端 [${terminalId}] 不存在或已关闭。请先通过 runInTerminal 或带 terminalId 的 command 启动会话。`
        });
    }

    return makeToolResult({
        hostId,
        status: 'visible_buffer',
        terminalId,
        durationMs: 0,
        maxLines: lines,
        output: output || '(终端当前无输出)'
    });
}

async function handleListTerminals() {
    const manager = getSSHManager();
    const terminals = manager && typeof manager.listTerminals === 'function'
        ? await manager.listTerminals()
        : [];

    if (!terminals || terminals.length === 0) {
        return makeToolResult({
            hostId: 'terminals',
            status: 'list',
            meta: '0 terminals',
            durationMs: 0,
            output: '当前没有活跃的虚拟终端。'
        });
    }

    const blocks = terminals.map((terminal) => ({
        hostId: terminal.hostId,
        status: terminal.busy ? 'running' : 'idle',
        meta: `${terminal.busy ? 'busy' : 'idle'}, terminalId: ${terminal.terminalId}`,
        durationMs: 0,
        output: [
            `类型: ${terminal.type}`,
            `当前命令: ${terminal.command || '(空闲)'}`,
            `最后活动: ${new Date(terminal.lastActivityAt).toISOString()}`,
            `缓冲区: ${terminal.bufferBytes} 字节`
        ].join('\n')
    }));

    return makeMultiToolResult(blocks, { count: terminals.length });
}

// ============================================
// 工具入口
// ============================================

async function runToolCall(args = {}, options = {}) {
    const executor = options.executor || await getExecutor();
    const context = options.context || {};
    const disconnectAfterCall = options.disconnectAfterCall === true;
    const authCode = resolveAdminAuthCode(context);

    try {
        logDebug(`[LinuxShellExecutor] 解析后的参数: ${JSON.stringify(args)}`);
        const action = normalizeActionName(args.action);

        switch (action) {
            case 'listhosts':
                return handleListHosts(executor);
            case 'testconnection':
                return await handleTestConnection(executor, args);
            case 'getstatus':
                return await handleGetStatus(executor);
            case 'listpresets':
                return { presets: executor.presetExecutor.listPresets() };
            case 'querytask':
                return await handleQueryTask(executor, args);
            case 'listtasks':
                return await handleListTasks(executor, args);
            case 'canceltask':
                return await handleCancelTask(executor, args);
            case 'sendkey':
            case 'sendinteractivekey':
                return await handleSendKey(executor, args);
            case 'pastetext':
            case 'pasteinteractivetext':
                return await handlePasteText(executor, args);
            case 'queryvisible':
                return await handleQueryVisible(executor, args);
            case 'listterminals':
                return await handleListTerminals(executor);
            case 'runinterminal':
            case 'startinteractive':
                return await handleExecuteCommand(executor, args, {
                    interactiveOnly: true,
                    signal: context.signal,
                    authCode
                });
            default:
                return await handleExecuteCommand(executor, args, {
                    signal: context.signal,
                    authCode
                });
        }
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
        directExecutor._stopAllTaskProbes();
        await directExecutor.disconnectAll();
        directExecutor = null;
        directExecutorInitPromise = null;
    }
    await taskStore.flush();
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
    runToolCall,
    __testing: {
        taskStore,
        hostsConfig,
        normalizeTargetHosts,
        normalizeActionName,
        parseWrapperStdout,
        parseProbeStdout,
        getExecutor,
        getSSHManager
    }
};

if (require.main === module) {
    main();
}
