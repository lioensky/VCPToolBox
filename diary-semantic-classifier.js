#!/usr/bin/env node

/**
 * 日记语义级分类工具 (Diary Semantic Classifier)
 * 
 * 功能：
 * 1. 读取指定源文件夹下的所有日记文件
 * 2. 基于已有向量索引，计算文件与给定分类的语义相似度
 * 3. 将文件自动移动到最匹配的分类文件夹中
 * 4. 自动更新数据库及重建向量索引
 * 
 * 使用方法：
 * node diary-semantic-classifier.js --source "小吉的知识" --categories "分类1,分类2" --filter "小吉的" --dry-run
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const { program } = require('commander');
const crypto = require('crypto');

// 尝试加载 Rust Vexus 引擎 (用于重建索引)
let VexusIndex;
try {
    const vexusModule = require('./rust-vexus-lite');
    VexusIndex = vexusModule.VexusIndex;
} catch (e) {
    console.warn('[Warning] Vexus-Lite engine not found. Index rebuilding might fail.');
}

// 加载环境变量
dotenv.config({ path: path.join(__dirname, 'config.env') });

// 引入 Embedding 工具
const { getEmbeddingsBatch } = require('./EmbeddingUtils');

// 配置
const config = {
    storePath: process.env.KNOWLEDGEBASE_STORE_PATH || path.join(__dirname, 'VectorStore'),
    rootPath: process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, 'dailynote'),
    dbName: 'knowledge_base.sqlite',
    dimension: parseInt(process.env.VECTORDB_DIMENSION) || 3072,
    apiKey: process.env.API_Key,
    apiUrl: process.env.API_URL,
    model: process.env.WhitelistEmbeddingModel || 'google/gemini-embedding-001'
};

// 命令行参数定义
program
    .option('-s, --source <folder>', '源日记本文件夹名称 (相对于 dailynote)', '')
    .option('-c, --categories <list>', '分类列表 (逗号分隔)', '')
    .option('-f, --filter <word>', '分类名净化屏蔽词 (例如 "小吉的")', '')
    .option('-t, --threshold <number>', '相似度阈值 (0-1), 低于此值不分类', '0.3')
    .option('-a, --api-url <url>', '覆盖 API 地址 (例如 http://192.168.1.5:3106)', '')
    .option('-d, --dry-run', '预览模式: 仅显示分类结果，不移动文件', false)
    .parse(process.argv);

const options = program.opts();

// 允许命令行覆盖 API 地址
if (options.apiUrl) {
    config.apiUrl = options.apiUrl;
    console.log(`[Config] API URL overridden: ${config.apiUrl}`);
}

// 工具函数：计算余弦相似度
function cosineSimilarity(vecA, vecB) {
    let dot = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 工具函数：计算加权平均向量
// 简单平均策略：所有 chunk 权重相等 (用户确认)
// 如果未来需要加权，可以在此修改
function computeAggregateVector(vectors) {
    if (!vectors || vectors.length === 0) return null;
    const dim = vectors[0].length;
    const avg = new Float32Array(dim).fill(0);

    for (const vec of vectors) {
        for (let i = 0; i < dim; i++) {
            avg[i] += vec[i];
        }
    }

    // 归一化
    let norm = 0.0;
    for (let i = 0; i < dim; i++) {
        avg[i] /= vectors.length;
        norm += avg[i] * avg[i];
    }
    norm = Math.sqrt(norm);

    if (norm > 1e-9) {
        for (let i = 0; i < dim; i++) {
            avg[i] /= norm;
        }
    }

    return avg;
}

// 主逻辑
async function main() {
    console.log('=== VCP Diary Semantic Classifier ===');

    if (!options.source || !options.categories) {
        console.error('Error: --source and --categories are required.');
        process.exit(1);
    }

    const sourceDir = options.source.trim();
    const categoriesRaw = options.categories.split(/[,，]/).map(c => c.trim()).filter(Boolean);
    const filterWord = options.filter ? options.filter.trim() : '';
    const threshold = parseFloat(options.threshold);
    const isDryRun = options.dryRun;

    console.log(`Source Diary:    [${sourceDir}]`);
    console.log(`Target Categories: ${categoriesRaw.join(', ')}`);
    if (filterWord) console.log(`Filter Word:       "${filterWord}" (will be removed from category names for vectorization)`);
    console.log(`Threshold:       ${threshold}`);
    console.log(`Mode:            ${isDryRun ? 'DRY-RUN (Preview Only)' : 'EXECUTION (Will move files)'}`);
    console.log('-------------------------------------------');

    // 1. 检查数据库连接
    const dbPath = path.join(config.storePath, config.dbName);
    if (!fs.existsSync(dbPath)) {
        console.error(`Error: Database not found at ${dbPath}`);
        process.exit(1);
    }
    const db = new Database(dbPath, { readonly: isDryRun }); // Dry-run 使用只读模式也不完全行，因为我们要读 vector BLOB，但为了安全起见 Dry-run 不写入即可
    console.log(`[Database] Connected to ${config.dbName}`);

    try {
        // 2. 准备分类向量
        // 净化分类名称
        const categoriesCleaned = categoriesRaw.map(c => {
            return filterWord ? c.replace(new RegExp(filterWord, 'g'), '') : c;
        });

        console.log(`[Embedding] Vectorizing ${categoriesCleaned.length} categories...`);
        // 使用 EmbeddingUtils 获取向量
        const categoryVectors = await getEmbeddingsBatch(categoriesCleaned, {
            apiKey: config.apiKey,
            apiUrl: config.apiUrl,
            model: config.model
        });

        if (categoryVectors.length !== categoriesRaw.length) {
            throw new Error('Failed to vectorize all categories.');
        }

        // 3. 读取源文件及其向量
        console.log(`[Database] Fetching files from diary "${sourceDir}"...`);
        const filesStmt = db.prepare('SELECT id, path FROM files WHERE diary_name = ?');
        const files = filesStmt.all(sourceDir);

        if (files.length === 0) {
            console.log('No files found in source diary.');
            return;
        }

        const chunksStmt = db.prepare('SELECT vector FROM chunks WHERE file_id = ? ORDER BY chunk_index ASC');

        const tasks = [];
        const moves = []; // 记录需要移动的操作 { fileId, oldPath, newPath, newDiaryName, score, category }

        console.log(`[Analysis] Analyzing ${files.length} files...`);

        for (const file of files) {
            const chunkRows = chunksStmt.all(file.id);
            if (chunkRows.length === 0) {
                console.warn(`Skipping ${file.path} (No vector chunks found)`);
                continue;
            }

            // 转换 BLOB 为 Float32Array
            const vectors = chunkRows.map(row => {
                return new Float32Array(row.vector.buffer, row.vector.byteOffset, config.dimension);
            });

            // 计算该文件的聚合向量
            const fileVec = computeAggregateVector(vectors);
            if (!fileVec) continue;

            // 与每个分类对比
            let bestScore = -1;
            let bestIdx = -1;

            for (let i = 0; i < categoryVectors.length; i++) {
                const catVec = new Float32Array(categoryVectors[i]);
                const score = cosineSimilarity(fileVec, catVec);
                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            }

            const fileName = path.basename(file.path);

            if (bestScore >= threshold && bestIdx !== -1) {
                const bestCategory = categoriesRaw[bestIdx]; // 使用原始分类名作为文件夹名

                // 构造新路径
                // 假设 file.path 是相对路径 (例如 "小吉的知识/test.md")
                // 目标路径: "小吉的知识/小吉的社会学/test.md" 还是 "dailynote/小吉的社会学/test.md"?
                // 需求描述： "把整理后的日记文件放到 dailynote/下对应的文件夹里"
                // 也就是说，目标文件夹是同级的日记本，而不是子文件夹。
                // 比如源是 "dailynote/Source", 目标是 "dailynote/TargetCategory"

                const newDiaryName = bestCategory; // 新日记本名称即为分类名
                const newRelPath = path.join(newDiaryName, fileName);

                tasks.push({
                    file: file,
                    fileName: fileName,
                    bestCategory: bestCategory,
                    score: bestScore,
                    newDiaryName: newDiaryName,
                    newRelPath: newRelPath
                });
            } else {
                console.log(`  [Keep] ${fileName} (Max Score: ${bestScore.toFixed(3)} < ${threshold})`);
            }
        }

        // 4. 执行移动
        console.log('\n--- Classification Results ---');
        const affectedDiaryNames = new Set();
        affectedDiaryNames.add(sourceDir); // 源日记本肯定受影响

        for (const task of tasks) {
            if (task.score >= threshold) {
                console.log(`  [Move] ${task.fileName} -> [${task.bestCategory}] (Score: ${task.score.toFixed(3)})`);

                if (!isDryRun) {
                    const fullOldPath = path.join(config.rootPath, task.file.path);
                    const fullNewDir = path.join(config.rootPath, task.bestCategory);
                    const fullNewPath = path.join(config.rootPath, task.newRelPath);

                    // 1. 物理移动
                    try {
                        if (!fs.existsSync(fullNewDir)) {
                            await fsPromises.mkdir(fullNewDir, { recursive: true });
                        }

                        // 检查目标是否存在
                        if (fs.existsSync(fullNewPath)) {
                            console.error(`    ❌ Error: Target file already exists: ${task.newRelPath}`);
                            continue;
                        }

                        // 移动文件
                        await fsPromises.rename(fullOldPath, fullNewPath);

                        // 2. 更新数据库
                        // 更新 files 表中的 path 和 diary_name
                        const updateStmt = db.prepare('UPDATE files SET path = ?, diary_name = ? WHERE id = ?');
                        updateStmt.run(task.newRelPath, task.newDiaryName, task.file.id);

                        affectedDiaryNames.add(task.newDiaryName);

                    } catch (err) {
                        console.error(`    ❌ Failed to move file: ${err.message}`);
                    }
                }
            }
        }

        // 5. 重建索引 (仅 Execution 模式)
        if (!isDryRun && tasks.length > 0) {
            console.log('\n--- Rebuilding Indexes ---');

            // 需要重建源日记本索引 + 所有涉及到的目标日记本索引
            for (const diaryName of affectedDiaryNames) {
                console.log(`Rebuilding index for diary: "${diaryName}"...`);
                const safeName = crypto.createHash('md5').update(diaryName).digest('hex');
                const idxPath = path.join(config.storePath, `index_diary_${safeName}.usearch`);

                // 删除旧索引
                if (fs.existsSync(idxPath)) {
                    fs.unlinkSync(idxPath);
                }

                // 重建索引
                if (VexusIndex) {
                    try {
                        const idx = new VexusIndex(config.dimension, 50000);
                        const count = await idx.recoverFromSqlite(dbPath, 'chunks', diaryName);
                        idx.save(idxPath);
                        console.log(`  ✅ Done. Indexed ${count} vectors.`);
                    } catch (e) {
                        console.error(`  ❌ Failed to rebuild index for ${diaryName}:`, e.message);
                    }
                } else {
                    console.warn(`  ⚠️ Vexus-Lite not loaded, cannot rebuild index for ${diaryName}. Please run rebuild_vector_indexes.js manually.`);
                }
            }
        } else if (isDryRun) {
            console.log('\n[Dry-Run] No files moved, no DB changes, no index updates.');
        }

    } catch (error) {
        console.error('Fatal Error:', error);
    } finally {
        if (db) db.close();
        console.log('\nDone.');
    }
}

main().catch(console.error);
