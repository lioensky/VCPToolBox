'use strict';

let lastTimestampMs = 0;
const START_PREFIX = '<<<[VCP_TOOL_BATCH_START:';
const END_PREFIX = '<<<[VCP_TOOL_BATCH_END:';
const timestampPattern = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

/** Build only after collecting the batch, so delimiter collisions can be checked. */
function formatToolResultBatch(parts, enableRoleDivider = true) {
    const body = parts.join('');
    if (!body) return '';
    let timestamp;
    let start;
    let end;
    do {
        lastTimestampMs = Math.max(Date.now(), lastTimestampMs + 1);
        timestamp = new Date(lastTimestampMs).toISOString();
        start = `${START_PREFIX}${timestamp}]>>>`;
        end = `${END_PREFIX}${timestamp}]>>>`;
    } while (body.includes(start) || body.includes(end));
    const batch = `\n${start}\n${body}\n${end}\n`;
    return enableRoleDivider
        ? `\n<<<[ROLE_DIVIDE_USER]>>>\n${batch}\n<<<[END_ROLE_DIVIDE_USER]>>>\n`
        : batch;
}

/** A fresh scanner per call; quoted batches are opaque, never recursively parsed. */
function createBatchStartScanner() {
    return new RegExp(`${START_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${timestampPattern})\\]>>>`, 'g');
}

function findBatchEnd(text, match) {
    const marker = `${END_PREFIX}${match[1]}]>>>`;
    const index = text.indexOf(marker, match.index + match[0].length);
    return index === -1 ? text.length : index + marker.length;
}

module.exports = { formatToolResultBatch, createBatchStartScanner, findBatchEnd };