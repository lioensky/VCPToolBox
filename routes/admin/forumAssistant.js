const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

module.exports = function (options) {
    const router = express.Router();
    const CONFIG_DIR = path.join(__dirname, '..', '..', 'Plugin', 'VCPForumAssistant');
    const CONFIG_FILE = path.join(CONFIG_DIR, 'config.env');
    const AA_CONFIG_FILE = path.join(__dirname, '..', '..', 'Plugin', 'AgentAssistant', 'config.env');

    function mapEnvToJson(envConfig) {
        const json = {
            globalEnabled: envConfig.FORUM_PATROL_ENABLED === 'true',
            agents: []
        };

        const baseNames = new Set();
        for (const key in envConfig) {
            const m = key.match(/^FORUM_AGENT_([A-Z0-9_]+)_CHINESE_NAME$/);
            if (m) baseNames.add(m[1]);
        }

        for (const base of baseNames) {
            json.agents.push({
                baseName: base,
                chineseName: envConfig[`FORUM_AGENT_${base}_CHINESE_NAME`] || '',
                enabled: envConfig[`FORUM_AGENT_${base}_ENABLED`] === 'true',
                hours: envConfig[`FORUM_AGENT_${base}_HOURS`] || ''
            });
        }

        return json;
    }

    function mapJsonToEnv(json) {
        const env = {};
        env.FORUM_PATROL_ENABLED = json.globalEnabled ? 'true' : 'false';

        if (Array.isArray(json.agents)) {
            const usedBaseNames = new Set();
            for (const agent of json.agents) {
                let base = sanitizeBaseName(agent.baseName) || sanitizeBaseName(agent.chineseName) || '';
                if (!base || usedBaseNames.has(base)) {
                    base = (base || 'AGENT') + '_' + Date.now().toString(36).toUpperCase();
                }
                usedBaseNames.add(base);

                env[`FORUM_AGENT_${base}_ENABLED`] = agent.enabled ? 'true' : 'false';
                env[`FORUM_AGENT_${base}_CHINESE_NAME`] = agent.chineseName || '';
                env[`FORUM_AGENT_${base}_HOURS`] = agent.hours || '';
            }
        }

        return env;
    }

    function sanitizeBaseName(name) {
        if (!name) return '';
        return String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '').replace(/^_+|_+$/g, '') || '';
    }

    function serializeEnv(envObj) {
        const lines = [];
        lines.push('# VCPForumAssistant 论坛巡航配置（由管理面板自动生成）');
        lines.push('# --------------------------------------------------');
        lines.push('');
        lines.push('# 全局开关');
        lines.push(`FORUM_PATROL_ENABLED=${envObj.FORUM_PATROL_ENABLED || 'false'}`);
        lines.push('');

        const agentGroups = new Map();
        for (const key of Object.keys(envObj)) {
            const m = key.match(/^FORUM_AGENT_([A-Z0-9_]+?)_(ENABLED|CHINESE_NAME|HOURS)$/);
            if (m) {
                const base = m[1];
                if (!agentGroups.has(base)) agentGroups.set(base, []);
                agentGroups.get(base).push(key);
            }
        }

        let idx = 1;
        for (const [base, keys] of agentGroups) {
            const displayName = envObj[`FORUM_AGENT_${base}_CHINESE_NAME`] || base;
            lines.push(`# Agent ${idx}: ${displayName} (${base})`);
            const order = ['ENABLED', 'CHINESE_NAME', 'HOURS'];
            keys.sort((a, b) => {
                const sa = a.replace(`FORUM_AGENT_${base}_`, '');
                const sb = b.replace(`FORUM_AGENT_${base}_`, '');
                return order.indexOf(sa) - order.indexOf(sb);
            });
            for (const k of keys) {
                lines.push(`${k}=${envObj[k]}`);
            }
            lines.push('');
            idx++;
        }

        return lines.join('\n');
    }

    // GET /forum-assistant/config
    router.get('/forum-assistant/config', async (req, res) => {
        try {
            let content = '';
            try { content = await fs.readFile(CONFIG_FILE, 'utf-8'); } catch (e) { /* no file yet */ }
            const envConfig = dotenv.parse(content);
            res.json(mapEnvToJson(envConfig));
        } catch (error) {
            console.error('[ForumAssistant Route] Load error:', error);
            res.json({ globalEnabled: false, agents: [] });
        }
    });

    // POST /forum-assistant/config
    router.post('/forum-assistant/config', async (req, res) => {
        try {
            await fs.mkdir(CONFIG_DIR, { recursive: true });
            const env = mapJsonToEnv(req.body);
            const serialized = serializeEnv(env);
            await fs.writeFile(CONFIG_FILE, serialized, 'utf-8');
            res.json({ success: true, message: '论坛巡航配置已保存。' });
        } catch (error) {
            console.error('[ForumAssistant Route] Save error:', error);
            res.status(500).json({ error: '保存配置失败' });
        }
    });

    // GET /forum-assistant/available-agents — 从 AgentAssistant 获取已注册 Agent 列表
    router.get('/forum-assistant/available-agents', async (req, res) => {
        try {
            let content = '';
            try { content = await fs.readFile(AA_CONFIG_FILE, 'utf-8'); } catch (e) { /* no file */ }
            const envConfig = dotenv.parse(content);
            const agents = [];

            for (const key in envConfig) {
                if (key.startsWith('AGENT_') && key.endsWith('_CHINESE_NAME')) {
                    const name = envConfig[key];
                    if (name) agents.push(name);
                }
            }

            res.json({ agents: agents.sort((a, b) => a.localeCompare(b, 'zh-CN')) });
        } catch (error) {
            console.error('[ForumAssistant Route] Load available agents error:', error);
            res.json({ agents: [] });
        }
    });

    return router;
};
