const express = require('express');
const fs = require('fs').promises;
const path = require('path');

/**
 * Admin Panel API Routes
 * This file has been modularized. individual route handlers are located in ./admin/*.js
 */
module.exports = function (DEBUG_MODE, dailyNoteRootPath, pluginManager, getCurrentServerLogPath, vectorDBManager, agentDirPath, cachedEmojiLists, tvsDirPath, triggerRestart) {
    if (!agentDirPath || typeof agentDirPath !== 'string') {
        throw new Error('[AdminPanelRoutes] agentDirPath must be a non-empty string');
    }
    if (!tvsDirPath || typeof tvsDirPath !== 'string') {
        throw new Error('[AdminPanelRoutes] tvsDirPath must be a non-empty string');
    }
    if (typeof triggerRestart !== 'function') {
        console.warn('[AdminPanelRoutes] triggerRestart callback not provided or not a function. Restarts will fall back to process.exit(1).');
    }

    const adminApiRouter = express.Router();

    // Dependencies to be passed to each module
    const options = {
        DEBUG_MODE,
        dailyNoteRootPath,
        pluginManager,
        getCurrentServerLogPath,
        vectorDBManager,
        agentDirPath,
        cachedEmojiLists,
        tvsDirPath,
        triggerRestart
    };

    /**
     * Helper to mount a module's router
     * @param {string} mountPath - The base path for this module
     * @param {string} moduleName - The filename in ./admin/
     */
    const mount = (mountPath, moduleName) => {
        try {
            const modulePath = path.join(__dirname, 'admin', `${moduleName}.js`);
            const routeHandler = require(modulePath)(options);
            adminApiRouter.use(mountPath, routeHandler);
        } catch (error) {
            console.error(`[AdminPanelRoutes] Failed to load module "${moduleName}" at "${mountPath}":`, error);
        }
    };

    // =========================================================================
    // Mounting Modules
    // Use flat mounting ('/') for most modules to maintain backward compatibility
    // with original route names that already include their own prefixes.
    // =========================================================================

    mount('/', 'system');             // Handles /system-monitor/*, /user-auth-code, /weather
    mount('/', 'logs');               // Handles /logs/*
    mount('/', 'config');             // Handles /tool-approval-config, /config/main
    mount('/', 'plugins');            // Handles /plugins/*, /preprocessors/*
    mount('/', 'server');             // Handles /verify-login, /logout, /check-auth, /server/restart
    mount('/', 'cache');              // Handles /multimodal-cache/*, /image-cache/*
    mount('/', 'toolbox');            // Handles /toolbox/*
    mount('/', 'agents');             // Handles /agents/*
    mount('/', 'tvs');                // Handles /tvsvars/*
    mount('/', 'placeholders');       // Handles /placeholders
    mount('/', 'schedules');          // Handles /schedules/*
    mount('/', 'rag');                // Handles /rag-tags, /rag-params, /available-clusters, etc.
    mount('/', 'agentAssistant');     // Handles /agent-assistant/*
    mount('/', 'taskAssistant');     // Handles /task-assistant/*
    mount('/', 'toolListEditor');     // Handles /tool-list/*
    mount('/', 'dream');              // Handles /dream-logs/*, /dream-operation/*
    mount('/', 'dailyNotes');         // Wrapper for existing dailyNotesRoutes (Handles /dailynotes/*)
    mount('/', 'newapiMonitor');      // Handles /newapi-monitor/*
    mount('/', 'sarPrompts');         // Handles /sarprompts/*
    mount('/', 'emojis');             // Handles /emojis/*

    return adminApiRouter;
};