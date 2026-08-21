'use strict';

const DEFAULT_HEARTBEAT_DELAY_SECONDS = 2;

const PROTECTED_REGION_MARKERS = [
    {
        start: '<<<[TOOL_REQUEST]>>>',
        end: '<<<[END_TOOL_REQUEST]>>>',
        caseInsensitive: true
    },
    {
        start: '[[VCP调用结果信息汇总',
        end: 'VCP调用结果结束]]',
        caseInsensitive: false
    }
];

const FLOWLOCK_PATTERNS = {
    complete: /\[\[Flowlock::Complete\]\]/i,
    fail: /\[\[Flowlock::Fail\]\]/i,
    stop: /\[\[Flowlock::Stop\]\]/i,
    start: /\[\[Flowlock::Start\]\]/i,
    heartbeat: /\[\[Flowlock::NextHeartbeat::(\d+)\]\]/ig,
    nextPrompt: /\[\[Flowlock::NextPrompt\]\]([\s\S]*?)\[\[\/Flowlock::NextPrompt\]\]/ig,
    any: /\[\[\/?Flowlock::/i,
    legacyComplete: /\[\[TaskComplete(?:\s*\]\]|\s[\s\S]*?\]\])/i,
    legacyFail: /\[\[TaskFailed(?:\s*\]\]|\s[\s\S]*?\]\])/i,
    legacyHeartbeat: /\[\[NextHeartbeat::(\d+)\]\]/ig
};

function findMarkerIndex(source, marker, fromIndex, caseInsensitive) {
    if (!caseInsensitive) {
        return source.indexOf(marker, fromIndex);
    }
    return source.toLowerCase().indexOf(marker.toLowerCase(), fromIndex);
}

function findNextProtectedRegion(source, fromIndex) {
    let nextRegion = null;

    for (const marker of PROTECTED_REGION_MARKERS) {
        const startIndex = findMarkerIndex(source, marker.start, fromIndex, marker.caseInsensitive);
        if (startIndex === -1 || (nextRegion && startIndex >= nextRegion.startIndex)) {
            continue;
        }

        const endMarkerIndex = findMarkerIndex(
            source,
            marker.end,
            startIndex + marker.start.length,
            marker.caseInsensitive
        );

        nextRegion = {
            startIndex,
            endIndex: endMarkerIndex === -1
                ? source.length
                : endMarkerIndex + marker.end.length
        };
    }

    return nextRegion;
}

function mapUnprotectedRegions(text, transformUnprotected, transformProtected) {
    const source = String(text || '');
    const chunks = [];
    let cursor = 0;

    while (cursor < source.length) {
        const region = findNextProtectedRegion(source, cursor);
        if (!region) {
            chunks.push(transformUnprotected(source.slice(cursor)));
            break;
        }

        if (region.startIndex > cursor) {
            chunks.push(transformUnprotected(source.slice(cursor, region.startIndex)));
        }

        chunks.push(transformProtected(source.slice(region.startIndex, region.endIndex)));
        cursor = region.endIndex;
    }

    return chunks.join('');
}

function maskProtectedProtocolRegions(text) {
    return mapUnprotectedRegions(
        text,
        chunk => chunk,
        chunk => chunk.replace(/[^\r\n]/g, ' ')
    );
}

function getLastPositiveIntegerMatch(text, pattern) {
    pattern.lastIndex = 0;
    let match;
    let value = null;

    while ((match = pattern.exec(text)) !== null) {
        const candidate = Number.parseInt(match[1], 10);
        if (Number.isSafeInteger(candidate) && candidate > 0) {
            value = candidate;
        }
    }

    pattern.lastIndex = 0;
    return value;
}

function getLastPromptMatch(text) {
    FLOWLOCK_PATTERNS.nextPrompt.lastIndex = 0;
    let match;
    let prompt = null;

    while ((match = FLOWLOCK_PATTERNS.nextPrompt.exec(text)) !== null) {
        const candidate = String(match[1] || '').trim();
        if (candidate) {
            prompt = candidate;
        }
    }

    FLOWLOCK_PATTERNS.nextPrompt.lastIndex = 0;
    return prompt;
}

function stripDirectivesFromUnprotectedChunk(chunk) {
    return chunk
        .replace(/\[\[Flowlock::(?:Complete|Fail|Stop|Start)\]\]/ig, '')
        .replace(/\[\[Flowlock::NextHeartbeat::\d+\]\]/ig, '')
        .replace(/\[\[Flowlock::NextPrompt\]\][\s\S]*?\[\[\/Flowlock::NextPrompt\]\]/ig, '')
        .replace(/\[\[TaskComplete(?:\s*\]\]|\s[\s\S]*?\]\])/ig, '')
        .replace(/\[\[TaskFailed(?:\s*\]\]|\s[\s\S]*?\]\])/ig, '')
        .replace(/\[\[NextHeartbeat::\d+\]\]/ig, '');
}

function stripProtocolDirectives(text) {
    return mapUnprotectedRegions(
        text,
        stripDirectivesFromUnprotectedChunk,
        chunk => chunk
    )
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function parseFlowlockDirectives(text) {
    const source = String(text || '');
    const protocolSource = maskProtectedProtocolRegions(source);
    const isFlowlockProtocol = FLOWLOCK_PATTERNS.any.test(protocolSource);
    const complete = FLOWLOCK_PATTERNS.complete.test(protocolSource) || FLOWLOCK_PATTERNS.legacyComplete.test(protocolSource);
    const fail = FLOWLOCK_PATTERNS.fail.test(protocolSource) || FLOWLOCK_PATTERNS.legacyFail.test(protocolSource);
    const stop = FLOWLOCK_PATTERNS.stop.test(protocolSource);
    const start = FLOWLOCK_PATTERNS.start.test(protocolSource);

    let action = 'continue';
    if (complete) {
        action = 'complete';
    } else if (fail) {
        action = 'fail';
    } else if (stop) {
        action = 'stop';
    } else if (start) {
        action = 'start';
    }

    const flowlockDelay = getLastPositiveIntegerMatch(protocolSource, FLOWLOCK_PATTERNS.heartbeat);
    const legacyDelay = getLastPositiveIntegerMatch(protocolSource, FLOWLOCK_PATTERNS.legacyHeartbeat);

    return {
        action,
        isFlowlockProtocol,
        start,
        stop,
        complete,
        fail,
        nextHeartbeatSeconds: flowlockDelay ?? legacyDelay ?? DEFAULT_HEARTBEAT_DELAY_SECONDS,
        hasExplicitHeartbeat: flowlockDelay !== null || legacyDelay !== null,
        nextPrompt: getLastPromptMatch(protocolSource),
        report: stripProtocolDirectives(source)
    };
}

module.exports = {
    DEFAULT_HEARTBEAT_DELAY_SECONDS,
    maskProtectedProtocolRegions,
    parseFlowlockDirectives,
    stripProtocolDirectives
};