// VCPTavern.js
const fs = require('fs').promises;
const path = require('path');
const express = require('express');

const PRESETS_DIR = path.join(__dirname, 'presets');
const ACCESS_LOG_FILE = path.join(__dirname, 'access_logs.json');
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Shanghai';

class VCPTavern {
    constructor() {
        this.presets = new Map();
        this.accessLogs = new Map(); // 存储预设的最后访问时间
        this.debugMode = false;
    }

    async _loadAccessLogs() {
        try {
            const data = await fs.readFile(ACCESS_LOG_FILE, 'utf-8');
            const logs = JSON.parse(data);
            this.accessLogs = new Map(Object.entries(logs));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[VCPTavern] 加载访问日志失败:', error);
            }
        }
    }

    async _saveAccessLogs() {
        try {
            const logs = Object.fromEntries(this.accessLogs);
            await fs.writeFile(ACCESS_LOG_FILE, JSON.stringify(logs, null, 2));
        } catch (error) {
            console.error('[VCPTavern] 保存访问日志失败:', error);
        }
    }

    // 计算字符串哈希
    _computeHash(str) {
        let hash = 0;
        if (str.length === 0) return hash.toString(16);
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(16);
    }

    // 获取会话唯一标识 (Session Key) - 双锚点机制
    _getSessionKey(messages, explicitId) {
        // 1. 显式 ID (最高优先级)
        if (explicitId) return explicitId;

        // --- 锚点 1: 角色身份 (CharID) ---
        let charId = 'UnknownChar';

        // A. 尝试从 name 字段获取
        const assistantMsg = messages.find(m => m.role === 'assistant' && m.name);
        if (assistantMsg && assistantMsg.name) {
            charId = assistantMsg.name;
        } else {
            // B. 尝试从 System Prompt 正则提取 Name/Char
            const systemMsg = messages.find(m => m.role === 'system');
            if (systemMsg && systemMsg.content) {
                // 匹配 Name: xxx, Char: xxx, 角色: xxx 等常见格式
                // 忽略大小写，取第一行非空内容
                const nameMatch = systemMsg.content.match(/(?:Name|Char|Character|姓名|角色)\s*[:：]\s*([^\n\r]+)/i);
                if (nameMatch && nameMatch[1]) {
                    charId = nameMatch[1].trim();
                } else {
                    // C. 实在找不到名字，计算 System Prompt 的哈希 (作为最后的兜底)
                    // 为了抵抗 RAG 变动，我们取 System Prompt 的 *后半部分* (假设破限词在最后且相对固定)
                    // 或者取整个内容的哈希，虽然不稳定，但总比没有好
                    charId = 'SysHash_' + this._computeHash(systemMsg.content.slice(-500)); // 取后500字符
                }
            }
        }

        // --- 锚点 2: 话题标识 (TopicID) ---
        // 使用第一条 User 消息的哈希作为话题指纹
        // 同一个话题内，第一条用户消息通常是不变的
        let topicId = 'DefaultTopic';
        const firstUserMsg = messages.find(m => m.role === 'user');
        if (firstUserMsg && firstUserMsg.content) {
            // 如果内容是数组(多模态)，转字符串处理
            const contentStr = typeof firstUserMsg.content === 'string'
                ? firstUserMsg.content
                : JSON.stringify(firstUserMsg.content);
            topicId = this._computeHash(contentStr);
        }

        // 组合最终 Key: 角色_话题
        // 例如: "Keqing_a1b2c3d4"
        return `${charId}_${topicId}`;
    }

    _formatDuration(ms) {
        if (ms < 1000) return '刚刚';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}天${hours % 24}小时`;
        if (hours > 0) return `${hours}小时${minutes % 60}分钟`;
        if (minutes > 0) return `${minutes}分钟`;
        return `${seconds}秒`;
    }

    // 即时解析时间占位符，将当前时间"烤死"进内容中
    _resolveTimeVariables(text) {
        if (!text || typeof text !== 'string') return text;

        const now = new Date();
        const date = now.toLocaleDateString('zh-CN', { timeZone: REPORT_TIMEZONE });
        const time = now.toLocaleTimeString('zh-CN', { timeZone: REPORT_TIMEZONE });
        const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: REPORT_TIMEZONE });

        return text
            .replace(/\{\{Date\}\}/g, date)
            .replace(/\{\{Time\}\}/g, time)
            .replace(/\{\{Today\}\}/g, today);
    }

    // 深度解析消息对象中的时间变量
    _resolveMessageTimeVariables(messageObj) {
        if (!messageObj) return messageObj;

        const resolved = JSON.parse(JSON.stringify(messageObj));

        if (typeof resolved.content === 'string') {
            resolved.content = this._resolveTimeVariables(resolved.content);
        } else if (Array.isArray(resolved.content)) {
            resolved.content = resolved.content.map(part => {
                if (part.type === 'text' && typeof part.text === 'string') {
                    return { ...part, text: this._resolveTimeVariables(part.text) };
                }
                return part;
            });
        }

        return resolved;
    }

    async initialize(config) {
        this.debugMode = config.DebugMode || false;
        await this._loadPresets();
        await this._loadAccessLogs();
        console.log('[VCPTavern] 插件已初始化。');
    }

    async _loadPresets() {
        try {
            await fs.mkdir(PRESETS_DIR, { recursive: true });
            const presetFiles = await fs.readdir(PRESETS_DIR);
            this.presets.clear();
            for (const file of presetFiles) {
                if (file.endsWith('.json')) {
                    const presetName = path.basename(file, '.json');
                    try {
                        const content = await fs.readFile(path.join(PRESETS_DIR, file), 'utf-8');
                        this.presets.set(presetName, JSON.parse(content));
                        if (this.debugMode) console.log(`[VCPTavern] 已加载预设: ${presetName}`);
                    } catch (e) {
                        console.error(`[VCPTavern] 加载预设文件失败 ${file}:`, e);
                    }
                }
            }
        } catch (error) {
            console.error('[VCPTavern] 加载预设目录失败:', error);
        }
    }

    // 作为 messagePreprocessor 的核心方法
    async processMessages(messages, config) {
        if (!messages || messages.length === 0) return messages;

        const systemMessage = messages.find(m => m.role === 'system');
        if (!systemMessage || typeof systemMessage.content !== 'string') {
            return messages;
        }

        const triggerRegex = /\{\{VCPTavern::(.+?)\}\}/;
        const match = systemMessage.content.match(triggerRegex);

        if (!match) {
            return messages;
        }

        // 支持解析 {{VCPTavern::PresetName::SessionID}} 格式
        const triggerContent = match[1];
        let [presetName, explicitSessionId] = triggerContent.split('::');

        const preset = this.presets.get(presetName);
        if (!preset || !Array.isArray(preset.rules)) {
            console.warn(`[VCPTavern] 预设 "${presetName}" 未找到或其 'rules' 格式无效。`);
            return messages;
        }

        systemMessage.content = systemMessage.content.replace(triggerRegex, '').trim();
        if (this.debugMode) console.log(`[VCPTavern] 检测到触发器，使用预设: ${presetName}`);

        // --- 计算时间间隔逻辑 ---
        const now = Date.now();
        let lastChatTimeStr = '';
        let timeSinceLastChatStr = '';

        // 获取会话唯一标识
        const sessionKey = this._getSessionKey(messages, explicitSessionId);
        // 组合 Log Key: 预设名 + 会话标识 (例如 "dailychat:Keqing")
        const logKey = `${presetName}:${sessionKey}`;

        if (this.accessLogs.has(logKey)) {
            const lastTime = this.accessLogs.get(logKey);
            const diff = now - lastTime;

            // 格式化上次时间
            const lastDate = new Date(lastTime);
            lastChatTimeStr = `上次对话时间：${lastDate.toLocaleString('zh-CN', { timeZone: REPORT_TIMEZONE })}`;

            // 格式化时间间隔
            timeSinceLastChatStr = `距离上次对话已过去 ${this._formatDuration(diff)}`;

            if (this.debugMode) {
                console.log(`[VCPTavern] 预设 ${presetName} (ID:${sessionKey}) 上次访问: ${lastChatTimeStr}, 间隔: ${timeSinceLastChatStr}`);
            }
        }

        // 更新访问时间并保存 (带防抖：1分钟内的重复请求不刷新时间戳)
        const DEBOUNCE_MS = 60 * 1000; // 1分钟防抖窗口
        const lastLoggedTime = this.accessLogs.get(logKey);
        if (!lastLoggedTime || (now - lastLoggedTime) >= DEBOUNCE_MS) {
            this.accessLogs.set(logKey, now);
            this._saveAccessLogs().catch(e => console.error('[VCPTavern] 异步保存日志失败:', e));
            if (this.debugMode) console.log(`[VCPTavern] 访问时间已更新 (Key: ${logKey})`);
        } else {
            if (this.debugMode) console.log(`[VCPTavern] 防抖生效，跳过时间更新 (距上次仅 ${Math.round((now - lastLoggedTime) / 1000)}s)`);
        }

        // 将计算出的时间变量注入到实例中，供 _resolveTimeVariables 使用
        // 注意：这里我们需要稍微修改 _resolveTimeVariables 来支持这两个新变量
        // 或者我们直接在这里定义一个临时的替换函数
        const resolveExtendedVariables = (text) => {
            if (!text || typeof text !== 'string') return text;
            let resolved = this._resolveTimeVariables(text); // 先处理基础时间变量
            return resolved
                .replace(/\{\{LastChatTime\}\}/g, lastChatTimeStr)
                .replace(/\{\{TimeSinceLastChat\}\}/g, timeSinceLastChatStr);
        };

        // 辅助函数：确保注入内容是消息对象格式
        const ensureMessageObject = (content, defaultRole = 'system') => {
            if (typeof content === 'string') {
                return { role: defaultRole, content: content };
            }
            return content;
        };

        let newMessages = [...messages];

        // 按照注入规则处理
        // 为了处理深度注入，我们先处理嵌入注入，再处理相对注入，最后处理深度注入
        const embedRules = preset.rules.filter(r => r.enabled && r.type === 'embed');
        const relativeRules = preset.rules.filter(r => r.enabled && r.type === 'relative').sort((a, b) => (a.position === 'before' ? -1 : 1));
        const depthRules = preset.rules.filter(r => r.enabled && r.type === 'depth').sort((a, b) => b.depth - a.depth);

        // 1. 嵌入注入 (直接修改现有消息内容) - 恢复兼容老版本
        for (const rule of embedRules) {
            let textToEmbed = typeof rule.content === 'object' ? rule.content.content : rule.content;
            if (typeof textToEmbed !== 'string') continue;

            // 解析时间变量
            textToEmbed = resolveExtendedVariables(textToEmbed);

            if (rule.target === 'system') {
                const systemMsg = newMessages.find(m => m.role === 'system');
                if (systemMsg && typeof systemMsg.content === 'string') {
                    if (rule.position === 'before') {
                        systemMsg.content = textToEmbed.trim() + '\n\n' + systemMsg.content.trim();
                    } else { // after
                        systemMsg.content = systemMsg.content.trim() + '\n\n' + textToEmbed.trim();
                    }
                }
            } else if (rule.target === 'last_user') {
                let lastUserIndex = -1;
                for (let i = newMessages.length - 1; i >= 0; i--) {
                    if (newMessages[i].role === 'user') {
                        lastUserIndex = i;
                        break;
                    }
                }
                if (lastUserIndex !== -1 && typeof newMessages[lastUserIndex].content === 'string') {
                    if (rule.position === 'before') {
                        newMessages[lastUserIndex].content = textToEmbed.trim() + '\n\n' + newMessages[lastUserIndex].content.trim();
                    } else { // after
                        newMessages[lastUserIndex].content = newMessages[lastUserIndex].content.trim() + '\n\n' + textToEmbed.trim();
                    }
                }
            }
        }

        // 2. 相对注入
        for (const rule of relativeRules) {
            // 即时解析时间变量（包含新变量），将当前时间"烤死"进注入内容
            let contentToInject = rule.content;

            if (typeof contentToInject === 'string') {
                contentToInject = resolveExtendedVariables(contentToInject);
            } else if (typeof contentToInject === 'object') {
                const contentStr = JSON.stringify(contentToInject);
                const resolvedStr = resolveExtendedVariables(contentStr);
                contentToInject = JSON.parse(resolvedStr);
            }

            // 确保是对象格式
            const msgObj = ensureMessageObject(contentToInject);

            if (rule.target === 'system') {
                const systemIndex = newMessages.findIndex(m => m.role === 'system');
                if (systemIndex !== -1) {
                    if (rule.position === 'before') {
                        newMessages.splice(systemIndex, 0, msgObj);
                    } else { // after
                        newMessages.splice(systemIndex + 1, 0, msgObj);
                    }
                }
            } else if (rule.target === 'last_user') {
                let lastUserIndex = -1;
                for (let i = newMessages.length - 1; i >= 0; i--) {
                    if (newMessages[i].role === 'user') {
                        lastUserIndex = i;
                        break;
                    }
                }
                if (lastUserIndex !== -1) {
                    if (rule.position === 'after') {
                        newMessages.splice(lastUserIndex + 1, 0, msgObj);
                    } else { // before
                        newMessages.splice(lastUserIndex, 0, msgObj);
                    }
                }
            } else if (rule.target === 'all_user') {
                const userIndices = [];
                for (let i = 0; i < newMessages.length; i++) {
                    if (newMessages[i].role === 'user') {
                        userIndices.push(i);
                    }
                }

                for (let j = userIndices.length - 1; j >= 0; j--) {
                    const userIndex = userIndices[j];
                    let clonedContent = rule.content;
                    if (typeof clonedContent === 'string') {
                        clonedContent = resolveExtendedVariables(clonedContent);
                    } else if (typeof clonedContent === 'object') {
                        const contentStr = JSON.stringify(clonedContent);
                        const resolvedStr = resolveExtendedVariables(contentStr);
                        clonedContent = JSON.parse(resolvedStr);
                    }

                    const clonedMsgObj = ensureMessageObject(clonedContent);

                    if (rule.position === 'after') {
                        newMessages.splice(userIndex + 1, 0, clonedMsgObj);
                    } else { // before
                        newMessages.splice(userIndex, 0, clonedMsgObj);
                    }
                }
            }
        }

        // 3. 深度注入
        for (const rule of depthRules) {
            if (rule.depth > 0) {
                let contentToInject = rule.content;
                if (typeof contentToInject === 'string') {
                    contentToInject = resolveExtendedVariables(contentToInject);
                } else if (typeof contentToInject === 'object') {
                    const contentStr = JSON.stringify(contentToInject);
                    const resolvedStr = resolveExtendedVariables(contentStr);
                    contentToInject = JSON.parse(resolvedStr);
                }

                const msgObj = ensureMessageObject(contentToInject);

                if (rule.depth < newMessages.length) {
                    const injectionIndex = newMessages.length - rule.depth;
                    newMessages.splice(injectionIndex, 0, msgObj);
                } else {
                    const systemIndex = newMessages.findIndex(m => m.role === 'system');
                    if (systemIndex !== -1) {
                        newMessages.splice(systemIndex + 1, 0, msgObj);
                    }
                }
            }
        }

        if (this.debugMode) {
            console.log(`[VCPTavern] 原始消息数量: ${messages.length}, 注入后消息数量: ${newMessages.length}`);
        }

        return newMessages;
    }

    // 作为 service 插件的核心方法
    registerRoutes(app, adminApiRouter, config, projectBasePath) {
        const router = express.Router();
        router.use(express.json({ limit: '10mb' }));

        // 获取所有预设名称
        router.get('/presets', (req, res) => {
            res.json(Array.from(this.presets.keys()));
        });

        // 获取特定预设的详细内容
        router.get('/presets/:name', (req, res) => {
            const preset = this.presets.get(req.params.name);
            if (preset) {
                res.json(preset);
            } else {
                res.status(404).json({ error: 'Preset not found' });
            }
        });

        // 保存/更新预设
        router.post('/presets/:name', async (req, res) => {
            const presetName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, ''); // Sanitize
            if (!presetName) {
                return res.status(400).json({ error: 'Invalid preset name.' });
            }
            const presetData = req.body;
            try {
                const filePath = path.join(PRESETS_DIR, `${presetName}.json`);
                await fs.writeFile(filePath, JSON.stringify(presetData, null, 2));
                this.presets.set(presetName, presetData);
                if (this.debugMode) console.log(`[VCPTavern] 预设已保存: ${presetName}`);
                res.status(200).json({ message: 'Preset saved', name: presetName });
            } catch (error) {
                console.error(`[VCPTavern] 保存预设失败 ${presetName}:`, error);
                res.status(500).json({ error: 'Failed to save preset' });
            }
        });

        // 删除预设
        router.delete('/presets/:name', async (req, res) => {
            const presetName = req.params.name;
            try {
                const filePath = path.join(PRESETS_DIR, `${presetName}.json`);
                await fs.unlink(filePath);
                this.presets.delete(presetName);
                if (this.debugMode) console.log(`[VCPTavern] 预设已删除: ${presetName}`);
                res.status(200).json({ message: 'Preset deleted' });
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Preset not found' });
                }
                console.error(`[VCPTavern] 删除预设失败 ${presetName}:`, error);
                res.status(500).json({ error: 'Failed to delete preset' });
            }
        });

        // 将路由挂载到传入的 adminApiRouter 上
        adminApiRouter.use('/vcptavern', router);

        if (this.debugMode) console.log('[VCPTavern] API 路由已通过 adminApiRouter 注册到 /vcptavern');
    }

    async shutdown() {
        console.log('[VCPTavern] 插件已卸载。');
    }
}

const vcPTavernInstance = new VCPTavern();

// 使得插件能被 Plugin.js 正确加载和初始化
module.exports = {
    initialize: (config) => vcPTavernInstance.initialize(config),
    processMessages: (messages, config) => vcPTavernInstance.processMessages(messages, config),
    registerRoutes: (app, adminApiRouter, config, projectBasePath) => vcPTavernInstance.registerRoutes(app, adminApiRouter, config, projectBasePath),
    shutdown: () => vcPTavernInstance.shutdown(),
};
