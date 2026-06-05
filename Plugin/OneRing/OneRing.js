'use strict';
// OneRing.js — 统一上下文预处理器主模块
// 触发语法：系统提示词中包含 [[OneRing::AgentName::Frontend]]
// Only 模式：[[OneRing::AgentName::Frontend::Only]] 或独立 [[OneRing::Only]] 只入库/标记，不做跨端上下文追加。

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const db = require('./OneRingDB.js');
const fuzzy = require('./OneRingFuzzy.js');
const snapshot = require('./OneRingSnapshot.js');

// ─── 触发语法解析 ────────────────────────────────────────────────────────────
const TRIGGER_REGEX = /\[\[OneRing::([^:]+?)::([^:\]]+?)(?:::([^\]]+?))?\]\]/;
const TRIGGER_GLOBAL_REGEX = /\[\[OneRing::([^:]+?)::([^:\]]+?)(?:::([^\]]+?))?\]\]/g;
const ONLY_TRIGGER_GLOBAL_REGEX = /\[\[OneRing::Only\]\]/gi;

function getLastTriggerMatch(systemText) {
    if (typeof systemText !== 'string') return null;
    const matches = [...systemText.matchAll(TRIGGER_GLOBAL_REGEX)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1];
}

function getLastOnlyTriggerMatch(systemText) {
    if (typeof systemText !== 'string') return null;
    const matches = [...systemText.matchAll(ONLY_TRIGGER_GLOBAL_REGEX)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1];
}

// ─── 消息来源分类：需要丢弃的模式 ────────────────────────────────────────────
// 心跳/系统类消息，直接丢弃不入库
const DISCARD_PATTERNS = [
    /^\s*\[系统提示/,
    /^\s*\[系统警告/,
    /^\s*\[系统指示/,
    /by\[Vchat群聊\]/,
    // 群聊邀请心跳：如"现在轮到你{{VCPChatAgentName}}发言"或"邀请xxx发言"
    /现在轮到你.{0,30}发言/,
    /邀请.{1,20}发言/,
];

// AA 通讯中心私聊标记。
// 例：[Tips:这是一条来自AgentAssistant通讯中心 小克 的联络，你可以直接正常回复...]
const AA_COMM_REGEX = /\[Tips:这是一条来自AgentAssistant通讯中心\s+([\s\S]*?)\s+的联络[^\]]*\]/;

// 群聊发言头标记，如 [莱恩的发言]: 或 [小克的发言]:
const GROUPCHAT_SENDER_REGEX = /^\s*\[([^\]]{1,30})的发言\]\s*[:：]\s*/;

const NEW_CONVERSATION_START_SUFFIX = '；这是一个新对话的起点';
const ONERING_TAIL_STACK_REGEX = /(?:\s*\[OneRing通知:[\s\S]*?于\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?发送于[^\]]*?(?:；这是一个新对话的起点)?\]\s*)+$/;

function stripOneRingTailTagText(text) {
    return typeof text === 'string' ? text.replace(ONERING_TAIL_STACK_REGEX, '').trim() : '';
}

function isUnresolvedTemplateName(name) {
    return !name || /\$\{[^}]+\}/.test(name) || /\{\{[^}]+\}\}/.test(name);
}

/**
 * 从 user 消息内容中提取"净内容"和"来源信息"。
 * 返回 null 表示该消息应丢弃。
 */
function classifyUserContent(rawContent, defaultUserName, registeredAgentName = null) {
    let text = typeof rawContent === 'string' ? rawContent
        : fuzzy.extractText(rawContent);

    // 1. 剥离系统通知栏与既有 OneRing 尾标，避免二次入库污染 cleanText。
    text = stripOneRingTailTagText(text.replace(fuzzy.SYSTEM_NOTICE_REGEX, ''));

    // 系统通知 user 块剥离通知后无正文时，直接丢弃，不入库也不补尾标。
    if (!text.trim()) return null;

    // 2. 检查丢弃模式
    for (const pat of DISCARD_PATTERNS) {
        if (pat.test(text)) return null;
    }

    // 3. AA 通讯中心来源头：提取实际 senderName，但保留开头标记入库正文。
    //    这些头部标记是上下文语义的一部分；OneRing 尾标只负责机器可读来源追踪。
    let aaSenderName = null;
    const aaMatch = AA_COMM_REGEX.exec(text);
    if (aaMatch) {
        const candidate = aaMatch[1].trim();
        if (!isUnresolvedTemplateName(candidate)) {
            aaSenderName = candidate;
        } else if (registeredAgentName) {
            // AA 头存在但 senderName 模板未解析时，不应落回 username；
            // 这是 AA 信道消息，退回当前 OneRing 注册 Agent 作为保守来源。
            aaSenderName = registeredAgentName;
        }
    }

    // 4. 群聊发言头可能连续嵌套，如 [莱恩的发言]: [小克的发言]: 正文。
    //    最后一个发言头才是当前消息真实说话者；但所有开头标记都保留在 cleanText 中。
    let groupSenderName = null;
    let scanText = text;
    let gcMatch = GROUPCHAT_SENDER_REGEX.exec(scanText);
    while (gcMatch) {
        groupSenderName = gcMatch[1].trim();
        scanText = scanText.replace(GROUPCHAT_SENDER_REGEX, '').trim();
        gcMatch = GROUPCHAT_SENDER_REGEX.exec(scanText);
    }

    if (groupSenderName) {
        return { senderName: groupSenderName, source: aaSenderName ? 'AA+GroupChat' : 'GroupChat', cleanText: text };
    }

    if (aaSenderName) {
        return { senderName: aaSenderName, source: 'AA', cleanText: text };
    }

    // 5. 普通用户发言
    return { senderName: defaultUserName, source: 'Direct', cleanText: text };
}

function getOneRingTailMeta(content) {
    const text = fuzzy.extractText(content);
    const re = /\[OneRing通知:([\s\S]*?)于(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)发送于([^\]；]*?)(；这是一个新对话的起点)?\]/g;
    let m;
    let last = null;
    while ((m = re.exec(text)) !== null) {
        last = m;
    }
    return last ? {
        senderName: last[1].trim(),
        timestamp: last[2].trim(),
        frontendSource: last[3].trim(),
        isNewConversationStart: !!last[4]
    } : null;
}

function hasOneRingTailTag(content) {
    return !!getOneRingTailMeta(content);
}

/**
 * 为消息附加 OneRing 尾部标记。
 * 只在 cleanText 末尾追加，不影响原消息开头，对下游处理透明。
 */
function appendTailTag(content, senderName, timestamp, frontendSource, isNewConversationStart = false) {
    const newConversationSuffix = isNewConversationStart ? NEW_CONVERSATION_START_SUFFIX : '';
    const tag = `\n[OneRing通知:${senderName}于${timestamp}发送于${frontendSource}${newConversationSuffix}]`;
    if (typeof content === 'string') return content + tag;
    if (Array.isArray(content)) {
        // 找最后一个 text part 追加
        const result = [...content];
        for (let i = result.length - 1; i >= 0; i--) {
            if (result[i] && result[i].type === 'text' && typeof result[i].text === 'string') {
                result[i] = { ...result[i], text: result[i].text + tag };
                return result;
            }
        }
        result.push({ type: 'text', text: tag.trim() });
        return result;
    }
    return content;
}

/**
 * 替换或附加 OneRing 尾部标记。
 * 用于修正旧上下文中曾经打错 senderName/frontendSource 的尾标。
 */
function upsertTailTag(content, senderName, timestamp, frontendSource, isNewConversationStart = false) {
    const newConversationSuffix = isNewConversationStart ? NEW_CONVERSATION_START_SUFFIX : '';
    const tag = `[OneRing通知:${senderName}于${timestamp}发送于${frontendSource}${newConversationSuffix}]`;
    if (typeof content === 'string') {
        const stripped = stripOneRingTailTagText(content);
        return `${stripped}\n${tag}`;
    }
    if (Array.isArray(content)) {
        const result = [...content];
        for (let i = result.length - 1; i >= 0; i--) {
            if (result[i] && result[i].type === 'text' && typeof result[i].text === 'string') {
                result[i] = { ...result[i], text: `${stripOneRingTailTagText(result[i].text)}\n${tag}` };
                return result;
            }
        }
        result.push({ type: 'text', text: tag });
        return result;
    }
    return content;
}

// ─── 系统提示词替换 ─────────────────────────────────────────────────────────────
function replaceLastOccurrence(text, search, replacement) {
    if (typeof text !== 'string' || !search) return text;
    const idx = text.lastIndexOf(search);
    if (idx < 0) return text;
    return text.slice(0, idx) + replacement + text.slice(idx + search.length);
}

function replaceTriggerWithNotice(content, triggerText, agentName, frontendSource, mode) {
    const modeNotice = mode ? `，当前模式${mode}` : '';
    const notice = `[OneRing系统已启动，当前Agent${agentName}，当前客户端${frontendSource}${modeNotice}，所有上下文OneRing信息来源标记由系统生成无需你自动输出。]`;

    if (typeof content === 'string') {
        return replaceLastOccurrence(content, triggerText, notice);
    }

    if (Array.isArray(content)) {
        const result = [...content];
        for (let i = result.length - 1; i >= 0; i--) {
            const part = result[i];
            if (
                part &&
                part.type === 'text' &&
                typeof part.text === 'string' &&
                part.text.includes(triggerText)
            ) {
                result[i] = { ...part, text: replaceLastOccurrence(part.text, triggerText, notice) };
                return result;
            }
        }
        return result;
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return { ...content, text: replaceLastOccurrence(content.text, triggerText, notice) };
    }

    return content;
}

function replaceOnlyTriggerWithNotice(content, triggerText) {
    const notice = '[OneRing Only模式已启动：本次只入库/标记，不做跨端上下文追加。]';

    if (typeof content === 'string') {
        return replaceLastOccurrence(content, triggerText, notice);
    }

    if (Array.isArray(content)) {
        const result = [...content];
        for (let i = result.length - 1; i >= 0; i--) {
            const part = result[i];
            if (
                part &&
                part.type === 'text' &&
                typeof part.text === 'string' &&
                part.text.includes(triggerText)
            ) {
                result[i] = { ...part, text: replaceLastOccurrence(part.text, triggerText, notice) };
                return result;
            }
        }
        return result;
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return { ...content, text: replaceLastOccurrence(content.text, triggerText, notice) };
    }

    return content;
}

// ─── 模块状态 ─────────────────────────────────────────────────────────────────
const HOT_CONFIG_FILE_NAME = 'OneRingConfig.json';
const DEFAULT_HOT_CONFIG = Object.freeze({
    enabled: true,
    tailTagPlacement: 'inline',
    maxContextBlocks: 10,
    timeInsert: true
});
const TAIL_TAG_PLACEMENT_INLINE = 'inline';
const TAIL_TAG_PLACEMENT_SYSTEM_USER_BLOCK = 'system_user_block';

let config = {};
let projectBasePath = '';
let debugMode = false;
let hotConfig = { ...DEFAULT_HOT_CONFIG };
let hotConfigPath = path.join(__dirname, HOT_CONFIG_FILE_NAME);
let hotConfigWatcher = null;

function toBoolean(value, defaultValue = true) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return defaultValue;
}

function toPositiveInteger(value, defaultValue) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function normalizeTailTagPlacement(value) {
    const normalized = String(value || DEFAULT_HOT_CONFIG.tailTagPlacement).trim().toLowerCase();
    if (['system_user_block', 'system-user-block', 'user_block', 'user-block', 'pseudo_system_user'].includes(normalized)) {
        return TAIL_TAG_PLACEMENT_SYSTEM_USER_BLOCK;
    }
    return TAIL_TAG_PLACEMENT_INLINE;
}

function normalizeHotConfig(raw = {}) {
    return {
        enabled: toBoolean(raw.enabled, DEFAULT_HOT_CONFIG.enabled),
        tailTagPlacement: normalizeTailTagPlacement(raw.tailTagPlacement),
        maxContextBlocks: toPositiveInteger(raw.maxContextBlocks, DEFAULT_HOT_CONFIG.maxContextBlocks),
        timeInsert: toBoolean(raw.timeInsert, DEFAULT_HOT_CONFIG.timeInsert)
    };
}

function readHotConfigFile() {
    try {
        if (!fs.existsSync(hotConfigPath)) {
            hotConfig = { ...DEFAULT_HOT_CONFIG };
            console.warn(`[OneRing] Hot config not found at ${hotConfigPath}, using defaults.`);
            return;
        }
        const parsed = JSON.parse(fs.readFileSync(hotConfigPath, 'utf8'));
        hotConfig = normalizeHotConfig(parsed);
        console.log(`[OneRing] Hot config loaded: enabled=${hotConfig.enabled}, tailTagPlacement=${hotConfig.tailTagPlacement}, maxContextBlocks=${hotConfig.maxContextBlocks}, timeInsert=${hotConfig.timeInsert}`);
    } catch (e) {
        console.error(`[OneRing] Failed to load hot config "${hotConfigPath}", keeping previous config:`, e.message);
    }
}

function setupHotConfigWatcher() {
    if (hotConfigWatcher) {
        hotConfigWatcher.close().catch(() => {});
        hotConfigWatcher = null;
    }

    readHotConfigFile();

    hotConfigWatcher = chokidar.watch(hotConfigPath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100
        }
    });

    hotConfigWatcher
        .on('add', readHotConfigFile)
        .on('change', readHotConfigFile)
        .on('unlink', () => {
            hotConfig = { ...DEFAULT_HOT_CONFIG };
            console.warn(`[OneRing] Hot config removed, using defaults until ${HOT_CONFIG_FILE_NAME} is restored.`);
        })
        .on('error', (error) => {
            console.error('[OneRing] Hot config watcher error:', error.message);
        });
}

function getOneRingMaxContextBlocks() {
    return hotConfig.maxContextBlocks;
}

function isOneRingTimeInsertEnabled() {
    return hotConfig.timeInsert;
}

function getOneRingMaxDbRecords() {
    const value = parseInt(config.ONERING_MAX_DB_RECORDS ?? '100', 10);
    return Number.isFinite(value) ? value : 100;
}

/**
 * 生成 OneRing 使用的本地时间戳。
 * 必须与尾标、DB timestamp 完全一致；跨端补充依赖 YYYY-MM-DD HH:mm:ss(.SSS) 字符串排序和区间查询。
 */
function formatOneRingTimestamp(date = new Date(), includeMilliseconds = false) {
    const timeZone = config.DEFAULT_TIMEZONE || process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).formatToParts(date).reduce((acc, part) => {
            if (part.type !== 'literal') acc[part.type] = part.value;
            return acc;
        }, {});
        const ms = includeMilliseconds ? `.${String(date.getMilliseconds()).padStart(3, '0')}` : '';
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}${ms}`;
    } catch (e) {
        if (debugMode) console.warn(`[OneRing] Invalid DEFAULT_TIMEZONE="${timeZone}", fallback to local time:`, e.message);
        const pad = (n) => String(n).padStart(2, '0');
        const ms = includeMilliseconds ? `.${String(date.getMilliseconds()).padStart(3, '0')}` : '';
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${ms}`;
    }
}

function createOneRingTimestampSequencer(baseDate = new Date()) {
    let offsetMs = 0;
    return () => formatOneRingTimestamp(new Date(baseDate.getTime() + offsetMs++), true);
}

function mergeConversationByOneRingTimestamp(messages) {
    if (!Array.isArray(messages)) return messages;
    const nonConversation = messages.filter(m => !m || (m.role !== 'user' && m.role !== 'assistant'));
    const conversation = messages
        .map((message, index) => {
            const meta = message && (message.role === 'user' || message.role === 'assistant')
                ? getOneRingTailMeta(message.content)
                : null;
            return {
                message,
                index,
                timestamp: meta?.timestamp || null
            };
        })
        .filter(item => item.message && (item.message.role === 'user' || item.message.role === 'assistant'));

    conversation.sort((a, b) => {
        // 无时间戳的当前轮消息应排在已知历史之后；同一时间戳保持原始稳定顺序。
        const ta = a.timestamp || '9999-12-31 23:59:59';
        const tb = b.timestamp || '9999-12-31 23:59:59';
        if (ta !== tb) return ta < tb ? -1 : 1;
        return a.index - b.index;
    });

    return [
        ...nonConversation,
        ...conversation.map(item => item.message)
    ];
}

function choosePreferredDuplicateMessage(prev, current) {
    const prevMeta = getOneRingTailMeta(prev?.content);
    const currentMeta = getOneRingTailMeta(current?.content);

    // 优先保留带 OneRing 时间戳的记录，保证跨端时间线稳定。
    if (!prevMeta && currentMeta) return current;
    if (prevMeta && !currentMeta) return prev;

    // 两者都有时间戳时保留更早的原始时间点；编辑 update 不应改变时间戳。
    if (prevMeta && currentMeta) {
        if (prevMeta.timestamp <= currentMeta.timestamp) return prev;
        return current;
    }

    // 都无尾标时保留信息量更大的文本。
    const prevText = fuzzy.normalize(fuzzy.extractText(prev?.content));
    const currentText = fuzzy.normalize(fuzzy.extractText(current?.content));
    return currentText.length > prevText.length ? current : prev;
}

function logOneRingSummary(agentName, frontendSource, mode, stats = {}) {
    const injected = stats.injected || 0;
    const dbInserted = stats.dbInserted || 0;
    const dbUpdated = stats.dbUpdated || 0;
    const snapshotEdited = stats.snapshotEdited || 0;
    const fuzzyEdited = stats.fuzzyEdited || 0;
    const outputDeduped = stats.outputDeduped || 0;
    const snapshotSaved = stats.snapshotSaved || 0;

    if (
        injected === 0 &&
        dbInserted === 0 &&
        dbUpdated === 0 &&
        snapshotEdited === 0 &&
        fuzzyEdited === 0 &&
        outputDeduped === 0 &&
        snapshotSaved === 0
    ) return;

    console.log(
        `[OneRing] Summary agent="${agentName}" frontend="${frontendSource}" mode=${mode}: ` +
        `注入=${injected}条, 写库insert=${dbInserted}条, 写库update=${dbUpdated}条, ` +
        `快照编辑=${snapshotEdited}条, fuzzy编辑=${fuzzyEdited}条, 输出去重=${outputDeduped}条, 快照保存=${snapshotSaved}条`
    );
}

function dedupeAdjacentSimilarConversation(messages, threshold = 0.98) {
    if (!Array.isArray(messages)) return messages;

    const result = [];
    for (const message of messages) {
        if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
            result.push(message);
            continue;
        }

        const prev = result[result.length - 1];
        if (
            prev &&
            prev.role === message.role &&
            (prev.role === 'user' || prev.role === 'assistant') &&
            fuzzy.similarity(fuzzy.extractText(prev.content), fuzzy.extractText(message.content)) >= threshold
        ) {
            result[result.length - 1] = choosePreferredDuplicateMessage(prev, message);
            continue;
        }

        result.push(message);
    }

    return result;
}

class OneRingPreprocessor {
    async processMessages(messages, requestConfig) {
        const cfg = { ...config, ...requestConfig };
        if (!hotConfig.enabled) return messages;

        // ── 1. 检测触发语法 ──────────────────────────────────────────────────
        const systemMsg = messages.find(m => m.role === 'system');
        if (!systemMsg) return messages;

        const systemText = fuzzy.extractText(systemMsg.content);
        const triggerMatch = getLastTriggerMatch(systemText);
        if (!triggerMatch) return messages;

        const onlyTriggerMatch = getLastOnlyTriggerMatch(systemText);
        const agentName = triggerMatch[1].trim();
        const frontendSource = triggerMatch[2].trim();
        const triggerMode = (triggerMatch[3] || '').trim();
        const onlyMode = triggerMode.toLowerCase() === 'only' || !!onlyTriggerMatch;
        const effectiveTriggerMode = onlyMode && !triggerMode ? 'Only' : triggerMode;
        systemMsg.content = replaceTriggerWithNotice(systemMsg.content, triggerMatch[0], agentName, frontendSource, effectiveTriggerMode);
        if (onlyTriggerMatch) {
            systemMsg.content = replaceOnlyTriggerWithNotice(systemMsg.content, onlyTriggerMatch[0]);
        }
        const defaultUserName = cfg.ONERING_USER_NAME || 'Ryan';
        const threshold = parseFloat(cfg.ONERING_DEDUP_SIMILARITY ?? '0.92');
        const maxUnknownRatio = parseFloat(cfg.ONERING_MAX_UNKNOWN_RATIO ?? '0.35');
        const allowPatch = String(cfg.ONERING_ALLOW_CONTEXT_PATCH ?? 'true').toLowerCase() !== 'false';
        const maxBlocks = getOneRingMaxContextBlocks();
        const recordOnly = String(cfg.ONERING_RECORD_ONLY ?? 'true').toLowerCase() !== 'false';
        const snapshotMaxBlocks = parseInt(cfg.ONERING_POST_SNAPSHOT_MAX_BLOCKS ?? '20', 10);
        const outputDedupeThreshold = parseFloat(cfg.ONERING_OUTPUT_DEDUP_SIMILARITY ?? '0.98');

        if (debugMode) console.log(`[OneRing] Triggered for agent="${agentName}" frontend="${frontendSource}"`);

        // ── 2. 提取本次 post 的 user/assistant 历史块（忽略 system）──────────
        const historyBlocks = messages
            .map((m, index) => ({ m, index }))
            .filter(({ m }) => m && (m.role === 'user' || m.role === 'assistant'))
            .map(({ m, index }) => {
                const tailMeta = getOneRingTailMeta(m.content);
                return {
                    role: m.role,
                    text: fuzzy.extractText(m.content),
                    frontendSource: tailMeta?.frontendSource || null,
                    index,
                    _msg: m
                };
            });

        if (historyBlocks.length === 0) return messages;

        if (onlyMode || recordOnly) {
            if (debugMode) {
                const reason = onlyMode ? 'trigger Only mode' : 'ONERING_RECORD_ONLY';
                console.log(`[OneRing] Record-only mode enabled by ${reason} for agent="${agentName}" frontend="${frontendSource}"`);
            }
            const result = this._processRecordOnlyMessages(
                messages,
                agentName,
                frontendSource,
                defaultUserName,
                threshold,
                snapshotMaxBlocks,
                outputDedupeThreshold
            );
            return this._applyTailTagPlacement(result);
        }

        // ── 3. 从 DB 查询同信道历史，做 diff（优先快照精确编辑，兜底 fuzzy）────
        let patchMessages = messages;
        let isFreshShortContext = false;
        const localPostBlocks = this._extractLocalPostBlocks(messages, agentName, frontendSource, defaultUserName);
        const summaryStats = {
            injected: 0,
            dbInserted: 0,
            dbUpdated: 0,
            snapshotEdited: 0,
            fuzzyEdited: 0,
            outputDeduped: 0,
            snapshotSaved: 0
        };

        try {
            const snapshotResult = snapshot.applySnapshotEdits(
                agentName,
                frontendSource,
                localPostBlocks,
                projectBasePath,
                { debug: debugMode }
            );
            summaryStats.snapshotEdited += snapshotResult.editedCount || 0;
            summaryStats.dbUpdated += snapshotResult.editedCount || 0;
            if (debugMode && snapshotResult.reliable) {
                console.log(`[OneRing] Snapshot edit diff: edited=${snapshotResult.editedCount} exact=${snapshotResult.exactMatches} comparable=${snapshotResult.comparable} offset=${snapshotResult.offset}`);
            }

            const dbBlocks = db.getRecentMessagesByFrontend(agentName, frontendSource, maxBlocks * 2, projectBasePath);

            // 全新短上下文：DB 尚无同前端记录，且 post 内历史块很少。
            // 策略：新 user 先入库；若同 Agent 已有全局历史，再做保守补充。
            // 注意：长上下文无匹配时不补充；只有短新 user 场景可以尝试接入同 Agent 既有时间线。
            if (dbBlocks.length === 0 && historyBlocks.length <= 4) {
                isFreshShortContext = true;
                const newConversationStartUserIndex = this._detectNewConversationStartUserIndex(messages, defaultUserName, agentName);
                const freshStats = this._recordFreshShortContext(agentName, frontendSource, defaultUserName, historyBlocks, threshold, newConversationStartUserIndex);
                summaryStats.dbInserted += freshStats.inserted || 0;
                summaryStats.dbUpdated += freshStats.updated || 0;
            } else if (dbBlocks.length > 0) {
                // 同前端 DB 只与当前前端/无尾标块对齐；跨端注入块不能参与 diff，
                // 否则第二轮以后会把上轮补入的手机/其他端历史误判为结构错位。
                const diffBlocks = historyBlocks.filter(block =>
                    !block.frontendSource || block.frontendSource === frontendSource
                );
                const diffResult = fuzzy.diffContext(diffBlocks, dbBlocks, threshold);

                const totalPost = diffBlocks.length;
                const unmatchedCount = diffResult.unknownCount + diffResult.newBlocks.length;
                const isShortPost = totalPost <= 2;
                const unknownRatio = isShortPost
                    ? 0 // 新 user / 极短对话豁免：允许尝试补充
                    : unmatchedCount / totalPost;
                const patchSafe = diffResult.reliable || isShortPost;

                if (debugMode) {
                    console.log(`[OneRing] diff: matched=${diffResult.matchedCount} unknown=${diffResult.unknownCount} new=${diffResult.newBlocks.length} edited=${diffResult.editedBlocks.length} unknownRatio=${unknownRatio.toFixed(2)} reliable=${diffResult.reliable} patchSafe=${patchSafe}`);
                }

                if (unknownRatio <= maxUnknownRatio && patchSafe && diffResult.reliable) {
                    // 只有可靠 diff 才更新被编辑的历史消息；极短新 post 不允许误覆盖旧 DB。
                    for (const edited of diffResult.editedBlocks) {
                        db.updateMessageById(agentName, edited.dbId, edited.newText, projectBasePath);
                        summaryStats.fuzzyEdited++;
                        summaryStats.dbUpdated++;
                        if (debugMode) console.log(`[OneRing] Updated edited block dbId=${edited.dbId}`);
                    }
                } else {
                    if (debugMode) console.log(`[OneRing] Unreliable diff, skipping edit update.`);
                }
            }
        } catch (e) {
            console.error('[OneRing] DB diff error, skipping patch:', e.message);
        }

        // ── 4. 跨端历史补全：fuzzy 反查每条 DB 历史是否在上下文存在，缺失的按时间戳补入 ──
        if (allowPatch) {
            try {
                patchMessages = this._doFuzzyTimestampPatch(messages, agentName, frontendSource, maxBlocks, threshold);
                summaryStats.injected += patchMessages.__oneRingInjectedCount || 0;
            } catch (e) {
                console.error('[OneRing] Patch error, using original messages:', e.message);
                patchMessages = messages;
            }
        }

        // ── 5. 为当前 post 的 user/assistant 历史块补齐尾部标记 ───────────────
        // 关键原因：AI 回复入库是异步 DB 写入，不会回写给前端历史；
        // 下一轮前端带回来的 assistant 历史可能没有 OneRing 标记，因此这里必须补标。
        const nextTimestamp = createOneRingTimestampSequencer();
        const now = nextTimestamp();
        const newConversationStartUserIndex = this._detectNewConversationStartUserIndex(messages, defaultUserName, agentName);

        // 入库必须以“实际 post 传入的上下文”为真相；
        // patchMessages 可能已经包含 DB 补齐块，不能再反向同步进 DB。
        const realUserEntries = [...messages].map((m, i) => ({ m, i }))
            .filter(({ m }) => m && m.role === 'user')
            .map(({ m, i }) => ({
                m,
                i,
                classified: classifyUserContent(m.content, defaultUserName, agentName)
            }))
            .filter(({ classified }) => !!classified);

        const lastRealUserIdx = realUserEntries.pop();

        if (lastRealUserIdx && !isFreshShortContext) {
            const userRecordResult = this._recordUserMessage(
                agentName,
                frontendSource,
                lastRealUserIdx.classified.senderName,
                lastRealUserIdx.classified.cleanText,
                now,
                threshold,
                lastRealUserIdx.i === newConversationStartUserIndex
            );
            if (userRecordResult === 'insert') summaryStats.dbInserted++;
            if (userRecordResult === 'update') summaryStats.dbUpdated++;
        }

        if (!isFreshShortContext) {
            const incomingAssistantStats = this._recordIncomingAssistantContext(
                agentName,
                frontendSource,
                messages,
                nextTimestamp,
                threshold
            );
            summaryStats.dbInserted += incomingAssistantStats.inserted || 0;
            summaryStats.dbUpdated += incomingAssistantStats.updated || 0;
        }

        patchMessages = patchMessages.map((m) => {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return m;

            const existingMeta = getOneRingTailMeta(m.content);
            if (m.role === 'assistant') {
                const classifiedAssistant = classifyUserContent(m.content, agentName, agentName);
                if (!classifiedAssistant) return m;

                if (existingMeta && existingMeta.senderName === classifiedAssistant.senderName) return m;

                return {
                    ...m,
                    content: upsertTailTag(
                        m.content,
                        classifiedAssistant.senderName,
                        existingMeta?.timestamp || nextTimestamp(),
                        existingMeta?.frontendSource || frontendSource
                    )
                };
            }

            const classified = classifyUserContent(m.content, defaultUserName, agentName);
            if (!classified) return m;

            const originalIndex = messages.indexOf(m);
            const shouldMarkNewConversationStart = originalIndex === newConversationStartUserIndex;
            if (
                existingMeta &&
                existingMeta.senderName === classified.senderName &&
                (!shouldMarkNewConversationStart || existingMeta.isNewConversationStart)
            ) return m;

            return {
                ...m,
                content: upsertTailTag(
                    m.content,
                    classified.senderName,
                    existingMeta?.timestamp || nextTimestamp(),
                    existingMeta?.frontendSource || frontendSource,
                    shouldMarkNewConversationStart || existingMeta?.isNewConversationStart
                )
            };
        });

        const beforeDedupeCount = patchMessages.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        patchMessages = dedupeAdjacentSimilarConversation(patchMessages, outputDedupeThreshold);
        const afterDedupeCount = patchMessages.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        summaryStats.outputDeduped += Math.max(0, beforeDedupeCount - afterDedupeCount);

        try {
            const snapshotSaveResult = snapshot.saveSnapshotFromDb(
                agentName,
                frontendSource,
                localPostBlocks,
                projectBasePath,
                { debug: debugMode, maxSnapshotBlocks: snapshotMaxBlocks }
            );
            summaryStats.snapshotSaved += snapshotSaveResult.savedCount || 0;
        } catch (e) {
            console.error('[OneRing] Snapshot save failed:', e.message);
        }

        logOneRingSummary(agentName, frontendSource, 'normal', summaryStats);

        try {
            Object.defineProperty(patchMessages, '__oneRingMeta', {
                value: { agentName, frontendSource },
                enumerable: false,
                configurable: true
            });
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Failed to attach non-enumerable meta:', e.message);
        }

        return this._applyTailTagPlacement(patchMessages);
    }

    /**
     * 核心补全逻辑：fuzzy 仔细检查 DB 历史中每条消息是否在上下文已存在，
     * 将缺失的块按时间戳合并补入上下文。
     * 不依赖已有尾标时间戳，用 fuzzy 相似度比对实现去重。
     */
    _doFuzzyTimestampPatch(messages, agentName, frontendSource, maxBlocks, threshold = 0.92) {
        const histMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant');
        const remaining = Math.max(0, maxBlocks - histMsgs.length);
        if (remaining <= 0) return isOneRingTimeInsertEnabled()
            ? mergeConversationByOneRingTimestamp(messages)
            : messages;

        let dbHistory = [];
        try {
            dbHistory = db.getRecentMessages(agentName, maxBlocks * 3, projectBasePath);
        } catch (e) {
            console.error('[OneRing] Fuzzy patch DB query failed:', e.message);
            return messages;
        }

        if (dbHistory.length === 0) return messages;

        // 为每条 DB 历史 fuzzy 反查是否在当前上下文中已存在
        const missing = dbHistory.filter(dbItem => {
            const dbKey = fuzzy.normalize(dbItem.content);
            if (!dbKey) return false;
            return !histMsgs.some(m => {
                const postKey = fuzzy.normalize(fuzzy.extractText(m.content));
                return m.role === dbItem.role && fuzzy.similarity(dbKey, postKey) >= threshold;
            });
        });

        if (missing.length === 0) return isOneRingTimeInsertEnabled()
            ? mergeConversationByOneRingTimestamp(messages)
            : messages;

        const padded = missing.slice(-remaining).map(item => ({
            role: item.role,
            content: `${stripOneRingTailTagText(item.content)}\n[OneRing通知:${item.senderName || item.agentName || '?'}于${item.timestamp}发送于${item.frontendSource || '?'}]`
        }));

        if (debugMode) console.log(`[OneRing] Fuzzy patch: ${padded.length} missing blocks补入上下文`);

        const patched = isOneRingTimeInsertEnabled()
            ? mergeConversationByOneRingTimestamp([...messages, ...padded])
            : [...messages, ...padded];
        try {
            Object.defineProperty(patched, '__oneRingInjectedCount', {
                value: padded.length,
                enumerable: false,
                configurable: true
            });
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Failed to attach patch injected count:', e.message);
        }
        return patched;
    }

    _applyTailTagPlacement(messages) {
        if (!Array.isArray(messages) || hotConfig.tailTagPlacement !== TAIL_TAG_PLACEMENT_SYSTEM_USER_BLOCK) {
            return messages;
        }

        const result = [];
        for (const message of messages) {
            if (!message || message.role !== 'assistant') {
                result.push(message);
                continue;
            }

            const meta = getOneRingTailMeta(message.content);
            if (!meta) {
                result.push(message);
                continue;
            }

            result.push({
                ...message,
                content: this._stripTailTagFromContent(message.content)
            });
            result.push({
                role: 'user',
                content: `[系统提示:][OneRing通知:上一条消息由${meta.senderName}于${meta.timestamp}发送于${meta.frontendSource}]`
            });
        }

        if (messages.__oneRingMeta) {
            this._attachMeta(result, messages.__oneRingMeta.agentName, messages.__oneRingMeta.frontendSource);
        }
        return result;
    }

    _stripTailTagFromContent(content) {
        if (typeof content === 'string') {
            return stripOneRingTailTagText(content);
        }
        if (Array.isArray(content)) {
            return content.map((part) => {
                if (part && part.type === 'text' && typeof part.text === 'string') {
                    return { ...part, text: stripOneRingTailTagText(part.text) };
                }
                return part;
            });
        }
        if (content && typeof content === 'object' && typeof content.text === 'string') {
            return { ...content, text: stripOneRingTailTagText(content.text) };
        }
        return content;
    }

    _detectNewConversationStartUserIndex(messages, defaultUserName, agentName) {
        if (!Array.isArray(messages)) return -1;

        const effectiveBlocks = [];
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;

            if (message.role === 'assistant') {
                effectiveBlocks.push({ role: 'assistant', index: i });
                continue;
            }

            const classified = classifyUserContent(message.content, defaultUserName, agentName);
            if (!classified) {
                // 纯系统通知 user 块在新对话起点判定中也被忽略。
                continue;
            }

            effectiveBlocks.push({ role: 'user', index: i, classified });
        }

        if (effectiveBlocks.length !== 1 || effectiveBlocks[0].role !== 'user') return -1;
        return effectiveBlocks[0].index;
    }

    _attachMeta(messages, agentName, frontendSource) {
        try {
            Object.defineProperty(messages, '__oneRingMeta', {
                value: { agentName, frontendSource },
                enumerable: false,
                configurable: true
            });
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Failed to attach non-enumerable meta:', e.message);
        }
        return messages;
    }

    _processRecordOnlyMessages(messages, agentName, frontendSource, defaultUserName, threshold, maxSnapshotBlocks = 20, outputDedupeThreshold = 0.98) {
        const nextTimestamp = createOneRingTimestampSequencer();
        let result = Array.isArray(messages) ? [...messages] : messages;

        const postBlocks = this._extractLocalPostBlocks(result, agentName, frontendSource, defaultUserName);
        const summaryStats = {
            injected: 0,
            dbInserted: 0,
            dbUpdated: 0,
            snapshotEdited: 0,
            fuzzyEdited: 0,
            outputDeduped: 0,
            snapshotSaved: 0
        };

        try {
            const snapshotResult = snapshot.applySnapshotEdits(
                agentName,
                frontendSource,
                postBlocks,
                projectBasePath,
                { debug: debugMode }
            );
            summaryStats.snapshotEdited += snapshotResult.editedCount || 0;
            summaryStats.dbUpdated += snapshotResult.editedCount || 0;
            if (debugMode && snapshotResult.reliable) {
                console.log(`[OneRing] Record-only snapshot edit diff: edited=${snapshotResult.editedCount} exact=${snapshotResult.exactMatches} comparable=${snapshotResult.comparable} offset=${snapshotResult.offset}`);
            }
        } catch (e) {
            console.error('[OneRing] Record-only snapshot edit failed:', e.message);
        }

        const newConversationStartUserIndex = this._detectNewConversationStartUserIndex(result, defaultUserName, agentName);
        const syncStats = this._syncRecordOnlyPostWithDb(agentName, frontendSource, defaultUserName, result, nextTimestamp, threshold, postBlocks, newConversationStartUserIndex);
        summaryStats.dbInserted += syncStats.inserted || 0;
        summaryStats.dbUpdated += syncStats.updated || 0;
        summaryStats.fuzzyEdited += syncStats.fuzzyEdited || 0;

        result = result.map((m) => {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return m;

            const existingMeta = getOneRingTailMeta(m.content);
            if (m.role === 'assistant') {
                const classifiedAssistant = classifyUserContent(m.content, agentName, agentName);
                if (!classifiedAssistant) return m;

                if (existingMeta && existingMeta.senderName === classifiedAssistant.senderName) return m;

                return {
                    ...m,
                    content: upsertTailTag(
                        m.content,
                        classifiedAssistant.senderName,
                        existingMeta?.timestamp || nextTimestamp(),
                        existingMeta?.frontendSource || frontendSource
                    )
                };
            }

            const classified = classifyUserContent(m.content, defaultUserName, agentName);
            if (!classified) return m;

            const originalIndex = result.indexOf(m);
            const shouldMarkNewConversationStart = originalIndex === newConversationStartUserIndex;
            if (
                existingMeta &&
                existingMeta.senderName === classified.senderName &&
                (!shouldMarkNewConversationStart || existingMeta.isNewConversationStart)
            ) return m;

            return {
                ...m,
                content: upsertTailTag(
                    m.content,
                    classified.senderName,
                    existingMeta?.timestamp || nextTimestamp(),
                    existingMeta?.frontendSource || frontendSource,
                    shouldMarkNewConversationStart || existingMeta?.isNewConversationStart
                )
            };
        });

        const beforeDedupeCount = result.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        result = dedupeAdjacentSimilarConversation(result, outputDedupeThreshold);
        const afterDedupeCount = result.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        summaryStats.outputDeduped += Math.max(0, beforeDedupeCount - afterDedupeCount);

        try {
            const snapshotSaveResult = snapshot.saveSnapshotFromDb(
                agentName,
                frontendSource,
                postBlocks,
                projectBasePath,
                { debug: debugMode, maxSnapshotBlocks }
            );
            summaryStats.snapshotSaved += snapshotSaveResult.savedCount || 0;
        } catch (e) {
            console.error('[OneRing] Record-only snapshot save failed:', e.message);
        }

        logOneRingSummary(agentName, frontendSource, 'record-only', summaryStats);

        return this._attachMeta(result, agentName, frontendSource);
    }

    _extractLocalPostBlocks(messages, agentName, frontendSource, defaultUserName) {
        if (!Array.isArray(messages)) return [];

        return messages
            .map((m, index) => ({ m, index }))
            .filter(({ m }) => m && (m.role === 'user' || m.role === 'assistant'))
            .map(({ m, index }) => {
                const tailMeta = getOneRingTailMeta(m.content);
                const rawText = fuzzy.extractText(m.content);
                if (m.role === 'user') {
                    const classified = classifyUserContent(rawText, defaultUserName, agentName);
                    if (!classified) return null;
                    return {
                        role: m.role,
                        text: classified.cleanText,
                        senderName: classified.senderName,
                        frontendSource: tailMeta?.frontendSource || null,
                        index
                    };
                }
                const classified = classifyUserContent(rawText, agentName, agentName);
                if (!classified) return null;
                return {
                    role: m.role,
                    text: classified.cleanText,
                    senderName: classified.senderName,
                    frontendSource: tailMeta?.frontendSource || null,
                    index
                };
            })
            .filter(Boolean)
            .filter(block => !block.frontendSource || block.frontendSource === frontendSource)
            .filter(block => block.text);
    }

    _syncRecordOnlyPostWithDb(agentName, frontendSource, defaultUserName, messages, nextTimestamp, threshold, precomputedPostBlocks = null, newConversationStartUserIndex = -1) {
        const stats = { inserted: 0, updated: 0, fuzzyEdited: 0 };
        if (!Array.isArray(messages)) return stats;

        const postBlocks = Array.isArray(precomputedPostBlocks)
            ? precomputedPostBlocks
            : this._extractLocalPostBlocks(messages, agentName, frontendSource, defaultUserName);

        if (postBlocks.length === 0) return stats;

        try {
            const dbBlocks = db.getRecentMessagesByFrontend(
                agentName,
                frontendSource,
                Math.max(postBlocks.length * 2, 20),
                projectBasePath
            );

            const diffResult = fuzzy.diffContext(postBlocks, dbBlocks, threshold);

            for (const edited of diffResult.editedBlocks) {
                db.updateMessageById(agentName, edited.dbId, edited.newText, projectBasePath);
                stats.updated++;
                stats.fuzzyEdited++;
                if (debugMode) console.log(`[OneRing] Only mode updated edited block dbId=${edited.dbId}`);
            }

            for (const block of diffResult.newBlocks) {
                if (block.role === 'user') {
                    const userResult = this._recordUserMessage(
                        agentName,
                        frontendSource,
                        block.senderName || defaultUserName,
                        block.text,
                        nextTimestamp(),
                        threshold,
                        block.index === newConversationStartUserIndex
                    );
                    if (userResult === 'insert') stats.inserted++;
                    if (userResult === 'update') stats.updated++;
                } else if (block.role === 'assistant') {
                    const assistantResult = this._recordAssistantMessage(agentName, frontendSource, block.text, nextTimestamp(), threshold, block.senderName || agentName);
                    if (assistantResult === 'insert') stats.inserted++;
                    if (assistantResult === 'update') stats.updated++;
                }
            }

            // 单条/极短 post 在低相似度下会被 diff 保守标为 unknown。
            // Only 模式以最终 post 为真相，因此兜底记录最后一个 user，避免新消息漏记。
            if (diffResult.unknownCount > 0 && postBlocks.length <= 2) {
                const lastUser = [...postBlocks].reverse().find(block => block.role === 'user');
                if (lastUser) {
                    const userResult = this._recordUserMessage(
                        agentName,
                        frontendSource,
                        lastUser.senderName || defaultUserName,
                        lastUser.text,
                        nextTimestamp(),
                        threshold,
                        lastUser.index === newConversationStartUserIndex
                    );
                    if (userResult === 'insert') stats.inserted++;
                    if (userResult === 'update') stats.updated++;
                }
            }
        } catch (e) {
            console.error('[OneRing] Only mode DB sync failed:', e.message);
        }
        return stats;
    }

    /**
     * 从最终发送给上游的 messages 中推导 OneRing 元信息。
     * 注意：不在 message 对象上附加私有字段，避免 JSON.stringify 后发给上游。
     */
    _extractMetaFromMessages(messages) {
        if (!Array.isArray(messages)) return null;

        const attachedMeta = messages.__oneRingMeta || null;

        const systemMsg = messages.find(m => m.role === 'system');
        const systemText = systemMsg ? fuzzy.extractText(systemMsg.content) : '';
        const triggerMatch = getLastTriggerMatch(systemText);
        const noticeMatch = /\[OneRing系统已启动，当前Agent([\s\S]*?)，当前客户端([\s\S]*?)，所有上下文OneRing信息来源标记由系统生成无需你自动输出。\]/.exec(systemText);

        const agentName = attachedMeta?.agentName || (triggerMatch ? triggerMatch[1].trim() : null) || (noticeMatch ? noticeMatch[1].trim() : null);
        const frontendSourceFromTrigger = attachedMeta?.frontendSource || (triggerMatch ? triggerMatch[2].trim() : null) || (noticeMatch ? noticeMatch[2].trim() : null);
        if (!agentName || !frontendSourceFromTrigger) return null;

        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const tailMeta = lastUser ? getOneRingTailMeta(lastUser.content) : null;

        return {
            agentName,
            frontendSource: tailMeta ? tailMeta.frontendSource : frontendSourceFromTrigger,
            lastUserSenderName: tailMeta ? tailMeta.senderName : null,
            lastUserTimestamp: tailMeta ? tailMeta.timestamp : null
        };
    }

    /**
     * AI 回复入库（异步，fire-and-forget，供 Stream/NonStream handler 在最终回复完成后调用）。
     */
    async recordAIResponseFromMessages(messages, aiText) {
        const meta = this._extractMetaFromMessages(messages);
        if (!meta || !meta.agentName || typeof aiText !== 'string' || aiText.trim().length === 0) return;

        try {
            db.insertMessage(meta.agentName, {
                role: 'assistant',
                senderName: meta.agentName,
                frontendSource: meta.frontendSource,
                content: aiText,
                timestamp: formatOneRingTimestamp(),
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            if (debugMode) console.log(`[OneRing] Recorded assistant response for agent=${meta.agentName}`);
        } catch (e) {
            console.error('[OneRing] Failed to record AI response:', e.message);
        }
    }

    /**
     * 兼容旧调用：AI 回复入库（异步，fire-and-forget）。
     */
    async recordAIResponse(meta, aiText) {
        if (!meta || !meta.agentName || typeof aiText !== 'string' || aiText.trim().length === 0) return;
        try {
            db.insertMessage(meta.agentName, {
                role: 'assistant',
                senderName: meta.agentName,
                frontendSource: meta.frontendSource,
                content: aiText,
                timestamp: formatOneRingTimestamp(),
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            if (debugMode) console.log(`[OneRing] Recorded assistant response for agent=${meta.agentName}`);
        } catch (e) {
            console.error('[OneRing] Failed to record AI response:', e.message);
        }
    }

    /**
     * 全新短上下文入库。
     * 用于 user/assistant 块都很少、同前端 DB 为空的初次对话场景。
     * 记录 post 中已经存在的真实块；跨端补充由 _doFreshShortContextPatch 负责。
     */
    _recordFreshShortContext(agentName, frontendSource, defaultUserName, historyBlocks, threshold = 0.92, newConversationStartUserIndex = -1) {
        const stats = { inserted: 0, updated: 0 };
        const nextTimestamp = createOneRingTimestampSequencer();
        for (const block of historyBlocks) {
            if (block.role === 'user') {
                const classified = classifyUserContent(block.text, defaultUserName, agentName);
                if (!classified) continue;
                const userResult = this._recordUserMessage(
                    agentName,
                    frontendSource,
                    classified.senderName,
                    classified.cleanText,
                    nextTimestamp(),
                    threshold,
                    block.index === newConversationStartUserIndex
                );
                if (userResult === 'insert') stats.inserted++;
                if (userResult === 'update') stats.updated++;
            } else if (block.role === 'assistant' && typeof block.text === 'string' && block.text.trim()) {
                const classifiedAssistant = classifyUserContent(block.text, agentName, agentName);
                if (!classifiedAssistant) continue;
                const assistantResult = this._recordAssistantMessage(
                    agentName,
                    frontendSource,
                    classifiedAssistant.cleanText,
                    nextTimestamp(),
                    threshold,
                    classifiedAssistant.senderName
                );
                if (assistantResult === 'insert') stats.inserted++;
                if (assistantResult === 'update') stats.updated++;
            }
        }
        return stats;
    }

    _recordIncomingAssistantContext(agentName, frontendSource, messages, timestamp, threshold = 0.92) {
        const stats = { inserted: 0, updated: 0 };
        if (!Array.isArray(messages)) return stats;

        for (const m of messages) {
            if (!m || m.role !== 'assistant') continue;

            const classified = classifyUserContent(m.content, agentName, agentName);
            if (!classified) continue;

            // 群聊/AA 中 assistant role 可能承载别的 Agent 发言，必须入库给 OneRing 时间线。
            // 纯 Direct assistant 默认由 final callback 记录，避免当前目标 AI 的回复被重复同步。
            if (classified.source === 'Direct' && classified.senderName === agentName) continue;

            const assistantResult = this._recordAssistantMessage(
                agentName,
                frontendSource,
                classified.cleanText,
                typeof timestamp === 'function' ? timestamp() : timestamp,
                threshold,
                classified.senderName
            );
            if (assistantResult === 'insert') stats.inserted++;
            if (assistantResult === 'update') stats.updated++;
        }
        return stats;
    }

    _recordAssistantMessage(agentName, frontendSource, cleanText, timestamp, threshold = 0.92, senderName = agentName) {
        try {
            const recent = db.getRecentMessagesByFrontend(agentName, frontendSource, 12, projectBasePath)
                .filter(item => item.role === 'assistant')
                .slice(-1)[0];

            if (recent && fuzzy.similarity(cleanText, recent.content) >= threshold) {
                db.updateMessageById(agentName, recent.id, cleanText, projectBasePath);
                if (debugMode) console.log(`[OneRing] Updated recent assistant message dbId=${recent.id}`);
                return 'update';
            }

            db.insertMessage(agentName, {
                role: 'assistant',
                senderName,
                frontendSource,
                content: cleanText,
                timestamp,
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            if (debugMode) console.log(`[OneRing] Recorded assistant message for agent=${agentName}, sender=${senderName}, frontend=${frontendSource}`);
            return 'insert';
        } catch (e) {
            console.error('[OneRing] Failed to record assistant message:', e.message);
            return 'error';
        }
    }

    /**
     * user 发言入库（在 processMessages 内部确认要入库时调用）。
     * 最近同前端 user 块高度相似时执行 UPDATE，避免 retry / 重新发送导致重复写入。
     */
    _recordUserMessage(agentName, frontendSource, senderName, cleanText, timestamp, threshold = 0.92, isNewConversationStart = false) {
        try {
            const dbContent = isNewConversationStart
                ? upsertTailTag(cleanText, senderName, timestamp, frontendSource, true)
                : cleanText;
            const recent = db.getRecentMessagesByFrontend(agentName, frontendSource, 12, projectBasePath)
                .filter(item => item.role === 'user')
                .slice(-1)[0];

            if (recent && fuzzy.similarity(cleanText, recent.content) >= threshold) {
                db.updateMessageById(agentName, recent.id, dbContent, projectBasePath);
                if (debugMode) console.log(`[OneRing] Updated recent user message dbId=${recent.id}`);
                return 'update';
            }

            db.insertMessage(agentName, {
                role: 'user',
                senderName,
                frontendSource,
                content: dbContent,
                timestamp,
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            if (debugMode) console.log(`[OneRing] Recorded user message for agent=${agentName}, sender=${senderName}, frontend=${frontendSource}`);
            return 'insert';
        } catch (e) {
            console.error('[OneRing] Failed to record user message:', e.message);
            return 'error';
        }
    }

    initialize(initialConfig, dependencies) {
        config = initialConfig || {};
        debugMode = String(config.DebugMode || 'false').toLowerCase() === 'true';
        if (dependencies && dependencies.vcpLogFunctions) {
            // 预留：未来可接入 VCPLog
        }
        projectBasePath = config.PROJECT_BASE_PATH || '';
        this._projectBasePath = projectBasePath;
        hotConfigPath = path.join(projectBasePath || path.join(__dirname, '..', '..'), 'Plugin', 'OneRing', HOT_CONFIG_FILE_NAME);
        setupHotConfigWatcher();
        console.log(`[OneRing] Initialized. agent-scoped SQLite at ${projectBasePath}/Plugin/OneRing/data/`);
    }

    shutdown() {
        if (hotConfigWatcher) {
            hotConfigWatcher.close().catch(() => {});
            hotConfigWatcher = null;
        }
        db.closeAll();
        console.log('[OneRing] Shutdown, all DB connections closed.');
    }
}

module.exports = new OneRingPreprocessor();