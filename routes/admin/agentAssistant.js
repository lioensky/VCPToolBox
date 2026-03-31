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

        // 更新全局设置
        newEnv.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS = json.maxHistoryRounds;
        newEnv.AGENT_ASSISTANT_CONTEXT_TTL_HOURS = json.contextTtlHours;
        newEnv.AGENT_ALL_SYSTEM_PROMPT = json.globalSystemPrompt;

        // 清理旧的 Agent 键，防止删除 Agent 后残留
        for (const key in newEnv) {
            if (key.startsWith('AGENT_')) {
                // 排除全局提示词键，因为它会被重新赋值
                if (key !== 'AGENT_ALL_SYSTEM_PROMPT') {
                    delete newEnv[key];
                }
            }
        }

        // 重新注入 Agent 配置
        if (Array.isArray(json.agents)) {
            json.agents.forEach(agent => {
                let baseName = agent.baseName || agent.chineseName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
                if (!baseName) baseName = 'UNKNOWN';
                
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
     * 将对象转换为 Dotenv 文本格式
     */
    function serializeEnv(envObj) {
        return Object.entries(envObj)
            .map(([key, value]) => {
                if (typeof value === 'string' && (value.includes('\n') || value.includes('"'))) {
                    // 处理包含引号或换行的字符串
                    return `${key}="${value.replace(/"/g, '\\"')}"`;
                }
                return `${key}=${value}`;
            })
            .join('\n');
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
