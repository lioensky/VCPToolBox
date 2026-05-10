const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// 首字符允许中英文数字、下划线、短横线；后续可含点和空格。禁止路径分隔符与连续点号。
const SAFE_NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5][A-Za-z0-9_\-. \u4e00-\u9fa5]{0,63}$/;
const PATH_SEPARATOR_RE = /[\\/]/;
const MAX_TOOL_DESCRIPTION_LENGTH = 2000;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const MARKDOWN_HEADING_RE = /^\s{0,3}#{1,6}\s+/gm;
const FENCE_RE = /```/g;
const DANGEROUS_PROMPT_PHRASE_RE = /(ignore\s+previous\s+instructions|disregard\s+all\s+previous\s+instructions|system\s+prompt|developer\s+message)/gi;

function validateName(name) {
    return (
        typeof name === 'string' &&
        SAFE_NAME_RE.test(name) &&
        !name.includes('..') &&
        !PATH_SEPARATOR_RE.test(name)
    );
}

function resolveInside(baseDir, name, ext) {
    const target = path.resolve(baseDir, `${name}${ext}`);
    const base = path.resolve(baseDir) + path.sep;
    if (!target.startsWith(base)) return null;
    return target;
}

function toolKey(pluginName, toolName) {
    return `${pluginName}::${toolName}`;
}

function clampDescription(value) {
    const normalized = String(value ?? '').replace(/\r\n?/g, '\n').trim();
    if (normalized.length <= MAX_TOOL_DESCRIPTION_LENGTH) {
        return normalized;
    }
    return normalized.slice(0, MAX_TOOL_DESCRIPTION_LENGTH);
}

function sanitizeDescription(value) {
    const normalized = clampDescription(value)
        .replace(HTML_COMMENT_RE, '')
        .replace(MARKDOWN_HEADING_RE, '')
        .replace(FENCE_RE, "'''")
        .replace(DANGEROUS_PROMPT_PHRASE_RE, '[已移除潜在注入语句]')
        .trim();

    return normalized;
}

function normalizeToolDescriptions(input) {
    if (!input || typeof input !== 'object') {
        return {};
    }

    const output = {};
    const entries = Object.entries(input).slice(0, 5000);
    for (const [key, rawValue] of entries) {
        if (typeof rawValue !== 'string') {
            continue;
        }
        const safeValue = sanitizeDescription(rawValue);
        if (!safeValue) {
            continue;
        }
        output[key] = safeValue;
    }

    return output;
}

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager, tvsDirPath } = options;
    const PROJECT_BASE_PATH = path.join(__dirname, '..', '..');
    const TOOL_CONFIGS_DIR = path.join(PROJECT_BASE_PATH, 'ToolConfigs');

    async function ensureToolConfigsDir() {
        try {
            await fs.access(TOOL_CONFIGS_DIR);
        } catch {
            await fs.mkdir(TOOL_CONFIGS_DIR, { recursive: true });
        }
    }

    function collectAllTools() {
        const tools = [];
        for (const [pluginName, manifest] of pluginManager.plugins.entries()) {
            if (manifest.capabilities && manifest.capabilities.invocationCommands) {
                manifest.capabilities.invocationCommands.forEach(cmd => {
                    const name = cmd.commandIdentifier || pluginName;
                    tools.push({
                        uniqueId: toolKey(pluginName, name),
                        name,
                        pluginName,
                        displayName: manifest.displayName || pluginName,
                        description: cmd.description || manifest.description || '',
                        example: cmd.example || ''
                    });
                });
            }
        }
        return tools;
    }

    // GET /tool-list-editor/tools
    router.get('/tool-list-editor/tools', (req, res) => {
        try {
            res.json({ tools: collectAllTools() });
        } catch (error) {
            console.error('[AdminAPI] Error getting tool list:', error);
            res.status(500).json({ error: 'Failed to get tool list' });
        }
    });

    // GET /tool-list-editor/configs
    router.get('/tool-list-editor/configs', async (req, res) => {
        try {
            await ensureToolConfigsDir();
            const files = await fs.readdir(TOOL_CONFIGS_DIR);
            const configs = files
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace(/\.json$/, ''));
            res.json({ configs });
        } catch (error) {
            console.error('[AdminAPI] Error getting config list:', error);
            res.status(500).json({ error: 'Failed to get config list' });
        }
    });

    // GET /tool-list-editor/config/:configName
    router.get('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            const configName = req.params.configName;
            if (!validateName(configName)) {
                return res.status(400).json({ error: 'Invalid config name' });
            }
            await ensureToolConfigsDir();
            const configPath = resolveInside(TOOL_CONFIGS_DIR, configName, '.json');
            if (!configPath) return res.status(400).json({ error: 'Invalid config name' });

            const content = await fs.readFile(configPath, 'utf-8');
            const parsed = JSON.parse(content);
            // Normalize: support both legacy {selectedTools} and new {tools}
            const tools = Array.isArray(parsed.tools)
                ? parsed.tools
                : Array.isArray(parsed.selectedTools) ? parsed.selectedTools : [];
            const toolDescriptions = normalizeToolDescriptions(parsed.toolDescriptions);
            const includeHeader = typeof parsed.includeHeader === 'boolean' ? parsed.includeHeader : true;
            const includeExamples = typeof parsed.includeExamples === 'boolean' ? parsed.includeExamples : true;
            res.json({ tools, toolDescriptions, includeHeader, includeExamples });
        } catch (error) {
            console.error('[AdminAPI] Error loading config:', error);
            const status = error.code === 'ENOENT' ? 404 : 500;
            res.status(status).json({ error: status === 404 ? 'Config not found' : 'Failed to load config' });
        }
    });

    // POST /tool-list-editor/config/:configName
    router.post('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            const configName = req.params.configName;
            if (!validateName(configName)) {
                return res.status(400).json({ error: 'Invalid config name' });
            }
            await ensureToolConfigsDir();
            const configPath = resolveInside(TOOL_CONFIGS_DIR, configName, '.json');
            if (!configPath) return res.status(400).json({ error: 'Invalid config name' });

            const body = req.body || {};
            const rawTools = Array.isArray(body.tools)
                ? body.tools
                : Array.isArray(body.selectedTools) ? body.selectedTools : [];
            const tools = rawTools.filter(t => typeof t === 'string').slice(0, 5000);
            const toolDescriptions = normalizeToolDescriptions(body.toolDescriptions);
            const includeHeader = typeof body.includeHeader === 'boolean' ? body.includeHeader : true;
            const includeExamples = typeof body.includeExamples === 'boolean' ? body.includeExamples : true;

            const configData = { tools, toolDescriptions, includeHeader, includeExamples };
            await fs.writeFile(configPath, JSON.stringify(configData, null, 2), 'utf-8');
            res.json({ status: 'success' });
        } catch (error) {
            console.error('[AdminAPI] Error saving config:', error);
            res.status(500).json({ error: 'Failed to save config' });
        }
    });

    // DELETE /tool-list-editor/config/:configName
    router.delete('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            const configName = req.params.configName;
            if (!validateName(configName)) {
                return res.status(400).json({ error: 'Invalid config name' });
            }
            const configPath = resolveInside(TOOL_CONFIGS_DIR, configName, '.json');
            if (!configPath) return res.status(400).json({ error: 'Invalid config name' });

            await fs.unlink(configPath);
            res.json({ status: 'success' });
        } catch (error) {
            console.error('[AdminAPI] Error deleting config:', error);
            const status = error.code === 'ENOENT' ? 404 : 500;
            res.status(status).json({ error: status === 404 ? 'Config not found' : 'Failed to delete config' });
        }
    });

    // GET /tool-list-editor/check-file/:fileName
    router.get('/tool-list-editor/check-file/:fileName', async (req, res) => {
        try {
            const fileName = req.params.fileName;
            if (!validateName(fileName)) {
                return res.status(400).json({ error: 'Invalid file name' });
            }
            const outputPath = resolveInside(tvsDirPath, fileName, '.txt');
            if (!outputPath) return res.status(400).json({ error: 'Invalid file name' });
            try {
                await fs.access(outputPath);
                res.json({ exists: true });
            } catch {
                res.json({ exists: false });
            }
        } catch (error) {
            console.error('[AdminAPI] Error checking file:', error);
            res.status(500).json({ error: 'Failed to check file' });
        }
    });

    // POST /tool-list-editor/export/:fileName
    router.post('/tool-list-editor/export/:fileName', async (req, res) => {
        try {
            const fileName = req.params.fileName;
            if (!validateName(fileName)) {
                return res.status(400).json({ error: 'Invalid file name' });
            }
            const outputPath = resolveInside(tvsDirPath, fileName, '.txt');
            if (!outputPath) return res.status(400).json({ error: 'Invalid file name' });

            const body = req.body || {};
            const selectedTools = Array.isArray(body.tools)
                ? body.tools
                : Array.isArray(body.selectedTools) ? body.selectedTools : [];
            const selectedSet = new Set(selectedTools.filter(t => typeof t === 'string').slice(0, 5000));
            const toolDescriptions = normalizeToolDescriptions(body.toolDescriptions);
            const includeHeader = !!body.includeHeader;
            const includeExamples = !!body.includeExamples;

            let output = '';
            if (includeHeader) {
                output += 'VCP工具调用格式与指南\r\n\r\n';
                output += '<<<[TOOL_REQUEST]>>>\r\n';
                output += 'maid:「始」你的署名「末」, //重要字段，以进行任务追踪\r\n';
                output += 'tool_name:「始」工具名「末」, //必要字段\r\n';
                output += 'arg:「始」工具参数「末」, //具体视不同工具需求而定\r\n';
                output += '<<<[END_TOOL_REQUEST]>>>\r\n\r\n';
                output += '使用「始」「末」包裹参数来兼容富文本识别。\r\n';
                output += '主动判断当前需求，灵活使用各类工具调用。\r\n\r\n';
                output += '========================================\r\n\r\n';
            }

            const tools = collectAllTools().filter(t => selectedSet.has(t.uniqueId));

            const toolsByPlugin = {};
            tools.forEach(tool => {
                if (!toolsByPlugin[tool.pluginName]) toolsByPlugin[tool.pluginName] = [];
                toolsByPlugin[tool.pluginName].push(tool);
            });

            const sortedPluginNames = Object.keys(toolsByPlugin).sort((a, b) => a.localeCompare(b));
            let pluginIndex = 0;
            sortedPluginNames.forEach(pluginName => {
                pluginIndex++;
                const pluginTools = toolsByPlugin[pluginName];
                const pluginDisplayName = pluginTools[0].displayName || pluginName;

                if (pluginTools.length === 1) {
                    const tool = pluginTools[0];
                    const desc =
                        sanitizeDescription(
                            toolDescriptions[tool.uniqueId] ||
                            toolDescriptions[tool.name] ||
                            tool.description ||
                            '暂无描述'
                        ) ||
                        '暂无描述';
                    output += `${pluginIndex}. ${pluginDisplayName} (${tool.name})\r\n`;
                    output += `插件: ${pluginName}\r\n`;
                    output += `说明: ${desc}\r\n`;
                    if (includeExamples && tool.example) output += `\r\n示例:\r\n${tool.example}\r\n`;
                } else {
                    output += `${pluginIndex}. ${pluginDisplayName}\r\n`;
                    output += `插件: ${pluginName}\r\n`;
                    output += `该插件包含 ${pluginTools.length} 个工具调用:\r\n\r\n`;
                    pluginTools.forEach((tool, toolIdx) => {
                        const desc =
                            sanitizeDescription(
                                toolDescriptions[tool.uniqueId] ||
                                toolDescriptions[tool.name] ||
                                tool.description ||
                                '暂无描述'
                            ) ||
                            '暂无描述';
                        output += `  ${pluginIndex}.${toolIdx + 1} ${tool.name}\r\n`;
                        const descLines = desc.split('\n');
                        descLines.forEach((line, lineIdx) => {
                            if (lineIdx === 0) output += `  说明: ${line}\r\n`;
                            else output += `  ${line}\r\n`;
                        });
                        if (includeExamples && tool.example) {
                            output += `\r\n`;
                            const exampleLines = tool.example.split('\n');
                            exampleLines.forEach(line => { output += `  ${line}\r\n`; });
                        }
                        if (toolIdx < pluginTools.length - 1) output += '\r\n';
                    });
                }
                output += '\r\n----------------------------------------\r\n\r\n';
            });

            await fs.writeFile(outputPath, output, 'utf-8');
            res.json({ status: 'success', filePath: `${path.basename(tvsDirPath)}/${fileName}.txt` });
        } catch (error) {
            console.error('[AdminAPI] Error exporting to txt:', error);
            res.status(500).json({ error: 'Failed to export to txt' });
        }
    });

    return router;
};
