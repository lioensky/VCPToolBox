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
const native = require('./OneRingNative.js');

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
    return stripOneRingTailTagText(stripLeadingSystemNoticeText(text));
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
    const text = stripOneRingTailTagText(stripLeadingSystemNoticeText(fuzzy.extractText(content)));
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

    // 1. 剥离开头系统通知栏与既有 OneRing 尾标，避免二次入库污染 cleanText。
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
                ? (getOneRingTimelineMeta(message) || getOneRingTailMeta(message.content))
                : null;
            return {
                message,
                index,
                timestamp: meta?.timestamp || null,
                injectedFromDb: isOneRingInjectedFromDb(message)
            };
        })
        .filter(item => item.message && (item.message.role === 'user' || item.message.role === 'assistant'));

    const postItems = conversation.filter(item => !item.injectedFromDb);
    const injectedItems = conversation
        .filter(item => item.injectedFromDb && item.timestamp)
        .sort((a, b) => {
            if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
            return a.index - b.index;
        });

    // post 原始 user/assistant 顺序是绝对真相，任何时间戳排序都不能重排 post 本体。
    // DB 补入块的三种合法位置（受 hotConfig 控制）：
    //   1. prepend（allowPrepend=true）：时间戳严格早于 post 第一条带可信时间戳块 → prepend 到前面
    //   2. insert（allowInsert=true）：时间戳严格介于两个相邻均带可信时间戳的 post 块之间 → 中间插入
    //   3. 其他（无法定位）→ 直接丢弃，保守不插
    const allowPrepend = hotConfig.timeInsertPrepend !== false;
    const allowInsert = hotConfig.timeInsertMiddle !== false;

    if (injectedItems.length === 0) {
        return [
            ...nonConversation,
            ...postItems.map(item => item.message)
        ];
    }

    const firstAnchoredPost = postItems.find(item => !!item.timestamp) || null;
    const firstAnchorTs = firstAnchoredPost ? firstAnchoredPost.timestamp : null;

    const prependItems = [];
    const insertsAfterPostIndex = new Map();
    let conservativeInserted = 0;
    let conservativeSkipped = 0;

    for (const injected of injectedItems) {
        if (allowPrepend && firstAnchorTs && injected.timestamp < firstAnchorTs) {
            prependItems.push(injected);
            conservativeInserted++;
            continue;
        }

        if (allowInsert && postItems.length >= 2) {
            let inserted = false;
            for (let i = 0; i < postItems.length - 1; i++) {
                const left = postItems[i];
                const right = postItems[i + 1];
                if (!left.timestamp || !right.timestamp) continue;
                const minTs = left.timestamp <= right.timestamp ? left.timestamp : right.timestamp;
                const maxTs = left.timestamp <= right.timestamp ? right.timestamp : left.timestamp;
                if (injected.timestamp > minTs && injected.timestamp < maxTs) {
                    if (!insertsAfterPostIndex.has(i)) insertsAfterPostIndex.set(i, []);
                    insertsAfterPostIndex.get(i).push(injected);
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
        console.log(`[OneRing] Conservative timestamp merge: prepend=${prependItems.length}, midInserted=${conservativeInserted - prependItems.length}, skipped=${conservativeSkipped}, postOrderPreserved=true`);
    }

    const mergedConversation = [];
    for (let i = 0; i < postItems.length; i++) {
        mergedConversation.push(postItems[i].message);
        const inserts = insertsAfterPostIndex.get(i) || [];
        for (const ins of inserts) {
            mergedConversation.push(ins.message);
        }
    }

    const result = [
        ...nonConversation,
        ...prependItems.map(item => item.message),
        ...mergedConversation
    ];

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
        messages = this._sanitizeMessagesBeforeOneRing(messages);

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

            const asyncOnlyMode = hotConfig.asyncOnlyMode && String(cfg.ONERING_ASYNC_ONLY_MODE ?? 'true').toLowerCase() !== 'false';
            if (onlyMode && asyncOnlyMode) {
                const result = this._processOnlyMessagesForUpstream(
                    messages,
                    agentName,
                    frontendSource,
                    defaultUserName,
                    outputDedupeThreshold
                );
                this._scheduleRecordOnlyPersistence(
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
                const newConversationStartUserIndex = this._detectNewConversationStartUserIndex(messages, defaultUserName, agentName);
                const freshStats = this._recordFreshShortContext(agentName, frontendSource, defaultUserName, historyBlocks, threshold, newConversationStartUserIndex);
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
        const newConversationStartUserIndex = this._detectNewConversationStartUserIndex(messages, defaultUserName, agentName);

        // 入库必须以“实际 post 传入的上下文”为真相；
        // DB 补齐必须在 post 本体写库/补标之后进行，否则前端不回传 OneRing 时间戳时，
        // prepend / middle insert 没有可信 post 时间锚点，时间线合并会失效。
        const tailPostBatch = this._findTailPostBatch(messages, defaultUserName, agentName);

        const currentPostTimestampBindings = { boundTimestampsByIndex: {} };

        if (tailPostBatch?.user && !isFreshShortContext) {
            const userRecordResult = this._recordUserMessage(
                agentName,
                frontendSource,
                tailPostBatch.user.classified.senderName,
                tailPostBatch.user.classified.cleanText,
                now,
                threshold,
                tailPostBatch.user.index === newConversationStartUserIndex
            );
            if (userRecordResult === 'insert') {
                summaryStats.dbInserted++;
                // 这是本轮 post 抵达后新生成的权威时间戳，前端不会自带；
                // 必须立即作为尾标绑定，否则后续 DB 补全没有当前 post 的可信时间锚点。
                currentPostTimestampBindings.boundTimestampsByIndex[tailPostBatch.user.index] = {
                    timestamp: now,
                    senderName: tailPostBatch.user.classified.senderName,
                    frontendSource,
                    source: 'current-post-user'
                };
            }
            if (userRecordResult === 'update') summaryStats.dbUpdated++;
        }

        if (tailPostBatch && !isFreshShortContext) {
            const tailAssistantStats = this._recordTailPostAssistantBatch(
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
            ...(snapshotEditTimestampBindings.boundTimestampsByIndex || {})
        };
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
                patchMessages = this._doFuzzyTimestampPatch(patchMessages, agentName, frontendSource, maxBlocks, threshold);
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

        const retryTargetTurn = this._findRetryTargetTurn(agentName, frontendSource, localPostBlocks, snapshotApplyResult);
        const turnMeta = this._createPendingTurn(agentName, frontendSource, localPostBlocks, retryTargetTurn);
        this._attachMeta(patchMessages, agentName, frontendSource, turnMeta);

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

        // 为每条 DB 历史 fuzzy 反查是否在当前上下文中已存在。
        // 这里先预提取/归一化 post 文本，避免 dbHistory × histMsgs 嵌套循环中反复 normalize/extractText。
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
        const fuzzyCandidates = [];
        for (const candidate of dbCandidates) {
            const roleHashes = postKeysByRole.hashes[candidate.item.role] || new Set();
            if (roleHashes.has(candidate.hash)) {
                hashMatchedCount++;
                continue;
            }
            fuzzyCandidates.push(candidate);
        }

        const missing = fuzzyCandidates
            .filter(({ item, key }) => {
                const postKeys = postKeysByRole[item.role] || [];
                return !postKeys.some(postKey => fuzzy.similarity(key, postKey) >= threshold);
            })
            .map(({ item }) => item);

        if (debugMode && hashMatchedCount > 0) {
            console.log(`[OneRing] Fuzzy patch hash prefilter: exact=${hashMatchedCount}, fuzzyCandidates=${fuzzyCandidates.length}`);
        }

        if (missing.length === 0) return isOneRingTimeInsertEnabled()
            ? mergeConversationByOneRingTimestamp(messages)
            : messages;

        const padded = missing.slice(-remaining).map(item => markOneRingTimelineMeta(markOneRingInjectedFromDb({
            role: item.role,
            content: stripOneRingTailTagText(item.content)
        }), {
            timestamp: item.timestamp,
            senderName: item.senderName || item.agentName || '?',
            frontendSource: item.frontendSource || '?',
            source: 'db-injected'
        }));

        if (debugMode) console.log(`[OneRing] Fuzzy patch: ${padded.length} missing blocks补入上下文`);

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
                ? classifyUserContent(m.content, agentName, agentName)
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
                ? classifyUserContent(m.content, agentName, agentName)
                : classifyUserContent(m.content, defaultUserName, agentName);
            if (!classified) return m;

            const isNewConversationStart = !!meta.isNewConversationStart || index === newConversationStartUserIndex;
            return {
                ...m,
                content: upsertTailTag(
                    m.content,
                    meta.senderName || classified.senderName,
                    meta.timestamp,
                    meta.frontendSource || frontendSource,
                    m.role === 'user' && isNewConversationStart
                )
            };
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
                    const classifiedAssistant = classifyUserContent(message.content, agentName, agentName);
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

    _recordTailPostAssistantBatch(agentName, frontendSource, assistants, nextTimestamp, threshold = 0.92) {
        const stats = { inserted: 0, updated: 0, boundTimestampsByIndex: {} };
        const blocks = Array.isArray(assistants) ? assistants : [];
        for (const assistant of blocks) {
            if (!assistant?.classified) continue;
            const ts = typeof nextTimestamp === 'function' ? nextTimestamp() : nextTimestamp;
            const assistantResult = this._recordAssistantMessage(
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

    _sanitizeMessagesBeforeOneRing(messages) {
        if (!Array.isArray(messages)) return messages;

        let removedSystemUser = 0;
        let removedEmptyUser = 0;
        let strippedUserContent = 0;
        const result = [];

        for (const message of messages) {
            if (!message || message.role !== 'user') {
                result.push(message);
                continue;
            }

            const originalText = fuzzy.extractText(message.content);
            const sanitizedContent = sanitizeUserContentAtPipelineEntry(message.content);
            const sanitizedText = fuzzy.extractText(sanitizedContent);
            const shouldDropSystemPromptUser = DISCARD_PATTERNS.some(pattern => pattern.test(sanitizedText));

            if (shouldDropSystemPromptUser) {
                removedSystemUser++;
                continue;
            }

            if (!hasUserTextContent(sanitizedContent)) {
                removedEmptyUser++;
                continue;
            }

            if (originalText !== sanitizedText) strippedUserContent++;
            result.push({ ...message, content: sanitizedContent });
        }

        if (debugMode && (removedSystemUser > 0 || removedEmptyUser > 0 || strippedUserContent > 0)) {
            console.log(`[OneRing] Sanitized incoming user blocks: removedSystem=${removedSystemUser}, removedEmpty=${removedEmptyUser}, stripped=${strippedUserContent}`);
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

    _createPostRequestHash(postBlocks) {
        const normalizedBlocks = (Array.isArray(postBlocks) ? postBlocks : []).map(block => ({
            role: block.role,
            senderName: block.senderName || null,
            frontendSource: block.frontendSource || null,
            hash: snapshot.contentHash(block.text || '')
        }));
        return snapshot.contentHash(JSON.stringify(normalizedBlocks));
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

            // 极短 retry：如单 user g -> g2，没有 hash 锚点，但同前端最近 completed turn 块数一致时，
            // 这是用户改写刚才唯一输入并重试的常见模式。
            const blockCount = Array.isArray(postBlocks) ? postBlocks.length : 0;
            const latest = recentTurns[0] || null;
            if (latest && blockCount > 0 && blockCount <= 2 && Number(latest.requestBlockCount) === blockCount) {
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
            const rows = conn.prepare(
                `SELECT id, role, senderName, frontendSource, content, timestamp
                 FROM messages
                 WHERE agentName=? AND frontendSource=?
                 ORDER BY timestamp DESC, id DESC
                 LIMIT ?`
            ).all(agentName, frontendSource, Math.max(items.length * 8, 80));

            const usedIds = new Set();
            for (const item of items) {
                const matched = rows.find(row =>
                    row.role === item.role &&
                    !usedIds.has(row.id) &&
                    snapshot.contentHash(row.content) === item.oldHash
                );
                if (!matched) continue;
                usedIds.add(matched.id);
                stats.boundTimestampsByIndex[item.index] = {
                    dbId: matched.id,
                    oldDbId: item.oldDbId || null,
                    timestamp: matched.timestamp,
                    senderName: matched.senderName,
                    frontendSource: matched.frontendSource || frontendSource,
                    source
                };
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

    _processOnlyMessagesForUpstream(messages, agentName, frontendSource, defaultUserName, outputDedupeThreshold = 0.98) {
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
        result = dedupeAdjacentSimilarConversation(result, outputDedupeThreshold);
        const postBlocks = this._extractLocalPostBlocks(result, agentName, frontendSource, defaultUserName);
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
                    try {
                        native.updateMessageById(projectBasePath, config, agentName, item.dbId, item.content);
                    } catch (nativeError) {
                        if (debugMode) console.warn(`[OneRingNative] async update cache failed reason=${reason} dbId=${item.dbId}:`, nativeError.message);
                    }
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

    _scheduleRecordOnlyPersistence(messages, agentName, frontendSource, defaultUserName, threshold, maxSnapshotBlocks = 20, outputDedupeThreshold = 0.98) {
        const run = () => {
            try {
                this._processRecordOnlyMessages(
                    messages,
                    agentName,
                    frontendSource,
                    defaultUserName,
                    threshold,
                    maxSnapshotBlocks,
                    outputDedupeThreshold
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

    _processRecordOnlyMessages(messages, agentName, frontendSource, defaultUserName, threshold, maxSnapshotBlocks = 20, outputDedupeThreshold = 0.98) {
        const timing = createOneRingTimingProbe('record-only', { agentName, frontendSource });
        const nextTimestamp = createOneRingTimestampSequencer();
        let result = Array.isArray(messages) ? [...messages] : messages;

        const postBlocks = this._extractLocalPostBlocks(result, agentName, frontendSource, defaultUserName);
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

        const newConversationStartUserIndex = this._detectNewConversationStartUserIndex(result, defaultUserName, agentName);
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
                syncStats = this._recordSnapshotAppendBlocks(
                    agentName,
                    frontendSource,
                    defaultUserName,
                    appendResult.newBlocks || [],
                    nextTimestamp,
                    threshold,
                    newConversationStartUserIndex
                );
                syncStats.snapshotFastPath = true;
            }
        } catch (e) {
            console.error('[OneRing] Record-only snapshot append detection failed:', e.message);
            timing.mark('snapshotAppendDetect', 'error');
        }

        if (!syncStats) {
            syncStats = this._syncRecordOnlyPostWithDb(agentName, frontendSource, defaultUserName, result, nextTimestamp, threshold, postBlocks, newConversationStartUserIndex);
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
            ...(snapshotEditTimestampBindings.boundTimestampsByIndex || {})
        };
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
                const classifiedAssistant = classifyUserContent(m.content, agentName, agentName);
                if (!classifiedAssistant) return m;

                const originalIndex = result.indexOf(m);
                const bound = timestampBindings[originalIndex] || null;
                if (
                    existingMeta &&
                    existingMeta.senderName === classifiedAssistant.senderName &&
                    (!bound || (
                        existingMeta.timestamp === bound.timestamp &&
                        existingMeta.frontendSource === (bound.frontendSource || frontendSource)
                    ))
                ) return m;

                if (!bound) {
                    return existingMeta
                        ? { ...m, content: this._stripTailTagFromContent(m.content) }
                        : m;
                }

                return {
                    ...m,
                    content: upsertTailTag(
                        m.content,
                        classifiedAssistant.senderName,
                        bound.timestamp,
                        bound.frontendSource || frontendSource
                    )
                };
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
                    ? { ...m, content: this._stripTailTagFromContent(m.content) }
                    : m;
            }

            return {
                ...m,
                content: upsertTailTag(
                    m.content,
                    classified.senderName,
                    bound.timestamp,
                    bound.frontendSource || frontendSource,
                    shouldMarkNewConversationStart || existingMeta?.isNewConversationStart
                )
            };
        });
        timing.mark('tailTagUpsert');

        if (isOneRingTimeInsertEnabled()) {
            result = mergeConversationByOneRingTimestamp(result);
            timing.mark('timestampMerge');
        }

        const beforeDedupeCount = result.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        result = dedupeAdjacentSimilarConversation(result, outputDedupeThreshold);
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

    _bindExactTimestampsForPostBlocks(agentName, frontendSource, postBlocks, threshold = 0.92) {
        const stats = { boundTimestampsByIndex: {} };
        const blocks = Array.isArray(postBlocks) ? postBlocks : [];
        if (blocks.length === 0) return stats;

        const nativeBoundIds = new Set();
        try {
            const nativeResult = native.bindTimestampsForPostBlocks({
                projectBasePath,
                config,
                agentName,
                frontendSource,
                postBlocks: blocks,
                // 时间戳真相只允许 message 库 hash 命中；threshold > 1 可禁用 native fuzzy fallback，
                // 但 native exact 分支不依赖 threshold，仍会返回 hash 精确绑定。
                threshold: 1.000001,
                limit: Math.max(blocks.length * 4, 40)
            });
            if (nativeResult && Array.isArray(nativeResult.bindings)) {
                for (const binding of nativeResult.bindings) {
                    stats.boundTimestampsByIndex[binding.index] = {
                        dbId: binding.dbId,
                        timestamp: binding.timestamp,
                        senderName: binding.senderName,
                        frontendSource: binding.frontendSource || frontendSource,
                        source: binding.source || 'native'
                    };
                    if (binding.dbId) nativeBoundIds.add(binding.dbId);
                }
                if (debugMode || (nativeResult.elapsedMs || 0) >= 50) {
                    console.log(`[OneRingNative] timestamp bind native bound=${nativeResult.bindings.length}/${blocks.length} elapsed=${(nativeResult.elapsedMs || 0).toFixed(1)}ms phase=${nativeResult.phaseSummary || ''}`);
                }
                // Rust cache 可能落后于 JS better-sqlite3 写入（例如刚完成的 AI final hook）。
                // 只有完整绑定才直接返回；不完整时继续查 messages 真库补齐未绑定块。
                if (nativeResult.bindings.length >= blocks.length) return stats;
            }
        } catch (nativeError) {
            if (debugMode) console.warn('[OneRingNative] timestamp bind failed, falling back to JS:', nativeError.message);
        }

        let recentRows = [];
        try {
            recentRows = db.getRecentMessagesByFrontend(
                agentName,
                frontendSource,
                Math.max(blocks.length * 4, 40),
                projectBasePath
            );
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Exact timestamp binding DB query failed:', e.message);
            return stats;
        }

        const usedExactIds = new Set(nativeBoundIds);
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

            if (!matched) continue;

            usedExactIds.add(matched.row.id);
            stats.boundTimestampsByIndex[block.index] = {
                dbId: matched.row.id,
                timestamp: matched.row.timestamp,
                senderName: matched.row.senderName,
                frontendSource: matched.row.frontendSource || frontendSource,
                source: matchSource
            };
        }

        return stats;
    }

    _recordSnapshotAppendBlocks(agentName, frontendSource, defaultUserName, newBlocks, nextTimestamp, threshold, newConversationStartUserIndex = -1) {
        const stats = { inserted: 0, updated: 0, fuzzyEdited: 0, exactBound: 0, boundTimestampsByIndex: {} };
        let newUserCount = 0;
        let newAssistantCount = 0;
        const blocks = Array.isArray(newBlocks) ? newBlocks : [];
        const usedExactIds = new Set();

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
        try {
            const snapshotRows = snapshot.loadSnapshot(agentName, frontendSource, projectBasePath);
            const lastMappedSnapshotRow = [...snapshotRows].reverse().find(row => row && row.dbId) || null;
            if (lastMappedSnapshotRow) {
                const anchorIndex = recentRows.findIndex(row => row.id === lastMappedSnapshotRow.dbId);
                if (anchorIndex >= 0) {
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
                const ts = nextTimestamp();
                const userResult = this._recordUserMessage(
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
                    source: 'snapshot-post'
                };
                newUserCount++;
                const recordMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                if (debugMode || recordMs >= 50) console.log(`[OneRingTiming] recordSnapshotAppendBlock role=user result=${userResult} ms=${recordMs.toFixed(1)} textLen=${String(block.text || '').length} index=${block.index}`);
            } else if (block.role === 'user') {
                const skipMs = Number(process.hrtime.bigint() - recordStart) / 1e6;
                if (debugMode || skipMs >= 50) console.log(`[OneRingTiming] skipSnapshotAppendNonTailUserNoExact role=user ms=${skipMs.toFixed(1)} textLen=${String(block.text || '').length} index=${block.index}`);
            } else if (block.role === 'assistant') {
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

    _syncRecordOnlyPostWithDb(agentName, frontendSource, defaultUserName, messages, nextTimestamp, threshold, precomputedPostBlocks = null, newConversationStartUserIndex = -1) {
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
                    const userResult = this._recordUserMessage(
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
                    const assistantStats = this._recordTailPostAssistantBatch(
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

        const systemMsg = messages.find(m => m.role === 'system');
        const systemText = systemMsg ? fuzzy.extractText(systemMsg.content) : '';
        const triggerMatch = getLastTriggerMatch(systemText);
        const noticeMatch = /\[OneRing系统已启动，当前Agent([\s\S]*?)，当前客户端([\s\S]*?)(?:，当前模式[\s\S]*?)?，所有上下文OneRing信息来源标记由系统生成无需你自动输出。\]/.exec(systemText);

        const agentName = attachedMeta?.agentName || (triggerMatch ? triggerMatch[1].trim() : null) || (noticeMatch ? noticeMatch[1].trim() : null);
        const frontendSourceFromTrigger = attachedMeta?.frontendSource || (triggerMatch ? triggerMatch[2].trim() : null) || (noticeMatch ? noticeMatch[2].trim() : null);
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

    /**
     * AI 回复入库（异步，fire-and-forget，供 Stream/NonStream handler 在最终回复完成后调用）。
     */
    async recordAIResponseFromMessages(messages, aiText) {
        const meta = this._extractMetaFromMessages(messages);
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

                try {
                    native.updateMessageById(projectBasePath, config, meta.agentName, responseId, aiText);
                } catch (nativeError) {
                    if (debugMode) console.warn(`[OneRingNative] assistant retry update cache failed dbId=${responseId}:`, nativeError.message);
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

                try {
                    native.updateMessageById(projectBasePath, config, meta.agentName, responseId, aiText);
                } catch (nativeError) {
                    if (debugMode) console.warn(`[OneRingNative] assistant retry update cache failed dbId=${responseId}:`, nativeError.message);
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
        const timing = createOneRingTimingProbe('record-assistant-message', { agentName, frontendSource });
        try {
            const recentRows = db.getRecentMessagesByFrontend(agentName, frontendSource, 12, projectBasePath);
            timing.mark('getRecentMessagesByFrontend', `rows=${recentRows.length}`);
            const recent = recentRows
                .filter(item => item.role === 'assistant')
                .slice(-1)[0];
            timing.mark('filterRecentAssistant', `hasRecent=${!!recent}`);

            if (recent) {
                const sim = fuzzy.similarity(cleanText, recent.content);
                timing.mark('similarityRecentAssistant', `sim=${sim.toFixed(4)} cleanLen=${String(cleanText || '').length} recentLen=${String(recent.content || '').length}`);
                if (sim >= threshold) {
                    db.updateMessageById(agentName, recent.id, cleanText, projectBasePath);
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
                content: cleanText,
                timestamp,
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            timing.mark('insertMessage', `contentLen=${String(cleanText || '').length}`);
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
    _recordUserMessage(agentName, frontendSource, senderName, cleanText, timestamp, threshold = 0.92, isNewConversationStart = false) {
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
                const sim = fuzzy.similarity(cleanText, recent.content);
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
        try {
            native.getEngine(projectBasePath, config);
            const status = native.getStatus();
            console.log(`[OneRing] Native engine status: available=${status.available}, loaded=${status.loaded}, error=${status.error || 'none'}`);
        } catch (e) {
            console.warn('[OneRing] Native engine initialization failed, JS fallback will be used:', e.message);
        }
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