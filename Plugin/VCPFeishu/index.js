'use strict';

const FeishuBot = require('./feishuBot');

let config = {};
let botRunning = false;
let startPromise = null;

function log(...args) { console.log('[VCPFeishu]', ...args); }

function getConfigValue(...keys) {
    for (const key of keys) {
        if (config[key] !== undefined && config[key] !== null && config[key] !== '') return config[key];
        if (process.env[key] !== undefined && process.env[key] !== null && process.env[key] !== '') return process.env[key];
    }
    return '';
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return '';
}

function jsonError(res, err, status = 500) {
    res.status(status).json({ status: 'error', error: err?.message || String(err || '未知错误') });
}

function normalizeSendArgs(args = {}) {
    return {
        target: firstNonEmpty(args.target, args.chat_id, args.chatId, args.open_id, args.openId, args.receive_id, args.receiveId),
        content: firstNonEmpty(args.content, args.message, args.text),
        receiveIdType: firstNonEmpty(args.receive_id_type, args.receiveIdType),
        session: firstNonEmpty(args.session, args.sessionKey, args.session_id, args.sessionId),
        topicId: firstNonEmpty(args.topic_id, args.topicId),
    };
}

function missingStartupConfig() {
    const missing = [];
    if (!String(getConfigValue('FeishuAppId')).trim()) missing.push('FeishuAppId');
    if (!String(getConfigValue('FeishuAppSecret')).trim()) missing.push('FeishuAppSecret');
    if (!String(getConfigValue('FeishuBindAgent')).trim()) missing.push('FeishuBindAgent');
    return missing;
}

async function startBot(extraConfig) {
    if (botRunning) return { status: 'success', message: '飞书机器人已在运行中' };
    if (startPromise) return startPromise;
    if (extraConfig) {
        config = { ...config, ...extraConfig };
        FeishuBot.configure(config);
    }

    const missing = missingStartupConfig();
    if (missing.length > 0) {
        throw new Error(`缺少配置: ${missing.join(', ')}`);
    }

    startPromise = FeishuBot.initialize(config)
        .then(() => {
            botRunning = true;
            return { status: 'success', message: '飞书机器人已启动' };
        })
        .catch(err => {
            botRunning = false;
            throw err;
        })
        .finally(() => {
            startPromise = null;
        });

    return startPromise;
}

async function sendByArgs(args) {
    const normalized = normalizeSendArgs(args);
    if (!normalized.content) throw new Error('缺少 content/message/text 参数');
    if (!normalized.target && !normalized.session && !normalized.topicId) {
        throw new Error('缺少 target/chat_id/open_id/receive_id，或 session/topic_id 参数');
    }
    return FeishuBot.sendMessage(
        normalized.target,
        normalized.content,
        normalized.receiveIdType || undefined,
        { session: normalized.session, topicId: normalized.topicId }
    );
}

function listByArgs(args = {}) {
    const bindAgent = firstNonEmpty(args.bindAgent, args.bind_agent, args.agent, getConfigValue('FeishuBindAgent'));
    return FeishuBot.listFeishuTopicsDetailed(bindAgent);
}

function listGroupsByArgs(args = {}) {
    const bindAgent = firstNonEmpty(args.bindAgent, args.bind_agent, args.agent, getConfigValue('FeishuBindAgent'));
    return FeishuBot.listFeishuGroupsDetailed(bindAgent);
}

async function registerRoutes(app, pluginConfig, projectBasePath) {
    config = {
        ...config,
        ...pluginConfig,
        ...(projectBasePath ? { PROJECT_BASE_PATH: projectBasePath } : {}),
    };
    FeishuBot.configure(config);
    log('管理路由已注册');

    app.post('/api/plugins/feishu/send', async (req, res) => {
        try {
            const result = await sendByArgs(req.body || {});
            res.json({
                status: 'success',
                target: result.resolvedTarget || null,
                receive_id_type: result.receiveIdType || null,
                topic_id: result.topicId || null,
                session: result.sessionKey || null,
                feishu: result,
            });
        } catch (err) {
            jsonError(res, err);
        }
    });

    app.get('/api/plugins/feishu/sessions', async (req, res) => {
        try {
            res.json({ status: 'success', sessions: await listByArgs(req.query || {}) });
        } catch (err) {
            jsonError(res, err);
        }
    });

    app.get('/api/plugins/feishu/groups', async (req, res) => {
        try {
            res.json({ status: 'success', groups: await listGroupsByArgs(req.query || {}) });
        } catch (err) {
            jsonError(res, err);
        }
    });

    if (missingStartupConfig().length === 0) {
        startBot().catch(() => {});
    } else {
        log('飞书配置未完整，保持待机');
    }
}

async function processToolCall(args = {}) {
    const command = String(args.command || args.cmd || '').trim();
    const action = String(args.action || '').trim();

    if (command === 'FeishuSend' || action === 'send') {
        const result = await sendByArgs(args);
        return {
            content: [{
                type: 'text',
                text: `已向 ${result.resolvedTarget || '飞书目标'} 推送消息。`,
            }],
        };
    }

    if (command === 'FeishuListSessions' || action === 'list_sessions') {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(await listByArgs(args), null, 2),
            }],
        };
    }

    if (command === 'FeishuListGroups' || action === 'list_groups') {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(await listGroupsByArgs(args), null, 2),
            }],
        };
    }

    throw new Error(`VCPFeishu 未知 command/action: ${command || action || '(空)'}`);
}

module.exports = {
    registerRoutes,
    processToolCall,
};
