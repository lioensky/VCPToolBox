// TextChunker.js
require('dotenv').config({ path: './config.env' });
const { get_encoding } = require("@dqbd/tiktoken"); // 假设您已安装 tiktoken 用于精确计算
const encoding = get_encoding("cl100k_base"); // gpt-4, gpt-3.5, embedding models 常用

// 从 config.env 文件读取最大 token 数，并应用85%的安全边界
const embeddingMaxToken = parseInt(process.env.WhitelistEmbeddingModelMaxToken, 10) || 8000;
const safeMaxTokens = Math.floor(embeddingMaxToken * 0.85);
const defaultOverlapTokens = Math.floor(safeMaxTokens * 0.1); // 重叠部分为最大值的10%

console.log(`[TextChunker] 配置加载: MaxToken=${embeddingMaxToken}, SafeMaxTokens=${safeMaxTokens}, OverlapTokens=${defaultOverlapTokens}`);

/**
 * 智能文本切分器
 * @param {string} text - 需要切分的原始文本
 * @param {number} maxTokens - 每个切片的最大token数
 * @param {number} overlapTokens - 切片间的重叠token数，以保证上下文连续性
 * @returns {string[]} 切分后的文本块数组
 */
function chunkText(text, maxTokens = safeMaxTokens, overlapTokens = defaultOverlapTokens) {
    if (!text) return [];

    const sentences = text.split(/(?<=[。？！.!?\n])/g); // 按句子和换行符分割，保留分隔符
    const chunks = [];
    let currentChunk = "";
    let currentTokens = 0;

    for (let i = 0; i < sentences.length; i++) {
        let sentence = sentences[i];
        let sentenceTokens = encoding.encode(sentence).length;

        // 处理超长句子：如果单个句子超过maxTokens，需要强制分割
        if (sentenceTokens > maxTokens) {
            // 先保存当前切片（如果有内容）
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
                currentTokens = 0;
            }
            
            // 对超长句子进行强制分割
            const forceSplitChunks = forceSplitLongText(sentence, maxTokens, overlapTokens);
            chunks.push(...forceSplitChunks);
            continue;
        }

        if (currentTokens + sentenceTokens > maxTokens) {
            chunks.push(currentChunk.trim());
            
            // 创建重叠部分
            let overlapChunk = "";
            let overlapTokenCount = 0;
            for (let j = i - 1; j >= 0; j--) {
                const prevSentence = sentences[j];
                const prevSentenceTokens = encoding.encode(prevSentence).length;
                if (overlapTokenCount + prevSentenceTokens > overlapTokens) break;
                overlapChunk = prevSentence + overlapChunk;
                overlapTokenCount += prevSentenceTokens;
            }
            currentChunk = overlapChunk;
            currentTokens = overlapTokenCount;
        }
        
        currentChunk += sentence;
        currentTokens += sentenceTokens;
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks;
}

/**
 * 强制分割超长文本
 * @param {string} text - 需要分割的超长文本
 * @param {number} maxTokens - 每个切片的最大token数
 * @param {number} overlapTokens - 切片间的重叠token数
 * @returns {string[]} 分割后的文本块数组
 */
function forceSplitLongText(text, maxTokens, overlapTokens) {
    const chunks = [];
    const tokens = encoding.encode(text);
    
    let start = 0;
    while (start < tokens.length) {
        let end = Math.min(start + maxTokens, tokens.length);
        
        // 尝试在合适的位置断开（避免在词汇中间断开）
        if (end < tokens.length) {
            const chunkTokens = tokens.slice(start, end);
            let chunkText = encoding.decode(chunkTokens);
            
            // 尝试在标点符号或空白处断开
            const breakPoints = ['\n', '。', '！', '？', '，', '；', '：', ' ', '\t'];
            let bestBreakPoint = -1;
            
            for (let i = chunkText.length - 1; i >= Math.max(0, chunkText.length - 200); i--) {
                if (breakPoints.includes(chunkText[i])) {
                    bestBreakPoint = i + 1;
                    break;
                }
            }
            
            if (bestBreakPoint > 0) {
                chunkText = chunkText.substring(0, bestBreakPoint);
                const newTokens = encoding.encode(chunkText);
                end = start + newTokens.length;
            }
            
            chunks.push(chunkText.trim());
        } else {
            // 最后一块
            const chunkTokens = tokens.slice(start);
            chunks.push(encoding.decode(chunkTokens).trim());
        }
        
        // 计算下一个起始位置（考虑重叠）
        start = Math.max(start + 1, end - overlapTokens);
    }
    
    return chunks.filter(chunk => chunk.length > 0);
}

module.exports = { chunkText };