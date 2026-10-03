#!/usr/bin/env node
'use strict';

// Preview: node normalize-plugin-examples.js
// Apply:   node normalize-plugin-examples.js --write
// Backups: .plugin-example-backups/<timestamp>/<relative path>
const fs = require('node:fs/promises');
const path = require('node:path');

const START = '<<<[TOOL_REQUEST]>>>';
const END = '<<<[END_TOOL_REQUEST]>>>';

// Reject malformed/nested blocks instead of guessing and losing description text.
function extractBlocks(text) {
    const tokens = /<<<\[(TOOL_REQUEST|END_TOOL_REQUEST)\]>>>/g;
    const blocks = [];
    let start = null;
    let match;
    while ((match = tokens.exec(text))) {
        if (match[1] === 'TOOL_REQUEST') {
            if (start !== null) return { blocks: [], malformed: true };
            start = match.index;
        } else {
            if (start === null) return { blocks: [], malformed: true };
            blocks.push({ start, end: tokens.lastIndex, text: text.slice(start, tokens.lastIndex) });
            start = null;
        }
    }
    return { blocks, malformed: start !== null };
}

function normalizeManifest(manifest) {
    const changes = [];
    const warnings = [];
    let commandCount = 0;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { changes, warnings, commandCount };
    }
    const groups = [
        ['capabilities.invocationCommands', manifest.capabilities?.invocationCommands],
        ['invocationCommands', manifest.invocationCommands]
    ];
    for (const [location, commands] of groups) {
        if (!Array.isArray(commands)) continue;
        commands.forEach((command, index) => {
            if (!command || typeof command !== 'object' || Array.isArray(command)) return;
            if (typeof command.commandIdentifier !== 'string' || !command.commandIdentifier.trim()) return;
            commandCount++;
            const label = `${location}[${index}] ${command.commandIdentifier}`;
            if (typeof command.description !== 'string') return;
            const { blocks, malformed } = extractBlocks(command.description);
            if (malformed) {
                warnings.push(`${label}: 调用块不完整或嵌套，跳过此命令`);
                return;
            }
            if (!blocks.length) return;
            if (Object.hasOwn(command, 'example') && command.example != null && typeof command.example !== 'string') {
                warnings.push(`${label}: example 不是字符串，跳过此命令`);
                return;
            }
            const hasExample = typeof command.example === 'string' && command.example.trim().length > 0;
            let description = '';
            let cursor = 0;
            for (const block of blocks) {
                description += command.description.slice(cursor, block.start);
                cursor = block.end;
            }
            description += command.description.slice(cursor);
            // Preserve all text outside the blocks, including surrounding whitespace.
            command.description = description;
            if (!hasExample) command.example = blocks.map(block => block.text).join('\n\n');
            changes.push(`${label}: ${hasExample ? '保留现有示例，移除描述调用块' : '迁移描述调用块到示例'}（${blocks.length} 块）`);
        });
    }
    return { changes, warnings, commandCount };
}

async function* findConfigs(directory) {
    const plugins = await fs.readdir(directory, { withFileTypes: true });
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    for (const plugin of plugins) {
        if (!plugin.isDirectory() || ['node_modules', '.git', '.plugin-example-backups'].includes(plugin.name)) continue;
        const pluginDirectory = path.join(directory, plugin.name);
        const entries = await fs.readdir(pluginDirectory, { withFileTypes: true });
        for (const entry of entries) {
            // Only plugin-root manifests; never traverse browser profiles or runtime data.
            if (entry.isFile() && ['plugin-manifest.json', 'plugin-manifest.json.block'].includes(entry.name)) {
                yield path.join(pluginDirectory, entry.name);
            }
        }
    }
}

async function run({ root = path.join(__dirname, 'Plugin'), write = false,
    backupRoot = path.join(__dirname, '.plugin-example-backups'),
    log = console.log } = {}) {
    root = path.resolve(root);
    const backupDirectory = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}`);
    const summary = { files: 0, commands: 0, changedFiles: 0, changedCommands: 0, warnings: 0, errors: 0 };
    log(write ? '写入模式：修改前自动备份。' : '预览模式：不会修改文件。使用 --write 才会写入。');
    log('扫描范围：仅 Plugin/<插件>/plugin-manifest.json 和 plugin-manifest.json.block，不进入运行数据子目录。');
    for await (const file of findConfigs(root)) {
        summary.files++;
        const relative = path.relative(root, file);
        try {
            const original = await fs.readFile(file, 'utf8');
            const bom = original.startsWith('\uFEFF');
            const manifest = JSON.parse(bom ? original.slice(1) : original);
            const result = normalizeManifest(manifest);
            summary.commands += result.commandCount;
            summary.warnings += result.warnings.length;
            for (const warning of result.warnings) log(`[警告] ${relative}: ${warning}`);
            if (!result.commandCount) continue;
            log(`[检查] ${relative}: ${result.commandCount} 个 commandIdentifier`);
            if (!result.changes.length) continue;
            for (const change of result.changes) log(`  ${change}`);
            if (write) {
                // Refuse to overwrite concurrent edits. The backup is byte-for-byte original.
                if (await fs.readFile(file, 'utf8') !== original) throw new Error('文件在扫描后被修改，拒绝覆盖');
                const backup = path.join(backupDirectory, relative);
                await fs.mkdir(path.dirname(backup), { recursive: true });
                await fs.copyFile(file, backup, require('node:fs').constants.COPYFILE_EXCL);
                const indentation = original.match(/\n([ \t]+)"/)?.[1] || '  ';
                const eol = original.includes('\r\n') ? '\r\n' : '\n';
                let output = JSON.stringify(manifest, null, indentation).replace(/\n/g, eol);
                if (/\r?\n$/.test(original)) output += eol;
                if (bom) output = '\uFEFF' + output;
                await fs.writeFile(file, output, 'utf8');
            }
            summary.changedFiles++;
            summary.changedCommands += result.changes.length;
        } catch (error) {
            summary.errors++;
            log(`[错误] ${relative}: ${error.message}`);
        }
    }
    log(`汇总：扫描 ${summary.files} 文件，${summary.commands} 命令；${write ? '已修改' : '待修改'} ${summary.changedFiles} 文件/${summary.changedCommands} 命令；警告 ${summary.warnings}，错误 ${summary.errors}。`);
    if (write && summary.changedFiles) log(`备份目录：${backupDirectory}`);
    return summary;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('用法：node normalize-plugin-examples.js [--write]\n默认只预览；--write 备份并写入。仅扫描 Plugin/<插件>/plugin-manifest.json 和 plugin-manifest.json.block。\n不进入浏览器配置、缓存或其他运行数据目录。\n只处理带 commandIdentifier 的命令；已有非空 example 不覆盖。\n注意：描述中的调用块可能是参数说明模板，迁移前请审阅预览结果。');
    } else if (args.some(arg => arg !== '--write')) {
        console.error('未知选项。使用 --help 查看用法。');
        process.exitCode = 1;
    } else {
        run({ write: args.includes('--write') }).then(summary => {
            if (summary.errors) process.exitCode = 1;
        }).catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
    }
}

module.exports = { START, END, extractBlocks, normalizeManifest, run };