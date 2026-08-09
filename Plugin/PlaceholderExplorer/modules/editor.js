'use strict';

const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { parseEnvContent } = require('./envScanner');
const { locate } = require('./indexStore');
const { isPathInside, listFilesRecursive, normalizePlaceholder, pathExists, toRelative } = require('./pathUtils');

function timestampForPath() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function serializeEnvValue(value) {
    const text = String(value);
    if (/^[A-Za-z0-9_./:@%+,-]*$/.test(text)) return text;
    if (!text.includes("'")) return `'${text}'`;
    return `"${text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')}"`;
}

async function pruneBackups(backupRoot, retainCount) {
    const limit = Math.max(1, Number(retainCount) || 20);
    const files = await listFilesRecursive(backupRoot, [], { maxFiles: 100000, ignoredNames: [] });
    const records = await Promise.all(files.map(async filePath => ({
        filePath,
        mtimeMs: (await fs.stat(filePath)).mtimeMs
    })));
    records.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(records.slice(limit).map(record => fs.unlink(record.filePath).catch(() => undefined)));
}

async function atomicValidatedWrite(targetPath, newContent, options = {}) {
    const projectRoot = path.resolve(options.projectRoot);
    const target = path.resolve(targetPath);
    if (!isPathInside(projectRoot, target)) throw new Error('拒绝写入扫描根目录之外的路径');
    if (!(await pathExists(target))) throw new Error(`目标文件不存在：${toRelative(projectRoot, target)}`);

    const originalContent = await fs.readFile(target, 'utf8');
    const stat = await fs.stat(target);
    const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    const backupRoot = path.resolve(options.backupRoot);
    if (!isPathInside(options.pluginDir, backupRoot)) throw new Error('备份目录必须位于 PlaceholderExplorer 插件目录内');
    const relativeTarget = toRelative(projectRoot, target);
    const backupPath = path.join(backupRoot, timestampForPath(), ...relativeTarget.split('/'));

    let tempCreated = false;
    try {
        const handle = await fs.open(tempPath, 'wx', stat.mode);
        tempCreated = true;
        try {
            await handle.writeFile(newContent, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }

        const tempContent = await fs.readFile(tempPath, 'utf8');
        if (typeof options.validate === 'function') await options.validate(tempContent);

        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.copyFile(target, backupPath);
        await fs.rename(tempPath, target);
        tempCreated = false;
        await pruneBackups(backupRoot, options.backupRetention);
        return {
            file: relativeTarget,
            backup: toRelative(options.pluginDir, backupPath),
            bytesBefore: Buffer.byteLength(originalContent),
            bytesAfter: Buffer.byteLength(newContent)
        };
    } catch (error) {
        if (tempCreated) await fs.unlink(tempPath).catch(() => undefined);
        throw error;
    }
}

function validateEnvContent(content, key, expectedValue, options = {}) {
    const parsed = parseEnvContent(content, options);
    if (parsed.errors.length > 0) throw new Error(parsed.errors.map(item => item.message).join('；'));
    const matches = parsed.entries.filter(entry => entry.key === key);
    if (matches.length !== 1) throw new Error(`变量 ${key} 必须且只能定义一次，实际 ${matches.length} 次`);
    const dotenvValue = dotenv.parse(content)[key];
    if (dotenvValue !== expectedValue) throw new Error(`变量 ${key} 校验失败，写入值与读取值不一致`);
}

async function editEnvDefinition(entry, newValue, config) {
    const definition = entry.definitions.find(item => item.source === 'config_env');
    if (!definition) throw new Error(`${entry.placeholder} 不在 config.env 中定义`);
    const envPath = path.resolve(config.projectRoot, definition.file);
    if (envPath !== path.resolve(config.envPath)) throw new Error('索引中的 config.env 路径与当前配置不一致');
    const content = await fs.readFile(envPath, 'utf8');
    const parsed = parseEnvContent(content, { projectRoot: config.projectRoot, tvsDir: config.tvsDir });
    const key = entry.placeholder.slice(2, -2);
    const matches = parsed.entries.filter(item => item.key === key);
    if (matches.length !== 1) throw new Error(`变量 ${key} 必须且只能定义一次`);
    const target = matches[0];
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    lines.splice(target.startLine - 1, target.endLine - target.startLine + 1, `${key}=${serializeEnvValue(newValue)}`);
    const newContent = lines.join(eol);
    const writeResult = await atomicValidatedWrite(envPath, newContent, {
        ...config,
        validate: candidate => validateEnvContent(candidate, key, String(newValue), {
            projectRoot: config.projectRoot,
            tvsDir: config.tvsDir
        })
    });
    return { ...writeResult, placeholder: entry.placeholder, source: 'config.env', restartRequired: true };
}

async function editSarDefinition(entry, newValue, config) {
    const definition = entry.definitions.find(item => item.source === 'sarprompt_json');
    if (!definition) throw new Error(`${entry.placeholder} 不在 sarprompt.json 中定义`);
    const sarPath = path.resolve(config.projectRoot, definition.file);
    if (sarPath !== path.resolve(config.sarPromptPath)) throw new Error('索引中的 sarprompt.json 路径与当前配置不一致');
    const groups = JSON.parse(await fs.readFile(sarPath, 'utf8'));
    const promptKey = entry.placeholder.slice(2, -2);
    const matches = groups.filter(group => group?.promptKey === promptKey);
    if (matches.length !== 1) throw new Error(`Sar 定义 ${promptKey} 必须且只能出现一次`);
    matches[0].content = String(newValue);
    const newContent = `${JSON.stringify(groups, null, 2)}\n`;
    const writeResult = await atomicValidatedWrite(sarPath, newContent, {
        ...config,
        validate: candidate => {
            const parsed = JSON.parse(candidate);
            const match = parsed.filter(group => group?.promptKey === promptKey);
            if (match.length !== 1 || match[0].content !== String(newValue)) throw new Error('Sar 写入校验失败');
        }
    });
    return { ...writeResult, placeholder: entry.placeholder, source: 'sarprompt.json', restartRequired: false };
}

async function editResolvedFile(entry, newValue, config) {
    const candidates = entry.definitions.filter(item => item.resolvesTo);
    if (candidates.length !== 1) throw new Error(`${entry.placeholder} 必须唯一指向一个 TVStxt 文件才能编辑文件内容`);
    const targetPath = path.resolve(config.projectRoot, candidates[0].resolvesTo);
    if (!isPathInside(config.tvsDir, targetPath)) throw new Error('只允许编辑 TVStxt 目录内的变量文件');
    const writeResult = await atomicValidatedWrite(targetPath, String(newValue), {
        ...config,
        validate: candidate => {
            if (candidate.includes('\u0000')) throw new Error('文本中不允许包含 NUL 字符');
        }
    });
    return { ...writeResult, placeholder: entry.placeholder, source: 'TVStxt', restartRequired: false };
}

async function editPlaceholder(index, placeholder, newValue, options = {}) {
    if (newValue === undefined || newValue === null) throw new Error('缺少 newValue');
    const maxBytes = Number.isFinite(Number(options.maxEditBytes)) ? Number(options.maxEditBytes) : 1048576;
    if (Buffer.byteLength(String(newValue), 'utf8') > maxBytes) throw new Error(`新内容超过 ${maxBytes} 字节限制`);
    const entry = locate(index, normalizePlaceholder(placeholder));
    if (!entry) throw new Error(`索引中找不到占位符：${placeholder}`);
    if (!entry.editable) throw new Error(`${entry.placeholder} 是只读占位符，不提供写入路径`);
    if (options.scope === 'file') return editResolvedFile(entry, newValue, options);
    if (entry.type === 'sar' && entry.definitions.some(item => item.source === 'sarprompt_json')) {
        return editSarDefinition(entry, newValue, options);
    }
    return editEnvDefinition(entry, newValue, options);
}

module.exports = {
    atomicValidatedWrite,
    editPlaceholder,
    serializeEnvValue,
    validateEnvContent
};
