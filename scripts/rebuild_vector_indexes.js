// rebuild_vector_indexes.js
// Description: A utility script to safely delete and rebuild all Vexus vector indexes from the SQLite database.
// This is the most reliable way to fix "ghost ID" issues and ensure data synchronization.
// Usage: node rebuild_vector_indexes.js

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// 尝试加载 Rust Vexus 引擎
let VexusIndex;
try {
    const vexusModule = require('../rust-vexus-lite');
    VexusIndex = vexusModule.VexusIndex;
    console.log('[RepairScript] 🦀 Vexus-Lite Rust engine loaded');
} catch (e) {
    console.error('[RepairScript] ❌ Critical: Vexus-Lite not found. Please run `npm install` in `rust-vexus-lite` directory.');
    process.exit(1);
}

const config = {
    storePath: path.join(__dirname, '..', 'VectorStore'),
    dbName: 'knowledge_base.sqlite',
    // ⚠️ 确保这个维度与您的模型和配置一致
    dimension: parseInt(process.env.VECTORDB_DIMENSION) || 3072,
};

async function main() {
    console.log('--- Vector Index Rebuild Script ---');
    console.log(`Store Path: ${config.storePath}`);

    // 1. 删除所有旧的 .usearch 文件
    try {
        const files = await fs.readdir(config.storePath);
        const usearchFiles = files.filter(f => f.endsWith('.usearch'));
        if (usearchFiles.length === 0) {
            console.log('[Step 1/3] No old .usearch files found to delete.');
        } else {
            await Promise.all(usearchFiles.map(f => fs.unlink(path.join(config.storePath, f))));
            console.log(`[Step 1/3] ✅ Successfully deleted ${usearchFiles.length} old index files.`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
             console.log('[Step 1/3] VectorStore directory does not exist, nothing to delete.');
        } else {
            console.error('[Step 1/3] ❌ Error deleting old index files:', error);
            return;
        }
    }

    // 2. 连接数据库
    const dbPath = path.join(config.storePath, config.dbName);
    if (!require('fs').existsSync(dbPath)) {
        console.error(`[Step 2/3] ❌ Database file not found at ${dbPath}. Cannot rebuild.`);
        return;
    }
    const db = new Database(dbPath);
    console.log('[Step 2/3] ✅ Successfully connected to SQLite database.');

    // 3. 重建索引
    console.log('[Step 3/3] Starting index rebuild process...');
    let diariesRebuilt = 0;
    let tagsRebuilt = 0;

    try {
        // 重建日记本索引
        const diaries = db.prepare('SELECT DISTINCT diary_name FROM files').all();
        for (const diary of diaries) {
            const diaryName = diary.diary_name;
            const safeName = crypto.createHash('md5').update(diaryName).digest('hex');
            const idxPath = path.join(config.storePath, `index_diary_${safeName}.usearch`);
            
            console.log(`  -> Rebuilding index for diary: "${diaryName}"...`);
            const idx = new VexusIndex(config.dimension, 50000); // 使用默认容量
            const count = await idx.recoverFromSqlite(dbPath, 'chunks', diaryName);
            idx.save(idxPath);
            console.log(`     Done. Indexed ${count} vectors.`);
            diariesRebuilt++;
        }

        // 重建全局 Tag 索引
        console.log('  -> Rebuilding global tag index...');
        const tagIdxPath = path.join(config.storePath, 'index_global_tags.usearch');
        const tagIdx = new VexusIndex(config.dimension, 50000);
        const tagCount = await tagIdx.recoverFromSqlite(dbPath, 'tags', null);
        tagIdx.save(tagIdxPath);
        console.log(`     Done. Indexed ${tagCount} tags.`);
        tagsRebuilt = 1;

    } catch (error) {
        console.error('❌ An error occurred during the rebuild process:', error);
    } finally {
        db.close();
        console.log('--- Rebuild Complete ---');
        console.log(`✅ Rebuilt ${diariesRebuilt} diary indexes and ${tagsRebuilt} global tag index.`);
        console.log('You can now safely restart the VCP server.');
    }
}

main().catch(console.error);