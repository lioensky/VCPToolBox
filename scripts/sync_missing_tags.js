// sync_missing_tags.js
// 功能：扫描所有日记文件，找出数据库中缺失的标签，并生成同步文件触发自动入库
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const config = {
    rootPath: process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, 'dailynote'),
    storePath: process.env.KNOWLEDGEBASE_STORE_PATH || path.join(__dirname, 'VectorStore'),
    ignoreFolders: (process.env.IGNORE_FOLDERS || 'VCP论坛').split(',').map(f => f.trim()).filter(Boolean),
    syncDir: '已整理',
    syncFileName: 'missing_tags_sync.md'
};

// 模拟 KnowledgeBaseManager 的标签提取与清洗逻辑
function extractTags(content) {
    const tagLines = content.match(/Tag:\s*(.+)$/gim);
    if (!tagLines) return [];

    let allTags = [];
    tagLines.forEach(line => {
        const tagContent = line.replace(/Tag:\s*/i, '');
        const splitTags = tagContent.split(/[,，、;|｜]/).map(t => t.trim()).filter(Boolean);
        allTags.push(...splitTags);
    });

    const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
    return [...new Set(allTags.map(t => {
        return t.replace(/[。.]+$/g, '')
                .replace(decorativeEmojis, ' ')
                .replace(/[ \t]+/g, ' ')
                .trim();
    }).filter(t => t.length > 0))];
}

async function walkDir(dir, isRoot = false) {
    let files = [];
    const list = await fs.readdir(dir);
    for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);
        
        if (stat.isDirectory()) {
            // 过滤逻辑：1. 隐藏文件夹 2. 同步专用文件夹 3. IGNORE_FOLDERS (全局)
            if (file.startsWith('.') || file === config.syncDir) continue;
            if (config.ignoreFolders.includes(file)) {
                console.log(`[Skip] 忽略文件夹: ${file}`);
                continue;
            }
            files = files.concat(await walkDir(fullPath, false));
        } else if (fullPath.match(/\.(md|txt)$/i)) {
            files.push(fullPath);
        }
    }
    return files;
}

async function main() {
    console.log('--- 🔍 缺失标签扫描同步工具 ---');
    
    const dbPath = path.join(config.storePath, 'knowledge_base.sqlite');
    if (!fsSync.existsSync(dbPath)) {
        console.error('❌ 数据库不存在');
        return;
    }

    const db = new Database(dbPath);
    const foundTags = new Set();

    try {
        console.log(`[1/3] 正在扫描目录: ${config.rootPath} ...`);
        const files = await walkDir(config.rootPath, true);
        console.log(`找到 ${files.length} 个文本文件。`);

        for (const file of files) {
            try {
                const content = await fs.readFile(file, 'utf-8');
                const tags = extractTags(content);
                tags.forEach(t => foundTags.add(t));
            } catch (e) {
                console.warn(`读取失败 ${file}: ${e.message}`);
            }
        }

        console.log(`[2/3] 提取到 ${foundTags.size} 个唯一标签，正在对比数据库...`);
        const missingTags = [];
        const checkStmt = db.prepare("SELECT id FROM tags WHERE name = ?");
        
        for (const tag of foundTags) {
            const row = checkStmt.get(tag);
            if (!row) {
                missingTags.push(tag);
            }
        }

        if (missingTags.length === 0) {
            console.log('✅ 所有标签均已在库中，无需同步。');
            return;
        }

        console.log(`发现 ${missingTags.length} 个缺失标签。`);

        // [3/3] 生成同步文件
        const syncDirPath = path.join(config.rootPath, config.syncDir);
        if (!fsSync.existsSync(syncDirPath)) {
            await fs.mkdir(syncDirPath, { recursive: true });
        }

        const syncFilePath = path.join(syncDirPath, config.syncFileName);
        const syncContent = `---
title: 标签同步专用文件
description: 此文件由 sync_missing_tags.js 自动生成，用于触发 KnowledgeBaseManager 的自动 Embedding 流程。
updated_at: ${new Date().toLocaleString()}
---

这是一个同步用文件，包含了从存量文件中扫描出的缺失标签。

Tag: ${missingTags.join(', ')}
`;

        await fs.writeFile(syncFilePath, syncContent, 'utf-8');
        console.log(`\n✨ 同步文件已生成: ${syncFilePath}`);
        console.log(`🚀 KnowledgeBaseManager 应该已经检测到变更并开始为这 ${missingTags.length} 个标签生成向量。`);

    } catch (e) {
        console.error('❌ 运行出错:', e);
    } finally {
        db.close();
    }
}

main();