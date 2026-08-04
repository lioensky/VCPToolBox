'use strict';

const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { isPathInside, normalizePlaceholder, pathExists, toRelative } = require('./pathUtils');

function quoteIsClosed(text, quote) {
    for (let index = 1; index < text.length; index += 1) {
        if (text[index] !== quote) continue;
        if (quote === "'" || text[index - 1] !== '\\') return true;
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
        if (slashCount % 2 === 0) return true;
    }
    return false;
}

function classifyEnvKey(key) {
    if (key.startsWith('Tar')) return 'tar';
    if (key.startsWith('Var')) return 'var';
    if (/^SarPrompt(?:\d+|All)$/.test(key)) return 'sar';
    return null;
}

function parseEnvContent(content, options = {}) {
    const lines = String(content || '').split(/\r?\n/);
    const entries = [];
    const errors = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;

        const key = match[1];
        const startLine = index + 1;
        let endIndex = index;
        const firstValue = match[2];
        const quote = firstValue.startsWith("'") || firstValue.startsWith('"') ? firstValue[0] : null;
        if (quote && !quoteIsClosed(firstValue, quote)) {
            while (endIndex + 1 < lines.length) {
                endIndex += 1;
                const combinedValue = [firstValue, ...lines.slice(index + 1, endIndex + 1)].join('\n');
                if (quoteIsClosed(combinedValue, quote)) break;
            }
            const combinedValue = [firstValue, ...lines.slice(index + 1, endIndex + 1)].join('\n');
            if (!quoteIsClosed(combinedValue, quote)) {
                errors.push({ line: startLine, key, message: `变量 ${key} 的引号未闭合` });
            }
        }

        const rawBlock = lines.slice(index, endIndex + 1).join('\n');
        const parsed = dotenv.parse(rawBlock);
        const value = Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : firstValue;
        const type = classifyEnvKey(key);
        let resolvesTo = null;
        let resolvesToAbsolute = null;
        if (type && typeof value === 'string' && value.trim().toLowerCase().endsWith('.txt') && options.tvsDir) {
            const candidate = path.resolve(options.tvsDir, value.trim());
            if (isPathInside(options.tvsDir, candidate)) {
                resolvesToAbsolute = candidate;
                resolvesTo = options.projectRoot ? toRelative(options.projectRoot, candidate) : candidate;
            } else {
                errors.push({ line: startLine, key, message: `变量文件路径越界：${value}` });
            }
        }

        entries.push({
            key,
            placeholder: normalizePlaceholder(key),
            type,
            value,
            rawBlock,
            startLine,
            endLine: endIndex + 1,
            resolvesTo,
            resolvesToAbsolute,
            editable: Boolean(type)
        });
        index = endIndex;
    }

    return { entries, errors };
}

async function scanEnvFile(envPath, options = {}) {
    if (!(await pathExists(envPath))) {
        return { definitions: [], entries: [], errors: [{ line: 0, message: `配置文件不存在：${envPath}` }] };
    }
    const content = await fs.readFile(envPath, 'utf8');
    const parsed = parseEnvContent(content, options);
    const relativeFile = options.projectRoot ? toRelative(options.projectRoot, envPath) : envPath;
    const definitions = parsed.entries
        .filter(entry => entry.type)
        .map(entry => ({
            placeholder: entry.placeholder,
            type: entry.type,
            file: relativeFile,
            line: entry.startLine,
            endLine: entry.endLine,
            value: entry.value,
            resolvesTo: entry.resolvesTo,
            editable: true,
            source: 'config_env'
        }));
    return { ...parsed, definitions, content };
}

async function scanSarPromptFile(sarPromptPath, options = {}) {
    if (!(await pathExists(sarPromptPath))) return { definitions: [], errors: [] };
    const content = await fs.readFile(sarPromptPath, 'utf8');
    const relativeFile = options.projectRoot ? toRelative(options.projectRoot, sarPromptPath) : sarPromptPath;
    try {
        const groups = JSON.parse(content);
        if (!Array.isArray(groups)) throw new Error('根节点必须是数组');
        const definitions = groups
            .filter(group => group && typeof group.promptKey === 'string')
            .map(group => {
                const marker = `"promptKey"`;
                const valueMarker = JSON.stringify(group.promptKey);
                const markerIndex = content.indexOf(valueMarker, content.indexOf(marker));
                const line = content.slice(0, Math.max(0, markerIndex)).split(/\r?\n/).length;
                const value = typeof group.content === 'string' ? group.content : '';
                let resolvesTo = null;
                if (value.toLowerCase().endsWith('.txt') && options.tvsDir) {
                    const candidate = path.resolve(options.tvsDir, value);
                    if (isPathInside(options.tvsDir, candidate)) {
                        resolvesTo = options.projectRoot ? toRelative(options.projectRoot, candidate) : candidate;
                    }
                }
                return {
                    placeholder: normalizePlaceholder(group.promptKey),
                    type: 'sar',
                    file: relativeFile,
                    line,
                    value,
                    resolvesTo,
                    editable: true,
                    source: 'sarprompt_json',
                    models: Array.isArray(group.models) ? group.models : []
                };
            });
        return { definitions, groups, content, errors: [] };
    } catch (error) {
        return { definitions: [], groups: [], content, errors: [{ line: 1, message: `sarprompt.json 无效：${error.message}` }] };
    }
}

module.exports = {
    classifyEnvKey,
    parseEnvContent,
    scanEnvFile,
    scanSarPromptFile
};
