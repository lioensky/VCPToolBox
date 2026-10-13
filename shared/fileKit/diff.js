'use strict';
// 共享行级 diff：基于 diff-match-patch 的 line mode，输出紧凑 unified diff。
// 仅用于展示与审查，回退永远基于完整快照，不依赖 diff 反向应用。

const DiffMatchPatch = require('diff-match-patch');
const { normalizeEol } = require('./text');

const dmp = new DiffMatchPatch();

function toLines(text) {
    const norm = normalizeEol(text);
    if (norm === '') return [];
    return (norm.endsWith('\n') ? norm.slice(0, -1) : norm).split('\n');
}

/**
 * 计算行级操作序列：[{ type: ' '|'-'|'+', line, oldNo, newNo }]
 */
function lineOps(oldText, newText) {
    const a = toLines(oldText);
    const b = toLines(newText);
    // diff_linesToChars_ 要求每行以 \n 结尾才能正确切分
    const encoded = dmp.diff_linesToChars_(a.map(l => `${l}\n`).join(''), b.map(l => `${l}\n`).join(''));
    const diffs = dmp.diff_main(encoded.chars1, encoded.chars2, false);
    dmp.diff_charsToLines_(diffs, encoded.lineArray);

    const ops = [];
    let oldNo = 1;
    let newNo = 1;
    for (const [op, chunk] of diffs) {
        const lines = chunk.endsWith('\n') ? chunk.slice(0, -1).split('\n') : chunk.split('\n');
        for (const line of lines) {
            if (op === 0) ops.push({ type: ' ', line, oldNo: oldNo++, newNo: newNo++ });
            else if (op === -1) ops.push({ type: '-', line, oldNo: oldNo++, newNo: null });
            else ops.push({ type: '+', line, oldNo: null, newNo: newNo++ });
        }
    }
    return ops;
}

/**
 * 生成 unified diff 文本与统计。
 * @returns {{ text: string, added: number, removed: number, hunks: Array<{oldStart,oldCount,newStart,newCount}> }}
 */
function unifiedDiff(oldText, newText, options = {}) {
    const { context = 3, oldLabel = 'a', newLabel = 'b', maxLines = 400 } = options;
    const ops = lineOps(oldText, newText);
    const added = ops.filter(o => o.type === '+').length;
    const removed = ops.filter(o => o.type === '-').length;
    if (added === 0 && removed === 0) return { text: '', added, removed, hunks: [] };

    // 标记需要输出的下标（变更行 ± context）
    const keep = new Array(ops.length).fill(false);
    ops.forEach((o, i) => {
        if (o.type === ' ') return;
        for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
    });

    const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
    const hunks = [];
    let i = 0;
    while (i < ops.length) {
        if (!keep[i]) { i++; continue; }
        let j = i;
        while (j < ops.length && keep[j]) j++;
        const slice = ops.slice(i, j);
        // 计算 hunk 起始行：取首个有对应行号的值，纯插入/纯删除时向前推导
        const firstOld = slice.find(o => o.oldNo !== null)?.oldNo ?? (ops.slice(0, i).reverse().find(o => o.oldNo !== null)?.oldNo ?? 0) + 1;
        const firstNew = slice.find(o => o.newNo !== null)?.newNo ?? (ops.slice(0, i).reverse().find(o => o.newNo !== null)?.newNo ?? 0) + 1;
        const oldCount = slice.filter(o => o.type !== '+').length;
        const newCount = slice.filter(o => o.type !== '-').length;
        hunks.push({ oldStart: firstOld, oldCount, newStart: firstNew, newCount });
        out.push(`@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`);
        for (const o of slice) out.push(`${o.type}${o.line}`);
        i = j;
    }

    let text = out.join('\n');
    const allLines = text.split('\n');
    if (allLines.length > maxLines) {
        text = `${allLines.slice(0, maxLines).join('\n')}\n... [diff 已截断，共 ${allLines.length} 行，使用 GetNodeDiff 查看完整内容]`;
    }
    return { text, added, removed, hunks };
}

module.exports = { lineOps, unifiedDiff };