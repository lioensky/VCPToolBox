'use strict';
// OneRing.js — 统一上下文预处理器主模块
// 触发语法：系统提示词中包含 [[OneRing::AgentName::Frontend]]
// Only 模式：[[OneRing::AgentName::Frontend::Only]] 只入库/标记，不做跨端上下文追加。

const db = require('./OneRingDB.js');
const fuzzy = require('./OneRingFuzzy.js');

// ─── 触发语法解析 ────────────────────────────────────────────────────────────
const TRIGGER_REGEX = /\[\[OneRing::([^:]+?)::([^:\]]+?)(?:::([^\]]+?))?\]\]/;

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

function stripOneRingTailTagText(text) {
    return typeof text === 'string' ? text.replace(fuzzy.ONERING_TAIL_REGEX, '').trim() : '';
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
    const m = /\[OneRing通知:([\s\S]*?)于(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})发送于([\s\S]*?)\]\s*$/.exec(text);
    return m ? {
        senderName: m[1].trim(),
        timestamp: m[2].trim(),
        frontendSource: m[3].trim()
    } : null;
}

function hasOneRingTailTag(content) {
    return !!getOneRingTailMeta(content);
}

/**
 * 为消息附加 OneRing 尾部标记。
 * 只在 cleanText 末尾追加，不影响原消息开头，对下游处理透明。
 */
function appendTailTag(content, senderName, timestamp, frontendSource) {
    const tag = `\n[OneRing通知:${senderName}于${timestamp}发送于${frontendSource}]`;
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
function upsertTailTag(content, senderName, timestamp, frontendSource) {
    const tag = `[OneRing通知:${senderName}于${timestamp}发送于${frontendSource}]`;
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
function replaceTriggerWithNotice(content, triggerText, agentName, frontendSource, mode) {
    const modeNotice = mode ? `，当前模式${mode}` : '';
    const notice = `[OneRing系统已启动，当前Agent${agentName}，当前客户端${frontendSource}${modeNotice}，所有上下文OneRing信息来源标记由系统生成无需你自动输出。]`;

    if (typeof content === 'string') {
        return content.replace(triggerText, notice);
    }

    if (Array.isArray(content)) {
        let replaced = false;
        return content.map(part => {
            if (
                !replaced &&
                part &&
                part.type === 'text' &&
                typeof part.text === 'string' &&
                part.text.includes(triggerText)
            ) {
                replaced = true;
                return { ...part, text: part.text.replace(triggerText, notice) };
            }
            return part;
        });
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return { ...content, text: content.text.replace(triggerText, notice) };
    }

    return content;
}

// ─── 模块状态 ─────────────────────────────────────────────────────────────────
let config = {};
let projectBasePath = '';
let debugMode = false;

function getOneRingMaxDbRecords() {
    const value = parseInt(config.ONERING_MAX_DB_RECORDS ?? '100', 10);
    return Number.isFinite(value) ? value : 100;
}

/**
 * 生成 OneRing 使用的本地时间戳。
 * 必须与尾标、DB timestamp 完全一致；跨端补充依赖 YYYY-MM-DD HH:mm:ss 字符串排序和区间查询。
 */
function formatOneRingTimestamp(date = new Date()) {
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
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    } catch (e) {
        if (debugMode) console.warn(`[OneRing] Invalid DEFAULT_TIMEZONE="${timeZone}", fallback to local time:`, e.message);
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
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

class OneRingPreprocessor {
    async processMessages(messages, requestConfig) {
        const cfg = { ...config, ...requestConfig };
        const enabled = String(cfg.ONERING_ENABLED ?? 'true').toLowerCase() !== 'false';
        if (!enabled) return messages;

        // ── 1. 检测触发语法 ──────────────────────────────────────────────────
        const systemMsg = messages.find(m => m.role === 'system');
        if (!systemMsg) return messages;

        const systemText = fuzzy.extractText(systemMsg.content);
        const triggerMatch = TRIGGER_REGEX.exec(systemText);
        if (!triggerMatch) return messages;

        const agentName = triggerMatch[1].trim();
        const frontendSource = triggerMatch[2].trim();
        const triggerMode = (triggerMatch[3] || '').trim();
        const onlyMode = triggerMode.toLowerCase() === 'only';
        systemMsg.content = replaceTriggerWithNotice(systemMsg.content, triggerMatch[0], agentName, frontendSource, triggerMode);
        const defaultUserName = cfg.ONERING_USER_NAME || 'Ryan';
        const threshold = parseFloat(cfg.ONERING_DEDUP_SIMILARITY ?? '0.92');
        const maxUnknownRatio = parseFloat(cfg.ONERING_MAX_UNKNOWN_RATIO ?? '0.35');
        const allowPatch = String(cfg.ONERING_ALLOW_CONTEXT_PATCH ?? 'true').toLowerCase() !== 'false';
        const maxBlocks = parseInt(cfg.ONERING_MAX_CONTEXT_BLOCKS ?? '20', 10);
        const recordOnly = String(cfg.ONERING_RECORD_ONLY ?? 'true').toLowerCase() !== 'false';

        if (debugMode) console.log(`[OneRing] Triggered for agent="${agentName}" frontend="${frontendSource}"`);

        // ── 2. 提取本次 post 的 user/assistant 历史块（忽略 system）──────────
        const historyBlocks = messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => {
                const tailMeta = getOneRingTailMeta(m.content);
                return {
                    role: m.role,
                    text: fuzzy.extractText(m.content),
                    frontendSource: tailMeta?.frontendSource || null,
                    _msg: m
                };
            });

        if (historyBlocks.length === 0) return messages;

        if (onlyMode || recordOnly) {
            if (debugMode) {
                const reason = onlyMode ? 'trigger Only mode' : 'ONERING_RECORD_ONLY';
                console.log(`[OneRing] Record-only mode enabled by ${reason} for agent="${agentName}" frontend="${frontendSource}"`);
            }
            return this._processRecordOnlyMessages(
                messages,
                agentName,
                frontendSource,
                defaultUserName,
                threshold
            );
        }

        // ── 3. 从 DB 查询同信道历史，做 fuzzy diff ──────────────────────────
        let shouldTimeInsertPatch = false;
        let shouldRecentTopUp = false;
        let patchMessages = messages;
        let isFreshShortContext = false;

        try {
            const dbBlocks = db.getRecentMessagesByFrontend(agentName, frontendSource, maxBlocks * 2, projectBasePath);

            // 全新短上下文：DB 尚无同前端记录，且 post 内历史块很少。
            // 策略：新 user 先入库；若同 Agent 已有全局历史，再做保守补充。
            // 注意：长上下文无匹配时不补充；只有短新 user 场景可以尝试接入同 Agent 既有时间线。
            if (dbBlocks.length === 0 && historyBlocks.length <= 4) {
                isFreshShortContext = true;
                this._recordFreshShortContext(agentName, frontendSource, defaultUserName, historyBlocks, threshold);
                if (allowPatch) {
                    patchMessages = this._doFreshShortContextPatch(messages, agentName, frontendSource, maxBlocks);
                }
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

                if (unknownRatio <= maxUnknownRatio && patchSafe) {
                    // 只有可靠 diff 才更新被编辑的历史消息；极短新 post 只允许补上下文，不允许误覆盖旧 DB。
                    if (diffResult.reliable) {
                        for (const edited of diffResult.editedBlocks) {
                            db.updateMessageById(agentName, edited.dbId, edited.newText, projectBasePath);
                            if (debugMode) console.log(`[OneRing] Updated edited block dbId=${edited.dbId}`);
                        }
                    }
                    // 允许跨端补充
                    if (allowPatch) {
                        // 与 fresh 分支保持一致：只要允许上下文补充，就持续用最近全局历史补齐。
                        // 否则默认 ONERING_RECORD_ONLY=true 会导致“PC 首轮有手机上下文，第二轮以后消失”。
                        shouldRecentTopUp = true;
                        if (String(cfg.ONERING_TIME_INSERT ?? 'true').toLowerCase() !== 'false') {
                            shouldTimeInsertPatch = true;
                        }
                    }
                } else {
                    if (debugMode) console.log(`[OneRing] Unknown ratio too high or unreliable diff, skipping patch.`);
                }
            }
        } catch (e) {
            console.error('[OneRing] DB diff error, skipping patch:', e.message);
        }

        // ── 4. 跨端补充（时间戳插入 + 最近历史补齐）────────────────────────
        if (shouldTimeInsertPatch || shouldRecentTopUp) {
            try {
                if (shouldTimeInsertPatch && historyBlocks.length >= 2) {
                    patchMessages = await this._doCrossFrontendPatch(
                        messages, agentName, frontendSource, maxBlocks
                    );
                }
                if (shouldRecentTopUp) {
                    patchMessages = this._doRecentContextTopUp(
                        patchMessages, agentName, frontendSource, maxBlocks
                    );
                }
            } catch (e) {
                console.error('[OneRing] Patch error, using original messages:', e.message);
                patchMessages = messages;
            }
        }

        // ── 5. 为当前 post 的 user/assistant 历史块补齐尾部标记 ───────────────
        // 关键原因：AI 回复入库是异步 DB 写入，不会回写给前端历史；
        // 下一轮前端带回来的 assistant 历史可能没有 OneRing 标记，因此这里必须补标。
        const now = formatOneRingTimestamp();
        const realUserEntries = [...patchMessages].map((m, i) => ({ m, i }))
            .filter(({ m }) => m && m.role === 'user')
            .map(({ m, i }) => ({
                m,
                i,
                classified: classifyUserContent(m.content, defaultUserName, agentName)
            }))
            .filter(({ classified }) => !!classified);

        const lastRealUserIdx = realUserEntries.pop();

        if (lastRealUserIdx && !isFreshShortContext) {
            this._recordUserMessage(
                agentName,
                frontendSource,
                lastRealUserIdx.classified.senderName,
                lastRealUserIdx.classified.cleanText,
                now,
                threshold
            );
        }

        if (!isFreshShortContext) {
            this._recordIncomingAssistantContext(
                agentName,
                frontendSource,
                patchMessages,
                now,
                threshold
            );
        }

        patchMessages = patchMessages.map((m) => {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return m;

            const existingMeta = getOneRingTailMeta(m.content);
            if (m.role === 'assistant') {
                const classifiedAssistant = classifyUserContent(m.content, agentName, agentName);
                if (!classifiedAssistant) return m;

                if (
                    existingMeta &&
                    existingMeta.senderName === classifiedAssistant.senderName &&
                    existingMeta.frontendSource === frontendSource
                ) return m;

                return {
                    ...m,
                    content: upsertTailTag(m.content, classifiedAssistant.senderName, existingMeta?.timestamp || now, frontendSource)
                };
            }

            const classified = classifyUserContent(m.content, defaultUserName, agentName);
            if (!classified) return m;

            if (
                existingMeta &&
                existingMeta.senderName === classified.senderName &&
                existingMeta.frontendSource === frontendSource
            ) return m;

            return {
                ...m,
                content: upsertTailTag(m.content, classified.senderName, existingMeta?.timestamp || now, frontendSource)
            };
        });

        try {
            Object.defineProperty(patchMessages, '__oneRingMeta', {
                value: { agentName, frontendSource },
                enumerable: false,
                configurable: true
            });
        } catch (e) {
            if (debugMode) console.warn('[OneRing] Failed to attach non-enumerable meta:', e.message);
        }

        return patchMessages;
    }

    /**
     * 跨端时间戳插入：在 post 的相邻消息时间戳之间，查询其他前端的消息并插入。
     */
    async _doCrossFrontendPatch(messages, agentName, frontendSource, maxBlocks) {
        // 从尾部标记中提取时间戳（已入库的历史消息上应有 OneRing 尾部标记）
        const getTs = (content) => {
            const text = fuzzy.extractText(content);
            const m = /\[OneRing通知:[\s\S]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[\s\S]*?\]/.exec(text);
            return m ? m[1] : null;
        };

        const histMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant');
        if (histMsgs.length < 2) return messages;

        let insertions = []; // { afterIndex, message }

        for (let i = 0; i < histMsgs.length - 1; i++) {
            const tsA = getTs(histMsgs[i].content);
            const tsB = getTs(histMsgs[i + 1].content);
            if (!tsA || !tsB) continue;

            const crossMsgs = db.getMessagesBetweenTimestamps(agentName, tsA, tsB, frontendSource, this._projectBasePath);
            for (const cm of crossMsgs) {
                const tag = `\n[OneRing通知:${cm.senderName || '?'}于${cm.timestamp}发送于${cm.frontendSource || '?'}]`;
                insertions.push({
                    afterOriginalIndex: messages.indexOf(histMsgs[i]),
                    message: { role: cm.role, content: cm.content + tag }
                });
            }
        }

        if (insertions.length === 0) return messages;

        // 应用插入，同时检查总块数不超过 maxBlocks
        let result = [...messages];
        let insertOffset = 0;
        for (const ins of insertions) {
            if (result.filter(m => m.role === 'user' || m.role === 'assistant').length >= maxBlocks) break;
            result.splice(ins.afterOriginalIndex + 1 + insertOffset, 0, ins.message);
            insertOffset++;
        }
        return result;
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

    _processRecordOnlyMessages(messages, agentName, frontendSource, defaultUserName, threshold) {
        const now = formatOneRingTimestamp();
        let result = Array.isArray(messages) ? [...messages] : messages;

        this._syncRecordOnlyPostWithDb(agentName, frontendSource, defaultUserName, result, now, threshold);

        result = result.map((m) => {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return m;

            const existingMeta = getOneRingTailMeta(m.content);
            if (m.role === 'assistant') {
                const classifiedAssistant = classifyUserContent(m.content, agentName, agentName);
                if (!classifiedAssistant) return m;

                if (
                    existingMeta &&
                    existingMeta.senderName === classifiedAssistant.senderName &&
                    existingMeta.frontendSource === frontendSource
                ) return m;

                return {
                    ...m,
                    content: upsertTailTag(m.content, classifiedAssistant.senderName, existingMeta?.timestamp || now, frontendSource)
                };
            }

            const classified = classifyUserContent(m.content, defaultUserName, agentName);
            if (!classified) return m;

            if (
                existingMeta &&
                existingMeta.senderName === classified.senderName &&
                existingMeta.frontendSource === frontendSource
            ) return m;

            return {
                ...m,
                content: upsertTailTag(m.content, classified.senderName, existingMeta?.timestamp || now, frontendSource)
            };
        });

        return this._attachMeta(result, agentName, frontendSource);
    }

    _syncRecordOnlyPostWithDb(agentName, frontendSource, defaultUserName, messages, timestamp, threshold) {
        if (!Array.isArray(messages)) return;

        const postBlocks = messages
            .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
            .map(m => {
                const tailMeta = getOneRingTailMeta(m.content);
                const rawText = fuzzy.extractText(m.content);
                if (m.role === 'user') {
                    const classified = classifyUserContent(rawText, defaultUserName, agentName);
                    if (!classified) return null;
                    return {
                        role: m.role,
                        text: classified.cleanText,
                        senderName: classified.senderName,
                        frontendSource: tailMeta?.frontendSource || null
                    };
                }
                const classified = classifyUserContent(rawText, agentName, agentName);
                if (!classified) return null;
                return {
                    role: m.role,
                    text: classified.cleanText,
                    senderName: classified.senderName,
                    frontendSource: tailMeta?.frontendSource || null
                };
            })
            .filter(Boolean)
            .filter(block => !block.frontendSource || block.frontendSource === frontendSource)
            .filter(block => block.text);

        if (postBlocks.length === 0) return;

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
                if (debugMode) console.log(`[OneRing] Only mode updated edited block dbId=${edited.dbId}`);
            }

            for (const block of diffResult.newBlocks) {
                if (block.role === 'user') {
                    db.insertMessage(agentName, {
                        role: 'user',
                        senderName: block.senderName || defaultUserName,
                        frontendSource,
                        content: block.text,
                        timestamp,
                        maxRecords: getOneRingMaxDbRecords(),
                    }, projectBasePath);
                } else if (block.role === 'assistant') {
                    this._recordAssistantMessage(agentName, frontendSource, block.text, timestamp, threshold, block.senderName || agentName);
                }
            }

            // 单条/极短 post 在低相似度下会被 diff 保守标为 unknown。
            // Only 模式以最终 post 为真相，因此兜底记录最后一个 user，避免新消息漏记。
            if (diffResult.unknownCount > 0 && postBlocks.length <= 2) {
                const lastUser = [...postBlocks].reverse().find(block => block.role === 'user');
                if (lastUser) {
                    this._recordUserMessage(
                        agentName,
                        frontendSource,
                        lastUser.senderName || defaultUserName,
                        lastUser.text,
                        timestamp,
                        threshold
                    );
                }
            }
        } catch (e) {
            console.error('[OneRing] Only mode DB sync failed:', e.message);
        }
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
        const triggerMatch = TRIGGER_REGEX.exec(systemText);
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
     * 最近上下文补齐。
     * 时间戳夹缝插入只能补「两个已有尾标时间之间」的跨端消息；
     * 当前端已经有少量同端 DB 后，第三轮等短上下文不会再走 fresh 分支，
     * 因此需要在可靠 diff 后继续用全局最近历史补到 maxBlocks。
     */
    _doRecentContextTopUp(messages, agentName, frontendSource, maxBlocks) {
        const currentBlocks = messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
        const remaining = Math.max(0, maxBlocks - currentBlocks);
        if (remaining <= 0) return mergeConversationByOneRingTimestamp(messages);

        const seen = new Set(messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role}:${fuzzy.normalize(fuzzy.extractText(m.content))}`)
        );

        let candidates = [];
        try {
            candidates = db.getRecentMessages(agentName, maxBlocks * 3, projectBasePath)
                .filter(item => {
                    const key = `${item.role}:${fuzzy.normalize(item.content)}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .slice(-remaining);
        } catch (e) {
            console.error('[OneRing] Recent context top-up query failed:', e.message);
            return messages;
        }

        if (candidates.length === 0) return mergeConversationByOneRingTimestamp(messages);

        const padded = candidates.map(item => ({
            role: item.role,
            content: `${item.content}\n[OneRing通知:${item.senderName || item.agentName || '?'}于${item.timestamp}发送于${item.frontendSource || '?'}]`
        }));

        return mergeConversationByOneRingTimestamp([...messages, ...padded]);
    }

    /**
     * 全新短上下文补充。
     * 当当前前端尚无历史、post 很短时，从同 Agent 的全局最近消息中取历史垫片，
     * 插入到最后一个 user 之前，让全新对话也能接上统一时间线。
     */
    _doFreshShortContextPatch(messages, agentName, frontendSource, maxBlocks) {
        const currentBlocks = messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
        const remaining = Math.max(0, maxBlocks - currentBlocks);
        if (remaining <= 0) return mergeConversationByOneRingTimestamp(messages);

        let candidates = [];
        const seenFresh = new Set(messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role}:${fuzzy.normalize(fuzzy.extractText(m.content))}`));
        try {
            candidates = db.getRecentMessages(agentName, remaining * 2, projectBasePath)
                .filter(item => {
                    const key = `${item.role}:${fuzzy.normalize(item.content)}`;
                    if (seenFresh.has(key)) return false;
                    seenFresh.add(key);
                    return true;
                })
                .slice(-remaining);
        } catch (e) {
            console.error('[OneRing] Fresh short context patch query failed:', e.message);
            return messages;
        }

        if (candidates.length === 0) return mergeConversationByOneRingTimestamp(messages);

        const padded = candidates.map(item => ({
            role: item.role,
            content: `${item.content}\n[OneRing通知:${item.senderName || item.agentName || '?'}于${item.timestamp}发送于${item.frontendSource || '?'}]`
        }));

        return mergeConversationByOneRingTimestamp([...messages, ...padded]);
    }

    /**
     * 全新短上下文入库。
     * 用于 user/assistant 块都很少、同前端 DB 为空的初次对话场景。
     * 记录 post 中已经存在的真实块；跨端补充由 _doFreshShortContextPatch 负责。
     */
    _recordFreshShortContext(agentName, frontendSource, defaultUserName, historyBlocks, threshold = 0.92) {
        const now = formatOneRingTimestamp();
        for (const block of historyBlocks) {
            if (block.role === 'user') {
                const classified = classifyUserContent(block.text, defaultUserName, agentName);
                if (!classified) continue;
                this._recordUserMessage(
                    agentName,
                    frontendSource,
                    classified.senderName,
                    classified.cleanText,
                    now,
                    threshold
                );
            } else if (block.role === 'assistant' && typeof block.text === 'string' && block.text.trim()) {
                const classifiedAssistant = classifyUserContent(block.text, agentName, agentName);
                if (!classifiedAssistant) continue;
                this._recordAssistantMessage(
                    agentName,
                    frontendSource,
                    classifiedAssistant.cleanText,
                    now,
                    threshold,
                    classifiedAssistant.senderName
                );
            }
        }
    }

    _recordIncomingAssistantContext(agentName, frontendSource, messages, timestamp, threshold = 0.92) {
        if (!Array.isArray(messages)) return;

        for (const m of messages) {
            if (!m || m.role !== 'assistant') continue;

            const classified = classifyUserContent(m.content, agentName, agentName);
            if (!classified) continue;

            // 群聊/AA 中 assistant role 可能承载别的 Agent 发言，必须入库给 OneRing 时间线。
            // 纯 Direct assistant 默认由 final callback 记录，避免当前目标 AI 的回复被重复同步。
            if (classified.source === 'Direct' && classified.senderName === agentName) continue;

            this._recordAssistantMessage(
                agentName,
                frontendSource,
                classified.cleanText,
                timestamp,
                threshold,
                classified.senderName
            );
        }
    }

    _recordAssistantMessage(agentName, frontendSource, cleanText, timestamp, threshold = 0.92, senderName = agentName) {
        try {
            const recent = db.getRecentMessagesByFrontend(agentName, frontendSource, 12, projectBasePath)
                .filter(item => item.role === 'assistant')
                .slice(-1)[0];

            if (recent && fuzzy.similarity(cleanText, recent.content) >= threshold) {
                db.updateMessageById(agentName, recent.id, cleanText, projectBasePath);
                if (debugMode) console.log(`[OneRing] Updated recent assistant message dbId=${recent.id}`);
                return;
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
        } catch (e) {
            console.error('[OneRing] Failed to record assistant message:', e.message);
        }
    }

    /**
     * user 发言入库（在 processMessages 内部确认要入库时调用）。
     * 最近同前端 user 块高度相似时执行 UPDATE，避免 retry / 重新发送导致重复写入。
     */
    _recordUserMessage(agentName, frontendSource, senderName, cleanText, timestamp, threshold = 0.92) {
        try {
            const recent = db.getRecentMessagesByFrontend(agentName, frontendSource, 12, projectBasePath)
                .filter(item => item.role === 'user')
                .slice(-1)[0];

            if (recent && fuzzy.similarity(cleanText, recent.content) >= threshold) {
                db.updateMessageById(agentName, recent.id, cleanText, projectBasePath);
                if (debugMode) console.log(`[OneRing] Updated recent user message dbId=${recent.id}`);
                return;
            }

            db.insertMessage(agentName, {
                role: 'user',
                senderName,
                frontendSource,
                content: cleanText,
                timestamp,
                maxRecords: getOneRingMaxDbRecords(),
            }, projectBasePath);
            if (debugMode) console.log(`[OneRing] Recorded user message for agent=${agentName}, sender=${senderName}, frontend=${frontendSource}`);
        } catch (e) {
            console.error('[OneRing] Failed to record user message:', e.message);
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
        console.log(`[OneRing] Initialized. agent-scoped SQLite at ${projectBasePath}/Plugin/OneRing/data/`);
    }

    shutdown() {
        db.closeAll();
        console.log('[OneRing] Shutdown, all DB connections closed.');
    }
}

module.exports = new OneRingPreprocessor();