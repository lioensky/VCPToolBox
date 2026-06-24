'use strict';

function formatResultPathLine(result) {
    const rawPath = result?.fullPath || result?.sourceFile || result?.path || '';
    if (!rawPath) return '';

    const normalizedPath = String(rawPath).replace(/\\/g, '/');
    const localUrl = normalizedPath.startsWith('file://')
        ? normalizedPath
        : `file:///${normalizedPath}`;

    return `    [路径: ${localUrl}]\n`;
}

function formatMemoryEntry(result, { prefix = '* ', text = null } = {}) {
    const body = text !== null ? text : (result?.text || '').trim();
    return `${prefix}${body}\n${formatResultPathLine(result)}`;
}

function buildRagBlock(innerContent, metadata) {
    const metadataString = JSON.stringify(metadata).replace(/-->/g, '--\\>');
    return `<!-- VCP_RAG_BLOCK_START ${metadataString} -->${innerContent}<!-- VCP_RAG_BLOCK_END -->`;
}

function formatStandardResults(searchResults, displayName, metadata) {
    const mainResults = searchResults ? searchResults.filter(r => r.source !== 'associate') : [];
    const associateResults = searchResults ? searchResults.filter(r => r.source === 'associate') : [];

    let innerContent = `\n[--- 从"${displayName}"中检索到的相关记忆片段 ---]\n`;
    if (mainResults.length > 0) {
        innerContent += mainResults.map(r => formatMemoryEntry(r).trimEnd()).join('\n');
    } else {
        innerContent += '没有找到直接相关的记忆片段。';
    }

    if (associateResults.length > 0) {
        innerContent += `\n\n【联想共现记忆 (${associateResults.length}条, 多条记忆交叉关联)】\n`;
        innerContent += associateResults.map(r => formatMemoryEntry(r).trimEnd()).join('\n');
    }

    innerContent += `\n[--- 记忆片段结束 ---]\n`;

    return buildRagBlock(innerContent, metadata);
}

function formatCombinedTimeAwareResults(results, timeRanges, dbName, metadata) {
    const displayName = dbName + '日记本';
    const formatDate = (date) => {
        const d = new Date(date);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    };

    let innerContent = `\n[--- "${displayName}" 多时间感知检索结果 ---]\n`;

    const formattedRanges = timeRanges.map(tr => `"${formatDate(tr.start)} ~ ${formatDate(tr.end)}"`).join(' 和 ');
    innerContent += `[合并查询的时间范围: ${formattedRanges}]\n`;

    const ragEntries = results.filter(e => e.source === 'rag');
    const timeEntries = results.filter(e => e.source === 'time');
    const associateEntries = results.filter(e => e.source === 'associate');

    innerContent += `[统计: 共找到 ${results.length} 条不重复记忆 (语义相关 ${ragEntries.length}条, 时间范围 ${timeEntries.length}条${associateEntries.length > 0 ? `, 联想共现 ${associateEntries.length}条` : ''})]\n\n`;

    if (ragEntries.length > 0) {
        innerContent += '【语义相关记忆】\n';
        ragEntries.forEach(entry => {
            const dateMatch = entry.text.match(/^\[(\d{4}-\d{2}-\d{2})\]/);
            const datePrefix = dateMatch ? `[${dateMatch[1]}] ` : '';
            const body = `${datePrefix}${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}`;
            innerContent += formatMemoryEntry(entry, { text: body });
        });
    }

    if (timeEntries.length > 0) {
        innerContent += '\n【时间范围记忆】\n';
        timeEntries.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        timeEntries.forEach(entry => {
            const dateMatch = entry.text.match(/^\[(\d{4}[-.]\d{2}[-.]\d{2})\]/);
            const datePrefix = entry.date || (dateMatch ? dateMatch[1].replace(/\./g, '-') : '未知日期');
            const body = entry.text.replace(/^\[\d{4}[-.]\d{2}[-.]\d{2}\]\s*-\s*[^\n]*\n?/, '').trim();
            innerContent += formatMemoryEntry(entry, { text: `[${datePrefix}] ${body}` });
        });
    }

    if (associateEntries.length > 0) {
        innerContent += '\n【联想共现记忆】\n';
        associateEntries.forEach(entry => {
            const dateMatch = entry.text.match(/^\[(\d{4}-\d{2}-\d{2})\]/);
            const datePrefix = dateMatch ? `[${dateMatch[1]}] ` : '';
            const body = `${datePrefix}${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}`;
            innerContent += formatMemoryEntry(entry, { text: body });
        });
    }

    innerContent += `[--- 检索结束 ---]\n`;

    return buildRagBlock(innerContent, metadata);
}

function formatGroupRAGResults(searchResults, displayName, activatedGroups, metadata) {
    let innerContent = `\n[--- "${displayName}" 语义组增强检索结果 ---]\n`;

    if (activatedGroups && activatedGroups.size > 0) {
        innerContent += `[激活的语义组:]\n`;
        for (const [groupName, data] of activatedGroups) {
            innerContent += `  • ${groupName} (${(data.strength * 100).toFixed(0)}%激活): 匹配到 "${data.matchedWords.join(', ')}"\n`;
        }
        innerContent += '\n';
    } else {
        innerContent += `[未激活特定语义组]\n\n`;
    }

    innerContent += `[检索到 ${searchResults ? searchResults.length : 0} 条相关记忆]\n`;
    if (searchResults && searchResults.length > 0) {
        innerContent += searchResults.map(r => formatMemoryEntry(r).trimEnd()).join('\n');
    } else {
        innerContent += '没有找到直接相关的记忆片段。';
    }
    innerContent += `\n[--- 检索结束 ---]\n`;

    return buildRagBlock(innerContent, metadata);
}

function cleanResultsForBroadcast(results) {
    if (!Array.isArray(results)) return [];

    return results.map(r => {
        const cleaned = {
            text: r.text || '',
            score: r.score || undefined,
            source: r.source || undefined,
            date: r.date || undefined,
            fullPath: r.fullPath || undefined,
            sourceFile: r.sourceFile || undefined,
        };

        if (r.bm25Score !== undefined) cleaned.bm25Score = r.bm25Score;
        if (r.normalizedBM25Score !== undefined) cleaned.normalizedBM25Score = r.normalizedBM25Score;
        if (r.originalScore !== undefined) cleaned.originalScore = r.originalScore;
        if (r.tagMatchScore !== undefined) cleaned.tagMatchScore = r.tagMatchScore;

        let finalTags = [];
        if (r.matchedTags && Array.isArray(r.matchedTags)) {
            finalTags = r.matchedTags.map(t => {
                if (typeof t === 'string') return t;
                if (t && t.name) return t.name;
                return String(t);
            });
        }

        if (r.source === 'time' && !finalTags.includes('time')) {
            finalTags.push('time');
        }

        if (finalTags.length > 0) {
            cleaned.matchedTags = finalTags;
        }

        if (r.tagMatchCount !== undefined) cleaned.tagMatchCount = r.tagMatchCount;
        if (r.boostFactor !== undefined) cleaned.boostFactor = r.boostFactor;
        if (r._associateCoCount !== undefined) cleaned.associateCoCount = r._associateCoCount;

        if (r.coreTagsMatched && Array.isArray(r.coreTagsMatched)) {
            cleaned.coreTagsMatched = r.coreTagsMatched.map(t => {
                if (typeof t === 'string') return t;
                if (t && t.name) return t.isCore ? `!${t.name}` : t.name;
                return String(t);
            });
        }

        return cleaned;
    });
}

function aggregateTagStats(results) {
    const allMatchedTags = new Set();
    let totalBoostFactor = 0;
    let resultsWithTags = 0;

    for (const r of results) {
        if (r.matchedTags && r.matchedTags.length > 0) {
            r.matchedTags.forEach(tag => allMatchedTags.add(tag));
            resultsWithTags++;
            if (r.boostFactor) totalBoostFactor += r.boostFactor;
        }
    }

    return {
        uniqueMatchedTags: Array.from(allMatchedTags),
        totalTagMatches: allMatchedTags.size,
        resultsWithTags,
        avgBoostFactor: resultsWithTags > 0 ? (totalBoostFactor / resultsWithTags).toFixed(3) : 1.0
    };
}

module.exports = {
    formatResultPathLine,
    formatMemoryEntry,
    formatStandardResults,
    formatCombinedTimeAwareResults,
    formatGroupRAGResults,
    cleanResultsForBroadcast,
    aggregateTagStats
};