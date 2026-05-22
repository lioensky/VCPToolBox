'use strict';

const ALIAS_TO_CANONICAL = Object.freeze({
    PowerShellExecutor: 'ServerPowerShellExecutor',
    FileOperator: 'ServerFileOperator',
    LocalSearchController: 'ServerSearchController',
    VCPEverything: 'ServerSearchController',
    CodeSearcher: 'ServerCodeSearcher'
});

const CANONICAL_TO_ALIASES = Object.freeze(
    Object.entries(ALIAS_TO_CANONICAL).reduce((acc, [alias, canonical]) => {
        if (!acc[canonical]) {
            acc[canonical] = [];
        }
        acc[canonical].push(alias);
        return acc;
    }, {})
);

const KNOWN_CANONICAL_TOOL_NAMES = new Set(Object.values(ALIAS_TO_CANONICAL));

function normalizeToolName(toolName) {
    return typeof toolName === 'string' ? toolName.trim() : '';
}

function extractPrimaryCommand(toolArgs = {}) {
    if (!toolArgs || typeof toolArgs !== 'object') {
        return null;
    }

    const command = toolArgs.command;
    if (typeof command !== 'string') {
        return null;
    }

    const trimmed = command.trim();
    return trimmed || null;
}

function registryHas(pluginRegistry, toolName) {
    return Boolean(
        pluginRegistry &&
        typeof pluginRegistry.has === 'function' &&
        pluginRegistry.has(toolName)
    );
}

function getAliasesForCanonical(canonicalToolName) {
    const aliases = CANONICAL_TO_ALIASES[canonicalToolName];
    return aliases ? [...aliases] : [];
}

function resolveToolIdentity(input = {}) {
    const requestedToolName = normalizeToolName(input.requestedToolName);
    const command = extractPrimaryCommand(input.toolArgs);

    if (registryHas(input.pluginRegistry, requestedToolName) || KNOWN_CANONICAL_TOOL_NAMES.has(requestedToolName)) {
        return {
            requestedToolName,
            canonicalToolName: requestedToolName,
            registeredPluginName: requestedToolName,
            command,
            aliases: getAliasesForCanonical(requestedToolName),
            wasAlias: false,
            confidence: 'exact'
        };
    }

    const canonicalToolName = ALIAS_TO_CANONICAL[requestedToolName];
    if (canonicalToolName) {
        return {
            requestedToolName,
            canonicalToolName,
            registeredPluginName: canonicalToolName,
            command,
            aliases: getAliasesForCanonical(canonicalToolName),
            wasAlias: true,
            confidence: 'alias'
        };
    }

    return {
        requestedToolName,
        canonicalToolName: requestedToolName,
        registeredPluginName: null,
        command,
        aliases: [],
        wasAlias: false,
        confidence: 'unknown'
    };
}

module.exports = {
    ALIAS_TO_CANONICAL,
    CANONICAL_TO_ALIASES,
    getAliasesForCanonical,
    resolve: resolveToolIdentity,
    resolveToolIdentity
};
