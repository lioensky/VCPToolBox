'use strict';
// OneRingFuzzy.js — 独立 fuzzy diff 模块
// 职责：内容归一化、相似度计算、上下文数组比对定位。
// 设计为可独立升级：未来可替换为向量相似度或更复杂的 diff 算法，只要保持导出接口不变。

const crypto = require('crypto');

// 需要在比对前剥离的标记（尾部 OneRing 标记、系统通知栏）
// 群聊头 [xxx的发言]: 是真实上下文正文的一部分，必须参与 DB/snapshot/exact hash，不能在 normalize 中剥离。
const ONERING_TAIL_REGEX = /(?:\s*\[OneRing通知:[^\]]*\]\s*)+$/;
const SYSTEM_NOTICE_REGEX = /\[系统通知\][\s\S]*?\[系统通知结束\]/g;
const GROUPCHAT_HEAD_REGEX = /^\s*\[[^\]]{1,30}的发言\]\s*[:：]\s*/;
// VCP 多模态翻译块：ImageProcessor / MultiModalProcessor 在 {{TransBase64}} / {{TransBase64+}} 模式下
// 会向 user 文本内注入 <VCP_MULTIMODAL_INFO>...[MULTIMODAL_DATA_N_Info: 描述]...</VCP_MULTIMODAL_INFO>
// 在 TransBase64+ 模式下，第⑧阶段（chatCompletionHandler.js 970-1003）会把它从 AI 视野中删除并还原原始 base64。
// 但 OneRing 在第⑦阶段看到的正是这个被污染的中间态：
//   1) 同一张图每轮的多模态描述文字可能不同（编号 N 重排、模型重新生成等）；
//   2) 旧 user 块在历史中已被还原为原图，下一轮又会被注入新的 <VCP_MULTIMODAL_INFO>。
// 因此该块绝不能进入 hash / 相似度比对，否则 OneRing 的 snapshot/exact hash 对齐会全面失配。
// 这里只在 normalize/hash 时剥离它供哈希计算使用，DB 实际写入的 content（来自 classifyUserContent
// 的 cleanText）仍保留原样，AI 视野不受影响。
// 注意：用户正文可能字面讨论 "<VCP_MULTIMODAL_INFO> 到 </VCP_MULTIMODAL_INFO> 的剥离函数"。
// 因此不能无条件剥离所有成对标签，只剥离内部包含“服务器已处理多模态数据”或
// MULTIMODAL_DATA_N_Info 的自动注入块。
const VCP_MULTIMODAL_INFO_REGEX = /<VCP_MULTIMODAL_INFO\b[^>]*>(?=[\s\S]*?(?:服务器已处理多模态数据|\[MULTIMODAL_DATA_\d+_Info:))[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g;

function stripVcpMultimodalInfoForHash(text) {
    if (typeof text !== 'string') return '';
    return text.replace(VCP_MULTIMODAL_INFO_REGEX, '');
}

/**
 * 归一化：只剥离 OneRing/服务端临时标记，保留真实上下文内容用于比对。
 * 群聊头 [xxx的发言]: 是 AI 实际看到的正文，也是区分说话者的关键信息，不能剥离。
 * <VCP_MULTIMODAL_INFO> 是 TransBase64/TransBase64+ 中间态翻译，仅在 hash 计算时剥离。
 */
function normalize(text) {
    if (typeof text !== 'string') return '';
    let t = text;
    t = t.replace(SYSTEM_NOTICE_REGEX, '');
    t = stripVcpMultimodalInfoForHash(t);
    t = t.replace(ONERING_TAIL_REGEX, '');
    // 折叠多余空白
    t = t.replace(/\s+/g, ' ').trim();
    return t;
}

function normalizedHashFromKey(normalizedText) {
    return crypto.createHash('sha1').update(typeof normalizedText === 'string' ? normalizedText : '').digest('hex');
}

function normalizedHash(text) {
    return normalizedHashFromKey(normalize(text));
}

/**
 * Levenshtein 距离（带长度短路优化）
 */
function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= n; j++) {
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

/**
 * 相似度 [0,1]，基于归一化后的 Levenshtein。
 */
function similarity(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return 1;
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return 1;
    // 长度差过大直接短路，避免对超长文本做昂贵的编辑距离
    const lenRatio = Math.min(na.length, nb.length) / maxLen;
    if (lenRatio < 0.5) return lenRatio; // 长度差一半以上，相似度上限就是长度比
    const dist = levenshtein(na, nb);
    return 1 - dist / maxLen;
}

/**
 * 将一条 OpenAI 消息提取为纯文本（多模态取 text 部分）。
 */
function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n');
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return content.text;
    }
    return '';
}

/**
 * 比对 post 的 user/assistant 数组与 db 已存记录，定位差异。
 *
 * @param {Array<{role,text}>} postBlocks  本次 post 的 user/assistant 块（已提取文本）
 * @param {Array<{id,role,content}>} dbBlocks  db 中同信道历史记录
 * @param {number} threshold  相似度阈值
 * @returns {{
 *   matchedCount: number,        // 能对上的块数
 *   unknownCount: number,        // post 中未在 db 找到对应的块数
 *   editedBlocks: Array,         // 被编辑的块 [{ postIndex, dbId, oldContent, newText }]
 *   newBlocks: Array,            // post 末尾全新的块 [{ postIndex, role, text }]
 *   reliable: boolean            // 整体比对是否可靠（序列对齐良好）
 * }}
 */
function diffContext(postBlocks, dbBlocks, threshold) {
    const result = {
        matchedCount: 0,
        unknownCount: 0,
        editedBlocks: [],
        newBlocks: [],
        reliable: true
    };

    if (!Array.isArray(postBlocks) || postBlocks.length === 0) return result;
    if (!Array.isArray(dbBlocks) || dbBlocks.length === 0) {
        result.newBlocks = postBlocks.map((pb, index) => ({ ...pb, postIndex: index }));
        return result;
    }

    const preparedPostBlocks = postBlocks.map(pb => {
        const normalizedText = normalize(pb.text);
        return {
            ...pb,
            normalizedText,
            normalizedHash: normalizedHashFromKey(normalizedText)
        };
    });
    const preparedDbBlocks = dbBlocks.map(dbItem => {
        const normalizedText = normalize(dbItem.content);
        return {
            ...dbItem,
            normalizedText,
            normalizedHash: normalizedHashFromKey(normalizedText)
        };
    });

    // 低于该相似度时，不再把同角色差异直接视为“编辑”。
    // 这能保护“同端只 post 单条新消息/尾部窗口”时不误覆盖 DB 早期旧消息。
    const editFloor = Math.max(0.55, threshold - 0.25);

    // 对齐策略：前端可能只回传尾部窗口或单条 retry，因此不能固定从 DB 头部对齐。
    // 在 DB 中寻找与 post 最匹配的连续窗口；同分时偏向更靠后的窗口，符合聊天上下文尾部语义。
    let bestStart = 0;
    let bestScore = -Infinity;
    const maxStart = Math.max(0, dbBlocks.length - 1);
    for (let start = 0; start <= maxStart; start++) {
        let score = 0;
        for (let pi = 0; pi < preparedPostBlocks.length; pi++) {
            const dbItem = preparedDbBlocks[start + pi];
            const pb = preparedPostBlocks[pi];
            if (!dbItem) {
                score -= 0.25;
                continue;
            }
            if (dbItem.role !== pb.role) {
                score -= 1;
                continue;
            }
            score += pb.normalizedHash === dbItem.normalizedHash
                ? 1
                : similarity(pb.normalizedText, dbItem.normalizedText);
        }
        if (score >= bestScore) {
            bestScore = score;
            bestStart = start;
        }
    }

    let di = bestStart;
    for (let pi = 0; pi < preparedPostBlocks.length; pi++) {
        const pb = preparedPostBlocks[pi];
        if (di >= preparedDbBlocks.length) {
            result.newBlocks.push({ ...pb, postIndex: pi });
            continue;
        }

        const dbItem = preparedDbBlocks[di];
        if (dbItem.role !== pb.role) {
            result.unknownCount++;
            result.reliable = false;
            di++;
            continue;
        }

        const sim = pb.normalizedHash === dbItem.normalizedHash
            ? 1
            : similarity(pb.normalizedText, dbItem.normalizedText);
        if (sim >= threshold) {
            result.matchedCount++;
        } else if (sim >= editFloor) {
            result.editedBlocks.push({
                postIndex: pi,
                dbId: dbItem.id,
                oldContent: dbItem.content,
                newText: pb.text,
                similarity: sim
            });
        } else {
            result.unknownCount++;
            result.reliable = false;
        }
        di++;
    }

    return result;
}

module.exports = {
    normalize,
    normalizedHash,
    normalizedHashFromKey,
    stripVcpMultimodalInfoForHash,
    similarity,
    extractText,
    diffContext,
    // 暴露常量，供主处理器复用同一套标记定义
    ONERING_TAIL_REGEX,
    SYSTEM_NOTICE_REGEX,
    GROUPCHAT_HEAD_REGEX,
    VCP_MULTIMODAL_INFO_REGEX
};