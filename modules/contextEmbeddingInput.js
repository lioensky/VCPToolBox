'use strict';

const { getTokenCount } = require('../TextChunker');

const CONTEXT_EMBEDDING_BUDGETS = Object.freeze({ user: 5000, assistant: 5000, tool: 2000 });
const GAP = '\n\n[…]\n\n';
function stripContextSourceTail(text) {
    let end = text.trimEnd().length;
    while (text.charCodeAt(end - 1) === 93) {
        const start = text.lastIndexOf('[', end - 1);
        if (start < 0 || !text.startsWith('[OneRing通知:', start) ||
            text.indexOf(']', start) !== end - 1) break;
        end = text.slice(0, start).trimEnd().length;
    }
    return text.slice(0, end);
}

function compactCodeFences(text) {
    if (!text.includes('```') && !text.includes('~~~')) return text;
    const fences = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)/gm;
    let open = null;
    let previous = 0;
    const pieces = [];
    for (const match of text.matchAll(fences)) {
        if (!open) {
            open = { marker: match[1], bodyStart: match.index + match[0].length };
            continue;
        }
        if (!match[1].startsWith(open.marker) || match[2].trim()) continue;
        if (match.index - open.bodyStart > 1200) {
            pieces.push(text.slice(previous, open.bodyStart),
                edge(text.slice(open.bodyStart, open.bodyStart + 400), 399, false),
                GAP,
                edge(text.slice(match.index - 161, match.index), 160, true));
            previous = match.index;
        }
        open = null;
    }
    if (!pieces.length) return text;
    pieces.push(text.slice(previous));
    return pieces.join('');
}

// Slice only at a valid UTF-16 boundary. Candidate windows stay bounded even for huge attachments.
function edge(text, size, fromEnd) {
    if (size <= 0) return '';
    if (size >= text.length) return text;
    let cut = fromEnd ? text.length - size : size;
    const next = text.charCodeAt(cut);
    const prev = text.charCodeAt(cut - 1);
    if (next >= 0xDC00 && next <= 0xDFFF && prev >= 0xD800 && prev <= 0xDBFF) {
        cut += fromEnd ? 1 : -1;
    }
    return fromEnd ? text.slice(cut) : text.slice(0, cut);
}

function fits(text, budget) {
    return Buffer.byteLength(text, 'utf8') <= budget || getTokenCount(text) <= budget;
}

function fitEdge(text, budget, fromEnd) {
    if (budget <= 0) return '';
    if (fits(text, budget)) return text;
    let lo = 0;
    let hi = text.length;
    let best = '';
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = edge(text, mid, fromEnd).trim();
        if (fits(candidate, budget)) {
            best = candidate;
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

/**
 * Project already-sanitized conversation text, before any vector lookup or request.
 * This is not a document chunker: omitted text is not embedded separately.
 */
function projectContextEmbeddingInput(text, role) {
    if (typeof text !== 'string') return '';
    if (!Object.hasOwn(CONTEXT_EMBEDDING_BUDGETS, role)) return text.trim();
    let normalized = text.trim();
    if (normalized.endsWith(']') && normalized.includes('[OneRing通知:')) {
        normalized = stripContextSourceTail(normalized);
    }

    const budget = CONTEXT_EMBEDDING_BUDGETS[role];
    const window = budget * 8;
    if (normalized.length <= window && fits(normalized, budget)) return normalized;
    const compact = compactCodeFences(normalized);
    if (compact !== normalized) {
        normalized = compact;
        if (normalized.length <= window && fits(normalized, budget)) return normalized;
    }

    // Keep both the lead-in and the latest user question / assistant conclusion.
    const usable = budget - getTokenCount(GAP) - 8;
    const headBudget = Math.floor(usable * 0.4);
    const head = fitEdge(edge(normalized, Math.min(window, Math.floor(normalized.length / 2)), false), headBudget, false);
    const tailWindow = edge(normalized, Math.min(window, Math.ceil(normalized.length / 2)), true);
    const tail = fitEdge(tailWindow, usable - headBudget, true);
    const projected = [head, tail].filter(Boolean).join(GAP);
    return fits(projected, budget) ? projected : fitEdge(tailWindow, budget, true);
}

module.exports = { CONTEXT_EMBEDDING_BUDGETS, projectContextEmbeddingInput, stripContextSourceTail };