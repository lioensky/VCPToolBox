const express = require('express');

module.exports = function(options) {
    const {
        dailyNoteRootPath,
        knowledgeRootPath,
        DEBUG_MODE,
        vectorDBManager,
    } = options;

    const router = express.Router();

    // 日记管理：文件变更交给持有 SQLite/Rust 索引的主进程协调器。
    // 使用显式依赖注入，避免通用路由自行加载 KnowledgeBaseManager，
    // 也避免独立 adminServer 意外创建第二套进程级“单例”。
    const runExternalFileMutation = (
        vectorDBManager
        && typeof vectorDBManager.runExternalFileMutation === 'function'
    )
        ? vectorDBManager.runExternalFileMutation.bind(vectorDBManager)
        : null;
    const dailyNotesRoutes = require('../dailyNotesRoutes')(dailyNoteRootPath, DEBUG_MODE, {
        resourceLabel: '日记',
        allowedExtensions: 'md,txt',
        ignoredFolders: 'VectorStore,DebugLog',
        runExternalFileMutation,
    });
    router.use('/dailynotes', dailyNotesRoutes);

    // 知识库管理：独立 knowledge 目录不属于热日记 KnowledgeBaseManager.rootPath，
    // 不注入热记忆协调器，避免错误地把冷知识文件送入日记 SQLite。
    if (knowledgeRootPath) {
        const knowledgeRoutes = require('../dailyNotesRoutes')(knowledgeRootPath, DEBUG_MODE, {
            resourceLabel: '知识库',
            allowedExtensions: 'md,txt,json,html,pdf',
            ignoredFolders: 'VectorStore,DebugLog,TDBdocs',
        });
        router.use('/knowledge', knowledgeRoutes);
    }

    return router;
};
