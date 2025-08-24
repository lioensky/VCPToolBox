// TextChunker.js
const { get_encoding } = require("@dqbd/tiktoken"); // 假设您已安装 tiktoken 用于精确计算
const encoding = get_encoding("cl100k_base"); // gpt-4, gpt-3.5, embedding models 常用

/**
 * 智能文本切分器
 * @param {string} text - 需要切分的原始文本
 * @param {number} maxTokens - 每个切片的最大token数
 * @param {number} overlapTokens - 切片间的重叠token数，以保证上下文连续性
 * @returns {string[]} 切分后的文本块数组
 */
function chunkText(text, maxTokens = 500, overlapTokens = 50) {
    if (!text) return [];

    const sentences = text.split(/(?<=[。？！.!?\n])/g); // 按句子和换行符分割，保留分隔符
    const chunks = [];
    let currentChunk = "";
    let currentTokens = 0;

    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        const sentenceTokens = encoding.encode(sentence).length;

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
    
    // 注意：这里只是一个基础实现，更复杂的可能需要处理单个句子超长的情况。
    // 但对于日记这种文体，此算法已相当可靠。
    return chunks;
}

module.exports = { chunkText };