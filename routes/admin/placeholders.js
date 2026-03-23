const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const PREVIEW_MAX_LEN = 180;
function truncatePreview(text, maxLen = PREVIEW_MAX_LEN) {
    if (text == null) return '';
    if (typeof text !== 'string') return `<${typeof text}>`;
    const str = String(text).trim();
    if (str.length <= maxLen) return str;
    return Array.from(str).slice(0, maxLen).join('') + '…';
}

function charCount(str) {
    if (str == null) return 0;
    if (typeof str !== 'string') return '-';
    return Array.from(String(str)).length;
}

function getFixedTimeValues() {
    const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Shanghai';
    const now = new Date();
    const date = now.toLocaleDateString('zh-CN', { timeZone: REPORT_TIMEZONE });
    const time = now.toLocaleTimeString('zh-CN', { timeZone: REPORT_TIMEZONE });
    const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: REPORT_TIMEZONE });
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const lunarCalendar = require('chinese-lunar-calendar');
    const lunarDate = lunarCalendar.getLunar(year, month, day);
    let yearName = lunarDate.lunarYear.replace('年', '');
    let festivalInfo = `${yearName}${lunarDate.zodiac}年${lunarDate.dateStr}`;
    if (lunarDate.solarTerm) festivalInfo += ` ${lunarDate.solarTerm}`;
    const port = process.env.PORT || '';
    return { Date: date, Time: time, Today: today, Festival: festivalInfo, Port: port };
}

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager, cachedEmojiLists } = options;

    function getPlaceholderDescriptionsFromManifests() {
        const map = new Map();
        if (!pluginManager.plugins) return map;
        for (const plugin of pluginManager.plugins.values()) {
            const placeholders = plugin.capabilities && plugin.capabilities.systemPromptPlaceholders;
            if (!Array.isArray(placeholders)) continue;
            placeholders.forEach(ph => {
                const desc = (ph && ph.description) ? String(ph.description).trim() : '';
                if (ph && ph.placeholder) {
                    const raw = String(ph.placeholder).trim();
                    map.set(raw, desc);
                    const normalized = raw.replace(/^\{\{|\}\}$/g, '');
                    if (normalized !== raw) map.set(normalized, desc);
                }
            });
        }
        return map;
    }

    function getPluginDescriptionsByToolPlaceholder() {
        const map = new Map();
        if (!pluginManager.plugins) return map;
        for (const plugin of pluginManager.plugins.values()) {
            const hasTools = plugin.capabilities && plugin.capabilities.invocationCommands && plugin.capabilities.invocationCommands.length > 0;
            if (!hasTools) continue;
            const placeholderKey = `VCP${plugin.name}`;
            const desc = (plugin.description != null && plugin.description !== '') ? String(plugin.description).trim() : '';
            map.set(placeholderKey, desc);
        }
        return map;
    }

    // GET list of placeholders
    router.get('/placeholders', async (req, res) => {
        try {
            const list = [];
            const placeholderDescriptions = getPlaceholderDescriptionsFromManifests();
            const getDesc = (nameOrKey) => {
                const withBraces = nameOrKey.includes('{{') ? nameOrKey : `{{${nameOrKey}}}`;
                const withoutBraces = nameOrKey.replace(/^\{\{|\}\}$/g, '');
                return placeholderDescriptions.get(nameOrKey) || placeholderDescriptions.get(withBraces) || placeholderDescriptions.get(withoutBraces) || '';
            };

            // 1. Agent
            const agentManager = require('../../modules/agentManager');
            if (agentManager.agentMap && agentManager.agentMap.size > 0) {
                for (const alias of Array.from(agentManager.agentMap.keys())) {
                    try {
                        const content = await agentManager.getAgentPrompt(alias);
                        list.push({ type: 'agent', name: `{{${alias}}}`, preview: truncatePreview(content), charCount: charCount(content) });
                    } catch (e) {
                        list.push({ type: 'agent', name: `{{${alias}}}`, preview: `[获取失败: ${e.message}]`, charCount: 0 });
                    }
                }
            }

            // 2. Tar / Var
            const tvsManager = require('../../modules/tvsManager');
            const emojiPlaceholderRegex = /^[^{}]+?表情包\.txt$/g;
            const emojiLists = cachedEmojiLists && typeof cachedEmojiLists.get === 'function' ? cachedEmojiLists : new Map();
            const tarVarKeys = Object.keys(process.env).filter(k => k.startsWith('Tar') || k.startsWith('Var'));
            for (const envKey of tarVarKeys) {
                const raw = process.env[envKey] || '';
                let preview = raw;
                if (typeof raw === 'string') {
                    if (emojiPlaceholderRegex.test(raw)) {
                        const emojiName = raw.replace('.txt', '');
                        const emojiList = emojiLists.get(emojiName);
                        preview = emojiList || `[${emojiName}列表不可用]`;
                    } else if (raw.toLowerCase().endsWith('.txt')) {
                        try {
                            preview = await tvsManager.getContent(raw);
                        } catch (e) { preview = `[读取文件失败: ${e.message}]`; }
                    }
                }
                list.push({ type: 'env_tar_var', name: `{{${envKey}}}`, preview: truncatePreview(preview), charCount: charCount(preview) });
            }

            // 3. SarPrompt
            const sarKeys = Object.keys(process.env).filter(k => /^SarPrompt\d+$/.test(k));
            for (const envKey of sarKeys) {
                const raw = process.env[envKey] || '';
                let preview = raw;
                if (typeof raw === 'string') {
                    if (emojiPlaceholderRegex.test(raw)) {
                        const emojiName = raw.replace('.txt', '');
                        const emojiList = emojiLists.get(emojiName);
                        preview = emojiList || `[${emojiName}列表不可用]`;
                    } else if (raw.toLowerCase().endsWith('.txt')) {
                        try {
                            preview = await tvsManager.getContent(raw);
                        } catch (e) { preview = raw || '[按模型注入]'; }
                    }
                }
                list.push({ type: 'env_sar', name: `{{${envKey}}}`, preview: truncatePreview(preview || '[按模型注入]'), charCount: charCount(preview || '[按模型注入]') });
            }

            // 4. Fixed Time/Port
            const fixedVals = getFixedTimeValues();
            for (const key of ['Date', 'Time', 'Today', 'Festival']) {
                list.push({ type: 'fixed', name: `{{${key}}}`, preview: truncatePreview(fixedVals[key]), charCount: charCount(fixedVals[key]) });
            }
            if (fixedVals.Port !== undefined && fixedVals.Port !== '') {
                list.push({ type: 'fixed', name: '{{Port}}', preview: String(fixedVals.Port), charCount: charCount(fixedVals.Port) });
            }

            // 5. Static plugin placeholders
            const staticPlaceholderValues = pluginManager.getAllPlaceholderValues && pluginManager.getAllPlaceholderValues();
            if (staticPlaceholderValues && staticPlaceholderValues.size > 0) {
                for (const [key, value] of staticPlaceholderValues.entries()) {
                    const name = key.includes('{{') ? key : `{{${key}}}`;
                    list.push({ type: 'static_plugin', name, preview: truncatePreview(value), charCount: charCount(value), description: getDesc(name) });
                }
            }

            // 6. Tool descriptions
            const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions && pluginManager.getIndividualPluginDescriptions();
            const pluginDescByTool = getPluginDescriptionsByToolPlaceholder();
            if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
                for (const [placeholderKey, description] of individualPluginDescriptions) {
                    const toolDesc = pluginDescByTool.get(placeholderKey) || '';
                    list.push({ type: 'tool_description', name: `{{${placeholderKey}}}`, preview: truncatePreview(description), charCount: charCount(description), description: toolDesc });
                }
                const vcpDescriptionsList = [...individualPluginDescriptions.values()];
                const allVcpToolsString = vcpDescriptionsList.length > 0 ? vcpDescriptionsList.join('\n\n---\n\n') : '没有可用的VCP工具描述信息';
                list.push({ type: 'vcp_all_tools', name: '{{VCPAllTools}}', preview: truncatePreview(allVcpToolsString), charCount: charCount(allVcpToolsString) });
            }

            // 7. Image_Key
            const effectiveImageKey = pluginManager.getResolvedPluginConfigValue && pluginManager.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
            if (effectiveImageKey) {
                list.push({ type: 'image_key', name: '{{Image_Key}}', preview: '******', charCount: charCount(effectiveImageKey) });
            }

            // 8. Diary Data
            const allDiariesDataString = pluginManager.getPlaceholderValue && pluginManager.getPlaceholderValue('{{AllCharacterDiariesData}}');
            if (allDiariesDataString && !allDiariesDataString.startsWith('[Placeholder')) {
                try {
                    const allDiariesData = JSON.parse(allDiariesDataString);
                    list.push({ type: 'diary', name: '{{AllCharacterDiariesData}}', preview: truncatePreview(allDiariesDataString), charCount: charCount(allDiariesDataString) });
                    for (const characterName of Object.keys(allDiariesData)) {
                        const content = allDiariesData[characterName];
                        list.push({ type: 'diary_character', name: `{{${characterName}日记本}}`, preview: truncatePreview(content), charCount: charCount(content) });
                    }
                } catch (e) {
                    list.push({ type: 'diary', name: '{{AllCharacterDiariesData}}', preview: truncatePreview(allDiariesDataString), charCount: charCount(allDiariesDataString) });
                }
            }

            // 9. Async Placeholder description
            const asyncDesc = '动态占位符：异步任务完成后按 PluginName 与 requestId 替换为结果内容。';
            list.push({ type: 'async_placeholder', name: '{{VCP_ASYNC_RESULT::PluginName::requestId}}', preview: asyncDesc, charCount: charCount(asyncDesc) });

            res.json({ success: true, data: { list } });
        } catch (error) {
            console.error('[AdminPanelRoutes] Error listing placeholders:', error);
            res.status(500).json({ success: false, error: 'Failed to list placeholders' });
        }
    });

    // GET placeholder detail
    router.get('/placeholders/detail', async (req, res) => {
        try {
            const type = req.query.type;
            let name = req.query.name;
            if (!type || name === undefined || name === '') return res.status(400).json({ success: false, error: 'Missing type or name' });
            
            name = decodeURIComponent(String(name));
            const rawName = name.replace(/^\{\{|\}\}$/g, '');
            let value = '';
            switch (type) {
                case 'agent': {
                    const agentManager = require('../../modules/agentManager');
                    if (!agentManager.isAgent(rawName)) return res.status(404).json({ success: false, error: 'Agent not found' });
                    value = await agentManager.getAgentPrompt(rawName);
                    break;
                }
                case 'env_tar_var':
                case 'env_sar': {
                    const envVal = process.env[rawName];
                    if (envVal === undefined) return res.status(404).json({ success: false, error: 'Not found' });
                    value = envVal || '';
                    if (typeof envVal === 'string') {
                        const emojiPlaceholderRegex = /^[^{}]+?表情包\.txt$/g;
                        if (emojiPlaceholderRegex.test(envVal)) {
                            const emojiName = envVal.replace('.txt', '');
                            const emojiLists = cachedEmojiLists && typeof cachedEmojiLists.get === 'function' ? cachedEmojiLists : new Map();
                            value = emojiLists.get(emojiName) || `[${emojiName}列表不可用]`;
                        } else if (envVal.toLowerCase().endsWith('.txt')) {
                            const tvsManager = require('../../modules/tvsManager');
                            value = await tvsManager.getContent(envVal);
                        }
                    }
                    if (type === 'env_sar') value = value || '[当前未配置或按请求模型注入]';
                    break;
                }
                case 'fixed': {
                    const fixedVals = getFixedTimeValues();
                    value = fixedVals[rawName] !== undefined ? String(fixedVals[rawName]) : '[未知]';
                    break;
                }
                case 'static_plugin':
                    value = pluginManager.getPlaceholderValue(rawName);
                    if (value && typeof value === 'string' && value.startsWith('[Placeholder ')) return res.status(404).json({ success: false, error: 'Not found' });
                    if (value != null && typeof value !== 'string') value = JSON.stringify(value, null, 2);
                    break;
                case 'tool_description': {
                    const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions && pluginManager.getIndividualPluginDescriptions();
                    if (!individualPluginDescriptions || !individualPluginDescriptions.has(rawName)) return res.status(404).json({ success: false, error: 'Not found' });
                    value = individualPluginDescriptions.get(rawName) || '';
                    break;
                }
                case 'vcp_all_tools': {
                    const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions && pluginManager.getIndividualPluginDescriptions();
                    const vcpDescriptionsList = individualPluginDescriptions ? [...individualPluginDescriptions.values()] : [];
                    value = vcpDescriptionsList.length > 0 ? vcpDescriptionsList.join('\n\n---\n\n') : '没有可用的VCP工具描述信息';
                    break;
                }
                case 'image_key':
                    value = '安全第一，不显示';
                    break;
                case 'diary':
                    value = pluginManager.getPlaceholderValue && pluginManager.getPlaceholderValue('{{AllCharacterDiariesData}}');
                    break;
                case 'diary_character': {
                    const characterName = rawName.replace(/日记本$/, '');
                    const allDiariesDataString = pluginManager.getPlaceholderValue && pluginManager.getPlaceholderValue('{{AllCharacterDiariesData}}');
                    const allDiariesData = JSON.parse(allDiariesDataString);
                    value = allDiariesData.hasOwnProperty(characterName) ? allDiariesData[characterName] : `[角色「${characterName}」无日记数据]`;
                    break;
                }
                case 'async_placeholder':
                    value = '此占位符为动态格式：`{{VCP_ASYNC_RESULT::插件名::requestId}}`。';
                    break;
                default:
                    return res.status(400).json({ success: false, error: 'Unknown type' });
            }
            res.json({ success: true, data: { name: name.includes('{{') ? name : `{{${name}}}`, value } });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to get placeholder detail' });
        }
    });

    return router;
};
