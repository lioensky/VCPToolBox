const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

module.exports = function(options) {
    const router = express.Router();
    const ASSISTANT_DIR = path.join(__dirname, '..', '..', 'Plugin', 'AgentAssistant');
    const AGENT_ASSISTANT_CONFIG_FILE = path.join(ASSISTANT_DIR, 'config.env');
    const AGENT_ASSISTANT_SCORES_FILE = path.join(ASSISTANT_DIR, 'agent_scores.json');

    /**
     * 将 Dotenv 格式对象映射为前端需要的 JSON 结构
     */
    function mapEnvToJson(envConfig) {
        const json = {
            maxHistoryRounds: parseInt(envConfig.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS || '7', 10),
            contextTtlHours: parseInt(envConfig.AGENT_ASSISTANT_CONTEXT_TTL_HOURS || '24', 10),
            globalSystemPrompt: envConfig.AGENT_ALL_SYSTEM_PROMPT || '',
            delegationMaxRounds: parseInt(envConfig.DELEGATION_MAX_ROUNDS || '15', 10),
            delegationTimeout: parseInt(envConfig.DELEGATION_TIMEOUT || '300000', 10),
            delegationSystemPrompt: envConfig.DELEGATION_SYSTEM_PROMPT || '',
            delegationHeartbeatPrompt: envConfig.DELEGATION_HEARTBEAT_PROMPT || '',
            agents: []
        };

        const agentBaseNames = new Set();
        for (const key in envConfig) {
            if (key.startsWith('AGENT_') && key.endsWith('_MODEL_ID')) {
                const nameMatch = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i);
                if (nameMatch && nameMatch[1]) agentBaseNames.add(nameMatch[1].toUpperCase());
            }
        }

        for (const baseName of agentBaseNames) {
            json.agents.push({
                baseName: baseName,
                chineseName: envConfig[`AGENT_${baseName}_CHINESE_NAME`] || '',
                modelId: envConfig[`AGENT_${baseName}_MODEL_ID`] || '',
                systemPrompt: envConfig[`AGENT_${baseName}_SYSTEM_PROMPT`] || '',
                maxOutputTokens: parseInt(envConfig[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10),
                temperature: parseFloat(envConfig[`AGENT_${baseName}_TEMPERATURE`] || '0.7'),
                description: envConfig[`AGENT_${baseName}_DESCRIPTION`] || ''
            });
        }

        return json;
    }

    /**
     * 将前端 JSON 结构映射回 Dotenv 格式对象
     */
    function mapJsonToEnv(json, existingEnv) {
        const newEnv = { ...existingEnv };

        // 先清理旧的 AGENT_* 键，防止删除 Agent 后残留
        const preservedKeys = new Set([
            'AGENT_ALL_SYSTEM_PROMPT',
            'AGENT_ASSISTANT_MAX_HISTORY_ROUNDS',
            'AGENT_ASSISTANT_CONTEXT_TTL_HOURS',
        ]);
        for (const key in newEnv) {
            if (key.startsWith('AGENT_') && !preservedKeys.has(key)) {
                delete newEnv[key];
            }
        }

        // 清理完毕后设置全局配置，确保不被清理循环误删
        newEnv.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS = json.maxHistoryRounds;
        newEnv.AGENT_ASSISTANT_CONTEXT_TTL_HOURS = json.contextTtlHours;
        newEnv.AGENT_ALL_SYSTEM_PROMPT = json.globalSystemPrompt;

        // 委托模式配置
        if (json.delegationMaxRounds != null) newEnv.DELEGATION_MAX_ROUNDS = json.delegationMaxRounds;
        if (json.delegationTimeout != null) newEnv.DELEGATION_TIMEOUT = json.delegationTimeout;
        if (json.delegationSystemPrompt != null) newEnv.DELEGATION_SYSTEM_PROMPT = json.delegationSystemPrompt;
        if (json.delegationHeartbeatPrompt != null) newEnv.DELEGATION_HEARTBEAT_PROMPT = json.delegationHeartbeatPrompt;

        // 重新注入 Agent 配置
        const usedBaseNames = new Set();
        if (Array.isArray(json.agents)) {
            json.agents.forEach(agent => {
                let baseName = sanitizeBaseName(agent.baseName) || sanitizeBaseName(agent.chineseName) || '';

                if (!baseName || usedBaseNames.has(baseName)) {
                    baseName = (baseName || 'AGENT') + '_' + Date.now().toString(36).toUpperCase();
                }
                usedBaseNames.add(baseName);

                newEnv[`AGENT_${baseName}_MODEL_ID`] = agent.modelId;
                newEnv[`AGENT_${baseName}_CHINESE_NAME`] = agent.chineseName;
                newEnv[`AGENT_${baseName}_SYSTEM_PROMPT`] = agent.systemPrompt;
                newEnv[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] = agent.maxOutputTokens;
                newEnv[`AGENT_${baseName}_TEMPERATURE`] = agent.temperature;
                newEnv[`AGENT_${baseName}_DESCRIPTION`] = agent.description;
            });
        }

        return newEnv;
    }

    /**
     * 将任意名称转为合法的 env baseName（仅保留 ASCII 字母数字和下划线）
     * 如果输入是纯非 ASCII 文本，返回空字符串以便调用方兜底处理
     */
    function sanitizeBaseName(name) {
        if (!name) return '';
        const sanitized = String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '').replace(/^_+|_+$/g, '');
        return sanitized || '';
    }

    /**
     * 将对象转换为带分区注释的 Dotenv 文本格式
     */
    function serializeEnv(envObj) {
        const lines = [];
        const globalKeys = [];
        const delegationKeys = [];
        const agentGroups = new Map(); // baseName -> [key, ...]
        const otherKeys = [];

        for (const key of Object.keys(envObj)) {
            if (key === 'AGENT_ASSISTANT_MAX_HISTORY_ROUNDS' || key === 'AGENT_ASSISTANT_CONTEXT_TTL_HOURS' || key === 'AGENT_ALL_SYSTEM_PROMPT') {
                globalKeys.push(key);
            } else if (key.startsWith('DELEGATION_')) {
                delegationKeys.push(key);
            } else if (key.startsWith('AGENT_')) {
                const match = key.match(/^AGENT_([A-Z0-9_]+?)_(MODEL_ID|CHINESE_NAME|SYSTEM_PROMPT|MAX_OUTPUT_TOKENS|TEMPERATURE|DESCRIPTION)$/i);
                if (match) {
                    const baseName = match[1];
                    if (!agentGroups.has(baseName)) agentGroups.set(baseName, []);
                    agentGroups.get(baseName).push(key);
                } else {
                    otherKeys.push(key);
                }
            } else {
                otherKeys.push(key);
            }
        }

        lines.push('# AgentAssistant 插件配置（由管理面板自动生成）');
        lines.push('# --------------------------------------------------');
        lines.push('');

        if (globalKeys.length > 0) {
            lines.push('# 全局会话设置');
            globalKeys.forEach(k => lines.push(formatEnvLine(k, envObj[k])));
            lines.push('');
        }

        if (otherKeys.length > 0) {
            otherKeys.forEach(k => lines.push(formatEnvLine(k, envObj[k])));
            lines.push('');
        }

        let agentIndex = 1;
        for (const [baseName, keys] of agentGroups) {
            const chineseNameKey = `AGENT_${baseName}_CHINESE_NAME`;
            const displayName = envObj[chineseNameKey] || baseName;
            lines.push(`# Agent ${agentIndex}: ${displayName} (${baseName})`);
            keys.sort((a, b) => {
                const order = ['MODEL_ID', 'CHINESE_NAME', 'SYSTEM_PROMPT', 'MAX_OUTPUT_TOKENS', 'TEMPERATURE', 'DESCRIPTION'];
                const suffixA = a.replace(`AGENT_${baseName}_`, '');
                const suffixB = b.replace(`AGENT_${baseName}_`, '');
                return order.indexOf(suffixA) - order.indexOf(suffixB);
            });
            keys.forEach(k => lines.push(formatEnvLine(k, envObj[k])));
            lines.push('');
            agentIndex++;
        }

        if (delegationKeys.length > 0) {
            lines.push('# --- 异步委托模式 (Task Delegation) 配置 ---');
            delegationKeys.forEach(k => lines.push(formatEnvLine(k, envObj[k])));
            lines.push('');
        }

        return lines.join('\n');
    }

    function formatEnvLine(key, value) {
        const strValue = String(value ?? '');
        // 如果包含换行、回车、双引号、单引号、#号（注释符）、反斜杠或首尾空格，则使用双引号包裹
        if (/[\n\r"\'#\\]/.test(strValue) || strValue.startsWith(' ') || strValue.endsWith(' ')) {
            const escaped = strValue
                .replace(/\\/g, '\\\\') // 必须第一步转义反斜杠，防止二次转义
                .replace(/"/g, '\\"')   // 转义双引号
                .replace(/\n/g, '\\n')  // 将字面换行转为 \n 字符串
                .replace(/\r/g, '\\r'); // 将字面回车转为 \r 字符串
            return `${key}="${escaped}"`;
        }
        return `${key}=${strValue}`;
    }

    router.get('/agent-assistant/config', async (req, res) => {
        try {
            let content = '';
            try {
                content = await fs.readFile(AGENT_ASSISTANT_CONFIG_FILE, 'utf-8');
            } catch (e) {
                // 如果文件不存在，尝试读取 example
                const examplePath = AGENT_ASSISTANT_CONFIG_FILE + '.example';
                content = await fs.readFile(examplePath, 'utf-8').catch(() => '');
            }
            const envConfig = dotenv.parse(content);
            res.json(mapEnvToJson(envConfig));
        } catch (error) { 
            console.error('[AgentAssistant Route] Load Config Error:', error);
            res.json({ maxHistoryRounds: 7, contextTtlHours: 24, globalSystemPrompt: '', agents: [] }); 
        }
    });

    router.post('/agent-assistant/config', async (req, res) => {
        try {
            await fs.mkdir(ASSISTANT_DIR, { recursive: true });
            
            // 1. 读取当前环境以保留非管理键
            let existingContent = '';
            try {
                existingContent = await fs.readFile(AGENT_ASSISTANT_CONFIG_FILE, 'utf-8');
            } catch (e) { /* ignore */ }
            const existingEnv = dotenv.parse(existingContent);

            // 2. 映射并保存
            const updatedEnv = mapJsonToEnv(req.body, existingEnv);
            const serialized = serializeEnv(updatedEnv);
            
            await fs.writeFile(AGENT_ASSISTANT_CONFIG_FILE, serialized, 'utf-8');
            res.json({ success: true, message: 'Settings saved to config.env.' });
        } catch (error) { 
            console.error('[AgentAssistant Route] Save Config Error:', error);
            res.status(500).json({ error: 'Failed to save config.env' }); 
        }
    });

    router.get('/agent-assistant/scores', async (req, res) => {
        try {
            const content = await fs.readFile(AGENT_ASSISTANT_SCORES_FILE, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) { res.json({}); }
    });

    router.post('/agent-assistant/scores', async (req, res) => {
        try {
            await fs.mkdir(ASSISTANT_DIR, { recursive: true });
            await fs.writeFile(AGENT_ASSISTANT_SCORES_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
            res.json({ success: true, message: 'Scores saved.' });
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    return router;
};
