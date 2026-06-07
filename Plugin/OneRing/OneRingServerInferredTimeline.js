'use strict';
// OneRingServerInferredTimeline.js — 无 raw hash 包体客户端的服务端推断时间线策略。
// 负责可逆 working view、original/working index 映射、postBlocks hash binding 与恢复输出。

const fuzzy = require('./OneRingFuzzy.js');
const {
    rawSha256,
    findClientRawHashMatchVariant
} = require('./OneRingTimelineCommon.js');

class ServerInferredTimelineStrategy {
    constructor(options = {}) {
        this.bindingInfo = options.bindingInfo || { bindings: [] };
        this.debug = !!options.debug;
        this.discardPatterns = Array.isArray(options.discardPatterns) ? options.discardPatterns : [];
        this.sanitizeUserContentAtPipelineEntry = options.sanitizeUserContentAtPipelineEntry;
        this.hasUserTextContent = options.hasUserTextContent;
        this.markOneRingOriginalIndex = options.markOneRingOriginalIndex;
        this.getOneRingOriginalIndex = options.getOneRingOriginalIndex;
        this.markOneRingWorkingKey = options.markOneRingWorkingKey;
        this.getOneRingWorkingKey = options.getOneRingWorkingKey;
        this.isOneRingInjectedFromDb = options.isOneRingInjectedFromDb;
        this.getOneRingTimelineMeta = options.getOneRingTimelineMeta;
        this.getOneRingTailMeta = options.getOneRingTailMeta;
        this.cloneMessageWithOneRingMetadata = options.cloneMessageWithOneRingMetadata;
        this.upsertTailTag = options.upsertTailTag;
        this.attachMeta = options.attachMeta;
    }

    get kind() {
        return 'server-inferred';
    }

    get hasClientTimestampTruth() {
        return false;
    }

    // 注意：本策略没有 scheduleTimestampCorrections()。
    // 无 raw 包体时没有可被客户端 hash 权威校验的 timestamp truth，
    // 主流程通过 optional chaining 调用该能力；这里故意保持未实现以表达“不适用”。
    buildWorkingView(messages) {
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
                this.markOneRingOriginalIndex(workingMessage, originalIndex);
                this.markOneRingWorkingKey(workingMessage, originalKey);
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
            const sanitizedContent = this.sanitizeUserContentAtPipelineEntry(message.content);
            const sanitizedText = fuzzy.extractText(sanitizedContent);
            const shouldDropSystemPromptUser = this.discardPatterns.some(pattern => pattern.test(sanitizedText));

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

            if (!this.hasUserTextContent(sanitizedContent)) {
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
            const workingMessage = this.markOneRingWorkingKey(this.markOneRingOriginalIndex({ ...message, content: sanitizedContent }, originalIndex), originalKey);
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

        if (this.debug && (removedSystemUser > 0 || removedEmptyUser > 0 || strippedUserContent > 0)) {
            console.log(`[OneRing] Built reversible working view: removedSystem=${removedSystemUser}, removedEmpty=${removedEmptyUser}, stripped=${strippedUserContent}, original=${messages.length}, working=${workingMessages.length}`);
        }

        if (messages.__oneRingMeta && typeof this.attachMeta === 'function') {
            this.attachMeta(
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

    restoreWorkingViewToOriginalMessages(originalMessages, processedMessages, workingView) {
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
            const workingKey = this.getOneRingWorkingKey(message);
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

            const workingKey = this.getOneRingWorkingKey(message);

            if (this.isOneRingInjectedFromDb(message) || (workingKey && (workingKey.startsWith('z') || workingKey.startsWith('o')))) {
                queueInjected(message);
                continue;
            }

            let originalIndex = this.getOneRingOriginalIndex(message);
            if ((!Number.isInteger(originalIndex) || originalIndex < 0) && workingKey) {
                originalIndex = getOriginalIndexFromWorkingKey(workingKey);
            }

            if (!Number.isInteger(originalIndex) || originalIndex < 0 || originalIndex >= originalMessages.length) {
                continue;
            }

            flushPendingBefore(originalIndex);
            restored[originalIndex] = this.mergeProcessedMessageOntoOriginal(originalMessages[originalIndex], message);
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

        if (processedMessages.__oneRingMeta && typeof this.attachMeta === 'function') {
            this.attachMeta(
                result,
                processedMessages.__oneRingMeta.agentName,
                processedMessages.__oneRingMeta.frontendSource,
                { ...processedMessages.__oneRingMeta }
            );
        }

        try {
            Object.defineProperty(result, '__oneRingInjectedCount', {
                value: result.filter(message => this.isOneRingInjectedFromDb(message)).length,
                enumerable: false,
                configurable: true
            });
        } catch (e) {
            if (this.debug) console.warn('[OneRing] Failed to attach restored injected count:', e.message);
        }

        return result;
    }

    mergeProcessedMessageOntoOriginal(originalMessage, processedMessage) {
        if (!originalMessage || !processedMessage || originalMessage.role !== 'user') {
            return processedMessage;
        }

        const meta = this.getOneRingTimelineMeta(processedMessage) || this.getOneRingTailMeta(processedMessage.content);
        if (!meta) return originalMessage;

        return this.cloneMessageWithOneRingMetadata(originalMessage, {
            content: this.upsertTailTag(
                originalMessage.content,
                meta.senderName,
                meta.timestamp,
                meta.frontendSource,
                !!meta.isNewConversationStart
            )
        });
    }

    bindPostBlocks(agentName, frontendSource, postBlocks, source = 'client-verified-hash', options = {}) {
        const stats = { boundTimestampsByIndex: {}, verifiedBindings: [] };
        const blocks = Array.isArray(postBlocks) ? postBlocks : [];
        const clientBindings = Array.isArray(this.bindingInfo?.bindings) ? this.bindingInfo.bindings : [];
        if (blocks.length === 0 || clientBindings.length === 0) return stats;

        const blockByIndex = new Map(blocks.map(block => [block.index, block]));
        let hashMismatch = 0;
        let missingIndex = 0;
        let roleMismatch = 0;

        for (const binding of clientBindings) {
            const block = blockByIndex.get(binding.index);
            if (!block) {
                missingIndex++;
                continue;
            }
            if (block.role !== binding.role) {
                roleMismatch++;
                continue;
            }
            const hashMatch = findClientRawHashMatchVariant(block.text, binding.sentHash);
            if (!hashMatch) {
                hashMismatch++;
                continue;
            }
            const blockHash = hashMatch.hash;

            const verified = {
                ...binding,
                agentName,
                frontendSource,
                text: block.text,
                hash: blockHash,
                hashVariant: hashMatch.variant,
                hashVariantAddedChars: hashMatch.addedChars
            };
            stats.verifiedBindings.push(verified);
            stats.boundTimestampsByIndex[block.index] = {
                timestamp: binding.timestamp,
                senderName: block.senderName || (block.role === 'assistant' ? agentName : '?'),
                frontendSource,
                source,
                messageId: binding.messageId || null,
                sentHash: binding.sentHash,
                hashVariant: hashMatch.variant
            };
        }

        if (!options.suppressLog && (stats.verifiedBindings.length > 0 || hashMismatch > 0 || missingIndex > 0 || roleMismatch > 0)) {
            console.log(`[OneRing] Client timestamp hash binding verified=${stats.verifiedBindings.length}/${clientBindings.length} missingIndex=${missingIndex} roleMismatch=${roleMismatch} hashMismatch=${hashMismatch} agent="${agentName}" frontend="${frontendSource}"`);
            if (this.debug && hashMismatch > 0) {
                const mismatchSamples = clientBindings
                    .map(binding => {
                        const block = blockByIndex.get(binding.index);
                        if (!block || block.role !== binding.role) return null;
                        const serverHash = rawSha256(block.text);
                        const variantMatch = findClientRawHashMatchVariant(block.text, binding.sentHash);
                        return !variantMatch
                            ? `idx=${binding.index} role=${binding.role} client=${binding.sentHash.slice(0, 10)} server=${serverHash.slice(0, 10)} textLen=${String(block.text || '').length}`
                            : null;
                    })
                    .filter(Boolean)
                    .slice(0, 5);
                if (mismatchSamples.length > 0) {
                    console.log(`[OneRing] Client timestamp hash mismatch samples: ${mismatchSamples.join(' | ')}`);
                }
            }
        }

        return stats;
    }
}

module.exports = {
    ServerInferredTimelineStrategy
};