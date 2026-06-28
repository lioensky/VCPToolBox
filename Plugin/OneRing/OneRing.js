'use strict';
// OneRing.js — 统一上下文预处理器主模块
// 触发语法：系统提示词中包含 [[OneRing::AgentName::Frontend]]
// Only 模式：[[OneRing::AgentName::Frontend::Only]] 或独立 [[OneRing::Only]] 只入库/标记，不做跨端上下文追加。

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const db = require('./OneRingDB.js');
const fuzzy = require('./OneRingFuzzy.js');
const fuzzyPool = require('./OneRingFuzzyPool.js');
const snapshot = require('./OneRingSnapshot.js');
const timelineCommon = require('./OneRingTimelineCommon.js');
const { RawClientTimelineStrategy, probeRawClientTimestampBindings } = require('./OneRingRawClientTimeline.js');
const { ServerInferredTimelineStrategy } = require('./OneRingServerInferredTimeline.js');

// ─── 触发语法解析 ────────────────────────────────────────────────────────────
const TRIGGER_REGEX = /\[\[OneRing::([^:]+?)::([^:\]]+?)(?:::([^\]]+?))?\]\]/;
const TRIGGER_GLOBAL_REGEX = /\[\[OneRing::([^:]+?)::([^:\]]+?)(?:::([^\]]+?))?\]\]/g;
const ONLY_TRIGGER_GLOBAL_REGEX = /\[\[OneRing::Only\]\]/gi;
const VCP_RAG_BLOCK_REGEX = /<!--\s*VCP_RAG_BLOCK_START\b[\s\S]*?<!--\s*VCP_RAG_BLOCK_END\s*-->/gi;

function stripVcpRagBlocks(text) {
    return typeof text === 'string' ? text.replace(VCP_RAG_BLOCK_REGEX, '') : text;
}

function getVcpRagBlockRanges(text) {
    if (typeof text !== 'string') return [];
    const ranges = [];
    const re = new RegExp(VCP_RAG_BLOCK_REGEX.source, VCP_RAG_BLOCK_REGEX.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }
    return ranges;
}

function overlapsAnyRange(start, end, ranges) {
    return ranges.some(range => start < range.end && end > range.start);
}

function replaceLastOccurrenceOutsideVcpRagBlocks(text, search, replacement) {
    if (typeof text !== 'string' || !search) return text;
    const ranges = getVcpRagBlockRanges(text);
    let idx = text.lastIndexOf(search);
    while (idx >= 0) {
        const end = idx + search.length;
        if (!overlapsAnyRange(idx, end, ranges)) {
            return text.slice(0, idx) + replacement + text.slice(end);
        }
        idx = text.lastIndexOf(search, idx - 1);
    }
    return text;
}

function getLastTriggerMatch(systemText) {
    if (typeof systemText !== 'string') return null;
    const matches = [...stripVcpRagBlocks(systemText).matchAll(TRIGGER_GLOBAL_REGEX)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1];
}

function getLastOnlyTriggerMatch(systemText) {
    if (typeof systemText !== 'string') return null;
    const matches = [...stripVcpRagBlocks(systemText).matchAll(ONLY_TRIGGER_GLOBAL_REGEX)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1];
}

function getLastNoticeMeta(systemText) {
    if (typeof systemText !== 'string') return null;
    systemText = stripVcpRagBlocks(systemText);

    // 完整通知格式：
    // [OneRing系统已启动，当前Agent小吉，当前客户端VCPChat，所有上下文OneRing信息来源标记由系统生成无需你自动输出。]
    // 或：
    // [OneRing系统已启动，当前Agent小吉，当前客户端VCPChat，当前模式Only，所有上下文OneRing信息来源标记由系统生成无需你自动输出。]
    //
    // final hook 兜底时可能只拿到被其他处理器截断/改写后的顶部占位符替换文本，例如：
    // [OneRing系统已启动，当前Agent小吉，当前客户端VCPChat，
    // 因此这里只解析 agent/frontend/mode 前缀，不强依赖完整尾句。
    const re = /\[OneRing系统已启动，当前Agent([^，\]\r\n]+)，当前客户端([^，\]\r\n]+)(?:，当前模式([^，\]\r\n]+))?/g;
    let m;
    let last = null;
    while ((m = re.exec(systemText)) !== null) {
        last = m;
    }
    if (!last) return null;

    return {
        agentName: last[1].trim(),
        frontendSource: last[2].trim(),
        mode: last[3] ? last[3].trim() : ''
    };
}

// ─── 顶层 system 触发块选择 ───────────────────────────────────────────────────
function getTopLevelOneRingSystemMessage(messages) {
    if (!Array.isArray(messages)) return null;

    // 只信任从 messages 开头开始的连续 system 前缀，数量不做固定假设。
    // 一旦遇到 user/assistant/其他 role，后续 system 都视为上下文中的系统块，不参与 OneRing 触发。
    const topLevelSystemCandidates = [];
    for (const message of messages) {
        if (!message || message.role !== 'system') break;
        const text = fuzzy.extractText(message.content);
        if (getLastTriggerMatch(text)) {
            topLevelSystemCandidates.push({ message, text });
        }
    }

    if (topLevelSystemCandidates.length === 0) return null;
    return topLevelSystemCandidates[topLevelSystemCandidates.length - 1].message;
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
const LEADING_SYSTEM_NOTICE_REGEX = /^\s*\[系统通知\][\s\S]*?\[系统通知结束\]\s*/;

function stripOneRingTailTagText(text) {
    return typeof text === 'string' ? text.replace(ONERING_TAIL_STACK_REGEX, '').trim() : '';
}

function stripLeadingSystemNoticeText(text) {
    if (typeof text !== 'string') return '';
    let result = text;
    while (LEADING_SYSTEM_NOTICE_REGEX.test(result)) {
        result = result.replace(LEADING_SYSTEM_NOTICE_REGEX, '');
    }
    return result.trim();
}

function sanitizeUserTextAtPipelineEntry(text) {
    return stripLeadingSystemNoticeText(text);
}

function sanitizeUserContentAtPipelineEntry(content) {
    if (typeof content === 'string') {
        return sanitizeUserTextAtPipelineEntry(content);
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (part && part.type === 'text' && typeof part.text === 'string') {
                    return { ...part, text: sanitizeUserTextAtPipelineEntry(part.text) };
                }
                return part;
            })
            .filter((part) => !(part && part.type === 'text' && typeof part.text === 'string' && !part.text.trim()));
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return { ...content, text: sanitizeUserTextAtPipelineEntry(content.text) };
    }
    return content;
}

function hasUserTextContent(content) {
    return !!fuzzy.extractText(content).trim();
}

function hasLeadingGroupChatSender(content) {
    const text = fuzzy.extractText(content);
    return GROUPCHAT_SENDER_REGEX.test(text);
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

    // 1. 仅剥离开头系统通知栏；OneRing 尾标只存在于 AI 视野，入口清洗不得剥离前端原文。
    text = sanitizeUserTextAtPipelineEntry(text);

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

/**
 * 从 assistant 消息内容中提取"净内容"和"来源信息"。
 * assistant 块不走 user 入口清洗/系统通知丢弃规则；前端 hash 以原始 assistant 文本为准。
 */
function classifyAssistantContent(rawContent, defaultAssistantName) {
    const text = typeof rawContent === 'string' ? rawContent : fuzzy.extractText(rawContent);
    if (!text.trim()) return null;

    let groupSenderName = null;
    let scanText = text;
    let gcMatch = GROUPCHAT_SENDER_REGEX.exec(scanText);
    while (gcMatch) {
        groupSenderName = gcMatch[1].trim();
        scanText = scanText.replace(GROUPCHAT_SENDER_REGEX, '').trim();
        gcMatch = GROUPCHAT_SENDER_REGEX.exec(scanText);
    }

    if (groupSenderName) {
        return { senderName: groupSenderName, source: 'GroupChat', cleanText: text };
    }

    return { senderName: defaultAssistantName, source: 'Direct', cleanText: text };
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

function markOneRingInjectedFromDb(message) {
    if (!message || typeof message !== 'object') return message;
    try {
        Object.defineProperty(message, '__oneRingInjectedFromDb', {
            value: true,
            enumerable: false,
            configurable: true
        });
    } catch (e) {
        if (debugMode) console.warn('[OneRing] Failed to mark injected DB message:', e.message);
    }
    return message;
}

function isOneRingInjectedFromDb(message) {
    return !!(message && message.__oneRingInjectedFromDb === true);
}

function markOneRingTimelineMeta(message, meta) {
    if (!message || typeof message !== 'object' || !meta || !meta.timestamp) return message;
    try {
        Object.defineProperty(message, '__oneRingTimelineMeta', {
            value: {
                timestamp: meta.timestamp,
                senderName: meta.senderName || '?',
                frontendSource: meta.frontendSource || '?',
                isNewConversationStart: !!meta.isNewConversationStart,
                source: meta.source || 'timeline'
            },
            enumerable: false,
            configurable: true
        });
    } catch (e) {
        if (debugMode) console.warn('[OneRing] Failed to mark timeline meta:', e.message);
    }
    return message;
}

function getOneRingTimelineMeta(message) {
    return message && message.__oneRingTimelineMeta ? message.__oneRingTimelineMeta : null;
}

function markOneRingOriginalIndex(message, originalIndex) {
    if (!message || typeof message !== 'object' || !Number.isInteger(originalIndex)) return message;
    try {
        Object.defineProperty(message, '__oneRingOriginalIndex', {
            value: originalIndex,
            enumerable: false,
            configurable: true
        });
    } catch (e) {
        if (debugMode) console.warn('[OneRing] Failed to mark original index:', e.message);
    }
    return message;
}

function getOneRingOriginalIndex(message) {
    return Number.isInteger(message?.__oneRingOriginalIndex) ? message.__oneRingOriginalIndex : -1;
}

function markOneRingWorkingKey(message, workingKey) {
    if (!message || typeof message !== 'object' || typeof workingKey !== 'string') return message;
    try {
        Object.defineProperty(message, '__oneRingWorkingKey', {
            value: workingKey,
            enumerable: false,
            configurable: true
        });
    } catch (e) {
        if (debugMode) console.warn('[OneRing] Failed to mark working key:', e.message);
    }
    return message;
}

function getOneRingWorkingKey(message) {
    return typeof message?.__oneRingWorkingKey === 'string' ? message.__oneRingWorkingKey : null;
}

function copyOneRingMessageMetadata(source, target) {
    if (!source || !target || typeof source !== 'object' || typeof target !== 'object') return target;

    for (const key of Object.getOwnPropertyNames(source)) {
        if (!key.startsWith('__oneRing')) continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor) continue;
        try {
            Object.defineProperty(target, key, descriptor);
        } catch (e) {
            if (debugMode) console.warn(`[OneRing] Failed to copy message metadata ${key}:`, e.message);
        }
    }

    return target;
}

function cloneMessageWithOneRingMetadata(message, overrides = {}) {
    if (!message || typeof message !== 'object') return message;
    return copyOneRingMessageMetadata(message, { ...message, ...overrides });
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
        return replaceLastOccurrenceOutsideVcpRagBlocks(content, triggerText, notice);
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
                result[i] = { ...part, text: replaceLastOccurrenceOutsideVcpRagBlocks(part.text, triggerText, notice) };
                return result;
            }
        }
        return result;
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return { ...content, text: replaceLastOccurrenceOutsideVcpRagBlocks(content.text, triggerText, notice) };
    }

    return content;
}

function replaceOnlyTriggerWithNotice(content, triggerText) {
    const notice = '[OneRing Only模式已启动：本次只入库/标记，不做跨端上下文追加。]';

    if (typeof content === 'string') {
        return replaceLastOccurrenceOutsideVcpRagBlocks(content, triggerText, notice);
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
                result[i] = { ...part, text: replaceLastOccurrenceOutsideVcpRagBlocks(part.text, triggerText, notice) };
                return result;
            }
        }
        return result;
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return { ...content, text: replaceLastOccurrenceOutsideVcpRagBlocks(content.text, triggerText, notice) };
    }

    return content;
}

// ─── 模块状态 ─────────────────────────────────────────────────────────────────
const HOT_CONFIG_FILE_NAME = 'OneRingConfig.json';
const DEFAULT_HOT_CONFIG = Object.freeze({
    enabled: true,
    tailTagPlacement: 'inline',
    maxContextBlocks: 10,
    timeInsert: true,
    timeInsertPrepend: true,
    timeInsertMiddle: true,
    asyncOnlyMode: true
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
        timeInsert: toBoolean(raw.timeInsert, DEFAULT_HOT_CONFIG.timeInsert),
        timeInsertPrepend: toBoolean(raw.timeInsertPrepend, DEFAULT_HOT_CONFIG.timeInsertPrepend),
        timeInsertMiddle: toBoolean(raw.timeInsertMiddle, DEFAULT_HOT_CONFIG.timeInsertMiddle),
        asyncOnlyMode: toBoolean(raw.asyncOnlyMode, DEFAULT_HOT_CONFIG.asyncOnlyMode)
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
        console.log(`[OneRing] Hot config loaded: enabled=${hotConfig.enabled}, tailTagPlacement=${hotConfig.tailTagPlacement}, maxContextBlocks=${hotConfig.maxContextBlocks}, timeInsert=${hotConfig.timeInsert}, asyncOnlyMode=${hotConfig.asyncOnlyMode}`);
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

function getOneRingSingleAnchorAssistantOptions() {
    const threshold = parseFloat(config.ONERING_SINGLE_ANCHOR_ASSISTANT_FUZZY_THRESHOLD ?? '0.95');
    return {
        enabled: String(config.ONERING_SINGLE_ANCHOR_ASSISTANT_FUZZY_UPDATE ?? 'true').toLowerCase() !== 'false',
        freshnessSeconds: toPositiveInteger(config.ONERING_SINGLE_ANCHOR_FRESHNESS_SECONDS, 1800),
        threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 0.95,
        minAssistantChars: toPositiveInteger(config.ONERING_SINGLE_ANCHOR_ASSISTANT_MIN_CHARS, 60),
        candidateLimit: toPositiveInteger(config.ONERING_SINGLE_ANCHOR_ASSISTANT_CANDIDATE_LIMIT, 5)
    };
}

function parseOneRingLocalTimestampMs(timestamp) {
    if (typeof timestamp !== 'string') return NaN;
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(timestamp.trim());
    if (!match) return NaN;

    const [, year, month, day, hour, minute, second, millisecond = '0'] = match;
    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(millisecond.padEnd(3, '0'))
    ).getTime();
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

    const items = messages.map((message, index) => {
        const isConversation = !!message && (message.role === 'user' || message.role === 'assistant');
        const meta = isConversation
            ? (getOneRingTimelineMeta(message) || getOneRingTailMeta(message.content))
            : null;
        return {
            message,
            index,
            isConversation,
            timestamp: meta?.timestamp || null,
            injectedFromDb: isConversation && isOneRingInjectedFromDb(message)
        };
    });

    const postItems = items.filter(item => item.isConversation && !item.injectedFromDb);
    const injectedItems = items
        .filter(item => item.injectedFromDb && item.timestamp)
        .sort((a, b) => {
            if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
            return a.index - b.index;
        });

    // 强约束：原始 post 数组顺序是绝对真相。
    // 这里绝不能把 system / 伪 system user / 心跳 / post 本体抽出来重组；
    // 只能在原数组流式输出时，在可信 post 锚点前/后插入 DB 缺失块。
    const allowPrepend = hotConfig.timeInsertPrepend !== false;
    const allowInsert = hotConfig.timeInsertMiddle !== false;

    if (injectedItems.length === 0) {
        return messages;
    }

    const firstAnchoredPost = postItems.find(item => !!item.timestamp) || null;
    const firstAnchorTs = firstAnchoredPost ? firstAnchoredPost.timestamp : null;

    const prependBeforeItemIndex = new Map();
    const insertsAfterItemIndex = new Map();
    let conservativeInserted = 0;
    let conservativeSkipped = 0;

    const markInjectedAnchor = (injected, anchorPostItem) => {
        const anchorWorkingKey = getOneRingWorkingKey(anchorPostItem?.message);
        if (anchorWorkingKey) {
            // z<id> 专用于 DB 注入块，表示“插在这个真实 post 块之后”。
            // 不再复用 o<id>，避免和 OneRing 伪 user/旧 orphan 标记混淆。
            markOneRingWorkingKey(injected.message, `z${anchorWorkingKey}`);
        }
    };

    for (const injected of injectedItems) {
        if (allowPrepend && firstAnchoredPost && firstAnchorTs && injected.timestamp < firstAnchorTs) {
            if (!prependBeforeItemIndex.has(firstAnchoredPost.index)) prependBeforeItemIndex.set(firstAnchoredPost.index, []);
            prependBeforeItemIndex.get(firstAnchoredPost.index).push(injected);
            conservativeInserted++;
            continue;
        }

        if (allowInsert && postItems.length >= 2) {
            let inserted = false;
            for (let i = 0; i < postItems.length - 1; i++) {
                const left = postItems[i];
                const right = postItems[i + 1];

                // 核心门禁：净化后的相邻 post 块必须双方都有可信时间戳，且顺序必须严格递增。
                // 只要任一侧无时间戳，或 post 顺序上的时间戳倒序/相等，就禁止在这个缝隙注入 DB 块；
                // 不能用 min/max 容忍倒序，否则会把 06:47 注入到 09:36 后面，造成上下文时间线乱套。
                if (!left.timestamp || !right.timestamp) continue;
                if (!(left.timestamp < right.timestamp)) continue;

                if (injected.timestamp > left.timestamp && injected.timestamp < right.timestamp) {
                    markInjectedAnchor(injected, left);
                    if (!insertsAfterItemIndex.has(left.index)) insertsAfterItemIndex.set(left.index, []);
                    insertsAfterItemIndex.get(left.index).push(injected);
                    conservativeInserted++;
                    inserted = true;
                    break;
                }
            }
            if (inserted) continue;
        }

        conservativeSkipped++;
    }

    if (debugMode && (conservativeInserted > 0 || conservativeSkipped > 0)) {
        console.log(`[OneRing] Conservative timestamp merge: prepend=${[...prependBeforeItemIndex.values()].reduce((n, arr) => n + arr.length, 0)}, midInserted=${[...insertsAfterItemIndex.values()].reduce((n, arr) => n + arr.length, 0)}, skipped=${conservativeSkipped}, postOrderPreserved=true`);
    }

    const result = [];
    const consumedInjected = new Set();

    for (const item of items) {
        if (item.injectedFromDb) continue;

        const prepend = prependBeforeItemIndex.get(item.index) || [];
        for (const injected of prepend) {
            consumedInjected.add(injected.index);
            result.push(injected.message);
        }

        result.push(item.message);

        const inserts = insertsAfterItemIndex.get(item.index) || [];
        for (const injected of inserts) {
            consumedInjected.add(injected.index);
            result.push(injected.message);
        }
    }

    try {
        Object.defineProperty(result, '__oneRingInjectedCount', {
            value: result.filter(message => isOneRingInjectedFromDb(message)).length,
            enumerable: false,
            configurable: true
        });
    } catch (e) {
        if (debugMode) console.warn('[OneRing] Failed to attach merged injected count:', e.message);
    }

    return result;
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

function createOneRingTimingProbe(label, meta = {}) {
    const start = process.hrtime.bigint();
    let last = start;
    const marks = [];
    const thresholdMs = parseFloat(config.ONERING_TIMING_LOG_THRESHOLD_MS ?? '250');

    const elapsedMs = (from, to) => Number(to - from) / 1e6;
    const formatMeta = Object.entries(meta)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');

    return {
        mark(step, extra = '') {
            const now = process.hrtime.bigint();
            marks.push({
                step,
                deltaMs: elapsedMs(last, now),
                totalMs: elapsedMs(start, now),
                extra
            });
            last = now;
        },
        finish(extra = '') {
            const now = process.hrtime.bigint();
            const totalMs = elapsedMs(start, now);
            if (!debugMode && Number.isFinite(thresholdMs) && totalMs < thresholdMs) return;

            const parts = marks.map(mark => {
                const suffix = mark.extra ? ` ${mark.extra}` : '';
                return `${mark.step}=+${mark.deltaMs.toFixed(1)}ms/${mark.totalMs.toFixed(1)}ms${suffix}`;
            });
            const extraText = extra ? ` ${extra}` : '';
            console.log(`[OneRingTiming] ${label}${formatMeta ? ` ${formatMeta}` : ''} total=${totalMs.toFixed(1)}ms${extraText} :: ${parts.join(' | ')}`);
        }
    };
}

async function dedupeAdjacentSimilarConversation(messages, threshold = 0.98) {
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
            await fuzzyPool.similarity(fuzzy.extractText(prev.content), fuzzy.extractText(message.content)) >= threshold
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
        const clientTimestampBindingInfo = timelineCommon.getClientTimestampBindingsFromConfig(cfg, formatOneRingTimestamp);
        const timelineStrategy = this._createTimelineStrategy(clientTimestampBindingInfo);
        const hasClientTimestampTruth = timelineStrategy.hasClientTimestampTruth;
        const originalMessages = Array.isArray(messages) ? messages : null;
        const workingView = hasClientTimestampTruth
            ? null
            : timelineStrategy.buildWorkingView(messages);
        messages = workingView ? workingView.workingMessages : messages;

        // ── 1. 检测触发语法：只检查开头连续 system 前缀 ────────────────────────
        const systemMsg = getTopLevelOneRingSystemMessage(messages);
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

        if (clientTimestampBindingInfo.rawCount > 0) {
            console.log(`[OneRing] Detected ${clientTimestampBindingInfo.bindings.length}/${clientTimestampBindingInfo.rawCount} client safe timestamp hash bindings for agent="${agentName}" frontend="${frontendSource}" schema=${clientTimestampBindingInfo.schemaVersion ?? 'unknown'} mode=${clientTimestampBindingInfo.messageMetadataMode || 'unknown'}`);
            if (typeof timelineStrategy.probe === 'function') {
                timelineStrategy.probe(originalMessages || messages, agentName, frontendSource, hasClientTimestampTruth ? 'raw-authoritative' : 'working-view');
            } else {
                probeRawClientTimestampBindings(originalMessages || messages, clientTimestampBindingInfo, agentName, frontendSource, hasClientTimestampTruth ? 'raw-authoritative' : 'working-view');
            }
        }

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

            const asyncOnlyMode = hotConfig.asyncOnlyMode && String(cfg.ONERING_ASYNC_ONLY_MODE ?? 'true').toLowerCase() !== 'false';
            if (onlyMode && asyncOnlyMode) {
                const result = await this._processOnlyMessagesForUpstream(
                    messages,
                    agentName,
                    frontendSource,
                    defaultUserName,
                    outputDedupeThreshold,
                    clientTimestampBindingInfo
                );
                this._scheduleRecordOnlyPersistence(
                    messages,
                    agentName,
                    frontendSource,
                    defaultUserName,
                    threshold,
                    snapshotMaxBlocks,
                    outputDedupeThreshold,
                    clientTimestampBindingInfo
                );
                const restoredResult = timelineStrategy.restoreWorkingViewToOriginalMessages
                    ? timelineStrategy.restoreWorkingViewToOriginalMessages(originalMessages, result, workingView)
                    : this._restoreWorkingViewToOriginalMessages(originalMessages, result, workingView);
                return this._applyTailTagPlacement(restoredResult);
            }

            const result = await this._processRecordOnlyMessages(
                messages,
                agentName,
                frontendSource,
                defaultUserName,
                threshold,
                snapshotMaxBlocks,
                outputDedupeThreshold,
                clientTimestampBindingInfo
            );
            const restoredResult = timelineStrategy.restoreWorkingViewToOriginalMessages
                ? timelineStrategy.restoreWorkingViewToOriginalMessages(originalMessages, result, workingView)
                : this._restoreWorkingViewToOriginalMessages(originalMessages, result, workingView);
            return this._applyTailTagPlacement(restoredResult);
        }

        // ── 3. 从 DB 查询同信道历史，做 diff（优先快照精确编辑，兜底 fuzzy）────
        let patchMessages = messages;
        let isFreshShortContext = false;
        const localPostBlocks = this._extractLocalPostBlocks(messages, agentName, frontendSource, defaultUserName);
        const clientTimestampBindings = hasClientTimestampTruth
            ? timelineStrategy.bindRawMessages(
                agentName,
                frontendSource,
                messages,
                defaultUserName,
                'client-verified-raw-hash'
            )
            : timelineStrategy.bindPostBlocks(
                agentName,
                frontendSource,
                localPostBlocks,
                'client-verified-hash'
            );
        const summaryStats = {
            injected: 0,
            dbInserted: 0,
            dbUpdated: 0,
            snapshotEdited: 0,
            fuzzyEdited: 0,
            outputDeduped: 0,
            snapshotSaved: 0
        };

        let snapshotEditTimestampBindings = { boundTimestampsByIndex: {} };
        let snapshotApplyResult = null;
        try {
            const snapshotResult = snapshot.applySnapshotEdits(
                agentName,
                frontendSource,
                localPostBlocks,
                projectBasePath,
                { debug: debugMode, deferUpdate: true }
            );
            snapshotApplyResult = snapshotResult;
            summaryStats.snapshotEdited += snapshotResult.editedCount || 0;
            summaryStats.dbUpdated += snapshotResult.editedCount || 0;
            const pendingSnapshotEdits = snapshotResult.pendingEdits || [];
            snapshotEditTimestampBindings = this._bindSnapshotEditsByOldHash(
                agentName,
                frontendSource,
                pendingSnapshotEdits,
                'snapshot-edit'
            );
            this._scheduleMessageContentUpdates(
                agentName,
                pendingSnapshotEdits
                    .map(edit => {
                        const bound = snapshotEditTimestampBindings.boundTimestampsByIndex?.[edit.index];
                        return bound?.dbId ? { dbId: bound.dbId, content: edit.text } : null;
                    })
                    .filter(Boolean),
                'snapshot-edit'
            );
            if (debugMode && snapshotResult.reliable) {
                console.log(`[OneRing] Snapshot edit diff: edited=${snapshotResult.editedCount} exact=${snapshotResult.exactMatches} comparable=${snapshotResult.comparable} offset=${snapshotResult.offset}`);
            }

            const dbBlocks = db.getRecentMessagesByFrontend(agentName, frontendSource, maxBlocks * 2, projectBasePath);

            // 全新短上下文：DB 尚无同前端记录，且 post 内历史块很少。
            // 策略：新 user 先入库；若同 Agent 已有全局历史，再做保守补充。
            // 注意：长上下文无匹配时不补充；只有短新 user 场景可以尝试接入同 Agent 既有时间线。
            if (dbBlocks.length === 0 && historyBlocks.length <= 4) {
                isFreshShortContext = true;
                const newConversationStartUserIndex = this._detectNewConversationStartUserIndexForTimeline(messages, defaultUserName, agentName, hasClientTimestampTruth);
                const freshStats = await this._recordFreshShortContext(agentName, frontendSource, defaultUserName, historyBlocks, threshold, newConversationStartUserIndex);
                summaryStats.dbInserted += freshStats.inserted || 0;
                summaryStats.dbUpdated += freshStats.updated || 0;
            } else if (dbBlocks.length > 0) {
                // normal 模式不再使用 fuzzy diff 推断编辑。
                // 编辑由 snapshot.applySnapshotEdits() 的结构对齐 + 旧 hash 回查 messages 处理；
                // 新 user 由后续 _recordUserMessage() 按 post time 写库。
                if (debugMode) {
                    console.log('[OneRing] Normal mode DB diff skipped: hash/snapshot/turn pipeline is authoritative.');
                }
            }
        } catch (e) {
            console.error('[OneRing] DB diff error, skipping patch:', e.message);
        }

        // ── 4. 为当前 post 的 user/assistant 历史块补齐尾部标记 ───────────────
        // 关键原因：AI 回复入库是异步 DB 写入，不会回写给前端历史；
        // 下一轮前端带回来的 assistant 历史可能没有 OneRing 标记，因此这里必须补标。
        const nextTimestamp = createOneRingTimestampSequencer();
        const now = nextTimestamp();
        const newConversationStartUserIndex = this._detectNewConversationStartUserIndexForTimeline(messages, defaultUserName, agentName, hasClientTimestampTruth);

        // 入库必须以“实际 post 传入的上下文”为真相；
        // DB 补齐必须在 post 本体写库/补标之后进行，否则前端不回传 OneRing 时间戳时，
        // prepend / middle insert 没有可信 post 时间锚点，时间线合并会失效。
        const tailPostBatch = this._findTailPostBatch(messages, defaultUserName, agentName);

        const currentPostTimestampBindings = { boundTimestampsByIndex: {} };

        if (tailPostBatch?.user && !isFreshShortContext) {
            const userRecordResult = await this._recordUserMessage(
                agentName,
                frontendSource,
                tailPostBatch.user.classified.senderName,
                tailPostBatch.user.classified.cleanText,
                clientTimestampBindings.boundTimestampsByIndex?.[tailPostBatch.user.index]?.timestamp || now,
                threshold,
                tailPostBatch.user.index === newConversationStartUserIndex
            );
            if (userRecordResult === 'insert') {
                summaryStats.dbInserted++;
                // 这是本轮 post 抵达后新生成的权威时间戳，前端不会自带；
                // 必须立即作为尾标绑定，否则后续 DB 补全没有当前 post 的可信时间锚点。
                currentPostTimestampBindings.boundTimestampsByIndex[tailPostBatch.user.index] = {
                    timestamp: clientTimestampBindings.boundTimestampsByIndex?.[tailPostBatch.user.index]?.timestamp || now,
                    senderName: tailPostBatch.user.classified.senderName,
                    frontendSource,
                    source: 'current-post-user'
                };
            }
            if (userRecordResult === 'update') summaryStats.dbUpdated++;
        }

        if (tailPostBatch && !isFreshShortContext) {
            const tailAssistantStats = await this._recordTailPostAssistantBatch(
                agentName,
                frontendSource,
                tailPostBatch.assistants,
                nextTimestamp,
                threshold
            );
            summaryStats.dbInserted += tailAssistantStats.inserted || 0;
            summaryStats.dbUpdated += tailAssistantStats.updated || 0;
            Object.assign(
                currentPostTimestampBindings.boundTimestampsByIndex,
                tailAssistantStats.boundTimestampsByIndex || {}
            );
        }

        const exactTimestampBindings = this._bindExactTimestampsForPostBlocks(agentName, frontendSource, localPostBlocks, threshold);
        const timestampBindings = {
            ...(currentPostTimestampBindings.boundTimestampsByIndex || {}),
            ...(exactTimestampBindings.boundTimestampsByIndex || {}),
            ...(snapshotEditTimestampBindings.boundTimestampsByIndex || {}),
            ...(clientTimestampBindings.boundTimestampsByIndex || {})
        };
        timelineStrategy.scheduleTimestampCorrections?.(agentName, frontendSource, clientTimestampBindings.verifiedBindings, 'normal-client-hash');
        patchMessages = this._markTimelineBindings(
            patchMessages,
            messages,
            timestampBindings,
            defaultUserName,
            agentName,
            frontendSource,
            newConversationStartUserIndex
        );

        // ── 5. 跨端历史补全：先基于统一时间线元数据判定注入点，最后再统一写 OneRing 尾标 ──
        if (allowPatch) {
            try {
                patchMessages = this._doHashOnlyTimestampPatch(patchMessages, agentName, frontendSource, maxBlocks);
                summaryStats.injected += patchMessages.__oneRingInjectedCount || 0;
            } catch (e) {
                console.error('[OneRing] Patch error, using timestamped post messages:', e.message);
            }
        }

        patchMessages = this._upsertTimelineTailTags(
            patchMessages,
            defaultUserName,
            agentName,
            frontendSource,
            newConversationStartUserIndex
        );

        const beforeDedupeCount = patchMessages.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        patchMessages = await dedupeAdjacentSimilarConversation(patchMessages, outputDedupeThreshold);
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

        const retryTargetTurn = this._findRetryTargetTurn(agentName, frontendSource, localPostBlocks, snapshotApplyResult);
        const turnMeta = this._createPendingTurn(agentName, frontendSource, localPostBlocks, retryTargetTurn);
        this._attachMeta(patchMessages, agentName, frontendSource, turnMeta);

        patchMessages = timelineStrategy.restoreWorkingViewToOriginalMessages
            ? timelineStrategy.restoreWorkingViewToOriginalMessages(originalMessages, patchMessages, workingView)
            : this._restoreWorkingViewToOriginalMessages(originalMessages, patchMessages, workingView);
        return this._applyTailTagPlacement(patchMessages);
    }

    _createRawClientTimelineStrategy(bindingInfo) {
        return new RawClientTimelineStrategy({
            bindingInfo,
            projectBasePath,
            debug: debugMode,
            discardPatterns: DISCARD_PATTERNS,
            classifyUserContent,
            classifyAssistantContent
        });
    }

    _createServerInferredTimelineStrategy(bindingInfo) {
        return new ServerInferredTimelineStrategy({
            bindingInfo,
            debug: debugMode,
            discardPatterns: DISCARD_PATTERNS,
            sanitizeUserContentAtPipelineEntry,
            hasUserTextContent,
            markOneRingOriginalIndex,
            getOneRingOriginalIndex,
            markOneRingWorkingKey,
            getOneRingWorkingKey,
            isOneRingInjectedFromDb,
            getOneRingTimelineMeta,
            getOneRingTailMeta,
            cloneMessageWithOneRingMetadata,
            upsertTailTag,
            attachMeta: this._attachMeta.bind(this)
        });
    }

    _createTimelineStrategy(bindingInfo) {
        return (bindingInfo?.bindings || []).length > 0
            ? this._createRawClientTimelineStrategy(bindingInfo)
            : this._createServerInferredTimelineStrategy(bindingInfo);
    }

    /**
     * 核心补全逻辑：仅使用归一化 hash 检查 DB 历史中每条消息是否在上下文已存在，
     * 将 hash 缺失的块按时间戳合并补入上下文。
     * 不再使用 Levenshtein fuzzy，避免普通补齐路径阻塞主线程或误判轻微编辑。
     */
    _doHashOnlyTimestampPatch(messages, agentName, frontendSource, maxBlocks) {
        const histMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant');
        const remaining = Math.max(0, maxBlocks - histMsgs.length);
        if (remaining <= 0) return isOneRingTimeInsertEnabled()
            ? mergeConversationByOneRingTimestamp(messages)
            : messages;

        let dbHistory = [];
        try {
            dbHistory = db.getRecentMessages(agentName, maxBlocks * 3, projectBasePath);
        } catch (e) {
            console.error('[OneRing] Hash-only patch DB query failed:', e.message);
            return messages;
        }

        if (dbHistory.length === 0) return messages;

        // 为每条 DB 历史做归一化 hash 反查是否在当前上下文中已存在。
        // 普通补齐路径禁止 Levenshtein fuzzy，只按 hash 判断缺失。
        const postKeysByRole = histMsgs.reduce((acc, m) => {
            const postKey = fuzzy.normalize(fuzzy.extractText(m.content));
            if (postKey) {
                if (!acc[m.role]) acc[m.role] = [];
                if (!acc.hashes[m.role]) acc.hashes[m.role] = new Set();
                acc[m.role].push(postKey);
                acc.hashes[m.role].add(fuzzy.normalizedHashFromKey(postKey));
            }
            return acc;
        }, { user: [], assistant: [], hashes: { user: new Set(), assistant: new Set() } });
        const dbCandidates = dbHistory
            .map(item => {
                const key = fuzzy.normalize(item.content);
                return {
                    item,
                    key,
                    hash: key ? fuzzy.normalizedHashFromKey(key) : ''
                };
            })
            .filter(candidate => candidate.key);

        let hashMatchedCount = 0;
        const missing = [];
        for (const candidate of dbCandidates) {
            const roleHashes = postKeysByRole.hashes[candidate.item.role] || new Set();
            if (roleHashes.has(candidate.hash)) {
                hashMatchedCount++;
                continue;
            }
            missing.push(candidate.item);
        }

        if (debugMode && hashMatchedCount > 0) {
            console.log(`[OneRing] Hash-only patch prefilter: exact=${hashMatchedCount}, missing=${missing.length}`);
        }

        if (missing.length === 0) return isOneRingTimeInsertEnabled()
            ? mergeConversationByOneRingTimestamp(messages)
            : messages;

        const padded = missing.slice(-remaining).map((item) => markOneRingWorkingKey(markOneRingTimelineMeta(markOneRingInjectedFromDb({
            role: item.role,
            content: stripOneRingTailTagText(item.content)
        }), {
            timestamp: item.timestamp,
            senderName: item.senderName || item.agentName || '?',
            frontendSource: item.frontendSource || '?',
            source: 'db-injected'
        }), 'z'));

        if (debugMode) console.log(`[OneRing] Hash-only patch: ${padded.length} missing blocks补入上下文`);

        const patched = isOneRingTimeInsertEnabled()
            ? mergeConversationByOneRingTimestamp([...messages, ...padded])
            : [...messages, ...padded];
        try {
            Object.defineProperty(patched, '__oneRingInjectedCount', {
                value: patched.filter(message => isOneRingInjectedFromDb(message)).length,
                enumerable: false,
                configurable: true
            });
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Failed to attach patch injected count:', e.message);
        }
        return patched;
    }

    _markTimelineBindings(messages, originalMessages, timestampBindings, defaultUserName, agentName, frontendSource, newConversationStartUserIndex = -1) {
        if (!Array.isArray(messages)) return messages;
        return messages.map((m) => {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return m;

            const originalIndex = Array.isArray(originalMessages) ? originalMessages.indexOf(m) : -1;
            const bound = originalIndex >= 0 ? (timestampBindings[originalIndex] || null) : null;
            const existingMeta = getOneRingTailMeta(m.content);
            if (!bound && !existingMeta) return m;

            const classified = m.role === 'assistant'
                ? classifyAssistantContent(m.content, agentName)
                : classifyUserContent(m.content, defaultUserName, agentName);
            if (!classified) return m;

            const shouldMarkNewConversationStart = originalIndex === newConversationStartUserIndex;
            return markOneRingTimelineMeta(m, {
                timestamp: bound?.timestamp || existingMeta?.timestamp,
                senderName: bound?.senderName || existingMeta?.senderName || classified.senderName,
                frontendSource: bound?.frontendSource || existingMeta?.frontendSource || frontendSource,
                isNewConversationStart: shouldMarkNewConversationStart || existingMeta?.isNewConversationStart,
                source: bound?.source || 'existing-tail'
            });
        });
    }

    _upsertTimelineTailTags(messages, defaultUserName, agentName, frontendSource, newConversationStartUserIndex = -1) {
        if (!Array.isArray(messages)) return messages;
        return messages.map((m, index) => {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return m;

            const timelineMeta = getOneRingTimelineMeta(m);
            const existingMeta = getOneRingTailMeta(m.content);
            const meta = timelineMeta || existingMeta;
            if (!meta) {
                return existingMeta
                    ? { ...m, content: this._stripTailTagFromContent(m.content) }
                    : m;
            }

            const classified = m.role === 'assistant'
                ? classifyAssistantContent(m.content, agentName)
                : classifyUserContent(m.content, defaultUserName, agentName);
            if (!classified) return m;

            const isNewConversationStart = !!meta.isNewConversationStart || index === newConversationStartUserIndex;
            return cloneMessageWithOneRingMetadata(m, {
                content: upsertTailTag(
                    m.content,
                    meta.senderName || classified.senderName,
                    meta.timestamp,
                    meta.frontendSource || frontendSource,
                    isNewConversationStart
                )
            });
        });
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

            result.push(cloneMessageWithOneRingMetadata(message, {
                content: this._stripTailTagFromContent(message.content)
            }));
            result.push({
                role: 'user',
                content: `[系统提示:][OneRing通知:上一条消息由${meta.senderName}于${meta.timestamp}发送于${meta.frontendSource}]`
            });
        }

        if (messages.__oneRingMeta) {
            this._attachMeta(
                result,
                messages.__oneRingMeta.agentName,
                messages.__oneRingMeta.frontendSource,
                { ...messages.__oneRingMeta }
            );
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

    _findTailPostBatch(messages, defaultUserName, agentName) {
        if (!Array.isArray(messages)) return null;
        const tailAssistants = [];
        let foundUser = null;
        let abandonedAssistantCount = 0;
        let skippedSystemUserCount = 0;

        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;

            if (message.role === 'assistant') {
                if (hasLeadingGroupChatSender(message.content)) {
                    const classifiedAssistant = classifyAssistantContent(message.content, agentName);
                    if (classifiedAssistant) {
                        tailAssistants.unshift({
                            message,
                            index: i,
                            classified: classifiedAssistant
                        });
                    } else {
                        abandonedAssistantCount++;
                    }
                } else {
                    abandonedAssistantCount++;
                }
                continue;
            }

            const classifiedUser = classifyUserContent(message.content, defaultUserName, agentName);
            if (!classifiedUser) {
                skippedSystemUserCount++;
                continue;
            }

            foundUser = {
                message,
                index: i,
                classified: classifiedUser
            };
            break;
        }

        if (!foundUser) {
            if (debugMode && (tailAssistants.length > 0 || abandonedAssistantCount > 0 || skippedSystemUserCount > 0)) {
                console.log(`[OneRing] Tail post batch not found: assistants=${tailAssistants.length}, abandonedAssistants=${abandonedAssistantCount}, skippedSystemUsers=${skippedSystemUserCount}`);
            }
            return null;
        }

        if (debugMode && (tailAssistants.length > 0 || abandonedAssistantCount > 0 || skippedSystemUserCount > 0)) {
            console.log(`[OneRing] Tail post batch: userIndex=${foundUser.index}, assistants=${tailAssistants.length}, abandonedAssistants=${abandonedAssistantCount}, skippedSystemUsers=${skippedSystemUserCount}`);
        }

        return {
            user: foundUser,
            assistants: tailAssistants
        };
    }

    async _recordTailPostAssistantBatch(agentName, frontendSource, assistants, nextTimestamp, threshold = 0.92) {
        const stats = { inserted: 0, updated: 0, boundTimestampsByIndex: {} };
        const blocks = Array.isArray(assistants) ? assistants : [];
        for (const assistant of blocks) {
            if (!assistant?.classified) continue;
            const ts = typeof nextTimestamp === 'function' ? nextTimestamp() : nextTimestamp;
            const assistantResult = await this._recordAssistantMessage(
                agentName,
                frontendSource,
                assistant.classified.cleanText,
                ts,
                threshold,
                assistant.classified.senderName
            );
            if (assistantResult === 'insert') stats.inserted++;
            if (assistantResult === 'update') stats.updated++;
            if (assistantResult === 'insert' || assistantResult === 'update') {
                stats.boundTimestampsByIndex[assistant.index] = {
                    timestamp: ts,
                    senderName: assistant.classified.senderName,
                    frontendSource,
                    source: 'tail-post-group-assistant'
                };
            }
        }
        return stats;
    }

    // Legacy fallback：主流程现在优先走 ServerInferredTimelineStrategy；
    // 保留这些实例方法是为了兼容旧调用和策略对象不可用时的兜底路径。
    _buildOneRingWorkingView(messages) {
        if (!Array.isArray(messages)) return null;

        let removedSystemUser = 0;
        let removedEmptyUser = 0;
        let strippedUserContent = 0;
        const workingMessages = [];
        const workingToOriginalIndex = [];
        const originalToWorkingIndex = new Map();
        const originalRecords = new Map();
        const removedItems = [];

        messages.forEach((message, originalIndex) => {
            const originalKey = String(originalIndex);
            if (!message || message.role !== 'user') {
                const workingMessage = message && typeof message === 'object'
                    ? { ...message }
                    : message;
                markOneRingOriginalIndex(workingMessage, originalIndex);
                markOneRingWorkingKey(workingMessage, originalKey);
                originalToWorkingIndex.set(originalIndex, workingMessages.length);
                workingToOriginalIndex.push(originalIndex);
                originalRecords.set(originalKey, {
                    originalIndex,
                    workingIndex: workingMessages.length,
                    role: message?.role || null,
                    sanitized: false,
                    removed: false,
                    reason: null
                });
                workingMessages.push(workingMessage);
                return;
            }

            const originalText = fuzzy.extractText(message.content);
            const sanitizedContent = sanitizeUserContentAtPipelineEntry(message.content);
            const sanitizedText = fuzzy.extractText(sanitizedContent);
            const shouldDropSystemPromptUser = DISCARD_PATTERNS.some(pattern => pattern.test(sanitizedText));

            if (shouldDropSystemPromptUser) {
                removedSystemUser++;
                removedItems.push({ originalIndex, originalKey, message, reason: 'system-user' });
                originalRecords.set(originalKey, {
                    originalIndex,
                    workingIndex: null,
                    role: 'user',
                    sanitized: originalText !== sanitizedText,
                    removed: true,
                    reason: 'system-user'
                });
                return;
            }

            if (!hasUserTextContent(sanitizedContent)) {
                removedEmptyUser++;
                removedItems.push({ originalIndex, originalKey, message, reason: 'empty-user' });
                originalRecords.set(originalKey, {
                    originalIndex,
                    workingIndex: null,
                    role: 'user',
                    sanitized: originalText !== sanitizedText,
                    removed: true,
                    reason: 'empty-user'
                });
                return;
            }

            if (originalText !== sanitizedText) strippedUserContent++;
            const workingMessage = markOneRingWorkingKey(markOneRingOriginalIndex({ ...message, content: sanitizedContent }, originalIndex), originalKey);
            originalToWorkingIndex.set(originalIndex, workingMessages.length);
            workingToOriginalIndex.push(originalIndex);
            originalRecords.set(originalKey, {
                originalIndex,
                workingIndex: workingMessages.length,
                role: 'user',
                sanitized: originalText !== sanitizedText,
                removed: false,
                reason: originalText !== sanitizedText ? 'sanitized-user' : null
            });
            workingMessages.push(workingMessage);
        });

        if (debugMode && (removedSystemUser > 0 || removedEmptyUser > 0 || strippedUserContent > 0)) {
            console.log(`[OneRing] Built reversible working view: removedSystem=${removedSystemUser}, removedEmpty=${removedEmptyUser}, stripped=${strippedUserContent}, original=${messages.length}, working=${workingMessages.length}`);
        }

        if (messages.__oneRingMeta) {
            this._attachMeta(
                workingMessages,
                messages.__oneRingMeta.agentName,
                messages.__oneRingMeta.frontendSource,
                { ...messages.__oneRingMeta }
            );
        }

        return {
            originalMessages: messages,
            workingMessages,
            workingToOriginalIndex,
            originalToWorkingIndex,
            originalRecords,
            removedItems
        };
    }

    _sanitizeMessagesBeforeOneRing(messages) {
        const view = this._buildOneRingWorkingView(messages);
        return view ? view.workingMessages : messages;
    }

    _restoreWorkingViewToOriginalMessages(originalMessages, processedMessages, workingView) {
        if (!workingView || !Array.isArray(originalMessages) || !Array.isArray(processedMessages)) {
            return processedMessages;
        }

        const restored = [...originalMessages];
        const injectedBeforeOriginalIndex = new Map();
        const injectedAfterOriginalIndex = new Map();
        const injectedAtEnd = [];
        let pendingInjected = [];

        const pushInjectedAfter = (originalIndex, injectedMessages) => {
            if (!Array.isArray(injectedMessages) || injectedMessages.length === 0 || !Number.isInteger(originalIndex)) return false;
            if (originalIndex < 0 || originalIndex >= originalMessages.length) return false;
            if (!injectedAfterOriginalIndex.has(originalIndex)) {
                injectedAfterOriginalIndex.set(originalIndex, []);
            }
            injectedAfterOriginalIndex.get(originalIndex).push(...injectedMessages);
            return true;
        };

        const getOriginalIndexFromWorkingKey = (workingKey) => {
            if (!workingKey || !/^\d+$/.test(workingKey)) return -1;
            const record = workingView.originalRecords?.get?.(workingKey);
            if (Number.isInteger(record?.originalIndex)) return record.originalIndex;
            const parsed = parseInt(workingKey, 10);
            return Number.isInteger(parsed) ? parsed : -1;
        };

        const getInjectedAnchorOriginalIndex = (message) => {
            const workingKey = getOneRingWorkingKey(message);
            if (!workingKey || (!workingKey.startsWith('z') && !workingKey.startsWith('o'))) return -1;
            return getOriginalIndexFromWorkingKey(workingKey.slice(1));
        };

        const queueInjected = (message) => {
            const anchorOriginalIndex = getInjectedAnchorOriginalIndex(message);
            if (pushInjectedAfter(anchorOriginalIndex, [message])) {
                return;
            }
            pendingInjected.push(message);
        };

        const flushPendingBefore = (originalIndex) => {
            if (pendingInjected.length === 0 || !Number.isInteger(originalIndex)) return;
            if (!injectedBeforeOriginalIndex.has(originalIndex)) {
                injectedBeforeOriginalIndex.set(originalIndex, []);
            }
            injectedBeforeOriginalIndex.get(originalIndex).push(...pendingInjected);
            pendingInjected = [];
        };

        for (const message of processedMessages) {
            if (!message) continue;

            const workingKey = getOneRingWorkingKey(message);

            if (isOneRingInjectedFromDb(message) || (workingKey && (workingKey.startsWith('z') || workingKey.startsWith('o')))) {
                queueInjected(message);
                continue;
            }

            let originalIndex = getOneRingOriginalIndex(message);
            if ((!Number.isInteger(originalIndex) || originalIndex < 0) && workingKey) {
                originalIndex = getOriginalIndexFromWorkingKey(workingKey);
            }

            if (!Number.isInteger(originalIndex) || originalIndex < 0 || originalIndex >= originalMessages.length) {
                continue;
            }

            flushPendingBefore(originalIndex);
            restored[originalIndex] = this._mergeProcessedMessageOntoOriginal(originalMessages[originalIndex], message);
        }

        if (pendingInjected.length > 0) {
            injectedAtEnd.push(...pendingInjected);
        }

        const result = [];
        for (let i = 0; i < restored.length; i++) {
            const before = injectedBeforeOriginalIndex.get(i) || [];
            const after = injectedAfterOriginalIndex.get(i) || [];
            result.push(...before);
            result.push(restored[i]);
            result.push(...after);
        }
        result.push(...injectedAtEnd);

        if (processedMessages.__oneRingMeta) {
            this._attachMeta(
                result,
                processedMessages.__oneRingMeta.agentName,
                processedMessages.__oneRingMeta.frontendSource,
                { ...processedMessages.__oneRingMeta }
            );
        }

        try {
            Object.defineProperty(result, '__oneRingInjectedCount', {
                value: result.filter(message => isOneRingInjectedFromDb(message)).length,
                enumerable: false,
                configurable: true
            });
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Failed to attach restored injected count:', e.message);
        }

        return result;
    }

    _mergeProcessedMessageOntoOriginal(originalMessage, processedMessage) {
        if (!originalMessage || !processedMessage || originalMessage.role !== 'user') {
            return processedMessage;
        }

        const meta = getOneRingTimelineMeta(processedMessage) || getOneRingTailMeta(processedMessage.content);
        if (!meta) return originalMessage;

        return cloneMessageWithOneRingMetadata(originalMessage, {
            content: upsertTailTag(
                originalMessage.content,
                meta.senderName,
                meta.timestamp,
                meta.frontendSource,
                !!meta.isNewConversationStart
            )
        });
    }

    _detectNewConversationStartUserIndex(messages, defaultUserName, agentName) {
        if (!Array.isArray(messages)) return -1;

        // 统一语义：一个 post 是客户端发来的“当前完整上下文视图”。
        // 不论 raw-client 还是 server-inferred，忽略 system、伪 system user、空 user / 通知栏 user 后，
        // 第一个真实聊天块就是新对话起点；该块可能是 user，也可能是 assistant。
        //
        // 注意：这里返回的是当前传入 messages 视图中的 index。
        // raw-client 路径传入原始 messages，因此是 raw index；
        // server-inferred 路径传入 workingMessages，因此是 working index。
        // 后续绑定/恢复继续沿用各自现有 index 坐标系，避免破坏 original/working 映射。
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;

            if (message.role === 'assistant') {
                const classifiedAssistant = classifyAssistantContent(message.content, agentName);
                if (classifiedAssistant) return i;
                continue;
            }

            const classified = classifyUserContent(message.content, defaultUserName, agentName);
            if (classified) return i;
        }

        return -1;
    }

    _detectFirstUserIndexForClientHashTimeline(messages, defaultUserName, agentName) {
        // 兼容旧方法名；新逻辑不再按 raw-client 特判“第一个 user”，
        // 而是统一返回第一个真实聊天块的当前视图 index。
        return this._detectNewConversationStartUserIndex(messages, defaultUserName, agentName);
    }

    _detectNewConversationStartUserIndexForTimeline(messages, defaultUserName, agentName, hasClientTimestampTruth = false) {
        void hasClientTimestampTruth;
        return this._detectNewConversationStartUserIndex(messages, defaultUserName, agentName);
    }

    _createPostRequestHash(postBlocks) {
        const normalizedBlocks = (Array.isArray(postBlocks) ? postBlocks : []).map(block => ({
            role: block.role,
            senderName: block.senderName || null,
            frontendSource: block.frontendSource || null,
            hash: snapshot.contentHash(block.text || '')
        }));
        return snapshot.contentHash(JSON.stringify(normalizedBlocks));
    }

    _getPostBlockTotalCount(postBlocks) {
        const blocks = Array.isArray(postBlocks) ? postBlocks : [];
        const maxIndex = blocks.reduce((max, block) => {
            const index = Number(block?.index);
            return Number.isInteger(index) && index >= 0 ? Math.max(max, index) : max;
        }, -1);
        return maxIndex >= 0 ? maxIndex + 1 : blocks.length;
    }

    _createTurnId(agentName, frontendSource, requestHash) {
        const safeAgent = String(agentName || 'agent').replace(/[^\w.-]+/g, '_');
        const safeFrontend = String(frontendSource || 'frontend').replace(/[^\w.-]+/g, '_');
        return `${safeAgent}:${safeFrontend}:${Date.now()}:${requestHash.slice(0, 16)}:${Math.random().toString(36).slice(2, 8)}`;
    }

    _findRetryTargetTurn(agentName, frontendSource, postBlocks, snapshotResult = null) {
        try {
            const recentTurns = db.getRecentCompletedPostTurn(agentName, frontendSource, 5, projectBasePath);
            if (!recentTurns || recentTurns.length === 0) return null;

            // 可靠快照编辑说明当前 post 与上一轮 post 有确定性结构对应，可复用最近 completed turn 的 AI 回复。
            if (snapshotResult && snapshotResult.reliable && (snapshotResult.editedCount || 0) > 0) {
                return recentTurns[0] || null;
            }

            // 极短 retry 保守判定：
            // requestHash 只能证明当前可见短窗口一致，不能证明它来自同一个长上下文。
            // 因此必须同时校验：
            // 1) 当前参与 hash 的短窗口 block 数一致；
            // 2) 当前 post 的真实聊天楼层总数一致（例如 28 楼不能误复用 58 楼的 turn）；
            // 3) requestHash 完全一致。
            // 旧库没有 requestTotalBlockCount 的 completed turn 一律不参与自动 retry 复用。
            const blockCount = Array.isArray(postBlocks) ? postBlocks.length : 0;
            const totalBlockCount = this._getPostBlockTotalCount(postBlocks);
            const latest = recentTurns[0] || null;
            const latestTotalBlockCount = Number(latest?.requestTotalBlockCount);
            const requestHash = this._createPostRequestHash(postBlocks);
            if (
                latest &&
                blockCount > 0 &&
                blockCount <= 2 &&
                Number(latest.requestBlockCount) === blockCount &&
                Number.isInteger(latestTotalBlockCount) &&
                latestTotalBlockCount === totalBlockCount &&
                latest.requestHash === requestHash
            ) {
                return latest;
            }
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Retry target turn lookup failed:', e.message);
        }
        return null;
    }

    _createPendingTurn(agentName, frontendSource, postBlocks, retryTargetTurn = null) {
        const requestHash = this._createPostRequestHash(postBlocks);
        const nowIso = new Date().toISOString();
        const turnId = this._createTurnId(agentName, frontendSource, requestHash);
        db.insertPostTurn(agentName, {
            turnId,
            frontendSource,
            requestHash,
            requestBlockCount: Array.isArray(postBlocks) ? postBlocks.length : 0,
            requestTotalBlockCount: this._getPostBlockTotalCount(postBlocks),
            status: 'pending',
            createdAt: nowIso,
            updatedAt: nowIso
        }, projectBasePath);

        return {
            turnId,
            requestHash,
            responseMessageIdToUpdate: retryTargetTurn?.responseMessageId || null,
            retryOfTurnId: retryTargetTurn?.turnId || null
        };
    }

    _attachMeta(messages, agentName, frontendSource, extraMeta = {}) {
        try {
            Object.defineProperty(messages, '__oneRingMeta', {
                value: { agentName, frontendSource, ...extraMeta },
                enumerable: false,
                configurable: true
            });
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Failed to attach non-enumerable meta:', e.message);
        }
        return messages;
    }

    _bindSnapshotEditsByOldHash(agentName, frontendSource, edits, source = 'snapshot-old-hash') {
        const stats = { boundTimestampsByIndex: {} };
        const items = (Array.isArray(edits) ? edits : [])
            .filter(item => item && item.oldHash && item.role && Number.isInteger(Number(item.index)));

        if (items.length === 0) return stats;

        try {
            const conn = db.getDb(agentName, projectBasePath);
            const candidateIds = [...new Set(items
                .flatMap(item => [item.dbId, item.oldDbId])
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0)
            )];
            const directRowsById = new Map();
            if (candidateIds.length > 0) {
                const placeholders = candidateIds.map(() => '?').join(',');
                const directRows = conn.prepare(
                    `SELECT id, role, senderName, frontendSource, content, timestamp
                     FROM messages
                     WHERE agentName=? AND id IN (${placeholders})`
                ).all(agentName, ...candidateIds);
                for (const row of directRows) {
                    directRowsById.set(Number(row.id), row);
                }
            }

            const rows = conn.prepare(
                `SELECT id, role, senderName, frontendSource, content, timestamp
                 FROM messages
                 WHERE agentName=? AND frontendSource=?
                 ORDER BY timestamp DESC, id DESC
                 LIMIT ?`
            ).all(agentName, frontendSource, Math.max(items.length * 8, 80));

            const usedIds = new Set();
            let directBound = 0;
            let directHashMismatch = 0;
            let fallbackBound = 0;

            const bindMatchedRow = (item, matched, bindSource) => {
                usedIds.add(Number(matched.id));
                stats.boundTimestampsByIndex[item.index] = {
                    dbId: matched.id,
                    oldDbId: item.oldDbId || null,
                    timestamp: matched.timestamp,
                    senderName: matched.senderName,
                    frontendSource: matched.frontendSource || frontendSource,
                    source: bindSource
                };
            };

            for (const item of items) {
                // Snapshot edit 已经由 post 差分确认旧块位置，且快照行保存了 dbId。
                // UPDATE content 时必须优先信任该 dbId；oldHash 搜索只作为快照 dbId 缺失/失效时的兜底。
                // 这里绝不修改 timestamp；只有 raw-client 权威时间戳校正路径允许覆盖 timestamp。
                const preferredIds = [item.dbId, item.oldDbId]
                    .map(id => Number(id))
                    .filter(id => Number.isInteger(id) && id > 0);

                let directMatched = null;
                for (const preferredId of preferredIds) {
                    if (usedIds.has(preferredId)) continue;
                    const row = directRowsById.get(preferredId);
                    if (!row || row.role !== item.role) continue;
                    directMatched = row;
                    break;
                }

                if (directMatched) {
                    if (snapshot.contentHash(directMatched.content) !== item.oldHash) {
                        directHashMismatch++;
                        if (debugMode) {
                            console.warn(`[OneRing] Snapshot edit dbId direct bind hash mismatch source=${source} dbId=${directMatched.id} role=${item.role}; preserving dbId binding because snapshot post-diff is authoritative.`);
                        }
                    }
                    directBound++;
                    bindMatchedRow(item, directMatched, `${source}-dbid`);
                    continue;
                }

                const matched = rows.find(row =>
                    row.role === item.role &&
                    !usedIds.has(Number(row.id)) &&
                    snapshot.contentHash(row.content) === item.oldHash
                );
                if (!matched) continue;

                fallbackBound++;
                bindMatchedRow(item, matched, source);
            }

            if (debugMode && (directBound > 0 || fallbackBound > 0 || directHashMismatch > 0)) {
                console.log(`[OneRing] Snapshot edit binding source=${source}: directDbId=${directBound}, fallbackOldHash=${fallbackBound}, directHashMismatch=${directHashMismatch}, total=${items.length}`);
            }
        } catch (e) {
            if (debugMode) console.warn(`[OneRing] Snapshot old-hash timestamp binding failed source=${source}:`, e.message);
        }

        return stats;
    }

    _bindTimestampsByKnownDbIds(agentName, frontendSource, edits, source = 'known-dbid') {
        const stats = { boundTimestampsByIndex: {} };
        const items = (Array.isArray(edits) ? edits : [])
            .filter(item => item && item.dbId && Number.isInteger(Number(item.index)));

        if (items.length === 0) return stats;

        const uniqueIds = [...new Set(items.map(item => Number(item.dbId)))];
        try {
            const conn = db.getDb(agentName, projectBasePath);
            const placeholders = uniqueIds.map(() => '?').join(',');
            const rows = conn.prepare(
                `SELECT id, role, senderName, frontendSource, timestamp
                 FROM messages
                 WHERE agentName=? AND id IN (${placeholders})`
            ).all(agentName, ...uniqueIds);
            const rowById = new Map(rows.map(row => [Number(row.id), row]));

            for (const item of items) {
                const row = rowById.get(Number(item.dbId));
                if (!row) continue;
                stats.boundTimestampsByIndex[item.index] = {
                    dbId: row.id,
                    timestamp: row.timestamp,
                    senderName: row.senderName,
                    frontendSource: row.frontendSource || frontendSource,
                    source
                };
            }
        } catch (e) {
            if (debugMode) console.warn(`[OneRing] Known-dbId timestamp binding failed source=${source}:`, e.message);
        }

        return stats;
    }

    async _processOnlyMessagesForUpstream(messages, agentName, frontendSource, defaultUserName, outputDedupeThreshold = 0.98, clientTimestampBindingInfo = null) {
        let result = Array.isArray(messages) ? [...messages] : messages;

        // Only + asyncOnlyMode 的上游快速返回阶段不能生成任何新时间戳。
        // 原因：此阶段尚未完成 snapshot/messages 绑定；若直接 nextTimestamp()，
        // 会把仅存在于前端 post 或 snapshot(dbId=null) 的历史块误标成当前 post 时间。
        //
        // OneRing 时间戳真相只能来自：
        // 1) messages 真库 hash 命中；
        // 2) messages 真库 fuzzy 命中；
        // 3) snapshot append 明确识别出的“最后新增真实 user”写库结果；
        // 4) assistant final callback 写库结果。
        //
        // 因此这里仅做输出去重和 meta 附着；真正的补标/纠标由后台
        // _processRecordOnlyMessages() 完成。若某块已有旧尾标，暂不在快速路径改写，
        // 后台严格绑定阶段会在无可信 bound 时剥离，或用真库时间修正。
        const postBlocks = this._extractLocalPostBlocks(result, agentName, frontendSource, defaultUserName);
        const timelineStrategy = this._createTimelineStrategy(clientTimestampBindingInfo);
        const clientTimestampBindings = timelineStrategy.hasClientTimestampTruth
            ? timelineStrategy.bindRawMessages(
                agentName,
                frontendSource,
                result,
                defaultUserName,
                'only-client-verified-raw-hash'
            )
            : timelineStrategy.bindPostBlocks(
                agentName,
                frontendSource,
                postBlocks,
                'only-client-verified-hash'
            );
        if (clientTimestampBindings.verifiedBindings.length > 0) {
            const newConversationStartUserIndex = this._detectNewConversationStartUserIndexForTimeline(
                result,
                defaultUserName,
                agentName,
                timelineStrategy.hasClientTimestampTruth
            );
            const timestamped = this._markTimelineBindings(
                result,
                result,
                clientTimestampBindings.boundTimestampsByIndex,
                defaultUserName,
                agentName,
                frontendSource,
                newConversationStartUserIndex
            );
            result = this._upsertTimelineTailTags(
                timestamped,
                defaultUserName,
                agentName,
                frontendSource,
                newConversationStartUserIndex
            );
            timelineStrategy.scheduleTimestampCorrections?.(agentName, frontendSource, clientTimestampBindings.verifiedBindings, 'only-client-hash');
        }
        result = await dedupeAdjacentSimilarConversation(result, outputDedupeThreshold);
        const retryTargetTurn = this._findRetryTargetTurn(agentName, frontendSource, postBlocks, null);
        const turnMeta = this._createPendingTurn(agentName, frontendSource, postBlocks, retryTargetTurn);
        return this._attachMeta(result, agentName, frontendSource, turnMeta);
    }

    _scheduleMessageContentUpdates(agentName, updates, reason = 'async-update') {
        const items = (Array.isArray(updates) ? updates : [updates])
            .filter(item => item && item.dbId && typeof item.content === 'string');

        if (items.length === 0) return;

        const run = () => {
            for (const item of items) {
                try {
                    db.updateMessageById(agentName, item.dbId, item.content, projectBasePath);
                    if (debugMode) console.log(`[OneRing] Async message update completed reason=${reason} dbId=${item.dbId}`);
                } catch (e) {
                    console.error(`[OneRing] Async message update failed reason=${reason} dbId=${item.dbId}:`, e.message);
                }
            }
        };

        if (typeof setImmediate === 'function') {
            setImmediate(run);
        } else {
            setTimeout(run, 0);
        }
    }

    _scheduleRecordOnlyPersistence(messages, agentName, frontendSource, defaultUserName, threshold, maxSnapshotBlocks = 20, outputDedupeThreshold = 0.98, clientTimestampBindingInfo = null) {
        const run = async () => {
            try {
                await this._processRecordOnlyMessages(
                    messages,
                    agentName,
                    frontendSource,
                    defaultUserName,
                    threshold,
                    maxSnapshotBlocks,
                    outputDedupeThreshold,
                    clientTimestampBindingInfo,
                    true
                );
            } catch (e) {
                console.error('[OneRing] Async Only persistence failed:', e.message);
            }
        };

        if (typeof setImmediate === 'function') {
            setImmediate(run);
        } else {
            setTimeout(run, 0);
        }
    }

    async _processRecordOnlyMessages(messages, agentName, frontendSource, defaultUserName, threshold, maxSnapshotBlocks = 20, outputDedupeThreshold = 0.98, clientTimestampBindingInfo = null, suppressClientBindingLog = false) {
        const timing = createOneRingTimingProbe('record-only', { agentName, frontendSource });
        const nextTimestamp = createOneRingTimestampSequencer();
        let result = Array.isArray(messages) ? [...messages] : messages;

        const effectiveClientTimestampBindingInfo = clientTimestampBindingInfo || timelineCommon.getClientTimestampBindingsFromConfig({}, formatOneRingTimestamp);
        const postBlocks = this._extractLocalPostBlocks(result, agentName, frontendSource, defaultUserName);
        const timelineStrategy = this._createTimelineStrategy(effectiveClientTimestampBindingInfo);
        const clientTimestampBindings = timelineStrategy.hasClientTimestampTruth
            ? timelineStrategy.bindRawMessages(
                agentName,
                frontendSource,
                result,
                defaultUserName,
                'record-only-client-verified-raw-hash',
                { suppressLog: suppressClientBindingLog }
            )
            : timelineStrategy.bindPostBlocks(
                agentName,
                frontendSource,
                postBlocks,
                'record-only-client-verified-hash',
                { suppressLog: suppressClientBindingLog }
            );
        timing.mark('extractPostBlocks', `blocks=${postBlocks.length}`);
        const summaryStats = {
            injected: 0,
            dbInserted: 0,
            dbUpdated: 0,
            snapshotEdited: 0,
            fuzzyEdited: 0,
            outputDeduped: 0,
            snapshotSaved: 0
        };

        let snapshotEditTimestampBindings = { boundTimestampsByIndex: {} };
        let snapshotApplyResult = null;
        try {
            const snapshotResult = snapshot.applySnapshotEdits(
                agentName,
                frontendSource,
                postBlocks,
                projectBasePath,
                { debug: debugMode, deferUpdate: true }
            );
            snapshotApplyResult = snapshotResult;
            summaryStats.snapshotEdited += snapshotResult.editedCount || 0;
            summaryStats.dbUpdated += snapshotResult.editedCount || 0;
            const pendingSnapshotEdits = snapshotResult.pendingEdits || [];
            snapshotEditTimestampBindings = this._bindSnapshotEditsByOldHash(
                agentName,
                frontendSource,
                pendingSnapshotEdits,
                'record-only-snapshot-edit'
            );
            this._scheduleMessageContentUpdates(
                agentName,
                pendingSnapshotEdits
                    .map(edit => {
                        const bound = snapshotEditTimestampBindings.boundTimestampsByIndex?.[edit.index];
                        return bound?.dbId ? { dbId: bound.dbId, content: edit.text } : null;
                    })
                    .filter(Boolean),
                'record-only-snapshot-edit'
            );
            if (debugMode && snapshotResult.reliable) {
                console.log(`[OneRing] Record-only snapshot edit diff: edited=${snapshotResult.editedCount} exact=${snapshotResult.exactMatches} comparable=${snapshotResult.comparable} offset=${snapshotResult.offset}`);
            }
        } catch (e) {
            console.error('[OneRing] Record-only snapshot edit failed:', e.message);
        }
        timing.mark('snapshotApply', `edited=${summaryStats.snapshotEdited}`);

        const newConversationStartUserIndex = this._detectNewConversationStartUserIndexForTimeline(result, defaultUserName, agentName, timelineStrategy.hasClientTimestampTruth);
        let syncStats = null;
        try {
            const appendResult = snapshot.detectSnapshotAppend(
                agentName,
                frontendSource,
                postBlocks,
                projectBasePath,
                { debug: debugMode }
            );
            timing.mark('snapshotAppendDetect', `reliable=${appendResult.reliable} mode=${appendResult.mode} overlap=${appendResult.overlapCount || 0} new=${appendResult.newBlocks?.length || 0} reason=${appendResult.reason}`);
            if (appendResult.reliable) {
                syncStats = await this._recordSnapshotAppendBlocks(
                    agentName,
                    frontendSource,
                    defaultUserName,
                    appendResult.newBlocks || [],
                    nextTimestamp,
                    threshold,
                    newConversationStartUserIndex,
                    {
                        overlapCount: appendResult.overlapCount || 0,
                        mode: appendResult.mode || null,
                        hasClientTimestampTruth: (effectiveClientTimestampBindingInfo?.bindings || []).length > 0,
                        clientTimestampBindings: clientTimestampBindings.boundTimestampsByIndex || {}
                    }
                );
                syncStats.snapshotFastPath = true;
            }
        } catch (e) {
            console.error('[OneRing] Record-only snapshot append detection failed:', e.message);
            timing.mark('snapshotAppendDetect', 'error');
        }

        if (!syncStats) {
            syncStats = await this._syncRecordOnlyPostWithDb(agentName, frontendSource, defaultUserName, result, nextTimestamp, threshold, postBlocks, newConversationStartUserIndex);
        }
        summaryStats.dbInserted += syncStats.inserted || 0;
        summaryStats.dbUpdated += syncStats.updated || 0;
        summaryStats.fuzzyEdited += syncStats.fuzzyEdited || 0;
        timing.mark('syncRecordOnlyPostWithDb', `engine=${syncStats.snapshotFastPath ? 'snapshot' : 'fuzzy'} inserted=${syncStats.inserted || 0} updated=${syncStats.updated || 0} fuzzyEdited=${syncStats.fuzzyEdited || 0}`);

        const exactTimestampBindings = this._bindExactTimestampsForPostBlocks(agentName, frontendSource, postBlocks, threshold);
        // 时间戳绑定原则：
        // 1. 只信任 messages 真库 exact/fuzzy 命中；
        // 2. snapshot append 只负责识别新增/编辑，不再把 post 阶段生成的时间戳写回输出尾标；
        // 3. 新 user 若刚刚插入成功，也必须在真库中再次 exact/fuzzy 绑定后才可标记。
        const timestampBindings = {
            ...(exactTimestampBindings.boundTimestampsByIndex || {}),
            ...(syncStats?.boundTimestampsByIndex || {}),
            ...(snapshotEditTimestampBindings.boundTimestampsByIndex || {}),
            ...(clientTimestampBindings.boundTimestampsByIndex || {})
        };
        timelineStrategy.scheduleTimestampCorrections?.(agentName, frontendSource, clientTimestampBindings.verifiedBindings, 'record-only-client-hash');
        const exactBoundValues = Object.values(exactTimestampBindings.boundTimestampsByIndex || {});
        const exactSourceCounts = exactBoundValues.reduce((acc, binding) => {
            const source = binding?.source || 'exact';
            acc[source] = (acc[source] || 0) + 1;
            return acc;
        }, {});
        timing.mark(
            'exactTimestampBind',
            `bound=${exactBoundValues.length} exact=${exactSourceCounts.exact || 0} fuzzy=${exactSourceCounts.fuzzy || 0}`
        );
        result = result.map((m) => {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return m;

            const existingMeta = getOneRingTailMeta(m.content);
            if (m.role === 'assistant') {
                const classifiedAssistant = classifyAssistantContent(m.content, agentName);
                if (!classifiedAssistant) return m;

                const originalIndex = result.indexOf(m);
                const shouldMarkNewConversationStart = originalIndex === newConversationStartUserIndex;
                const bound = timestampBindings[originalIndex] || null;
                if (
                    existingMeta &&
                    existingMeta.senderName === classifiedAssistant.senderName &&
                    (!shouldMarkNewConversationStart || existingMeta.isNewConversationStart) &&
                    (!bound || (
                        existingMeta.timestamp === bound.timestamp &&
                        existingMeta.frontendSource === (bound.frontendSource || frontendSource)
                    ))
                ) return m;

                if (!bound) {
                    return existingMeta
                        ? cloneMessageWithOneRingMetadata(m, { content: this._stripTailTagFromContent(m.content) })
                        : m;
                }

                return cloneMessageWithOneRingMetadata(m, {
                    content: upsertTailTag(
                        m.content,
                        classifiedAssistant.senderName,
                        bound.timestamp,
                        bound.frontendSource || frontendSource,
                        shouldMarkNewConversationStart || existingMeta?.isNewConversationStart
                    )
                });
            }

            const classified = classifyUserContent(m.content, defaultUserName, agentName);
            if (!classified) return m;

            const originalIndex = result.indexOf(m);
            const shouldMarkNewConversationStart = originalIndex === newConversationStartUserIndex;
            const bound = timestampBindings[originalIndex] || null;
            if (
                existingMeta &&
                existingMeta.senderName === classified.senderName &&
                (!shouldMarkNewConversationStart || existingMeta.isNewConversationStart) &&
                (!bound || (
                    existingMeta.timestamp === bound.timestamp &&
                    existingMeta.frontendSource === (bound.frontendSource || frontendSource)
                ))
            ) return m;

            if (!bound) {
                return existingMeta
                    ? cloneMessageWithOneRingMetadata(m, { content: this._stripTailTagFromContent(m.content) })
                    : m;
            }

            return cloneMessageWithOneRingMetadata(m, {
                content: upsertTailTag(
                    m.content,
                    classified.senderName,
                    bound.timestamp,
                    bound.frontendSource || frontendSource,
                    shouldMarkNewConversationStart || existingMeta?.isNewConversationStart
                )
            });
        });
        timing.mark('tailTagUpsert');

        if (isOneRingTimeInsertEnabled()) {
            result = mergeConversationByOneRingTimestamp(result);
            timing.mark('timestampMerge');
        }

        const beforeDedupeCount = result.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        result = await dedupeAdjacentSimilarConversation(result, outputDedupeThreshold);
        const afterDedupeCount = result.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        summaryStats.outputDeduped += Math.max(0, beforeDedupeCount - afterDedupeCount);
        timing.mark('outputDedupe', `before=${beforeDedupeCount} after=${afterDedupeCount}`);

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
        timing.mark('snapshotSave', `saved=${summaryStats.snapshotSaved}`);

        logOneRingSummary(agentName, frontendSource, 'record-only', summaryStats);
        timing.finish(`inserted=${summaryStats.dbInserted} updated=${summaryStats.dbUpdated} snapshotSaved=${summaryStats.snapshotSaved}`);

        const retryTargetTurn = this._findRetryTargetTurn(agentName, frontendSource, postBlocks, snapshotApplyResult);
        const turnMeta = this._createPendingTurn(agentName, frontendSource, postBlocks, retryTargetTurn);
        return this._attachMeta(result, agentName, frontendSource, turnMeta);
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
                const classified = classifyAssistantContent(rawText, agentName);
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

    _bindExactTimestampsForPostBlocks(agentName, frontendSource, postBlocks, threshold = 0.92) {
        const stats = { boundTimestampsByIndex: {} };
        const blocks = Array.isArray(postBlocks) ? postBlocks : [];
        if (blocks.length === 0) return stats;

        let recentRows = [];
        let jsExactMatched = 0;
        let jsExactMissed = 0;
        const jsMissSamples = [];
        try {
            recentRows = db.getRecentMessagesByFrontend(
                agentName,
                frontendSource,
                Math.max(blocks.length * 4, 40),
                projectBasePath
            );
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Exact timestamp binding DB query failed:', e.message);
            if (debugMode && (jsExactMatched > 0 || jsExactMissed > 0)) {
                console.log(`[OneRing] JS exact timestamp bind matched=${jsExactMatched} missed=${jsExactMissed} agent="${agentName}" frontend="${frontendSource}"`);
                if (jsMissSamples.length > 0) {
                    console.log(`[OneRing] JS exact timestamp bind miss samples: ${jsMissSamples.join(' | ')}`);
                }
            }

            return stats;
        }

        const usedExactIds = new Set();
        const exactCandidates = recentRows
            .map(row => ({
                row,
                hash: snapshot.contentHash(row.content)
            }))
            .filter(candidate => candidate.row && candidate.hash);

        for (const block of blocks) {
            if (stats.boundTimestampsByIndex[block.index]) continue;
            const blockHash = snapshot.contentHash(block.text);
            let matched = exactCandidates.find(candidate =>
                candidate.row.role === block.role &&
                candidate.hash === blockHash &&
                !usedExactIds.has(candidate.row.id)
            );
            const matchSource = 'exact';

            if (!matched) {
                jsExactMissed++;
                if (debugMode && jsMissSamples.length < 5) {
                    const sameRoleRecent = exactCandidates
                        .filter(candidate => candidate.row.role === block.role)
                        .slice(-3)
                        .map(candidate => `${candidate.row.id}:${candidate.hash.slice(0, 10)}:${String(candidate.row.content || '').length}`)
                        .join(',');
                    jsMissSamples.push(`idx=${block.index} role=${block.role} hash=${blockHash.slice(0, 10)} textLen=${String(block.text || '').length} sameRoleRecent=[${sameRoleRecent}]`);
                }
                continue;
            }

            jsExactMatched++;
            usedExactIds.add(matched.row.id);
            stats.boundTimestampsByIndex[block.index] = {
                dbId: matched.row.id,
                timestamp: matched.row.timestamp,
                senderName: matched.row.senderName,
                frontendSource: matched.row.frontendSource || frontendSource,
                source: matchSource
            };
        }

        // 跨端 assistant exact 兜底：
        // 当前 post 里可能已经带回了手机端 AI 回复，但没有 OneRing 尾标。
        // 这种块会被 fuzzy patch 视为“已存在”而不会从 DB 注入；如果只查同前端，
        // 就无法给它恢复 VCPMoblie/VCPChat 等真实来源时间戳。
        // 只对 assistant 做跨端 exact，避免短 user 文本跨端误绑。
        const unboundAssistantBlocks = blocks.filter(block =>
            block.role === 'assistant' &&
            !stats.boundTimestampsByIndex[block.index]
        );
        if (unboundAssistantBlocks.length > 0) {
            try {
                const crossRows = db.getRecentMessages(
                    agentName,
                    Math.max(unboundAssistantBlocks.length * 8, 80),
                    projectBasePath
                );
                const crossCandidates = crossRows
                    .map(row => ({
                        row,
                        hash: snapshot.contentHash(row.content)
                    }))
                    .filter(candidate =>
                        candidate.row &&
                        candidate.row.role === 'assistant' &&
                        candidate.row.frontendSource !== frontendSource &&
                        candidate.hash
                    );

                let crossMatched = 0;
                for (const block of unboundAssistantBlocks) {
                    const blockHash = snapshot.contentHash(block.text);
                    const matched = crossCandidates.find(candidate =>
                        candidate.hash === blockHash &&
                        !usedExactIds.has(candidate.row.id)
                    );
                    if (!matched) continue;

                    crossMatched++;
                    usedExactIds.add(matched.row.id);
                    stats.boundTimestampsByIndex[block.index] = {
                        dbId: matched.row.id,
                        timestamp: matched.row.timestamp,
                        senderName: matched.row.senderName,
                        frontendSource: matched.row.frontendSource || frontendSource,
                        source: 'exact-cross-frontend-assistant'
                    };
                }

                if (debugMode && crossMatched > 0) {
                    console.log(`[OneRing] Cross-frontend assistant exact timestamp bind matched=${crossMatched}/${unboundAssistantBlocks.length} agent="${agentName}" currentFrontend="${frontendSource}"`);
                }
            } catch (e) {
                if (debugMode) console.warn('[OneRing] Cross-frontend assistant exact timestamp binding failed:', e.message);
            }
        }

        return stats;
    }

    async _recordSnapshotAppendBlocks(agentName, frontendSource, defaultUserName, newBlocks, nextTimestamp, threshold, newConversationStartUserIndex = -1, appendMeta = {}) {
        const stats = { inserted: 0, updated: 0, fuzzyEdited: 0, exactBound: 0, boundTimestampsByIndex: {} };
        let newUserCount = 0;
        let newAssistantCount = 0;
        const blocks = Array.isArray(newBlocks) ? newBlocks : [];
        const usedExactIds = new Set();
        const isSingleAnchorShortAppend =
            !appendMeta?.hasClientTimestampTruth &&
            Number(appendMeta?.overlapCount || 0) === 1 &&
            blocks.length <= 3;

        let recentRows = [];
        try {
            recentRows = db.getRecentMessagesByFrontend(
                agentName,
                frontendSource,
                Math.max(blocks.length * 4, 24),
                projectBasePath
            );
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Snapshot append exact DB binding failed, will record candidates:', e.message);
        }

        const exactCandidates = recentRows
            .map(row => ({
                row,
                hash: snapshot.contentHash(row.content)
            }))
            .filter(candidate => candidate.row && candidate.hash);

        const lastUserBlock = [...blocks].reverse().find(block => block.role === 'user') || null;
        let positionalRowsAfterSnapshot = [];
        let singleAnchorDbRow = null;
        try {
            const snapshotRows = snapshot.loadSnapshot(agentName, frontendSource, projectBasePath);
            const lastMappedSnapshotRow = [...snapshotRows].reverse().find(row => row && row.dbId) || null;
            if (lastMappedSnapshotRow) {
                const anchorIndex = recentRows.findIndex(row => row.id === lastMappedSnapshotRow.dbId);
                if (anchorIndex >= 0) {
                    singleAnchorDbRow = recentRows[anchorIndex] || null;
                    positionalRowsAfterSnapshot = recentRows.slice(anchorIndex + 1);
                }
            }
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Snapshot append positional binding unavailable:', e.message);
        }
        let positionalCursor = 0;

        for (const block of blocks) {
            const recordStart = process.hrtime.bigint();
            const blockHash = snapshot.contentHash(block.text);
            const exact = exactCandidates.find(candidate =>
                candidate.row.role === block.role &&
                candidate.hash === blockHash &&
                !usedExactIds.has(candidate.row.id)
            );

            if (exact) {
                usedExactIds.add(exact.row.id);
                stats.exactBound++;
                stats.boundTimestampsByIndex[block.index] = {
                    dbId: exact.row.id,
                    timestamp: exact.row.timestamp,
                    senderName: exact.row.senderName,
                    frontendSource: exact.row.frontendSource || frontendSource,
                    source: 'snapshot-exact'
                };
                const bindMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                if (debugMode || bindMs >= 50) console.log(`[OneRingTiming] bindSnapshotAppendBlockExact role=${block.role} dbId=${exact.row.id} ms=${bindMs.toFixed(1)} timestamp=${exact.row.timestamp} index=${block.index}`);
                continue;
            }

            // Snapshot append 已证明“旧 post 尾部 == 当前 post 头部”，因此 newBlocks 通常是：
            // - 上轮异步 AI 回复 f：已经由 handler final callback 入 message 库，但不在上一轮 post 快照；
            // - 本轮最后真实 user g：应作为新消息写库。
            //
            // 对非最后 user 的新增块，优先使用“上一轮快照尾部 dbId 之后的 message 位置窗口”确定性绑定。
            // 只要位置候选存在且角色一致，hash 不同就是用户编辑，直接 UPDATE content，timestamp 不变。
            // 这里不需要 fuzzy；fuzzy 只保留给快照无法可靠对齐的兜底路径。
            const mayBeExistingMessageAfterPreviousPost = !(block.role === 'user' && block === lastUserBlock);
            if (mayBeExistingMessageAfterPreviousPost) {
                while (
                    positionalCursor < positionalRowsAfterSnapshot.length &&
                    usedExactIds.has(positionalRowsAfterSnapshot[positionalCursor].id)
                ) {
                    positionalCursor++;
                }

                const positionalRow = positionalRowsAfterSnapshot[positionalCursor] || null;
                if (positionalRow && positionalRow.role === block.role) {
                    positionalCursor++;
                    usedExactIds.add(positionalRow.id);

                    const positionalHash = snapshot.contentHash(positionalRow.content);
                    if (positionalHash !== blockHash) {
                        this._scheduleMessageContentUpdates(
                            agentName,
                            [{ dbId: positionalRow.id, content: block.text }],
                            'snapshot-append-positional'
                        );
                        stats.updated++;
                        stats.fuzzyEdited++;
                    } else {
                        stats.exactBound++;
                    }

                    stats.boundTimestampsByIndex[block.index] = {
                        dbId: positionalRow.id,
                        timestamp: positionalRow.timestamp,
                        senderName: positionalRow.senderName,
                        frontendSource: positionalRow.frontendSource || frontendSource,
                        source: positionalHash === blockHash ? 'snapshot-positional-exact' : 'snapshot-positional-update'
                    };
                    const bindMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                    if (debugMode || bindMs >= 50) console.log(`[OneRingTiming] bindSnapshotAppendBlockPositional role=${block.role} dbId=${positionalRow.id} changed=${positionalHash !== blockHash} ms=${bindMs.toFixed(1)} timestamp=${positionalRow.timestamp} index=${block.index}`);
                    continue;
                }
            }

            if (block.role === 'user' && block === lastUserBlock) {
                const clientBound = appendMeta?.clientTimestampBindings?.[block.index] || null;
                const ts = clientBound?.timestamp || nextTimestamp();
                const userResult = await this._recordUserMessage(
                    agentName,
                    frontendSource,
                    block.senderName || defaultUserName,
                    block.text,
                    ts,
                    threshold,
                    block.index === newConversationStartUserIndex
                );
                if (userResult === 'insert') stats.inserted++;
                if (userResult === 'update') stats.updated++;
                stats.boundTimestampsByIndex[block.index] = {
                    timestamp: ts,
                    senderName: block.senderName || defaultUserName,
                    frontendSource,
                    source: clientBound ? 'snapshot-post-client-verified' : 'snapshot-post'
                };
                newUserCount++;
                const recordMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                if (debugMode || recordMs >= 50) console.log(`[OneRingTiming] recordSnapshotAppendBlock role=user result=${userResult} ms=${recordMs.toFixed(1)} textLen=${String(block.text || '').length} index=${block.index}`);
            } else if (block.role === 'user') {
                const skipMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                if (debugMode || skipMs >= 50) console.log(`[OneRingTiming] skipSnapshotAppendNonTailUserNoExact role=user ms=${skipMs.toFixed(1)} textLen=${String(block.text || '').length} index=${block.index}`);
            } else if (block.role === 'assistant') {
                const singleAnchorMatch = isSingleAnchorShortAppend
                    ? await this._trySingleAnchorAssistantFuzzyUpdate(agentName, frontendSource, block, singleAnchorDbRow, usedExactIds)
                    : null;
                if (singleAnchorMatch) {
                    const matched = singleAnchorMatch.row;
                    usedExactIds.add(matched.id);
                    this._scheduleMessageContentUpdates(
                        agentName,
                        [{ dbId: matched.id, content: block.text }],
                        'snapshot-append-single-anchor-assistant-fuzzy'
                    );
                    stats.updated++;
                    stats.fuzzyEdited++;
                    stats.boundTimestampsByIndex[block.index] = {
                        dbId: matched.id,
                        timestamp: matched.timestamp,
                        senderName: matched.senderName,
                        frontendSource: matched.frontendSource || frontendSource,
                        source: 'snapshot-single-anchor-assistant-fuzzy-update'
                    };
                    const updateMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                    console.log(`[OneRing] Single-anchor assistant fuzzy update dbId=${matched.id} sim=${singleAnchorMatch.sim.toFixed(4)} ageSec=${singleAnchorMatch.ageSec.toFixed(1)} ms=${updateMs.toFixed(1)} index=${block.index}`);
                    continue;
                }

                // 正常推进中的 assistant 候选必须优先由 final callback 写库并提供真实时间戳。
                // 快照快速路径未精确命中 DB 时，不在这里插入 assistant，避免重复 f 和 post 时间戳污染。
                newAssistantCount++;
                const skipMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                if (debugMode || skipMs >= 50) console.log(`[OneRingTiming] skipSnapshotAppendAssistantNoExact role=assistant ms=${skipMs.toFixed(1)} textLen=${String(block.text || '').length} index=${block.index}`);
            }
        }

        if (debugMode || blocks.length > 0) {
            console.log(`[OneRing] Snapshot append fast-path recorded users=${newUserCount} assistants=${newAssistantCount} exactBound=${stats.exactBound} inserted=${stats.inserted} updated=${stats.updated}`);
        }

        return stats;
    }

    async _trySingleAnchorAssistantFuzzyUpdate(agentName, frontendSource, block, anchorDbRow, usedExactIds) {
        const options = getOneRingSingleAnchorAssistantOptions();
        if (!options.enabled) return null;
        if (!block || block.role !== 'assistant') return null;
        if (String(block.text || '').length < options.minAssistantChars) return null;
        if (!anchorDbRow || anchorDbRow.role !== 'user' || !anchorDbRow.timestamp) return null;

        const anchorMs = parseOneRingLocalTimestampMs(anchorDbRow.timestamp);
        if (!Number.isFinite(anchorMs)) return null;

        const ageMs = Date.now() - anchorMs;
        if (ageMs < 0 || ageMs > options.freshnessSeconds * 1000) return null;

        try {
            const conn = db.getDb(agentName, projectBasePath);
            const rows = conn.prepare(
                `SELECT id, role, senderName, frontendSource, content, timestamp
                 FROM messages
                 WHERE agentName=? AND frontendSource=? AND role='assistant' AND timestamp>?
                 ORDER BY timestamp ASC, id ASC
                 LIMIT ?`
            ).all(agentName, frontendSource, anchorDbRow.timestamp, options.candidateLimit);

            const candidates = rows.filter(row => row && !usedExactIds.has(row.id));
            const similarities = await fuzzyPool.similarityMany(candidates.map(row => ({
                a: block.text,
                b: row.content
            })));
            const matches = candidates
                .map((row, index) => ({
                    row,
                    sim: similarities[index],
                    ageSec: ageMs / 1000
                }))
                .filter(item => item.sim >= options.threshold)
                .sort((a, b) => b.sim - a.sim);

            if (matches.length !== 1) {
                if (debugMode && matches.length > 1) {
                    console.log(`[OneRing] Single-anchor assistant fuzzy update skipped: ambiguous matches=${matches.length} anchorDbId=${anchorDbRow.id} index=${block.index}`);
                }
                return null;
            }

            return matches[0];
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Single-anchor assistant fuzzy update lookup failed:', e.message);
            return null;
        }
    }

    async _syncRecordOnlyPostWithDb(agentName, frontendSource, defaultUserName, messages, nextTimestamp, threshold, precomputedPostBlocks = null, newConversationStartUserIndex = -1) {
        const timing = createOneRingTimingProbe('record-only-sync-inner', { agentName, frontendSource });
        const stats = { inserted: 0, updated: 0, fuzzyEdited: 0, boundTimestampsByIndex: {} };
        if (!Array.isArray(messages)) return stats;

        const postBlocks = Array.isArray(precomputedPostBlocks)
            ? precomputedPostBlocks
            : this._extractLocalPostBlocks(messages, agentName, frontendSource, defaultUserName);
        timing.mark('preparePostBlocks', `blocks=${postBlocks.length} precomputed=${Array.isArray(precomputedPostBlocks)}`);

        if (postBlocks.length === 0) {
            timing.finish('emptyPostBlocks');
            return stats;
        }

        try {
            const dbLimit = Math.max(postBlocks.length * 4, 40);
            const dbBlocks = db.getRecentMessagesByFrontend(
                agentName,
                frontendSource,
                dbLimit,
                projectBasePath
            );
            timing.mark('getRecentMessagesByFrontend', `limit=${dbLimit} rows=${dbBlocks.length}`);

            const existingHashesByRole = dbBlocks.reduce((acc, row) => {
                if (!acc[row.role]) acc[row.role] = new Set();
                acc[row.role].add(snapshot.contentHash(row.content));
                return acc;
            }, {});
            const tailPostBatch = this._findTailPostBatch(messages, defaultUserName, agentName);
            const allowedTailIndexes = new Set([
                ...(tailPostBatch?.user ? [tailPostBatch.user.index] : []),
                ...((tailPostBatch?.assistants || []).map(item => item.index))
            ]);
            let skippedKnown = 0;
            let skippedUnknown = 0;
            let skippedNonTail = 0;

            for (const block of postBlocks) {
                const roleHashes = existingHashesByRole[block.role] || new Set();
                const blockHash = snapshot.contentHash(block.text);
                if (roleHashes.has(blockHash)) {
                    skippedKnown++;
                    continue;
                }

                if (!allowedTailIndexes.has(block.index)) {
                    skippedNonTail++;
                    continue;
                }

                if (tailPostBatch?.user && block.index === tailPostBatch.user.index) {
                    const recordStart = process.hrtime.bigint();
                    const ts = nextTimestamp();
                    const userResult = await this._recordUserMessage(
                        agentName,
                        frontendSource,
                        tailPostBatch.user.classified.senderName,
                        tailPostBatch.user.classified.cleanText,
                        ts,
                        threshold,
                        block.index === newConversationStartUserIndex
                    );
                    if (userResult === 'insert') stats.inserted++;
                    if (userResult === 'update') stats.updated++;
                    if (userResult === 'insert' || userResult === 'update') {
                        stats.boundTimestampsByIndex[block.index] = {
                            timestamp: ts,
                            senderName: tailPostBatch.user.classified.senderName,
                            frontendSource,
                            source: 'hash-only-post-user'
                        };
                    }
                    const recordMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                    if (debugMode || recordMs >= 50) console.log(`[OneRingTiming] recordTailUserHashOnly result=${userResult} ms=${recordMs.toFixed(1)} textLen=${String(block.text || '').length} index=${block.index}`);
                    continue;
                }

                const tailAssistant = (tailPostBatch?.assistants || []).find(item => item.index === block.index) || null;
                if (tailAssistant) {
                    const assistantStats = await this._recordTailPostAssistantBatch(
                        agentName,
                        frontendSource,
                        [tailAssistant],
                        nextTimestamp,
                        threshold
                    );
                    stats.inserted += assistantStats.inserted || 0;
                    stats.updated += assistantStats.updated || 0;
                    Object.assign(stats.boundTimestampsByIndex, assistantStats.boundTimestampsByIndex || {});
                } else {
                    skippedUnknown++;
                }
            }

            timing.mark('hashOnlySync', `known=${skippedKnown} nonTailSkipped=${skippedNonTail} unknownSkipped=${skippedUnknown} inserted=${stats.inserted} updated=${stats.updated}`);
        } catch (e) {
            console.error('[OneRing] Only mode hash-only DB sync failed:', e.message);
        }
        timing.finish(`inserted=${stats.inserted} updated=${stats.updated} fuzzyEdited=${stats.fuzzyEdited}`);
        return stats;
    }

        /**
         * 从最终发送给上游的 messages 中推导 OneRing 元信息。
         * 注意：不在 message 对象上附加私有字段，避免 JSON.stringify 后发给上游。
         */
        _extractMetaFromMessages(messages) {
            if (!Array.isArray(messages)) return null;
    
            const attachedMeta = messages.__oneRingMeta || null;
    
            // 触发符可能已被 processMessages 替换为通知文字；需同时检测两种形态。
            // final hook 可能拿到数组元信息丢失后的消息视图，甚至拿到只保留顶部通知前缀的文本；
            // 因此扫描开头连续 system 前缀中的最后一个 OneRing 触发串或启动通知作为兜底。
            let systemText = '';
            for (const msg of messages) {
                if (!msg || msg.role !== 'system') break;
                const t = fuzzy.extractText(msg.content);
                if (getLastTriggerMatch(t) || getLastNoticeMeta(t)) {
                    systemText = t;
                }
            }
            const triggerMatch = getLastTriggerMatch(systemText);
            const noticeMeta = getLastNoticeMeta(systemText);

        // final hook 有时拿到的是预处理前/数组元信息丢失后的消息视图；
        // 此时必须允许回读顶层 OneRing 触发串或已替换的启动通知，否则 agentName/frontendSource 会缺失，
        // AI 回复可能被写入空 agent 的幽灵库（例如 ".db"）。
        // 边界仍限制为开头连续 system 前缀，避免普通上下文/用户正文中的 OneRing 文本误触发。
        const agentName = attachedMeta?.agentName || (triggerMatch ? triggerMatch[1].trim() : null) || noticeMeta?.agentName || null;
        const frontendSourceFromTrigger = attachedMeta?.frontendSource || (triggerMatch ? triggerMatch[2].trim() : null) || noticeMeta?.frontendSource || null;
        if (!agentName || !frontendSourceFromTrigger) return null;

        const tailPostBatch = this._findTailPostBatch(messages, config.ONERING_USER_NAME || 'Ryan', agentName);
        const tailMeta = tailPostBatch?.user ? getOneRingTailMeta(tailPostBatch.user.message.content) : null;

        return {
            agentName,
            frontendSource: tailMeta ? tailMeta.frontendSource : frontendSourceFromTrigger,
            lastUserSenderName: tailMeta ? tailMeta.senderName : null,
            lastUserTimestamp: tailMeta ? tailMeta.timestamp : null,
            turnId: attachedMeta?.turnId || null,
            requestHash: attachedMeta?.requestHash || null,
            retryOfTurnId: attachedMeta?.retryOfTurnId || null,
            responseMessageIdToUpdate: attachedMeta?.responseMessageIdToUpdate || null
        };
    }

    _hasOneRingActivationSignal(messages) {
        if (!Array.isArray(messages)) return false;
        if (messages.__oneRingMeta) return true;

        for (const msg of messages) {
            if (!msg || msg.role !== 'system') break;
            const text = fuzzy.extractText(msg.content);
            if (getLastTriggerMatch(text) || getLastNoticeMeta(text)) return true;
        }

        return false;
    }

    extractMetaFromMessages(messages) {
        return this._extractMetaFromMessages(messages);
    }

    async recordAIResponseWithMeta(meta, aiText) {
        return this.recordAIResponse(meta, aiText);
    }

    /**
     * AI 回复入库（异步，fire-and-forget，供 Stream/NonStream handler 在最终回复完成后调用）。
     */
    async recordAIResponseFromMessages(messages, aiText) {
        const meta = this._extractMetaFromMessages(messages);
        if (!meta && !this._hasOneRingActivationSignal(messages)) {
            if (debugMode) {
                console.log('[OneRing] post回复跳过入库：未检测到OneRing触发信息。');
            }
            return;
        }
        if (!meta || !meta.agentName || typeof aiText !== 'string') {
            console.warn(`[OneRing] post回复未写入OneRing：hook已收到但元信息无效或回复不是字符串 meta=${meta ? JSON.stringify(meta) : 'null'} aiTextType=${typeof aiText}`);
            return;
        }

        const text = aiText.trim();
        if (text.length === 0) {
            if (meta.turnId) {
                try {
                    db.markPostTurnAborted(meta.agentName, meta.turnId, new Date().toISOString(), projectBasePath);
                } catch (e) {
                    if (debugMode) console.warn('[OneRing] Failed to mark empty assistant turn aborted:', e.message);
                }
            }
            console.warn(`[OneRing] post回复未写入OneRing：hook已收到但AI回复正文为空 agent=${meta.agentName} frontend=${meta.frontendSource} turn=${meta.turnId || 'none'}`);
            return;
        }

        try {
            if (meta.responseMessageIdToUpdate) {
                const responseId = Number(meta.responseMessageIdToUpdate);
                if (!Number.isFinite(responseId) || responseId <= 0) {
                    console.warn(`[OneRing] post回复未写入OneRing：retry目标dbId无效 agent=${meta.agentName} frontend=${meta.frontendSource} responseMessageIdToUpdate=${meta.responseMessageIdToUpdate}`);
                    return;
                }

                const updateResult = db.updateMessageById(meta.agentName, responseId, aiText, projectBasePath);
                if (!updateResult || updateResult.changes <= 0) {
                    console.warn(`[OneRing] post回复未写入OneRing：retry更新未命中记录 agent=${meta.agentName} frontend=${meta.frontendSource} dbId=${responseId} turn=${meta.turnId || 'none'} textLen=${aiText.length}`);
                    return;
                }

                let turnCompleted = false;
                if (meta.turnId) {
                    const completeResult = db.completePostTurn(meta.agentName, meta.turnId, responseId, snapshot.contentHash(aiText), new Date().toISOString(), projectBasePath);
                    turnCompleted = !!completeResult && completeResult.changes > 0;
                    if (!turnCompleted) {
                        console.warn(`[OneRing] post回复写入OneRing成功但turn未完成：agent=${meta.agentName} frontend=${meta.frontendSource} dbId=${responseId} turn=${meta.turnId}`);
                    }
                }
                console.log(`[OneRing] post回复写入OneRing成功：agent=${meta.agentName} frontend=${meta.frontendSource} mode=update dbId=${responseId} turn=${meta.turnId || 'none'} turnCompleted=${turnCompleted} textLen=${aiText.length}`);
                return;
            }

            const timestamp = formatOneRingTimestamp();
            const result = db.insertMessage(meta.agentName, {
                role: 'assistant',
                senderName: meta.agentName,
                frontendSource: meta.frontendSource,
                content: aiText,
                timestamp,
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            const insertedId = Number(result?.lastInsertRowid || 0);
            if (!Number.isFinite(insertedId) || insertedId <= 0) {
                console.warn(`[OneRing] post回复未写入OneRing：insert未返回有效rowid agent=${meta.agentName} frontend=${meta.frontendSource} turn=${meta.turnId || 'none'} changes=${result?.changes ?? 'unknown'} textLen=${aiText.length}`);
                return;
            }

            let turnCompleted = false;
            if (meta.turnId) {
                const completeResult = db.completePostTurn(meta.agentName, meta.turnId, insertedId, snapshot.contentHash(aiText), new Date().toISOString(), projectBasePath);
                turnCompleted = !!completeResult && completeResult.changes > 0;
                if (!turnCompleted) {
                    console.warn(`[OneRing] post回复写入OneRing成功但turn未完成：agent=${meta.agentName} frontend=${meta.frontendSource} dbId=${insertedId} turn=${meta.turnId}`);
                }
            }
            console.log(`[OneRing] post回复写入OneRing成功：agent=${meta.agentName} frontend=${meta.frontendSource} mode=insert dbId=${insertedId} timestamp="${timestamp}" turn=${meta.turnId || 'none'} turnCompleted=${turnCompleted} textLen=${aiText.length}`);
        } catch (e) {
            console.warn(`[OneRing] post回复未写入OneRing：写库异常 agent=${meta.agentName} frontend=${meta.frontendSource} turn=${meta.turnId || 'none'} textLen=${aiText.length} error=${e.message}`);
        }
    }

    /**
     * 兼容旧调用：AI 回复入库（异步，fire-and-forget）。
     */
    async recordAIResponse(meta, aiText) {
        if (!meta || !meta.agentName || typeof aiText !== 'string' || aiText.trim().length === 0) {
            console.warn(`[OneRing] post回复未写入OneRing：兼容入口参数无效 meta=${meta ? JSON.stringify(meta) : 'null'} aiTextType=${typeof aiText} textLen=${typeof aiText === 'string' ? aiText.trim().length : 'n/a'}`);
            return;
        }
        try {
            if (meta.responseMessageIdToUpdate) {
                const responseId = Number(meta.responseMessageIdToUpdate);
                if (!Number.isFinite(responseId) || responseId <= 0) {
                    console.warn(`[OneRing] post回复未写入OneRing：兼容入口retry目标dbId无效 agent=${meta.agentName} frontend=${meta.frontendSource} responseMessageIdToUpdate=${meta.responseMessageIdToUpdate}`);
                    return;
                }

                const updateResult = db.updateMessageById(meta.agentName, responseId, aiText, projectBasePath);
                if (!updateResult || updateResult.changes <= 0) {
                    console.warn(`[OneRing] post回复未写入OneRing：兼容入口retry更新未命中记录 agent=${meta.agentName} frontend=${meta.frontendSource} dbId=${responseId} turn=${meta.turnId || 'none'} textLen=${aiText.length}`);
                    return;
                }

                let turnCompleted = false;
                if (meta.turnId) {
                    const completeResult = db.completePostTurn(meta.agentName, meta.turnId, responseId, snapshot.contentHash(aiText), new Date().toISOString(), projectBasePath);
                    turnCompleted = !!completeResult && completeResult.changes > 0;
                    if (!turnCompleted) {
                        console.warn(`[OneRing] post回复写入OneRing成功但turn未完成：兼容入口 agent=${meta.agentName} frontend=${meta.frontendSource} dbId=${responseId} turn=${meta.turnId}`);
                    }
                }
                console.log(`[OneRing] post回复写入OneRing成功：agent=${meta.agentName} frontend=${meta.frontendSource} mode=compat-update dbId=${responseId} turn=${meta.turnId || 'none'} turnCompleted=${turnCompleted} textLen=${aiText.length}`);
                return;
            }

            const timestamp = formatOneRingTimestamp();
            const result = db.insertMessage(meta.agentName, {
                role: 'assistant',
                senderName: meta.agentName,
                frontendSource: meta.frontendSource,
                content: aiText,
                timestamp,
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            const insertedId = Number(result?.lastInsertRowid || 0);
            if (!Number.isFinite(insertedId) || insertedId <= 0) {
                console.warn(`[OneRing] post回复未写入OneRing：兼容入口insert未返回有效rowid agent=${meta.agentName} frontend=${meta.frontendSource} turn=${meta.turnId || 'none'} changes=${result?.changes ?? 'unknown'} textLen=${aiText.length}`);
                return;
            }

            let turnCompleted = false;
            if (meta.turnId) {
                const completeResult = db.completePostTurn(meta.agentName, meta.turnId, insertedId, snapshot.contentHash(aiText), new Date().toISOString(), projectBasePath);
                turnCompleted = !!completeResult && completeResult.changes > 0;
                if (!turnCompleted) {
                    console.warn(`[OneRing] post回复写入OneRing成功但turn未完成：兼容入口 agent=${meta.agentName} frontend=${meta.frontendSource} dbId=${insertedId} turn=${meta.turnId}`);
                }
            }
            console.log(`[OneRing] post回复写入OneRing成功：agent=${meta.agentName} frontend=${meta.frontendSource} mode=compat-insert dbId=${insertedId} timestamp="${timestamp}" turn=${meta.turnId || 'none'} turnCompleted=${turnCompleted} textLen=${aiText.length}`);
        } catch (e) {
            console.warn(`[OneRing] post回复未写入OneRing：兼容入口写库异常 agent=${meta.agentName} frontend=${meta.frontendSource} turn=${meta.turnId || 'none'} textLen=${aiText.length} error=${e.message}`);
        }
    }

    /**
     * 全新短上下文入库。
     * 用于 user/assistant 块都很少、同前端 DB 为空的初次对话场景。
     * 记录 post 中已经存在的真实块；跨端补充由 _doFreshShortContextPatch 负责。
     */
    async _recordFreshShortContext(agentName, frontendSource, defaultUserName, historyBlocks, threshold = 0.92, newConversationStartUserIndex = -1) {
        const stats = { inserted: 0, updated: 0 };
        const nextTimestamp = createOneRingTimestampSequencer();
        for (const block of historyBlocks) {
            if (block.role === 'user') {
                const classified = classifyUserContent(block.text, defaultUserName, agentName);
                if (!classified) continue;
                const userResult = await this._recordUserMessage(
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
                const classifiedAssistant = classifyAssistantContent(block.text, agentName);
                if (!classifiedAssistant) continue;
                const assistantResult = await this._recordAssistantMessage(
                    agentName,
                    frontendSource,
                    classifiedAssistant.cleanText,
                    nextTimestamp(),
                    threshold,
                    classifiedAssistant.senderName,
                    block.index === newConversationStartUserIndex
                );
                if (assistantResult === 'insert') stats.inserted++;
                if (assistantResult === 'update') stats.updated++;
            }
        }
        return stats;
    }

    async _recordIncomingAssistantContext(agentName, frontendSource, messages, timestamp, threshold = 0.92) {
        const stats = { inserted: 0, updated: 0 };
        if (!Array.isArray(messages)) return stats;

        for (const m of messages) {
            if (!m || m.role !== 'assistant') continue;

            const classified = classifyAssistantContent(m.content, agentName);
            if (!classified) continue;

            // 群聊/AA 中 assistant role 可能承载别的 Agent 发言，必须入库给 OneRing 时间线。
            // 纯 Direct assistant 默认由 final callback 记录，避免当前目标 AI 的回复被重复同步。
            if (classified.source === 'Direct' && classified.senderName === agentName) continue;

            const assistantResult = await this._recordAssistantMessage(
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

    async _recordAssistantMessage(agentName, frontendSource, cleanText, timestamp, threshold = 0.92, senderName = agentName, isNewConversationStart = false) {
        const timing = createOneRingTimingProbe('record-assistant-message', { agentName, frontendSource });
        try {
            const dbContent = isNewConversationStart
                ? upsertTailTag(cleanText, senderName, timestamp, frontendSource, true)
                : cleanText;
            timing.mark('prepareDbContent', `cleanLen=${String(cleanText || '').length} dbLen=${String(dbContent || '').length} newStart=${isNewConversationStart}`);
            const recentRows = db.getRecentMessagesByFrontend(agentName, frontendSource, 12, projectBasePath);
            timing.mark('getRecentMessagesByFrontend', `rows=${recentRows.length}`);
            const recent = recentRows
                .filter(item => item.role === 'assistant')
                .slice(-1)[0];
            timing.mark('filterRecentAssistant', `hasRecent=${!!recent}`);

            if (recent) {
                const sim = await fuzzyPool.similarity(cleanText, recent.content);
                timing.mark('similarityRecentAssistant', `sim=${sim.toFixed(4)} cleanLen=${String(cleanText || '').length} recentLen=${String(recent.content || '').length}`);
                if (sim >= threshold) {
                    db.updateMessageById(agentName, recent.id, dbContent, projectBasePath);
                    timing.mark('updateMessageById', `dbId=${recent.id}`);
                    timing.finish('result=update');
                    if (debugMode) console.log(`[OneRing] Updated recent assistant message dbId=${recent.id}`);
                    return 'update';
                }
            } else {
                timing.mark('similarityRecentAssistant', 'skipped=noRecent');
            }

            db.insertMessage(agentName, {
                role: 'assistant',
                senderName,
                frontendSource,
                content: dbContent,
                timestamp,
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            timing.mark('insertMessage', `contentLen=${String(dbContent || '').length}`);
            timing.finish('result=insert');
            if (debugMode) console.log(`[OneRing] Recorded assistant message for agent=${agentName}, sender=${senderName}, frontend=${frontendSource}`);
            return 'insert';
        } catch (e) {
            timing.finish('result=error');
            console.error('[OneRing] Failed to record assistant message:', e.message);
            return 'error';
        }
    }

    /**
     * user 发言入库（在 processMessages 内部确认要入库时调用）。
     * 最近同前端 user 块高度相似时执行 UPDATE，避免 retry / 重新发送导致重复写入。
     */
    async _recordUserMessage(agentName, frontendSource, senderName, cleanText, timestamp, threshold = 0.92, isNewConversationStart = false) {
        const timing = createOneRingTimingProbe('record-user-message', { agentName, frontendSource });
        try {
            const dbContent = isNewConversationStart
                ? upsertTailTag(cleanText, senderName, timestamp, frontendSource, true)
                : cleanText;
            timing.mark('prepareDbContent', `cleanLen=${String(cleanText || '').length} dbLen=${String(dbContent || '').length} newStart=${isNewConversationStart}`);

            const recentRows = db.getRecentMessagesByFrontend(agentName, frontendSource, 12, projectBasePath);
            timing.mark('getRecentMessagesByFrontend', `rows=${recentRows.length}`);
            const recent = recentRows
                .filter(item => item.role === 'user')
                .slice(-1)[0];
            timing.mark('filterRecentUser', `hasRecent=${!!recent}`);

            if (recent) {
                const sim = await fuzzyPool.similarity(cleanText, recent.content);
                timing.mark('similarityRecentUser', `sim=${sim.toFixed(4)} cleanLen=${String(cleanText || '').length} recentLen=${String(recent.content || '').length}`);
                if (sim >= threshold) {
                    db.updateMessageById(agentName, recent.id, dbContent, projectBasePath);
                    timing.mark('updateMessageById', `dbId=${recent.id}`);
                    timing.finish('result=update');
                    if (debugMode) console.log(`[OneRing] Updated recent user message dbId=${recent.id}`);
                    return 'update';
                }
            } else {
                timing.mark('similarityRecentUser', 'skipped=noRecent');
            }

            db.insertMessage(agentName, {
                role: 'user',
                senderName,
                frontendSource,
                content: dbContent,
                timestamp,
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            timing.mark('insertMessage', `contentLen=${String(dbContent || '').length}`);
            timing.finish('result=insert');
            if (debugMode) console.log(`[OneRing] Recorded user message for agent=${agentName}, sender=${senderName}, frontend=${frontendSource}`);
            return 'insert';
        } catch (e) {
            timing.finish('result=error');
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
        fuzzyPool.close();
        db.closeAll();
        console.log('[OneRing] Shutdown, all DB connections closed.');
    }
}

module.exports = new OneRingPreprocessor();