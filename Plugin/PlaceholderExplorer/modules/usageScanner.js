'use strict';

const fs = require('fs').promises;
const path = require('path');
const { normalizePlaceholder, toRelative } = require('./pathUtils');

function extractPlaceholders(content, file, sourceKind = 'text') {
    const text = String(content || '');
    const references = [];
    const patterns = [
        { regex: /\{\{([^{}\r\n]+)\}\}/g, wrapper: 'curly' },
        { regex: /\[\[([^\[\]\r\n]+)\]\]/g, wrapper: 'bracket' }
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.regex.exec(text)) !== null) {
            const placeholder = pattern.wrapper === 'bracket'
                ? `[[${match[1].trim()}]]`
                : normalizePlaceholder(match[0]);
            const line = text.slice(0, match.index).split(/\r?\n/).length;
            references.push({
                placeholder,
                file,
                line,
                source: sourceKind,
                raw: match[0]
            });
        }
    }
    return references;
}

async function scanUsageFiles(files, options = {}) {
    const references = [];
    const errors = [];
    const seen = new Set();
    for (const filePath of files) {
        const resolved = path.resolve(filePath);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        try {
            const content = await fs.readFile(resolved, 'utf8');
            const relativeFile = options.projectRoot ? toRelative(options.projectRoot, resolved) : resolved;
            const sourceKind = options.sourceKinds?.get(resolved) || 'text';
            references.push(...extractPlaceholders(content, relativeFile, sourceKind));
        } catch (error) {
            errors.push({ file: resolved, line: 1, message: error.message });
        }
    }
    return { references, errors };
}

module.exports = { extractPlaceholders, scanUsageFiles };
