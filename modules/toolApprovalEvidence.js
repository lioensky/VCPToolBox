'use strict';

const { classifyToolEffect } = require('./toolEffectClassifier');
const { normalizeExecutionContext } = require('./toolExecutionContext');

const MAX_ARG_KEY_COUNT = 50;
const MAX_ARG_KEY_LENGTH = 80;
const MAX_ARRAY_PREVIEW_ITEMS = 5;

const SENSITIVE_ARG_KEY_PARTS = [
    'token',
    'apikey',
    'secret',
    'authorization',
    'cookie',
    'password',
    'passwd',
    'credential'
];

function normalizeString(value) {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : null;
}

function appendOptionalEvidenceField(target, source, key) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
        target[key] = source[key];
    }
}

function normalizeArgKey(key) {
    return String(key).replace(/[\s_-]/g, '').toLowerCase();
}

function isSensitiveArgKey(key) {
    const normalizedKey = normalizeArgKey(key);
    return SENSITIVE_ARG_KEY_PARTS.some((part) => normalizedKey.includes(part));
}

function limitArgKeyPath(keyPath) {
    return String(keyPath).slice(0, MAX_ARG_KEY_LENGTH);
}

function appendUniquePreviewKey(list, keyPath) {
    const limitedKeyPath = limitArgKeyPath(keyPath);
    if (!list.includes(limitedKeyPath)) {
        list.push(limitedKeyPath);
    }
}

function appendArgKey(preview, keyPath) {
    if (preview.truncated) {
        return;
    }

    const limitedKeyPath = limitArgKeyPath(keyPath);
    if (preview.argKeys.includes(limitedKeyPath)) {
        return;
    }

    if (preview.argKeys.length >= MAX_ARG_KEY_COUNT) {
        preview.truncated = true;
        return;
    }

    preview.argKeys.push(limitedKeyPath);
}

function joinArgKeyPath(parentPath, key) {
    const keyText = String(key);
    return parentPath ? `${parentPath}.${keyText}` : keyText;
}

function collectArgKeys(value, preview, parentPath = '', seen = new WeakSet()) {
    if (!value || typeof value !== 'object') {
        return;
    }

    if (seen.has(value)) {
        preview.hasCircular = true;
        return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
        const itemPath = parentPath ? `${parentPath}[]` : '[]';
        const previewItems = value.slice(0, MAX_ARRAY_PREVIEW_ITEMS);
        const arrayTruncated = value.length > MAX_ARRAY_PREVIEW_ITEMS;

        for (const item of previewItems) {
            collectArgKeys(item, preview, itemPath, seen);
            if (preview.truncated) {
                break;
            }
        }

        if (arrayTruncated) {
            preview.truncated = true;
        }

        seen.delete(value);
        return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
        const keyPath = joinArgKeyPath(parentPath, key);
        appendArgKey(preview, keyPath);

        if (isSensitiveArgKey(key)) {
            appendUniquePreviewKey(preview.redactedArgKeys, keyPath);
            preview.containsSensitiveKeys = true;
        } else {
            collectArgKeys(nestedValue, preview, keyPath, seen);
        }
    }

    seen.delete(value);
}

function buildApprovalArgsPreview(toolArgs) {
    const preview = {
        argumentType: toolArgs === null
            ? 'null'
            : (Array.isArray(toolArgs) ? 'array' : typeof toolArgs),
        argKeys: [],
        redactedArgKeys: [],
        containsSensitiveKeys: false,
        hasCommand: Boolean(toolArgs && typeof toolArgs === 'object'
            && Object.prototype.hasOwnProperty.call(toolArgs, 'command')),
        hasCircular: false,
        truncated: false
    };

    collectArgKeys(toolArgs, preview);

    return preview;
}

function buildToolApprovalEvidence(input = {}) {
    const approvalDecision = input.approvalDecision || {};
    const executionContext = normalizeExecutionContext(input.executionContext);
    const requestedToolName = normalizeString(approvalDecision.requestedToolName)
        || normalizeString(input.toolName);
    const canonicalToolName = normalizeString(approvalDecision.canonicalToolName)
        || requestedToolName;
    const evidence = {
        requestedToolName,
        canonicalToolName,
        matchedRule: normalizeString(approvalDecision.matchedRule),
        matchedCommand: normalizeString(approvalDecision.matchedCommand),
        wasAlias: approvalDecision.wasAlias === true,
        requestSource: executionContext.requestSource,
        agentAlias: executionContext.agentAlias,
        agentId: executionContext.agentId,
        requiresApproval: approvalDecision.requiresApproval === true,
        notifyAiOnReject: approvalDecision.notifyAiOnReject !== false
    };
    const effect = classifyToolEffect({
        toolName: requestedToolName,
        toolArgs: input.toolArgs,
        approvalDecision,
        executionContext
    });

    appendOptionalEvidenceField(evidence, executionContext, 'operatorId');
    appendOptionalEvidenceField(evidence, executionContext, 'bridgeId');
    appendOptionalEvidenceField(evidence, executionContext, 'taskId');
    appendOptionalEvidenceField(evidence, executionContext, 'invocationId');
    evidence.effect = effect;

    if (Object.prototype.hasOwnProperty.call(input, 'toolArgs')) {
        evidence.argsPreview = buildApprovalArgsPreview(input.toolArgs);
    }

    return evidence;
}

module.exports = {
    buildApprovalArgsPreview,
    buildToolApprovalEvidence,
    isSensitiveArgKey
};
