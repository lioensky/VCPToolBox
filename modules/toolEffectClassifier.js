'use strict';

const COMMAND_EFFECT_OVERRIDES = Object.freeze({
    'ServerFileOperator:ListAllowedDirectories': {
        effectClass: 'read_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local directory capability discovery'],
        evidenceSources: ['command_override:ServerFileOperator:ListAllowedDirectories']
    },
    'ServerFileOperator:ReadFile': {
        effectClass: 'read_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local file read'],
        evidenceSources: ['command_override:ServerFileOperator:ReadFile']
    },
    'ServerFileOperator:WebReadFile': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for network-backed fetch that persists content onto local disk'],
        evidenceSources: ['command_override:ServerFileOperator:WebReadFile']
    },
    'ServerFileOperator:ListDirectory': {
        effectClass: 'read_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local directory listing'],
        evidenceSources: ['command_override:ServerFileOperator:ListDirectory']
    },
    'ServerFileOperator:FileInfo': {
        effectClass: 'read_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local file metadata read'],
        evidenceSources: ['command_override:ServerFileOperator:FileInfo']
    },
    'ServerFileOperator:SearchFiles': {
        effectClass: 'read_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local file search'],
        evidenceSources: ['command_override:ServerFileOperator:SearchFiles']
    },
    'ServerFileOperator:WriteFile': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local file write'],
        evidenceSources: ['command_override:ServerFileOperator:WriteFile']
    },
    'ServerFileOperator:WriteEscapedFile': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for escaped local file write'],
        evidenceSources: ['command_override:ServerFileOperator:WriteEscapedFile']
    },
    'ServerFileOperator:AppendFile': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local file append'],
        evidenceSources: ['command_override:ServerFileOperator:AppendFile']
    },
    'ServerFileOperator:EditFile': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local file overwrite'],
        evidenceSources: ['command_override:ServerFileOperator:EditFile']
    },
    'ServerFileOperator:CopyFile': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local file copy'],
        evidenceSources: ['command_override:ServerFileOperator:CopyFile']
    },
    'ServerFileOperator:CreateDirectory': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local directory creation'],
        evidenceSources: ['command_override:ServerFileOperator:CreateDirectory']
    },
    'ServerFileOperator:DownloadFile': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for downloading content onto local disk'],
        evidenceSources: ['command_override:ServerFileOperator:DownloadFile']
    },
    'ServerFileOperator:ApplyDiff': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local file diff application'],
        evidenceSources: ['command_override:ServerFileOperator:ApplyDiff']
    },
    'ServerFileOperator:UpdateHistory': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local chat history mutation'],
        evidenceSources: ['command_override:ServerFileOperator:UpdateHistory']
    },
    'ServerFileOperator:CreateCanvas': {
        effectClass: 'write_local',
        confidence: 'explicit',
        reasons: ['explicit command override for local canvas file creation'],
        evidenceSources: ['command_override:ServerFileOperator:CreateCanvas']
    },
    'ServerFileOperator:MoveFile': {
        effectClass: 'delete_or_destructive',
        confidence: 'explicit',
        reasons: ['explicit command override for local move that removes the source location'],
        evidenceSources: ['command_override:ServerFileOperator:MoveFile']
    },
    'ServerFileOperator:RenameFile': {
        effectClass: 'delete_or_destructive',
        confidence: 'explicit',
        reasons: ['explicit command override for local rename that mutates the source path identity'],
        evidenceSources: ['command_override:ServerFileOperator:RenameFile']
    },
    'ServerFileOperator:DeleteFile': {
        effectClass: 'delete_or_destructive',
        confidence: 'explicit',
        reasons: ['explicit command override for destructive file delete'],
        evidenceSources: ['command_override:ServerFileOperator:DeleteFile']
    }
});

const TOOL_EFFECT_DEFAULTS = Object.freeze({
    ServerSearchController: {
        effectClass: 'read_local',
        confidence: 'explicit',
        reasons: ['explicit tool default for local search'],
        evidenceSources: ['tool_default:ServerSearchController']
    },
    ServerCodeSearcher: {
        effectClass: 'read_local',
        confidence: 'explicit',
        reasons: ['explicit tool default for code search'],
        evidenceSources: ['tool_default:ServerCodeSearcher']
    },
    ServerPowerShellExecutor: {
        effectClass: 'execute_shell',
        confidence: 'explicit',
        reasons: ['shell execution surface remains powerful even for read-like commands'],
        evidenceSources: ['tool_default:ServerPowerShellExecutor']
    }
});

const EFFECT_CLASS_PRIORITY = Object.freeze({
    unknown: 0,
    ui_or_notification: 1,
    read_local: 2,
    read_external: 3,
    write_local: 4,
    write_external: 5,
    network_publish: 6,
    execute_shell: 7,
    credential_or_secret_touch: 8,
    delete_or_destructive: 9
});

function normalizeString(value) {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : null;
}

function buildResult(input = {}) {
    const requestedToolName = normalizeString(input.requestedToolName) || '';
    const canonicalToolName = normalizeString(input.canonicalToolName) || requestedToolName;
    const command = normalizeString(input.command);
    const effectClass = normalizeString(input.effectClass) || 'unknown';
    const confidence = normalizeString(input.confidence) || 'unknown';
    const reasons = Array.isArray(input.reasons) ? [...input.reasons] : [];
    const evidenceSources = Array.isArray(input.evidenceSources) ? [...input.evidenceSources] : [];

    return {
        requestedToolName,
        canonicalToolName,
        command,
        effectClass,
        effectConfidence: confidence,
        effectReasons: reasons,
        effectEvidenceSources: evidenceSources
    };
}

function extractCommands(toolArgs = {}) {
    if (!toolArgs || typeof toolArgs !== 'object') {
        return [];
    }

    const commands = [];
    const primaryCommand = normalizeString(toolArgs.command);
    if (primaryCommand) {
        commands.push(primaryCommand);
    }

    const numberedCommandKeys = Object.keys(toolArgs)
        .filter((key) => /^command\d+$/.test(key))
        .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));

    for (const key of numberedCommandKeys) {
        const normalizedCommand = normalizeString(toolArgs[key]);
        if (normalizedCommand) {
            commands.push(normalizedCommand);
        }
    }

    return [...new Set(commands)];
}

function getEffectPriority(effectClass) {
    return EFFECT_CLASS_PRIORITY[effectClass] ?? -1;
}

function chooseMoreRestrictiveResult(current, candidate) {
    if (!current) {
        return candidate;
    }

    const currentPriority = getEffectPriority(current.effectClass);
    const candidatePriority = getEffectPriority(candidate.effectClass);

    if (candidatePriority > currentPriority) {
        return candidate;
    }

    return current;
}

function classifyToolEffect(input = {}) {
    const approvalDecision = input.approvalDecision || {};
    const requestedToolName = normalizeString(approvalDecision.requestedToolName)
        || normalizeString(input.toolName)
        || '';
    const canonicalToolName = normalizeString(approvalDecision.canonicalToolName)
        || requestedToolName;
    const commands = extractCommands(input.toolArgs);
    let strongestCommandResult = null;

    for (const command of commands) {
        const commandKey = `${canonicalToolName}:${command}`;
        if (Object.prototype.hasOwnProperty.call(COMMAND_EFFECT_OVERRIDES, commandKey)) {
            const match = COMMAND_EFFECT_OVERRIDES[commandKey];
            strongestCommandResult = chooseMoreRestrictiveResult(
                strongestCommandResult,
                buildResult({
                    requestedToolName,
                    canonicalToolName,
                    command,
                    effectClass: match.effectClass,
                    confidence: match.confidence,
                    reasons: match.reasons,
                    evidenceSources: match.evidenceSources
                })
            );
            continue;
        }

        if (canonicalToolName === 'ServerFileOperator') {
            strongestCommandResult = chooseMoreRestrictiveResult(
                strongestCommandResult,
                buildResult({
                    requestedToolName,
                    canonicalToolName,
                    command,
                    effectClass: 'delete_or_destructive',
                    confidence: 'derived',
                    reasons: ['unmapped ServerFileOperator command remains conservative by default'],
                    evidenceSources: ['tool_family_default:ServerFileOperator']
                })
            );
        }
    }

    if (strongestCommandResult) {
        return strongestCommandResult;
    }

    if (Object.prototype.hasOwnProperty.call(TOOL_EFFECT_DEFAULTS, canonicalToolName)) {
        const match = TOOL_EFFECT_DEFAULTS[canonicalToolName];
        return buildResult({
            requestedToolName,
            canonicalToolName,
            command: commands[0] || null,
            effectClass: match.effectClass,
            confidence: match.confidence,
            reasons: match.reasons,
            evidenceSources: match.evidenceSources
        });
    }

    return buildResult({
        requestedToolName,
        canonicalToolName,
        command: commands[0] || null,
        effectClass: 'unknown',
        confidence: 'unknown',
        reasons: ['no explicit effect mapping for canonical tool or command'],
        evidenceSources: ['fallback:unknown']
    });
}

module.exports = {
    classifyToolEffect
};
