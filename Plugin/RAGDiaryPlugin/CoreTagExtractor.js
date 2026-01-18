// Plugin/RAGDiaryPlugin/CoreTagExtractor.js
const { Jieba } = require('@node-rs/jieba');
const { dict } = require('@node-rs/jieba/dict');
class CoreTagExtractor {
    constructor(vectorDBManager) {
        this.vectorDBManager = vectorDBManager;
        this.jiebaInstance = null;
        this.stopWords = new Set([
            '的', '了', '在', '是', '我', '你', '他', '她', '它',
            '这', '那', '有', '个', '就', '不', '人', '都', '一',
            '上', '也', '很', '到', '说', '要', '去', '能', '会',
            '着', '于', '与', '及', '等', '被', '从', '而', '但'
        ]);
        try {
            this.jiebaInstance = Jieba.withDict(dict);
            console.log('[CoreTagExtractor] Jieba initialized successfully.');
        } catch (error) {
            console.error('[CoreTagExtractor] Failed to initialize Jieba:', error);
        }
    }
    /**
     * 从文本中提取核心 Tag
     * @param {string} text - 净化后的上下文文本
     * @returns {Promise<Array<string>>} - 匹配到数据库标签库的核心 Tag 列表
     */
    async extract(text) {
        if (!text || !this.jiebaInstance) return [];
        // 1. 分词
        const words = this.jiebaInstance.cut(text, false); // 精确模式
        const candidates = [...new Set(
            words
                .map(w => w.toLowerCase().trim())
                .filter(w => w.length >= 1) // 允许单字，提高召回率（如：铅、汞、铊）
                .filter(w => !this.stopWords.has(w))
        )];
        if (candidates.length === 0) return [];
        // 2. 与数据库中的“Tag 海”进行握手（验证存在性）
        try {
            const db = this.vectorDBManager.db;
            if (!db) return [];
            const placeholders = candidates.map(() => '?').join(',');
            const sql = `SELECT name FROM tags WHERE name IN (${placeholders})`;
            const rows = db.prepare(sql).all(...candidates);
            const matchedTags = rows.map(r => r.name);
            console.log(`[CoreTagExtractor] Extracted ${matchedTags.length} core tags from context.`);
            return matchedTags;
        } catch (error) {
            console.error('[CoreTagExtractor] Error during tag validation:', error);
            return [];
        }
    }
}
module.exports = CoreTagExtractor;