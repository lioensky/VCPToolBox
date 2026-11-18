'use strict';

const MAX_QUERY_TOKENS = 256;
const MAX_TOKEN_BYTES = 1024;

function buildQueryTokens(plugin, text, enabled) {
    const diagnostics = {
        enabled, originalUnique: 0, expansionUnique: 0,
        retained: 0, dropped: 0, invalid: 0, truncated: false
    };
    if (!enabled) return { queryTokens: [], diagnostics };

    const normalize = value => {
        if (typeof value !== 'string') { diagnostics.invalid++; return null; }
        const token = value.trim().toLowerCase();
        if (!token) return null;
        if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
            diagnostics.invalid++;
            return null;
        }
        return token;
    };
    const original = new Set();
    for (const value of plugin._tokenize(text)) {
        const token = normalize(value);
        if (token) original.add(token);
    }
    diagnostics.originalUnique = original.size;
    const selected = [...original].slice(0, MAX_QUERY_TOKENS);
    const seen = new Set(original);
    const groups = [];
    const activated = new Set();
    for (const token of original) {
        const words = plugin.wordToGroupMap?.get(token);
        if (!Array.isArray(words)) continue;
        // The loader normally shares an array across all members of one group.
        const key = JSON.stringify(words);
        if (activated.has(key)) continue;
        activated.add(key);
        groups.push(words);
    }

    // Enumerate by round, not by whole group: one huge group cannot monopolize
    // the remaining budget. Continue counting overflow for truthful diagnostics.
    const width = groups.reduce((max, words) => Math.max(max, words.length), 0);
    for (let index = 0; index < width; index++) {
        for (const words of groups) {
            if (index >= words.length) continue;
            const token = normalize(words[index]);
            if (!token || seen.has(token)) continue;
            seen.add(token);
            diagnostics.expansionUnique++;
            if (selected.length < MAX_QUERY_TOKENS) selected.push(token);
        }
    }
    diagnostics.retained = selected.length;
    diagnostics.dropped = diagnostics.originalUnique
        + diagnostics.expansionUnique - diagnostics.retained;
    diagnostics.truncated = diagnostics.dropped > 0;
    return { queryTokens: selected, diagnostics };
}

module.exports = { buildQueryTokens, MAX_QUERY_TOKENS, MAX_TOKEN_BYTES };