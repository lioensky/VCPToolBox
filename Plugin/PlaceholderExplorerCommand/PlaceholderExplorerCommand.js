'use strict';

const fs = require('fs');
const path = require('path');

console.log = (...args) => console.error(...args);

const sharedRoot = path.resolve(__dirname, '..', 'PlaceholderExplorer');
const { editPlaceholder } = require(path.join(sharedRoot, 'modules', 'editor'));
const { locate } = require(path.join(sharedRoot, 'modules', 'indexStore'));
const { previewPlaceholder } = require(path.join(sharedRoot, 'modules', 'preview'));
const { createScanConfig, ensureIndex, scanProject } = require(path.join(sharedRoot, 'modules', 'scanner'));
const { normalizePlaceholder } = require(path.join(sharedRoot, 'modules', 'pathUtils'));

function readInput() {
    const raw = fs.readFileSync(process.stdin.fd, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
}

function createEditorConfig(scanConfig) {
    const pluginDir = path.resolve(sharedRoot);
    const backupRoot = path.isAbsolute(process.env.PLACEHOLDER_BACKUP_DIR || '')
        ? path.resolve(process.env.PLACEHOLDER_BACKUP_DIR)
        : path.resolve(pluginDir, process.env.PLACEHOLDER_BACKUP_DIR || 'backups');
    return {
        ...scanConfig,
        pluginDir,
        backupRoot,
        backupRetention: Number(process.env.PLACEHOLDER_BACKUP_RETENTION || 20),
        maxEditBytes: Number(process.env.PLACEHOLDER_MAX_EDIT_BYTES || 1048576)
    };
}

function requirePlaceholder(request) {
    const value = request.placeholder || request.name;
    if (!value) throw new Error('缺少 placeholder 参数');
    return normalizePlaceholder(value);
}

async function dispatch(request) {
    const command = String(request.command || 'Locate').trim();
    const scanConfig = createScanConfig();

    if (command === 'Scan') {
        const { index, config } = await scanProject(scanConfig);
        return { command, indexFile: config.indexPath, stats: index.stats, errors: index.errors };
    }

    const { index } = await ensureIndex(scanConfig);
    if (command === 'Locate') {
        const placeholder = requirePlaceholder(request);
        const entry = locate(index, placeholder);
        if (!entry) throw new Error(`索引中找不到占位符：${placeholder}`);
        return { command, entry };
    }
    if (command === 'CheckDeadLinks') {
        return { command, stats: index.stats, ...index.checks, errors: index.errors };
    }
    if (command === 'Edit') {
        const placeholder = requirePlaceholder(request);
        const editResult = await editPlaceholder(index, placeholder, request.newValue ?? request.value ?? request.content, {
            ...createEditorConfig(scanConfig),
            scope: request.scope === 'file' ? 'file' : 'definition'
        });
        const rescanned = await scanProject(scanConfig);
        return {
            command,
            edit: editResult,
            stats: rescanned.index.stats,
            message: editResult.restartRequired
                ? '保存成功。config.env 已备份并原子写回；请重启 VCP 服务后生效。'
                : '保存成功。原文件已备份并原子写回。'
        };
    }
    if (command === 'Preview') {
        const placeholder = requirePlaceholder(request);
        return {
            command,
            preview: await previewPlaceholder(placeholder, {
                config: scanConfig,
                role: request.role || 'system',
                model: request.model,
                text: request.text,
                context: request.context
            })
        };
    }
    throw new Error(`不支持的命令：${command}`);
}

(async () => {
    try {
        const result = await dispatch(readInput());
        process.stdout.write(JSON.stringify({ status: 'success', result }));
    } catch (error) {
        process.stdout.write(JSON.stringify({ status: 'error', error: error.message }));
    }
})();
