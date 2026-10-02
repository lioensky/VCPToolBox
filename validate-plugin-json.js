#!/usr/bin/env node
'use strict';

// Usage: node validate-plugin-json.js
// Read-only syntax validation, not manifest schema or semantic validation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

async function validateDirectory(root = path.join(__dirname, 'Plugin'), log = console.log) {
    const summary = { files: 0, valid: 0, invalid: 0, directoryErrors: 0 };
    const decoder = new TextDecoder('utf-8', { fatal: true });
    root = path.resolve(root);

    async function visit(directory) {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            summary.directoryErrors++;
            log(`[目录读取失败] ${path.relative(root, directory) || '.'}: ${error.message}`);
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const target = path.join(directory, entry.name);
            // Match the normalizer's scope; never follow symlinks.
            if (entry.isDirectory() && !['node_modules', '.git', '.plugin-example-backups'].includes(entry.name)) {
                await visit(target);
            } else if (entry.isFile() && /\.json(?:\.block)?$/i.test(entry.name)) {
                summary.files++;
                try {
                    const bytes = await fs.readFile(target);
                    let text = decoder.decode(bytes);
                    if (text.startsWith('\uFEFF')) text = text.slice(1);
                    JSON.parse(text);
                    summary.valid++;
                } catch (error) {
                    summary.invalid++;
                    log(`[校验失败] ${path.relative(root, target)}: ${error.message}`);
                }
            }
        }
    }

    log(`只读 JSON 语法及 UTF-8 编码校验：${root}`);
    await visit(root);
    log(`汇总：扫描 ${summary.files} 文件，通过 ${summary.valid}，失败 ${summary.invalid}，目录读取失败 ${summary.directoryErrors}。`);
    if (!summary.invalid && !summary.directoryErrors) {
        log('所有扫描文件均为可解析的 JSON。此结果不代表字段完整性或业务内容正确。');
    }
    return summary;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
        console.log('用法：node validate-plugin-json.js\n只读递归校验 Plugin 下 .json 和 .json.block；支持 UTF-8 BOM。\n跳过 node_modules、.git 和符号链接。失败时返回非零退出码。');
    } else if (args.length) {
        console.error('未知选项。使用 --help 查看用法。');
        process.exitCode = 1;
    } else {
        validateDirectory().then(summary => {
            if (summary.invalid || summary.directoryErrors) process.exitCode = 1;
        }).catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
    }
}

module.exports = { validateDirectory };