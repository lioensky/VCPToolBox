const express = require('express');

module.exports = function(options) {
    const {
        dailyNoteRootPath,
        knowledgeRootPath,
        DEBUG_MODE,
    } = options;

    const router = express.Router();

    // 日记管理：原有日记目录
    const dailyNotesRoutes = require('../dailyNotesRoutes')(dailyNoteRootPath, DEBUG_MODE, {
        resourceLabel: '日记',
        allowedExtensions: 'md,txt',
        ignoredFolders: 'VectorStore,DebugLog',
    });
    router.use('/dailynotes', dailyNotesRoutes);

    // 知识库管理：独立 knowledge 目录
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
