// repair_database.js (v2 - No Re-embedding Required)
// Description: A script to detect, merge duplicate tags in the SQLite DB,
// and surgically remove the corresponding vectors from the .usearch index file.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

console.log('VCP Knowledge Base Database & Index Repair Tool (Cost-Saving Version)');
console.log('====================================================================\n');

// --- Vexus Index Loader ---
let VexusIndex;
try {
    const vexusModule = require('./rust-vexus-lite');
    VexusIndex = vexusModule.VexusIndex;
    console.log('✅ Vexus-Lite Rust engine loaded.');
} catch (e) {
    console.error('❌ Critical: Vexus-Lite not found. Cannot proceed with index repair.');
    console.error('   Please ensure `rust-vexus-lite` is correctly installed.');
    process.exit(1);
}

// This function must be an exact copy of the one in KnowledgeBaseManager.js
function _prepareTextForEmbedding(text) {
    const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
    let cleaned = text.replace(decorativeEmojis, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length === 0 ? '[EMPTY_CONTENT]' : cleaned;
}

const storePath = path.join(__dirname, 'VectorStore');
const dbPath = path.join(storePath, 'knowledge_base.sqlite');
const tagIdxPath = path.join(storePath, 'index_global_tags.usearch');

let db;
let tagIndex;

try {
    db = new Database(dbPath);
    console.log(`✅ Successfully connected to database at: ${dbPath}`);
} catch (error) {
    console.error(`❌ Failed to connect to the database. Make sure the path is correct.`);
    console.error(error.message);
    process.exit(1);
}

// --- Main Repair Logic ---
try {
    // [Phase 1] Analyze tags for duplicates
    console.log('\n[Phase 1/4] Analyzing tags for duplicates after cleaning...');
    const allTags = db.prepare('SELECT id, name FROM tags').all();
    const cleanedTagsMap = new Map();

    for (const tag of allTags) {
        const cleanedName = _prepareTextForEmbedding(tag.name);
        if (cleanedName === '[EMPTY_CONTENT]') continue;
        if (!cleanedTagsMap.has(cleanedName)) {
            cleanedTagsMap.set(cleanedName, []);
        }
        cleanedTagsMap.get(cleanedName).push({ id: tag.id, originalName: tag.name });
    }

    const duplicates = Array.from(cleanedTagsMap.values()).filter(tags => tags.length > 1);

    if (duplicates.length === 0) {
        console.log('✅ No duplicate tags found. Your database and index are clean!');
        db.close();
        process.exit(0);
    }

    // [Phase 2] Merge duplicates in the database
    console.log(`\n[Phase 2/4] Found ${duplicates.length} sets of duplicate tags. Starting DB merge...`);
    const allDuplicateIds = [];

    const mergeTransaction = db.transaction(() => {
        for (const group of duplicates) {
            group.sort((a, b) => a.id - b.id);
            const canonicalTag = group[0];
            const duplicateTags = group.slice(1);
            const duplicateIds = duplicateTags.map(t => t.id);
            allDuplicateIds.push(...duplicateIds);

            console.log(`\nMerging group: "${canonicalTag.originalName}" (ID: ${canonicalTag.id})`);
            duplicateTags.forEach(dup => console.log(`  - Merging duplicate: "${dup.originalName}" (ID: ${dup.id})`));

            const placeholders = duplicateIds.map(() => '?').join(',');
            
            const updateStmt = db.prepare(`UPDATE file_tags SET tag_id = ? WHERE tag_id IN (${placeholders}) AND file_id NOT IN (SELECT file_id FROM file_tags WHERE tag_id = ?)`);
            const updateResult = updateStmt.run(canonicalTag.id, ...duplicateIds, canonicalTag.id);
            console.log(`  - Remapped ${updateResult.changes} file-tag relationships.`);

            const deleteStmt = db.prepare(`DELETE FROM tags WHERE id IN (${placeholders})`);
            const deleteResult = deleteStmt.run(...duplicateIds);
            console.log(`  - Deleted ${deleteResult.changes} duplicate tag entries from DB.`);
            
            const cleanupStmt = db.prepare(`DELETE FROM file_tags WHERE tag_id IN (${placeholders})`);
            cleanupStmt.run(...duplicateIds);
        }
    });

    mergeTransaction();
    console.log('✅ Database merge complete.');

    // [Phase 3] Surgically remove vectors from the index file
    console.log('\n[Phase 3/4] Removing corresponding vectors from the tag index file...');
    if (!fs.existsSync(tagIdxPath)) {
        console.warn(`⚠️ Tag index file not found at ${tagIdxPath}. Skipping index repair.`);
        console.warn(`   A new index will be created when you next start the server.`);
    } else {
        try {
            // It's crucial to know the dimension. We'll read it from the environment or use the default.
            const dimension = parseInt(process.env.VECTORDB_DIMENSION) || 3072;
            tagIndex = VexusIndex.load(tagIdxPath, null, dimension, 50000); // Capacity can be a safe default
            
            let removedCount = 0;
            for (const id of allDuplicateIds) {
                try {
                    tagIndex.remove(id);
                    removedCount++;
                } catch (removeError) {
                    // Ignore errors if the key doesn't exist, which is possible.
                }
            }
            console.log(`  - Removed ${removedCount} vectors from the index object in memory.`);

            // [Phase 4] Save the repaired index
            console.log('\n[Phase 4/4] Saving the repaired index file to disk...');
            tagIndex.save(tagIdxPath);
            console.log(`✅ Successfully saved repaired index to: ${tagIdxPath}`);

        } catch (indexError) {
            console.error('❌ An error occurred during index repair:', indexError.message);
            console.error('   Please delete the file `VectorStore/index_global_tags.usearch` manually and restart the server to rebuild it.');
        }
    }

} catch (error) {
    console.error('\n❌ An error occurred during the repair process:');
    console.error(error.message);
    if (error.stack) console.error(error.stack);
} finally {
    if (db) {
        db.close();
        console.log('\nDatabase connection closed.');
    }
}

console.log('\nRepair process finished. You can now safely restart your server.');