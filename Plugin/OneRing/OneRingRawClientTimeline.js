'use strict';
// OneRingRawClientTimeline.js — 有包体客户端时间线策略。
// 负责 raw message index + raw sha256 hash + client timestamp 的权威绑定路径。

const db = require('./OneRingDB.js');
const fuzzy = require('./OneRingFuzzy.js');
const snapshot = require('./OneRingSnapshot.js');
const {
    rawSha256,
    findClientRawHashMatchVariant
} = require('./OneRingTimelineCommon.js');

function probeRawClientTimestampBindings(messages, bindingInfo, agentName, frontendSource, stage = 'raw-entry') {
    const clientBindings = Array.isArray(bindingInfo?.bindings) ? bindingInfo.bindings : [];
    if (!Array.isArray(messages) || clientBindings.length === 0) return;

    const stats = {
        total: clientBindings.length,
        rawMatched: 0,
        normalizedMatched: 0,
        missingIndex: 0,
        roleMismatch: 0,
        rawMissByRole: { user: 0, assistant: 0 },
        rawMatchedByRole: { user: 0, assistant: 0 },
        samples: []
    };

    for (const binding of clientBindings) {
        const message = messages[binding.index];
        if (!message) {
            stats.missingIndex++;
            continue;
        }
        if (message.role !== binding.role) {
            stats.roleMismatch++;
            continue;
        }

        const rawText = fuzzy.extractText(message.content);
        const rawHash = rawSha256(rawText);
        const normalizedHash = snapshot.contentHash(rawText);
        const variantMatch = findClientRawHashMatchVariant(rawText, binding.sentHash);
        const rawMatched = !!variantMatch;
        const normalizedMatched = normalizedHash === binding.sentHash;

        if (rawMatched) {
            stats.rawMatched++;
            stats.rawMatchedByRole[binding.role]++;
        } else {
            stats.rawMissByRole[binding.role]++;
        }
        if (normalizedMatched) stats.normalizedMatched++;

        if (!rawMatched && stats.samples.length < 5) {
            const tailCodes = [...rawText.slice(-12)].map(ch => ch.codePointAt(0).toString(16)).join(',');
            const head = JSON.stringify(rawText.slice(0, 40));
            const tail = JSON.stringify(rawText.slice(-40));
            stats.samples.push(
                `idx=${binding.index} role=${binding.role} client=${binding.sentHash.slice(0, 10)} raw=${rawHash.slice(0, 10)} norm=${normalizedHash.slice(0, 10)} rawLen=${rawText.length} tailCodes=[${tailCodes}] head=${head} tail=${tail}`
            );
        }
    }

    console.log(
        `[OneRingProbe] ${stage} client hash rawProbe agent="${agentName}" frontend="${frontendSource}" ` +
        `rawMatched=${stats.rawMatched}/${stats.total} normalizedMatched=${stats.normalizedMatched}/${stats.total} ` +
        `rawMatchedByRole=user:${stats.rawMatchedByRole.user},assistant:${stats.rawMatchedByRole.assistant} ` +
        `rawMissByRole=user:${stats.rawMissByRole.user},assistant:${stats.rawMissByRole.assistant} ` +
        `missingIndex=${stats.missingIndex} roleMismatch=${stats.roleMismatch}`
    );
    if (stats.samples.length > 0) {
        console.log(`[OneRingProbe] ${stage} raw mismatch samples: ${stats.samples.join(' | ')}`);
    }
}

const LEADING_SYSTEM_NOTICE_REGEX = /^\s*\[系统通知\][\s\S]*?\[系统通知结束\]\s*/;

function stripLeadingSystemNoticeText(text) {
    if (typeof text !== 'string') return '';
    let result = text;
    while (LEADING_SYSTEM_NOTICE_REGEX.test(result)) {
        result = result.replace(LEADING_SYSTEM_NOTICE_REGEX, '');
    }
    return result.trim();
}

class RawClientTimelineStrategy {
    constructor(options = {}) {
        this.bindingInfo = options.bindingInfo || { bindings: [] };
        this.projectBasePath = options.projectBasePath || '';
        this.debug = !!options.debug;
        this.classifyUserContent = options.classifyUserContent;
        this.classifyAssistantContent = options.classifyAssistantContent;
        this.discardPatterns = Array.isArray(options.discardPatterns) ? options.discardPatterns : [];
    }

    get kind() {
        return 'raw-client';
    }

    get hasClientTimestampTruth() {
        return (this.bindingInfo.bindings || []).length > 0;
    }

    _buildClientContextMap(messages, defaultUserName, agentName) {
        const records = [];
        const contextRecords = [];
        const sideRecords = [];
        let contextIndex = 0;
        let sideIndex = 0;

        if (!Array.isArray(messages)) {
            return { records, contextRecords, sideRecords };
        }

        messages.forEach((message, rawIndex) => {
            const role = message?.role || null;
            const rawText = fuzzy.extractText(message?.content);
            const baseRecord = {
                rawIndex,
                role,
                message,
                rawText,
                kind: 'side-other',
                contextIndex: null,
                sideIndex: null,
                hashText: '',
                dbText: '',
                classified: null,
                reason: null
            };

            if (!message || (role !== 'user' && role !== 'assistant')) {
                baseRecord.kind = role === 'system' ? 'side-system' : 'side-non-conversation';
                baseRecord.sideIndex = sideIndex++;
                baseRecord.reason = baseRecord.kind;
                records.push(baseRecord);
                sideRecords.push(baseRecord);
                return;
            }

            if (role === 'assistant') {
                const classified = this.classifyAssistantContent(message.content, agentName);
                if (!classified) {
                    baseRecord.kind = 'side-empty-assistant';
                    baseRecord.sideIndex = sideIndex++;
                    baseRecord.reason = 'empty-assistant';
                    records.push(baseRecord);
                    sideRecords.push(baseRecord);
                    return;
                }

                baseRecord.kind = 'context-assistant';
                baseRecord.contextIndex = contextIndex++;
                // hashText 只用于客户端 hash 绑定；剥离服务端多模态注入块，避免与前端原始安全 hash 失配。
                baseRecord.hashText = fuzzy.stripVcpMultimodalInfoForHash(rawText);
                baseRecord.dbText = classified.cleanText;
                baseRecord.classified = classified;
                records.push(baseRecord);
                contextRecords.push(baseRecord);
                return;
            }

            const strippedNoticeText = stripLeadingSystemNoticeText(rawText);
            const hasNoticePrefix = strippedNoticeText !== rawText.trim();
            const hashText = hasNoticePrefix ? strippedNoticeText : rawText;
            const shouldDropSystemUser = this.discardPatterns.some(pattern => pattern.test(strippedNoticeText || rawText));

            if (!strippedNoticeText.trim()) {
                baseRecord.kind = 'side-vcp-notice-user';
                baseRecord.sideIndex = sideIndex++;
                baseRecord.reason = 'empty-vcp-notice-user';
                records.push(baseRecord);
                sideRecords.push(baseRecord);
                return;
            }

            if (shouldDropSystemUser) {
                baseRecord.kind = 'side-pseudo-system-user';
                baseRecord.sideIndex = sideIndex++;
                baseRecord.reason = 'discard-pattern';
                records.push(baseRecord);
                sideRecords.push(baseRecord);
                return;
            }

            const classified = this.classifyUserContent(hashText, defaultUserName, agentName);
            if (!classified) {
                baseRecord.kind = 'side-unrecordable-user';
                baseRecord.sideIndex = sideIndex++;
                baseRecord.reason = 'unrecordable-user';
                records.push(baseRecord);
                sideRecords.push(baseRecord);
                return;
            }

            baseRecord.kind = hasNoticePrefix ? 'context-user-vcp-notice-prefix' : 'context-user';
            baseRecord.contextIndex = contextIndex++;
            // hashText 只用于客户端 hash 绑定；剥离服务端多模态注入块，避免与前端原始安全 hash 失配。
            baseRecord.hashText = fuzzy.stripVcpMultimodalInfoForHash(hashText);
            baseRecord.dbText = classified.cleanText;
            baseRecord.classified = classified;
            records.push(baseRecord);
            contextRecords.push(baseRecord);
        });

        return { records, contextRecords, sideRecords };
    }

    _matchClientBindingsToContextRecords(clientBindings, contextMap) {
        const usedRawIndexes = new Set();
        const matches = [];
        const unmatched = [];
        let noticePrefixUserMatched = 0;

        for (const binding of clientBindings) {
            const candidates = contextMap.contextRecords
                .map((record) => {
                    if (!record || usedRawIndexes.has(record.rawIndex)) return null;
                    if (record.role !== binding.role) return null;
                    const hashMatch = findClientRawHashMatchVariant(record.hashText, binding.sentHash);
                    if (!hashMatch) return null;

                    // binding.index 可能是 rawIndex，也可能是客户端压缩后的 contextIndex。
                    // 不提前假设；hash/time 才是真相源。排序只用于多候选歧义时稳定选最近的那个。
                    const rawDistance = Math.abs(record.rawIndex - binding.index);
                    const contextDistance = Math.abs(record.contextIndex - binding.index);
                    const exactRaw = record.rawIndex === binding.index ? 0 : 1;
                    const exactContext = record.contextIndex === binding.index ? 0 : 1;
                    return { record, hashMatch, rawDistance, contextDistance, exactRaw, exactContext };
                })
                .filter(Boolean)
                .sort((a, b) => {
                    if (a.exactRaw !== b.exactRaw) return a.exactRaw - b.exactRaw;
                    if (a.exactContext !== b.exactContext) return a.exactContext - b.exactContext;
                    if (a.rawDistance !== b.rawDistance) return a.rawDistance - b.rawDistance;
                    if (a.contextDistance !== b.contextDistance) return a.contextDistance - b.contextDistance;
                    return a.record.rawIndex - b.record.rawIndex;
                });

            const best = candidates[0] || null;
            if (!best) {
                unmatched.push(binding);
                continue;
            }

            usedRawIndexes.add(best.record.rawIndex);
            if (best.record.kind === 'context-user-vcp-notice-prefix') noticePrefixUserMatched++;
            matches.push({
                binding,
                record: best.record,
                hashMatch: best.hashMatch,
                matchMode: best.record.rawIndex === binding.index
                    ? 'raw-index'
                    : (best.record.contextIndex === binding.index ? 'context-index' : 'hash-search')
            });
        }

        return {
            matches,
            unmatched,
            noticePrefixUserMatched,
            conservativeContextRecords: contextMap.contextRecords.filter(record => !usedRawIndexes.has(record.rawIndex))
        };
    }

    probe(messages, agentName, frontendSource, stage = 'raw-authoritative') {
        const clientBindings = Array.isArray(this.bindingInfo?.bindings) ? this.bindingInfo.bindings : [];
        if (!Array.isArray(messages) || clientBindings.length === 0) return;

        const contextMap = this._buildClientContextMap(messages, 'Ryan', agentName);
        const matchResult = this._matchClientBindingsToContextRecords(clientBindings, contextMap);
        const stats = {
            total: clientBindings.length,
            rawMatched: matchResult.matches.length,
            normalizedMatched: 0,
            unmatched: matchResult.unmatched.length,
            rawMissByRole: { user: 0, assistant: 0 },
            rawMatchedByRole: { user: 0, assistant: 0 },
            noticePrefixUserMatched: matchResult.noticePrefixUserMatched,
            sideSkipped: contextMap.sideRecords.length,
            conservativeContext: matchResult.conservativeContextRecords.length,
            matchModeCounts: {},
            samples: []
        };

        for (const matched of matchResult.matches) {
            const { binding, record, matchMode } = matched;
            stats.rawMatchedByRole[binding.role]++;
            stats.matchModeCounts[matchMode] = (stats.matchModeCounts[matchMode] || 0) + 1;
            if (snapshot.contentHash(record.hashText) === binding.sentHash) stats.normalizedMatched++;
        }

        for (const binding of matchResult.unmatched) {
            stats.rawMissByRole[binding.role]++;
            if (stats.samples.length >= 5) continue;
            const sameRole = contextMap.contextRecords
                .filter(record => record.role === binding.role)
                .slice(0, 5)
                .map(record => `raw=${record.rawIndex}/ctx=${record.contextIndex}/kind=${record.kind}/hash=${rawSha256(record.hashText).slice(0, 10)}/len=${record.hashText.length}`)
                .join(',');
            stats.samples.push(`idx=${binding.index} role=${binding.role} client=${binding.sentHash.slice(0, 10)} sameRoleCandidates=[${sameRole}]`);
        }

        console.log(
            `[OneRingProbe] ${stage} client authoritative hash map agent="${agentName}" frontend="${frontendSource}" ` +
            `rawMatched=${stats.rawMatched}/${stats.total} normalizedMatched=${stats.normalizedMatched}/${stats.total} ` +
            `context=${contextMap.contextRecords.length} sideSkipped=${stats.sideSkipped} conservativeContext=${stats.conservativeContext} ` +
            `noticePrefixUserMatched=${stats.noticePrefixUserMatched} matchModes=${JSON.stringify(stats.matchModeCounts)} ` +
            `rawMatchedByRole=user:${stats.rawMatchedByRole.user},assistant:${stats.rawMatchedByRole.assistant} ` +
            `rawMissByRole=user:${stats.rawMissByRole.user},assistant:${stats.rawMissByRole.assistant} unmatched=${stats.unmatched}`
        );
        if (stats.samples.length > 0) {
            console.log(`[OneRingProbe] ${stage} unmatched hash samples: ${stats.samples.join(' | ')}`);
        }
    }

    bindRawMessages(agentName, frontendSource, messages, defaultUserName, source = 'client-verified-raw-hash', options = {}) {
        const stats = { boundTimestampsByIndex: {}, verifiedBindings: [] };
        const clientBindings = Array.isArray(this.bindingInfo?.bindings) ? this.bindingInfo.bindings : [];
        if (!Array.isArray(messages) || clientBindings.length === 0) return stats;

        const contextMap = this._buildClientContextMap(messages, defaultUserName, agentName);
        const matchResult = this._matchClientBindingsToContextRecords(clientBindings, contextMap);
        let unrecordable = 0;

        for (const matched of matchResult.matches) {
            const { binding, record, hashMatch, matchMode } = matched;
            const classified = record.classified;
            if (!classified) {
                unrecordable++;
                continue;
            }

            const senderName = classified.senderName || (record.role === 'assistant' ? agentName : '?');
            const verified = {
                ...binding,
                index: record.rawIndex,
                clientContextIndex: record.contextIndex,
                bindingIndex: binding.index,
                agentName,
                frontendSource,
                senderName,
                text: record.hashText,
                rawText: record.rawText,
                dbText: record.dbText,
                kind: record.kind,
                matchMode,
                hash: hashMatch.hash,
                hashVariant: hashMatch.variant,
                hashVariantAddedChars: hashMatch.addedChars
            };
            stats.verifiedBindings.push(verified);
            stats.boundTimestampsByIndex[record.rawIndex] = {
                timestamp: binding.timestamp,
                senderName,
                frontendSource,
                source: record.kind === 'context-user-vcp-notice-prefix'
                    ? `${source}-notice-stripped`
                    : source,
                messageId: binding.messageId || null,
                sentHash: binding.sentHash,
                hashVariant: hashMatch.variant,
                bindingIndex: binding.index,
                clientContextIndex: record.contextIndex,
                kind: record.kind,
                matchMode
            };
        }

        if (!options.suppressLog && (stats.verifiedBindings.length > 0 || matchResult.unmatched.length > 0 || unrecordable > 0)) {
            const modeCounts = matchResult.matches.reduce((acc, item) => {
                acc[item.matchMode] = (acc[item.matchMode] || 0) + 1;
                return acc;
            }, {});
            console.log(`[OneRing] Client timestamp authoritative hash map verified=${stats.verifiedBindings.length}/${clientBindings.length} context=${contextMap.contextRecords.length} sideSkipped=${contextMap.sideRecords.length} conservativeContext=${matchResult.conservativeContextRecords.length} noticePrefixUserMatched=${matchResult.noticePrefixUserMatched} unmatched=${matchResult.unmatched.length} unrecordable=${unrecordable} matchModes=${JSON.stringify(modeCounts)} agent="${agentName}" frontend="${frontendSource}"`);
        }

        return stats;
    }

    scheduleTimestampCorrections(agentName, frontendSource, verifiedBindings, reason = 'client-timestamp-correction') {
        const items = (Array.isArray(verifiedBindings) ? verifiedBindings : [])
            .filter(item => item && item.hash && item.role && item.timestamp && typeof item.dbText === 'string' && item.dbText.trim());

        if (items.length === 0) return;

        const run = () => {
            try {
                const conn = db.getDb(agentName, this.projectBasePath);
                const recentRows = db.getRecentMessagesByFrontend(
                    agentName,
                    frontendSource,
                    Math.max(items.length * 8, 80),
                    this.projectBasePath
                );
                const usedIds = new Set();
                let updated = 0;
                let inserted = 0;

                for (const item of items) {
                    const itemContentHash = snapshot.contentHash(item.dbText);
                    const matched = recentRows.find(row => {
                        if (!row || row.role !== item.role || usedIds.has(row.id)) return false;
                        return snapshot.contentHash(row.content) === itemContentHash;
                    });

                    if (matched) {
                        usedIds.add(matched.id);
                        if (matched.timestamp !== item.timestamp) {
                            db.updateMessageTimestampById(agentName, matched.id, item.timestamp, this.projectBasePath);
                            updated++;
                            if (this.debug) {
                                console.log(`[OneRing] Async authoritative client timestamp update reason=${reason} dbId=${matched.id} old="${matched.timestamp}" new="${item.timestamp}" role=${item.role} kind=${item.kind || 'context'}`);
                            }
                        }
                        continue;
                    }

                    db.insertMessage(agentName, {
                        role: item.role,
                        senderName: item.senderName || (item.role === 'assistant' ? agentName : '?'),
                        frontendSource,
                        content: item.dbText,
                        timestamp: item.timestamp
                    }, this.projectBasePath);
                    inserted++;
                    if (this.debug) {
                        console.log(`[OneRing] Async authoritative client context insert reason=${reason} role=${item.role} kind=${item.kind || 'context'} timestamp="${item.timestamp}" contentLen=${item.dbText.length}`);
                    }
                }

                if ((this.debug || inserted > 0 || updated > 0) && (inserted > 0 || updated > 0)) {
                    console.log(`[OneRing] Async authoritative client context DB sync reason=${reason} inserted=${inserted} timestampUpdated=${updated} agent="${agentName}" frontend="${frontendSource}"`);
                }

                void conn;
            } catch (e) {
                console.error(`[OneRing] Async client timestamp correction/upsert failed reason=${reason}:`, e.message);
            }
        };

        if (typeof setImmediate === 'function') {
            setImmediate(run);
        } else {
            setTimeout(run, 0);
        }
    }
}

module.exports = {
    RawClientTimelineStrategy,
    probeRawClientTimestampBindings
};