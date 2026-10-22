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

    for (let i = 0; i < sentences.length; i++) {
        let sentence = sentences[i];
        let sentenceTokens = encoding.encode(sentence.trim()).length;

        // 处理超长句子：如果单个句子超过maxTokens，需要强制分割
        if (sentenceTokens > maxTokens) {
            // 先保存当前切片（如果有内容）
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
            }
            
            // 对超长句子进行强制分割
            const forceSplitChunks = forceSplitLongText(sentence, maxTokens, overlapTokens);
            chunks.push(...forceSplitChunks);
            continue;
        }

        if (encoding.encode((currentChunk + sentence).trim()).length > maxTokens) {
            chunks.push(currentChunk.trim());
            
            // 创建重叠部分
            let overlapChunk = "";
            let overlapTokenCount = 0;
            for (let j = i - 1; j >= 0; j--) {
                const prevSentence = sentences[j];
                const prevSentenceTokens = encoding.encode(prevSentence).length;
                if (overlapTokenCount + prevSentenceTokens > overlapTokens) break;
                // Leave room for the incoming sentence, using the actual BPE
                // count of the combined text rather than a sum of sentence counts.
                if (encoding.encode((prevSentence + overlapChunk + sentence).trim()).length > maxTokens) break;
                overlapChunk = prevSentence + overlapChunk;
                overlapTokenCount += prevSentenceTokens;
            }
            currentChunk = overlapChunk;
        }
        
        currentChunk += sentence;
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
    
    // Safety check to prevent infinite loop
    const safeOverlap = Math.min(overlapTokens, Math.max(0, maxTokens - 1));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    
    let start = 0;
    while (start < tokens.length) {
        let end = Math.min(start + maxTokens, tokens.length);
        let chunkText;

        // Token boundaries can split a UTF-8 character. Decode token IDs through
        // tiktoken first, then shorten the slice until it ends on a whole character.
        while (end > start) {
            try {
                chunkText = decoder.decode(encoding.decode(tokens.slice(start, end)));
                // BPE can tokenize an isolated, trimmed slice differently from
                // the original text. Check the exact string sent for embedding.
                if (encoding.encode(chunkText.trim()).length > maxTokens) {
                    end--;
                    continue;
                }
                break;
            } catch (error) {
                if (!(error instanceof TypeError)) throw error;
                end--;
            }
        }
        if (end === start) {
            throw new RangeError('maxTokens is too small to fit a complete UTF-8 character');
        }
        
        // 尝试在合适的位置断开（避免在词汇中间断开）
        if (end < tokens.length) {
            // 尝试在标点符号或空白处断开
            const breakPoints = ['\n', '。', '！', '？', '，', '；', '：', ' ', '\t'];
            let bestBreakPoint = -1;
            
            for (let i = chunkText.length - 1; i >= Math.max(0, chunkText.length - 200); i--) {
                if (breakPoints.includes(chunkText[i])) {
                    bestBreakPoint = i + 1;
                    break;
                }
            }
            
            let finalChunkText = chunkText;
            if (bestBreakPoint > 0) {
                const candidateText = chunkText.substring(0, bestBreakPoint);
                const newTokens = encoding.encode(candidateText);
                
                // Prevent infinite loop: only accept the breakpoint if it provides meaningful progress
                // Re-encoding a prefix can change its final token. Only advance
                // by this count when it still identifies the original token prefix.
                const isOriginalPrefix = newTokens.length <= end - start
                    && newTokens.every((token, index) => token === tokens[start + index]);
                if (isOriginalPrefix && encoding.encode(candidateText.trim()).length <= maxTokens
                    && (newTokens.length > safeOverlap || newTokens.length === (end - start))) {
                    finalChunkText = candidateText;
                    end = start + newTokens.length;
                }
            }
            
            chunks.push(finalChunkText.trim());
        } else {
            // 最后一块
            chunks.push(chunkText.trim());
            break;
        }
        
        // 计算下一个起始位置（考虑重叠），确保 start 至少向前推进 1 步，即使 end 没有发生变化
        let nextStart = Math.max(start + 1, end - safeOverlap);
        // Reduce overlap rather than starting the next slice inside a character.
        while (nextStart < end) {
            const firstByte = encoding.decode(tokens.slice(nextStart, nextStart + 1))[0];
            if ((firstByte & 0xc0) !== 0x80) break;
            nextStart++;
        }
        start = nextStart;
    }
    
    return chunks.filter(chunk => chunk.length > 0);
}

module.exports = { chunkText };