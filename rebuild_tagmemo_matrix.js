// rebuild_tagmemo_matrix.js
// 功能：手动触发 TagMemo 共现矩阵重建 + Rust 内生残差预计算
// 用法：node rebuild_tagmemo_matrix.js
// 适用场景：服务器闲时离线维护，无需启动主服务

const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const config = {
    storePath: path.join(__dirname, 'VectorStore'),
    dbName: 'knowledge_base.sqlite',
    dimension: parseInt(process.env.VECTORDB_DIMENSION) || 3072,
};

async function main() {
    const startTime = Date.now();
    console.log('=== 🧠 TagMemo 共现矩阵 & 内生残差 离线重建工具 ===\n');

    const dbPath = path.join(config.storePath, config.dbName);
    const tagIdxPath = path.join(config.storePath, 'index_global_tags.usearch');

    if (!require('fs').existsSync(dbPath)) {
        console.error('❌ 数据库文件不存在:', dbPath);
        process.exit(1);
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // =========================================================================
    // Step 1: 构建有向序位势能共现矩阵 (复刻 TagMemoEngine.buildDirectedCooccurrenceMatrix)
    // =========================================================================
    console.log('[Step 1/3] 🔗 构建有向共现矩阵...');

    const PHI_MAX = 0.9;
    const PHI_MIN = 0.5;

    // 获取每篇日记的 Tag 数量
    const tagCountStmt = db.prepare(`
        SELECT file_id, COUNT(*) as tag_count
        FROM file_tags
        GROUP BY file_id
    `);
    const tagCounts = new Map();
    for (const row of tagCountStmt.iterate()) {
        tagCounts.set(row.file_id, row.tag_count);
    }

    // 逐文件处理有向共现
    const stmt = db.prepare(`
        SELECT file_id, tag_id, position
        FROM file_tags
        WHERE position > 0
        ORDER BY file_id, position ASC
    `);

    const matrix = new Map();
    let currentFileId = -1;
    let fileTags = [];
    let totalFiles = 0;

    const processFileGroup = (tags) => {
        const n = tags.length;
        if (n < 2 || n > 100) return;

        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const t1 = tags[i];
                const t2 = tags[j];

                const phi1 = n > 1 ? PHI_MAX - (PHI_MAX - PHI_MIN) * (t1.pos - 1) / (n - 1) : PHI_MAX;
                const phi2 = n > 1 ? PHI_MAX - (PHI_MAX - PHI_MIN) * (t2.pos - 1) / (n - 1) : PHI_MAX;
                const weight = phi1 * phi2;

                if (!matrix.has(t1.id)) matrix.set(t1.id, new Map());
                const targetMap = matrix.get(t1.id);
                targetMap.set(t2.id, (targetMap.get(t2.id) || 0) + weight);
            }
        }
    };

    for (const row of stmt.iterate()) {
        if (row.file_id !== currentFileId) {
            if (fileTags.length > 0) {
                processFileGroup(fileTags);
                totalFiles++;
            }
            currentFileId = row.file_id;
            fileTags = [];
        }
        fileTags.push({ id: row.tag_id, pos: row.position });
    }
    if (fileTags.length > 0) {
        processFileGroup(fileTags);
        totalFiles++;
    }

    // 处理旧数据 (position = 0 的回退为无向等权重)
    const legacyStmt = db.prepare(`
        SELECT ft1.tag_id as tag1, ft2.tag_id as tag2, COUNT(ft1.file_id) as cnt
        FROM file_tags ft1
        JOIN file_tags ft2 
            ON ft1.file_id = ft2.file_id 
            AND ft1.tag_id < ft2.tag_id
        WHERE ft1.position = 0 OR ft2.position = 0
        GROUP BY ft1.tag_id, ft2.tag_id
    `);

    const LEGACY_PHI = 0.7;
    let legacyEdges = 0;
    for (const row of legacyStmt.iterate()) {
        const weight = row.cnt * LEGACY_PHI * LEGACY_PHI;

        if (!matrix.has(row.tag1)) matrix.set(row.tag1, new Map());
        if (!matrix.has(row.tag2)) matrix.set(row.tag2, new Map());

        const e1 = matrix.get(row.tag1).get(row.tag2) || 0;
        matrix.get(row.tag1).set(row.tag2, e1 + weight);
        const e2 = matrix.get(row.tag2).get(row.tag1) || 0;
        matrix.get(row.tag2).set(row.tag1, e2 + weight);
        legacyEdges++;
    }

    // 统计
    let totalEdges = 0;
    for (const targets of matrix.values()) totalEdges += targets.size;

    console.log(`✅ 共现矩阵构建完成：${matrix.size} 个源节点, ${totalEdges} 条有向边, ${totalFiles} 个文件, ${legacyEdges} 条旧格式边`);

    // =========================================================================
    // Step 2: Rust 内生残差预计算 (复刻 TagMemoEngine.recomputeIntrinsicResiduals)
    // =========================================================================
    console.log('\n[Step 2/3] ⚡ 通过 Rust 引擎预计算内生残差...');

    let VexusIndex;
    try {
        VexusIndex = require('./rust-vexus-lite').VexusIndex;
    } catch (e) {
        console.error('❌ 无法加载 Rust Vexus 引擎:', e.message);
        db.close();
        process.exit(1);
    }

    // 加载或重建 Tag 索引
    let tagIndex;
    if (require('fs').existsSync(tagIdxPath)) {
        try {
            tagIndex = VexusIndex.load(tagIdxPath, null, config.dimension, 50000);
            console.log('  📂 已从磁盘加载 Tag 索引');
        } catch (e) {
            console.warn('  ⚠️ 磁盘索引加载失败，从 SQLite 重建...');
            tagIndex = new VexusIndex(config.dimension, 50000);
            await tagIndex.recoverFromSqlite(dbPath, 'tags', null);
        }
    } else {
        console.log('  📂 Tag 索引文件不存在，从 SQLite 重建...');
        tagIndex = new VexusIndex(config.dimension, 50000);
        await tagIndex.recoverFromSqlite(dbPath, 'tags', null);
    }

    // 调用 Rust 预计算
    try {
        const result = await tagIndex.computeIntrinsicResiduals(dbPath);
        console.log(`✅ Rust 预计算完成：${result.computedCount} 个已计算, ${result.skippedCount} 个跳过, 耗时 ${result.elapsedMs.toFixed(1)}ms`);
    } catch (e) {
        console.error('❌ Rust 预计算失败:', e.message);
    }

    // =========================================================================
    // Step 3: 验证结果
    // =========================================================================
    console.log('\n[Step 3/3] 📊 验证结果...');

    const tagCount = db.prepare('SELECT COUNT(*) as count FROM tags').get().count;
    const residualCount = db.prepare('SELECT COUNT(*) as count FROM tag_intrinsic_residuals').get().count;
    const fileTagCount = db.prepare('SELECT COUNT(*) as count FROM file_tags').get().count;

    const avgResidual = db.prepare('SELECT AVG(residual_energy) as avg FROM tag_intrinsic_residuals').get().avg;
    const minResidual = db.prepare('SELECT MIN(residual_energy) as min FROM tag_intrinsic_residuals').get().min;
    const maxResidual = db.prepare('SELECT MAX(residual_energy) as max FROM tag_intrinsic_residuals').get().max;

    console.log(`  标签总数:        ${tagCount}`);
    console.log(`  文件-标签关联:   ${fileTagCount}`);
    console.log(`  残差记录数:      ${residualCount} / ${tagCount} (${(residualCount / tagCount * 100).toFixed(1)}%)`);
    if (avgResidual !== null) {
        console.log(`  残差能量分布:    min=${minResidual.toFixed(3)}, avg=${avgResidual.toFixed(3)}, max=${maxResidual.toFixed(3)}`);
    }

    db.close();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✨ 全部完成！总耗时 ${elapsed}s`);
    console.log('💡 提示：重启主服务后，TagMemoEngine 会自动加载最新的残差数据。');
}

main().catch(e => {
    console.error('❌ 脚本执行失败:', e);
    process.exit(1);
});