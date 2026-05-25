#!/usr/bin/env node

const { execSync } = require('child_process');

// ============================================
// ObsidianBridge - VCP <-> Obsidian CLI 桥接器
// Version: 1.2.0
// Author: Nova & 小夜 | 扩展: infinite-vector
// ============================================

const path = require('path');
const fs = require('fs');

/**
 * Load OBSIDIAN_CLI_PATH from config.env (same directory as this script).
 * Falls back to 'obsidian' (system PATH) if not configured.
 */
function loadCliPath() {
    const envFile = path.join(__dirname, 'config.env');
    if (fs.existsSync(envFile)) {
        try {
            const content = fs.readFileSync(envFile, 'utf-8');
            for (const line of content.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
                const [key, ...rest] = trimmed.split('=');
                if (key.trim() === 'OBSIDIAN_CLI_PATH') {
                    const val = rest.join('=').trim();
                    if (val) return val;
                }
            }
        } catch (_) { /* ignore read errors, fall through */ }
    }
    return 'obsidian';
}

const OBSIDIAN_CLI = loadCliPath();

// --- 工具函数 ---

function escapeValue(val, options = {}) {
    if (val === undefined || val === null) return '';
    let str = String(val);
    if (!options.preserveBackslash) {
        str = str.replace(/\\/g, '\\\\');
    }
    return str.replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function buildCommand(subcommand, params = {}, flags = [], vault = null) {
    const parts = [OBSIDIAN_CLI];
    if (vault) {
        parts.push(`vault="${escapeValue(vault)}"`);
    }
    parts.push(subcommand);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            const preserveBackslash = key === 'content';
            parts.push(`${key}="${escapeValue(value, { preserveBackslash })}"`);
        }
    }
    for (const flag of flags) {
        parts.push(flag);
    }
    return parts.join(' ');
}

function execCLI(cmdStr, timeoutMs = 25000) {
    try {
        const stdout = execSync(cmdStr, {
            encoding: 'utf-8',
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 10 * 1024 * 1024
        });
        return { success: true, output: stdout.trim() };
    } catch (err) {
        const stderr = err.stderr ? err.stderr.toString().trim() : '';
        const stdout = err.stdout ? err.stdout.toString().trim() : '';
        const message = stderr || stdout || err.message || 'Unknown CLI error';
        return { success: false, output: message };
    }
}
// --- 安全策略 ---
// 以下 CLI 命令存在破坏性风险，不应添加 handler：
// - 文件操作：delete, move, rename（可能破坏内链结构）
// - 代码执行：eval, dev:*（等同于打开 Obsidian JS 执行权）
// - 插件管理：plugin:install/uninstall（改变运行环境）
// - 历史回滚：history:restore（可能覆盖当前文件）
// - 命令映射说明：桥接器侧用下划线（daily_read），CLI 侧用冒号（daily:read）
// --- 命令处理器 ---

const COMMAND_HANDLERS = {

    // ===== 原有命令（v1.0.0） =====

    read: (args) => {
        if (!args.file && !args.path) {
            return error('缺少必需参数: file 或 path');
        }
        const params = {};
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        const cmd = buildCommand('read', params, [], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('读取笔记失败: ' + result.output);
        return success('笔记内容 [' + (args.file || args.path) + ']:\n\n' + result.output);
    },

    search: (args) => {
        if (!args.query) return error('缺少必需参数: query');
        const params = { query: args.query };
        if (args.limit) params.limit = args.limit;
        if (args.folder) params.path = args.folder;
        const cmd = buildCommand('search', params, [], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('搜索失败: ' + result.output);
        return success('搜索 "' + args.query + '" 的结果:\n\n' + result.output);
    },

    create: (args) => {
        if (!args.name) return error('缺少必需参数: name');
        const params = { name: args.name };
        if (args.content) params.content = args.content;
        if (args.template) params.template = args.template;
        if (args.folder) {
            const baseName = args.name.replace(/\.md$/i, '');
            const fullPath = args.folder.replace(/\/$/, '') + '/' + baseName + '.md';
            params.path = fullPath;
            delete params.name;
        }
        const flags = [];
        if (args.overwrite) flags.push('overwrite');
        const cmd = buildCommand('create', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('创建笔记失败: ' + result.output);
        return success('笔记 "' + args.name + '" 创建成功。' + (result.output ? '\n' + result.output : ''));
    },

    append: (args) => {
        if (!args.file && !args.path) return error('缺少必需参数: file 或 path');
        if (!args.content) return error('缺少必需参数: content');
        const params = { content: args.content };
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        const cmd = buildCommand('append', params, [], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('追加内容失败: ' + result.output);
        return success('已向 "' + (args.file || args.path) + '" 追加内容。' + (result.output ? '\n' + result.output : ''));
    },

    daily_read: (args) => {
        const cmd = buildCommand('daily:read', {}, [], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('读取每日笔记失败: ' + result.output);
        return success('今日每日笔记内容:\n\n' + result.output);
    },

    daily_append: (args) => {
        if (!args.content) return error('缺少必需参数: content');
        const params = { content: args.content };
        const cmd = buildCommand('daily:append', params, [], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('追加每日笔记失败: ' + result.output);
        return success('已向今日每日笔记追加内容。' + (result.output ? '\n' + result.output : ''));
    },

    backlinks: (args) => {
        if (!args.file && !args.path) return error('缺少必需参数: file 或 path');
        const params = {};
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        const cmd = buildCommand('backlinks', params, ['counts'], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('查询反向链接失败: ' + result.output);
        return success('"' + (args.file || args.path) + '" 的反向链接:\n\n' + result.output);
    },

    tags: (args) => {
        const cmd = buildCommand('tags', {}, ['sort=count', 'counts'], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('获取标签统计失败: ' + result.output);
        return success('笔记库标签统计:\n\n' + result.output);
    },

    tasks: (args) => {
        const params = {};
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        if (args.status) params.status = args.status;

        const validScopes = ['daily', 'all', 'file']; if (args.scope && !validScopes.includes(args.scope)) { return error('scope invalid: ' + args.scope + '. Use: daily, all'); } const scope = args.scope || ((args.file || args.path) ? 'file' : 'daily');
        const flags = [];

        if (args.done) {
            flags.push('done');
        } else {
            flags.push('todo');
        }

        if (args.verbose !== false) flags.push('verbose');
        if (scope === 'daily' && !args.file && !args.path) flags.push('daily');

        const cmd = buildCommand('tasks', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('获取任务列表失败: ' + result.output);

        const scopeLabel = (args.file || args.path)
            ? ('指定文件 [' + (args.file || args.path) + ']')
            : (scope === 'daily' ? '今日每日笔记' : '全库');
        return success(scopeLabel + '待办任务:\n\n' + result.output);
    },

    property_set: (args) => {
        if (!args.file && !args.path) return error('缺少必需参数: file 或 path');
        if (!args.name) return error('缺少必需参数: name (属性名)');
        if (args.value === undefined || args.value === null) return error('缺少必需参数: value (属性值)');
        const params = { name: args.name, value: args.value };
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        if (args.type) params.type = args.type;
        const cmd = buildCommand('property:set', params, [], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('设置属性失败: ' + result.output);
        return success('已设置 "' + (args.file || args.path) + '" 的属性 [' + args.name + '] = "' + args.value + '"。' + (result.output ? '\n' + result.output : ''));
    },

    // ===== 新增命令（v1.1.0 by ResearchCC） =====

    files: (args) => {
        const params = {};
        if (args.folder) params.folder = args.folder;
        if (args.ext) params.ext = args.ext;
        const flags = [];
        if (args.total) flags.push('total');
        const cmd = buildCommand('files', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('列出文件失败: ' + result.output);
        return success('文件列表:\n\n' + result.output);
    },

    folders: (args) => {
        const params = {};
        if (args.folder) params.folder = args.folder;
        const flags = [];
        if (args.total) flags.push('total');
        const cmd = buildCommand('folders', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('列出文件夹失败: ' + result.output);
        return success('文件夹列表:\n\n' + result.output);
    },

    prepend: (args) => {
        if (!args.file && !args.path) return error('缺少必需参数: file 或 path');
        if (!args.content) return error('缺少必需参数: content');
        const params = { content: args.content };
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        const flags = [];
        if (args.inline) flags.push('inline');
        const cmd = buildCommand('prepend', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('向文件开头写入失败: ' + result.output);
        return success('已向 "' + (args.file || args.path) + '" 开头写入内容。' + (result.output ? '\n' + result.output : ''));
    },

    daily_prepend: (args) => {
        if (!args.content) return error('缺少必需参数: content');
        const params = { content: args.content };
        const flags = [];
        if (args.inline) flags.push('inline');
        const cmd = buildCommand('daily:prepend', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('向每日笔记开头写入失败: ' + result.output);
        return success('已向今日每日笔记开头写入内容。' + (result.output ? '\n' + result.output : ''));
    },

    daily_path: (args) => {
        const cmd = buildCommand('daily:path', {}, [], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('获取每日笔记路径失败: ' + result.output);
        return success('今日每日笔记路径: ' + result.output);
    },

    search_context: (args) => {
        if (!args.query) return error('缺少必需参数: query');
        const params = { query: args.query };
        if (args.limit) params.limit = args.limit;
        if (args.folder) params.path = args.folder;
        const flags = [];
        if (args.case_sensitive) flags.push('case');
        const cmd = buildCommand('search:context', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('上下文搜索失败: ' + result.output);
        return success('搜索 "' + args.query + '" 的上下文结果:\n\n' + result.output);
    },

    wordcount: (args) => {
        const params = {};
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        const flags = [];
        if (args.words) flags.push('words');
        if (args.characters) flags.push('characters');
        const cmd = buildCommand('wordcount', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('字数统计失败: ' + result.output);
        return success('字数统计 [' + (args.file || args.path || '活跃文件') + ']:\n' + result.output);
    },

    outline: (args) => {
        const params = {};
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        if (args.format) params.format = args.format;
        const flags = [];
        if (args.total) flags.push('total');
        const cmd = buildCommand('outline', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('获取大纲失败: ' + result.output);
        return success('文件大纲 [' + (args.file || args.path || '活跃文件') + ']:\n\n' + result.output);
    },

    property_read: (args) => {
        if (!args.name) return error('缺少必需参数: name (属性名)');
        const params = { name: args.name };
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        const cmd = buildCommand('property:read', params, [], args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('读取属性失败: ' + result.output);
        return success('[' + args.name + '] = ' + result.output);
    },

    properties: (args) => {
        const params = {};
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        if (args.name) params.name = args.name;
        if (args.format) params.format = args.format;
        const flags = [];
        if (args.total) flags.push('total');
        if (args.counts) flags.push('counts');
        if (args.sort) flags.push('sort=' + args.sort);
        const cmd = buildCommand('properties', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('获取属性列表失败: ' + result.output);
        return success('属性列表:\n\n' + result.output);
    },

    links: (args) => {
        if (!args.file && !args.path) return error('缺少必需参数: file 或 path');
        const params = {};
        if (args.file) params.file = args.file;
        if (args.path) params.path = args.path;
        const flags = [];
        if (args.total) flags.push('total');
        const cmd = buildCommand('links', params, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('查询出站链接失败: ' + result.output);
        return success('"' + (args.file || args.path) + '" 的出站链接:\n\n' + result.output);
    },

    templates: (args) => {
        const flags = [];
        if (args.total) flags.push('total');
        const cmd = buildCommand('templates', {}, flags, args.vault);
        const result = execCLI(cmd);
        if (!result.success) return error('获取模板列表失败: ' + result.output);
        return success('模板列表:\n\n' + result.output);
    }
};

// --- 响应构建 ---

function success(text, details = null) {
    const result = {
        status: 'success',
        result: {
            content: [{ type: 'text', text: text }]
        }
    };
    if (details) result.result.details = details;
    return result;
}

function error(message) {
    return {
        status: 'error',
        error: message
    };
}

// --- handleRequest 入口 ---

async function handleRequest(args) {
    const command = args.command;
    if (!command) {
        return error('缺少必需参数: command。可用命令: ' + Object.keys(COMMAND_HANDLERS).join(', '));
    }
    const handler = COMMAND_HANDLERS[command];
    if (!handler) {
        return error('未知命令: "' + command + '"。可用命令: ' + Object.keys(COMMAND_HANDLERS).join(', '));
    }
    try {
        return handler(args);
    } catch (err) {
        return error('ObsidianBridge 内部错误: ' + err.message);
    }
}

module.exports = { handleRequest };

// --- stdio 主入口 ---

async function main() {
    let inputChunks = [];
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
        inputChunks.push(chunk);
    }
    const inputData = inputChunks.join('');
    try {
        if (!inputData.trim()) {
            throw new Error('No input data received from stdin.');
        }
        const parsedArgs = JSON.parse(inputData);
        const resultObject = await handleRequest(parsedArgs);
        console.log(JSON.stringify(resultObject));
    } catch (e) {
        console.log(JSON.stringify({
            status: 'error',
            error: 'ObsidianBridge Error: ' + e.message
        }));
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
