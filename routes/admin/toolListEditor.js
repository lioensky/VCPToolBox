const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager, tvsDirPath } = options;
    const PROJECT_BASE_PATH = path.join(__dirname, '..', '..');
    const TOOL_CONFIGS_DIR = path.join(PROJECT_BASE_PATH, 'ToolConfigs');

    // 确保ToolConfigs目录存在
    async function ensureToolConfigsDir() {
        try {
            await fs.access(TOOL_CONFIGS_DIR);
        } catch {
            await fs.mkdir(TOOL_CONFIGS_DIR, { recursive: true });
        }
    }

    // GET /tool-list-editor/tools - 获取所有可用工具列表
    router.get('/tool-list-editor/tools', (req, res) => {
        try {
            const tools = [];
            for (const [pluginName, manifest] of pluginManager.plugins.entries()) {
                if (manifest.capabilities && manifest.capabilities.invocationCommands) {
                    manifest.capabilities.invocationCommands.forEach(cmd => {
                        tools.push({
                            name: cmd.commandIdentifier || pluginName,
                            pluginName: pluginName,
                            displayName: manifest.displayName || pluginName,
                            description: cmd.description || manifest.description || '',
                            example: cmd.example || ''
                        });
                    });
                }
            }
            res.json({ tools });
        } catch (error) {
            console.error('[AdminAPI] Error getting tool list:', error);
            res.status(500).json({ error: 'Failed to get tool list', details: error.message });
        }
    });

    // GET /tool-list-editor/configs - 获取所有可用的配置文件列表
    router.get('/tool-list-editor/configs', async (req, res) => {
        try {
            await ensureToolConfigsDir();
            const files = await fs.readdir(TOOL_CONFIGS_DIR);
            const configs = files
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace('.json', ''));
            res.json({ configs });
        } catch (error) {
            console.error('[AdminAPI] Error getting config list:', error);
            res.status(500).json({ error: 'Failed to get config list', details: error.message });
        }
    });

    // GET /tool-list-editor/config/:configName - 加载指定的配置文件
    router.get('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            const configName = req.params.configName;
            const configPath = path.join(TOOL_CONFIGS_DIR, `${configName}.json`);
            const content = await fs.readFile(configPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminAPI] Error loading config:', error);
            res.status(500).json({ error: 'Failed to load config', details: error.message });
        }
    });

    // POST /tool-list-editor/config/:configName - 保存配置文件
    router.post('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            await ensureToolConfigsDir();
            const configName = req.params.configName;
            const configPath = path.join(TOOL_CONFIGS_DIR, `${configName}.json`);
            const configData = {
                selectedTools: req.body.selectedTools || [],
                toolDescriptions: req.body.toolDescriptions || {}
            };
            await fs.writeFile(configPath, JSON.stringify(configData, null, 2), 'utf-8');
            res.json({ status: 'success', message: 'Config saved successfully' });
        } catch (error) {
            console.error('[AdminAPI] Error saving config:', error);
            res.status(500).json({ error: 'Failed to save config', details: error.message });
        }
    });

    // DELETE /tool-list-editor/config/:configName - 删除配置文件
    router.delete('/tool-list-editor/config/:configName', async (req, res) => {
        try {
            const configName = req.params.configName;
            const configPath = path.join(TOOL_CONFIGS_DIR, `${configName}.json`);
            await fs.unlink(configPath);
            res.json({ status: 'success', message: 'Config deleted successfully' });
        } catch (error) {
            console.error('[AdminAPI] Error deleting config:', error);
            res.status(500).json({ error: 'Failed to delete config', details: error.message });
        }
    });

    // GET /tool-list-editor/check-file/:fileName - 检查文件是否存在
    router.get('/tool-list-editor/check-file/:fileName', async (req, res) => {
        try {
            const fileName = req.params.fileName;
            const outputPath = path.join(tvsDirPath, `${fileName}.txt`);
            try {
                await fs.access(outputPath);
                res.json({ exists: true });
            } catch {
                res.json({ exists: false });
            }
        } catch (error) {
            console.error('[AdminAPI] Error checking file:', error);
            res.status(500).json({ error: 'Failed to check file', details: error.message });
        }
    });

    // POST /tool-list-editor/export/:fileName - 导出为txt文件
    router.post('/tool-list-editor/export/:fileName', async (req, res) => {
        try {
            const fileName = req.params.fileName;
            const outputPath = path.join(tvsDirPath, `${fileName}.txt`);
            const { selectedTools, toolDescriptions, includeHeader, includeExamples } = req.body;
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

            const tools = [];
            for (const [pluginName, manifest] of pluginManager.plugins.entries()) {
                if (manifest.capabilities && manifest.capabilities.invocationCommands) {
                    manifest.capabilities.invocationCommands.forEach(cmd => {
                        const toolName = cmd.commandIdentifier || pluginName;
                        if (selectedTools.includes(toolName)) {
                            tools.push({
                                name: toolName,
                                pluginName: pluginName,
                                displayName: manifest.displayName || pluginName,
                                description: cmd.description || manifest.description || '',
                                example: cmd.example || ''
                            });
                        }
                    });
                }
            }

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
                    const desc = toolDescriptions[tool.name] || tool.description || '暂无描述';
                    output += `${pluginIndex}. ${pluginDisplayName} (${tool.name})\r\n`;
                    output += `插件: ${pluginName}\r\n`;
                    output += `说明: ${desc}\r\n`;
                    if (includeExamples && tool.example) output += `\r\n示例:\r\n${tool.example}\r\n`;
                } else {
                    output += `${pluginIndex}. ${pluginDisplayName}\r\n`;
                    output += `插件: ${pluginName}\r\n`;
                    output += `该插件包含 ${pluginTools.length} 个工具调用:\r\n\r\n`;
                    pluginTools.forEach((tool, toolIdx) => {
                        const desc = toolDescriptions[tool.name] || tool.description || '暂无描述';
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
            res.status(500).json({ error: 'Failed to export to txt', details: error.message });
        }
    });

    return router;
};
