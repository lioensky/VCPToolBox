// RETIRED: direct SQLite writes and legacy index publication are unsupported.
// Keep the write guard; use native Tag consistency plus Runtime checkpoints.
// rebuild_tag_index_custom.js
// 功能：1. 清理数据库中已存在的黑名单标签  2. 重新构建全局 Tag 向量索引
require('./guard-server-stopped').assertLegacyKnowledgeWriteDisabled();

const fs = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

// 1. 加载配置
const config = {
    storePath: path.join(__dirname, 'VectorStore'),
    dbName: 'knowledge_base.sqlite',
    dimension: parseInt(process.env.VECTORDB_DIMENSION) || 3072,
    // 从环境变量获取黑名单
    tagBlacklist: (process.env.TAG_BLACKLIST || '').split(',').map(t => t.trim()).filter(Boolean)
};

async function main() {
    console.log('--- 🏷️ 专门重建 Tag 索引 (含黑名单清理) ---');
    
    const dbPath = path.join(config.storePath, config.dbName);
    const tagIdxPath = path.join(config.storePath, 'index_global_tags.usearch');
    
    if (!require('fs').existsSync(dbPath)) {
        console.error('❌ 数据库文件不存在，请检查 VectorStore 目录');
        return;
    }

    const db = new Database(dbPath);
    
    try {
        // 步骤 1: 从数据库中物理删除黑名单标签
        if (config.tagBlacklist.length > 0) {
            console.log(`[Step 1/5] 正在从数据库清理 ${config.tagBlacklist.length} 个黑名单标签...`);
            const placeholders = config.tagBlacklist.map(() => '?').join(',');
            const info = db.prepare(`DELETE FROM tags WHERE name IN (${placeholders})`).run(...config.tagBlacklist);
            console.log(`✅ 已从数据库抹除 ${info.changes} 条存量黑名单记录。`);
        } else {
            console.log('[Step 1/4] 未检测到黑名单配置，跳过清理。');
        }

        // 步骤 2: 存量 Tag 深度净化与合并 (处理句号、多余空格、表情符号)
        console.log('[Step 2/5] 正在执行存量 Tag 深度净化与合并...');
        
        // 定义统一的清洗函数（与 KnowledgeBaseManager 保持一致）
        const prepareTag = (text) => {
            const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
            let cleaned = text.replace(/[。.]+$/g, '') // 移除末尾句号
                              .replace(decorativeEmojis, ' ')
                              .replace(/[ \t]+/g, ' ')
                              .replace(/ *\n */g, '\n')
                              .replace(/\n{2,}/g, '\n')
                              .trim();
            return cleaned;
        };

        const allTags = db.prepare("SELECT id, name FROM tags").all();
        let mergeCount = 0;
        let renameCount = 0;

        const transaction = db.transaction(() => {
            for (const tag of allTags) {
                const cleanName = prepareTag(tag.name);
                if (!cleanName || cleanName === tag.name) continue;

                const existing = db.prepare("SELECT id FROM tags WHERE name = ?").get(cleanName);
                if (existing) {
                    // 合并：将旧 Tag 的文件关联转移到新 Tag
                    db.prepare("UPDATE OR IGNORE file_tags SET tag_id = ? WHERE tag_id = ?").run(existing.id, tag.id);
                    // 删除旧的带句号 Tag
                    db.prepare("DELETE FROM tags WHERE id = ?").run(tag.id);
                    mergeCount++;
                } else {
                    // 重命名：直接修改名称，保留原向量
                    db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(cleanName, tag.id);
                    renameCount++;
                }
            }
        });
        transaction();
        console.log(`✅ 净化完成：合并 ${mergeCount} 个重复项，重命名 ${renameCount} 个标签。`);

        // 步骤 3: 自动清理“句子级”怪 Tag (长度熔断)
        console.log('[Step 3/5] 正在清理长度异常的“句子级”标签...');
        const MAX_TAG_LENGTH = 15; // 设定阈值，超过15个字符的标签通常是解析错误
        const longTags = db.prepare("SELECT id, name FROM tags WHERE length(name) > ?").all(MAX_TAG_LENGTH);
        
        if (longTags.length > 0) {
            const deleteLongTag = db.prepare("DELETE FROM tags WHERE id = ?");
            const longTagTransaction = db.transaction(() => {
                for (const tag of longTags) {
                    deleteLongTag.run(tag.id);
                }
            });
            longTagTransaction();
            console.log(`✅ 已自动抹除 ${longTags.length} 个长度超过 ${MAX_TAG_LENGTH} 的异常标签。`);
        } else {
            console.log('✅ 未发现长度异常的标签。');
        }

        // 步骤 4: 删除旧的索引文件
        console.log('[Step 4/5] 正在删除旧的 Tag 索引文件...');
        try {
            await fs.unlink(tagIdxPath);
            console.log('✅ 旧索引文件已移除。');
        } catch (e) {
            console.log('ℹ️ 未发现旧索引文件，准备创建新索引。');
        }

        // 步骤 5: 调用 Rust 引擎重建索引
        console.log('[Step 5/5] 正在通过 Rust 引擎重建索引...');
        const { VexusIndex } = require('./rust-vexus-lite');
        const tagIdx = new VexusIndex(config.dimension, 50000);
        
        // 核心：从清理后的数据库重新加载
        const count = await tagIdx.recoverFromSqlite(dbPath, 'tags', null);
        tagIdx.save(tagIdxPath);
        
        console.log(`\n✨ 重建成功！共索引 ${count} 个合法标签。`);
        console.log(`文件位置: ${tagIdxPath}`);

    } catch (error) {
        console.error('❌ 重建失败:', error);
    } finally {
        db.close();
    }
}

main();