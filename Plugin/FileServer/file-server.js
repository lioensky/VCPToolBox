// Plugin/FileServer/file-server.js
const express = require('express');
const path = require('path');

let serverFileKeyForAuth; // Stores File_Key from config
let pluginDebugMode = false; // To store the debug mode state for this plugin

/**
 * Registers the file server routes and middleware with the Express app.
 * @param {object} app - The Express application instance.
 * @param {object} pluginConfig - Configuration for this plugin, expecting { File_Key: '...' }.
 * @param {string} projectBasePath - The absolute path to the project's root directory.
 */
function registerRoutes(app, pluginConfig, projectBasePath) {
    pluginDebugMode = pluginConfig && pluginConfig.DebugMode === true; // Set module-level debug mode

    if (pluginDebugMode) console.log(`[FileServerPlugin] Registering routes for FileServer. DebugMode is ON.`);
    else console.log(`[FileServerPlugin] Registering routes for FileServer. DebugMode is OFF.`);

    if (!app || typeof app.use !== 'function') {
        console.error('[FileServerPlugin] Express app instance is required for registerRoutes.');
        return;
    }
    if (!pluginConfig || !pluginConfig.File_Key) {
        console.error('[FileServerPlugin] File_Key configuration is missing for FileServer plugin.');
    }
    serverFileKeyForAuth = pluginConfig.File_Key || null;

    const fileAuthMiddleware = (req, res, next) => {
        if (!serverFileKeyForAuth) {
            console.error("[FileAuthMiddleware] File_Key is not configured in plugin. Denying access.");
            return res.status(500).type('text/plain').send('Server Configuration Error: File key not set for plugin.');
        }
        const pathSegmentWithKey = req.params.pathSegmentWithKey;
        if (pluginDebugMode) console.log(`[FileAuthMiddleware] req.params.pathSegmentWithKey: '${pathSegmentWithKey}'`);

        if (pathSegmentWithKey && pathSegmentWithKey.startsWith('pw=')) {
            const requestFileKey = pathSegmentWithKey.substring(3);
            
            const match = requestFileKey === serverFileKeyForAuth;
            if (pluginDebugMode) console.log(`[FileAuthMiddleware] Key comparison result: ${match}`);

            if (match) {
                if (pluginDebugMode) console.log('[FileAuthMiddleware] Authentication successful.');
                next();
            } else {
                if (pluginDebugMode) console.log('[FileAuthMiddleware] Authentication failed: Invalid key.');
                return res.status(401).type('text/plain').send('Unauthorized: Invalid key for file access.');
            }
        } else {
            if (pluginDebugMode) console.log('[FileAuthMiddleware] Authentication failed: Invalid path format.');
            return res.status(400).type('text/plain').send('Bad Request: Invalid file access path format.');
        }
    };
    
    // Define physical paths
    const globalFileDir = path.join(projectBasePath, 'file');
    const doubaogenDir = path.join(projectBasePath, 'image', 'doubaogen');
    const fluxgenDir = path.join(projectBasePath, 'image', 'fluxgen');

    const staticOptions = {
        dotfiles: 'deny',
        index: false
    };

    // Mount the main 'file' directory at the root of '/files'
    app.use('/:pathSegmentWithKey/files', fileAuthMiddleware, express.static(globalFileDir, staticOptions));

    // Mount the special directories at their respective virtual paths
    app.use('/:pathSegmentWithKey/files/doubaogen', fileAuthMiddleware, express.static(doubaogenDir, staticOptions));
    app.use('/:pathSegmentWithKey/files/fluxgen', fileAuthMiddleware, express.static(fluxgenDir, staticOptions));
    
    const fileKeyForLog = serverFileKeyForAuth || "";
    const maskedFileKey = fileKeyForLog.length > 6
        ? fileKeyForLog.substring(0,3) + "***" + fileKeyForLog.slice(-3)
        : (fileKeyForLog.length > 1 ? fileKeyForLog[0] + "***" + fileKeyForLog.slice(-1) : (fileKeyForLog.length === 1 ? "*" : "NOT_CONFIGURED"));
    
    if (serverFileKeyForAuth) {
        console.log(`[FileServerPlugin] Protected file service registered. Access path format: /pw=${maskedFileKey}/files/...`);
        console.log(`[FileServerPlugin] Serving main directory from: ${globalFileDir}`);
        console.log(`[FileServerPlugin] Serving special directory 'doubaogen' from: ${doubaogenDir}`);
        console.log(`[FileServerPlugin] Serving special directory 'fluxgen' from: ${fluxgenDir}`);
    } else {
        console.warn(`[FileServerPlugin] Protected file service registered BUT File_Key IS NOT CONFIGURED. Access will be denied.`);
    }
}

module.exports = { registerRoutes };