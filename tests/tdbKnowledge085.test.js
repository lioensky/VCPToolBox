'use strict';

/**
 * TriviumDB 0.8.5 与 TDBKnowledge 集成及加固功能测试
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TriviumDB } = require('triviumdb');

async function runTests() {
    console.log('[Test] 🚀 开始测试 TriviumDB 0.8.5 集成与加固特性...');

    const tempDir = path.join(os.tmpdir(), `vcp_tdb_test_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const dbPath = path.join(tempDir, 'test_lib.tdb');

    try {
        // 1. 测试构造函数与 0.8.5 options 参数初始化
        const dim = 4;
        const db = new TriviumDB(dbPath, {
            dim,
            dtype: 'f32',
            syncMode: 'normal',
            storageMode: 'mmap',
            autoBuildQuiver: false,
            loadTextIndex: true,
            expectedNodes: 100,
            memoryLimitMb: 64
        });
        assert(db, 'TriviumDB 实例创建失败');
        console.log('[Test] ✅ 1. TriviumDB 0.8.5 实例创建成功');

        // 2. 测试 batchInsert 批量入库
        const v1 = [0.1, 0.2, 0.3, 0.4];
        const v2 = [0.2, 0.3, 0.4, 0.5];
        const v3 = [0.9, 0.8, 0.7, 0.6];
        const payloads = [
            { type: 'chunk', source_path: 'doc1.md', chunk_index: 0, title: 'Guide' },
            { type: 'chunk', source_path: 'doc1.md', chunk_index: 1, title: 'Guide' },
            { type: 'chunk', source_path: 'doc2.md', chunk_index: 0, title: 'API' }
        ];
        const ids = db.batchInsert([v1, v2, v3], payloads);
        assert.strictEqual(ids.length, 3, 'batchInsert 节点数量不符');
        console.log('[Test] ✅ 2. batchInsert 批量写入成功，IDs:', ids);

        // 3. 测试 link 拓扑边创建
        db.link(ids[0], ids[1], 'next', 0.8);
        db.link(ids[1], ids[0], 'prev', 0.8);
        console.log('[Test] ✅ 3. 知识图谱链接 (link) 成功');

        // 4. 测试 indexText 与 indexKeyword
        db.indexText(ids[0], 'Hello world welcome to TriviumDB guide');
        db.indexText(ids[1], 'Deep knowledge and advanced vector graph engine');
        db.indexText(ids[2], 'Trivium API reference and queries');

        if (typeof db.indexKeyword === 'function') {
            db.indexKeyword(ids[0], 'Guide');
            db.indexKeyword(ids[2], 'API');
            console.log('[Test] ✅ 4. AC 自动机 indexKeyword 建立成功');
        }

        db.buildTextIndex();
        console.log('[Test] ✅ 5. buildTextIndex 索引构建成功');

        // 5. 测试 searchHybrid 带 payload_filter
        const filter = { source_path: { $eq: 'doc1.md' } };
        const hitsWithFilter = db.searchHybrid(v1, 'guide', 10, 1, 0.0, 0.7, filter);
        assert(Array.isArray(hitsWithFilter), 'searchHybrid 返回值不是数组');
        assert(hitsWithFilter.length > 0, '带过滤的混合检索应有召回');
        for (const hit of hitsWithFilter) {
            assert.strictEqual(hit.payload.source_path, 'doc1.md', 'payloadFilter 预过滤应准确生效');
        }
        console.log(`[Test] ✅ 6. searchHybrid 配合 0.8.5 payload_filter 检索命中 ${hitsWithFilter.length} 条，过滤验证通过`);

        // 6. 测试 querySubgraph
        if (typeof db.querySubgraph === 'function') {
            const sub = db.querySubgraph(ids[0], {
                minDepth: 1,
                maxDepth: 2,
                direction: 'both'
            });
            assert(sub && Array.isArray(sub.nodes), 'querySubgraph 结果不合法');
            console.log(`[Test] ✅ 7. querySubgraph 子图提取成功，包含 ${sub.nodes.length} 个节点，${sub.edges.length} 条边`);
        }

        // 7. 测试 TQL
        if (typeof db.tql === 'function') {
            const tqlRes = db.tql('MATCH (n) RETURN n.id, n.type LIMIT 5');
            console.log('[Test] ✅ 8. TQL 查询执行成功:', typeof tqlRes === 'object' ? JSON.stringify(tqlRes).slice(0, 100) : tqlRes);
        }

        // 8. 测试 compact 与 flush
        if (typeof db.compact === 'function') {
            db.compact();
            console.log('[Test] ✅ 9. compact() 碎片整理成功');
        }
        db.flush();
        console.log('[Test] ✅ 10. flush() 磁盘同步成功');

        // 验证主 .tdb 文件已生成并存在
        assert(fs.existsSync(dbPath), '.tdb 数据库主文件应在 flush 后立即落盘');
        const stats = fs.statSync(dbPath);
        assert(stats.size > 0, '.tdb 数据库文件大小应大于 0');
        console.log(`[Test] ✅ 11. 磁盘验证通过: ${dbPath} 大小为 ${stats.size} 字节`);

        db.close();
        console.log('[Test] ✅ 12. close() 资源释放成功');

        console.log('\n🎉 所有 TriviumDB 0.8.5 功能与加固测试全部通过！');
    } finally {
        // 清理测试临时文件
        try {
            const files = fs.readdirSync(tempDir);
            for (const f of files) {
                try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {}
            }
            try { fs.rmdirSync(tempDir); } catch (_) {}
        } catch (_) {}
    }
}

runTests().catch(err => {
    console.error('[Test] ❌ 测试失败:', err);
    process.exit(1);
});
