// check_tagmemo_status.js
// 用法：node check_tagmemo_status.js
// 快速查看 TagMemo 残差表的更新时间和基本统计

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'VectorStore', 'knowledge_base.sqlite');

if (!require('fs').existsSync(dbPath)) {
    console.error('❌ 数据库不存在:', dbPath);
    process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const tagCount = db.prepare('SELECT COUNT(*) as c FROM tags').get().c;
const fileTagCount = db.prepare('SELECT COUNT(*) as c FROM file_tags').get().c;
const residualCount = db.prepare('SELECT COUNT(*) as c FROM tag_intrinsic_residuals').get().c;

console.log('=== TagMemo 状态 ===');
console.log(`标签总数:        ${tagCount}`);
console.log(`文件-标签关联:   ${fileTagCount}`);
console.log(`残差记录数:      ${residualCount} / ${tagCount} (${tagCount > 0 ? (residualCount / tagCount * 100).toFixed(1) : 0}%)`);

if (residualCount > 0) {
    const time = db.prepare('SELECT MIN(computed_at) as oldest, MAX(computed_at) as newest FROM tag_intrinsic_residuals').get();
    const stats = db.prepare('SELECT MIN(residual_energy) as min, AVG(residual_energy) as avg, MAX(residual_energy) as max FROM tag_intrinsic_residuals').get();

    console.log(`\n最后计算时间:    ${time.newest} (UTC)`);
    if (time.oldest !== time.newest) {
        console.log(`最早记录时间:    ${time.oldest} (UTC)`);
    }
    console.log(`残差能量:        min=${stats.min.toFixed(3)}, avg=${stats.avg.toFixed(3)}, max=${stats.max.toFixed(3)}`);
} else {
    console.log('\n⚠️ 残差表为空，尚未执行过预计算。');
}

db.close();