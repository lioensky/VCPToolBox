'use strict';
// OneRingTimelineCommon.js — OneRing 时间线策略公共工具。
// 这里集中放置客户端 raw hash、binding 解析、时间戳绑定合并等纯函数，
// 让 OneRing.js 不再把“客户端时间真相”和“服务端推断时间线”的公共协议散落在主流程中。

const crypto = require('crypto');

function rawSha256(text) {
    return crypto.createHash('sha256').update(typeof text === 'string' ? text : '').digest('hex');
}

function normalizeClientSentHash(hash) {
    if (typeof hash !== 'string') return '';
    const trimmed = hash.trim().toLowerCase();
    const normalized = trimmed.startsWith('sha256:') ? trimmed.slice(7) : trimmed;
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

function findClientRawHashMatchVariant(text, sentHash) {
    const rawText = typeof text === 'string' ? text : '';
    const targetHash = normalizeClientSentHash(sentHash);
    if (!targetHash) return null;

    const trimEndWhitespaceText = rawText.replace(/[\s\u00a0\u3000]+$/u, '');
    const trailingWhitespaceSuffixes = [
        ' ',
        '  ',
        '   ',
        '\t',
        '\u00a0',
        '\u3000',
        '\n',
        '\n\n',
        '\r\n',
        '\r\n\r\n',
        ' \n',
        ' \r\n',
        '\u00a0\n',
        '\u3000\n'
    ];

    const variants = [
        { text: rawText, variant: 'raw' },
        // VCPChat 文本框/渲染层偶发只在末尾多/少空白；
        // 这里仅容忍尾部空白差异，不折叠正文内部空格，避免破坏 raw hash 权威性。
        { text: trimEndWhitespaceText, variant: 'trim-end-whitespace' },
        ...trailingWhitespaceSuffixes.flatMap((suffix) => ([
            { text: `${rawText}${suffix}`, variant: `append-trailing-ws-${JSON.stringify(suffix)}` },
            { text: `${trimEndWhitespaceText}${suffix}`, variant: `trim-end-then-append-trailing-ws-${JSON.stringify(suffix)}` }
        ]))
    ];

    for (const candidate of variants) {
        const hash = rawSha256(candidate.text);
        if (hash === targetHash) {
            return {
                hash,
                variant: candidate.variant,
                addedChars: candidate.text.length - rawText.length
            };
        }
    }

    return null;
}

function getClientTimestampBindingsFromConfig(cfg = {}, formatTimestamp) {
    const ext = cfg && typeof cfg === 'object' ? cfg.vcpchatExtensions : null;
    const bindings = ext && Array.isArray(ext.messageTimestampBindings)
        ? ext.messageTimestampBindings
        : [];
    if (bindings.length === 0) return { schemaVersion: null, messageMetadataMode: null, rawCount: 0, bindings: [] };

    const valid = bindings
        .map((binding) => {
            if (!binding || typeof binding !== 'object') return null;
            const role = binding.role === 'user' || binding.role === 'assistant' ? binding.role : null;
            const index = Number(binding.sentMessageIndex);
            const timestampMs = Number(binding.timestamp);
            const sentHash = normalizeClientSentHash(binding.sentMessageHash);
            if (!role || !Number.isInteger(index) || index < 0 || !Number.isFinite(timestampMs) || timestampMs <= 0 || !sentHash) {
                return null;
            }
            return {
                messageId: typeof binding.messageId === 'string' ? binding.messageId : null,
                role,
                index,
                timestampMs,
                timestamp: typeof formatTimestamp === 'function'
                    ? formatTimestamp(new Date(timestampMs), true)
                    : new Date(timestampMs).toISOString(),
                timestampIso: typeof binding.timestampIso === 'string' ? binding.timestampIso : null,
                source: typeof binding.source === 'string' ? binding.source : 'client',
                sentHash
            };
        })
        .filter(Boolean);

    return {
        schemaVersion: ext?.schemaVersion ?? null,
        messageMetadataMode: ext?.messageMetadataMode || null,
        rawCount: bindings.length,
        bindings: valid
    };
}

function mergeTimestampBindings(...bindingMaps) {
    return bindingMaps.reduce((merged, map) => ({
        ...merged,
        ...(map || {})
    }), {});
}

module.exports = {
    rawSha256,
    normalizeClientSentHash,
    findClientRawHashMatchVariant,
    getClientTimestampBindingsFromConfig,
    mergeTimestampBindings
};