// Plugin/ImageServer/image-server.js
const express = require('express');
const path = require('path');

let serverImageKeyForAuth; // Stores Image_Key from config
let pluginDebugMode = false; // To store the debug mode state for this plugin

/**
 * Registers the image server routes and middleware with the Express app.
 * @param {object} app - The Express application instance.
 * @param {object} pluginConfig - Configuration for this plugin, expecting { Image_Key: '...' }.
 * @param {string} projectBasePath - The absolute path to the project's root directory.
 */
function registerRoutes(app, pluginConfig, projectBasePath) {
    pluginDebugMode = pluginConfig && pluginConfig.DebugMode === true; // Set module-level debug mode

    if (pluginDebugMode) console.log(`[ImageServerPlugin] Registering routes for ImageServer. DebugMode is ON.`);
    else console.log(`[ImageServerPlugin] Registering routes for ImageServer. DebugMode is OFF.`); // Optional: log when off

    if (!app || typeof app.use !== 'function') {
        console.error('[ImageServerPlugin] Express app instance is required for registerRoutes.');
        return;
    }
    if (!pluginConfig || !pluginConfig.Image_Key) {
        console.error('[ImageServerPlugin] Image_Key configuration is missing for ImageServer plugin.');
        // Fallback or strict error? For now, let it proceed but log heavily.
        // It won't be secure if Image_Key is missing.
        // return; // Or throw new Error('Image_Key configuration is missing for ImageServer plugin.');
    }
    serverImageKeyForAuth = pluginConfig.Image_Key || null;

    const imageAuthMiddleware = (req, res, next) => {
        // console.log('[ImageAuthMiddleware] Triggered.'); // Redundant if other logs exist
        // console.log(`[ImageAuthMiddleware] serverImageKeyForAuth at time of auth: '${serverImageKeyForAuth}' (Type: ${typeof serverImageKeyForAuth})`); // Sensitive

        if (!serverImageKeyForAuth) {
            console.error("[ImageAuthMiddleware] Image_Key is not configured in plugin. Denying access.");
            return res.status(500).type('text/plain').send('Server Configuration Error: Image key not set for plugin.');
        }
        const pathSegmentWithKey = req.params.pathSegmentWithKey;
        if (pluginDebugMode) console.log(`[ImageAuthMiddleware] req.params.pathSegmentWithKey: '${pathSegmentWithKey}'`);

        if (pathSegmentWithKey && pathSegmentWithKey.startsWith('pw=')) {
            const requestImageKey = pathSegmentWithKey.substring(3);
            // console.log(`[ImageAuthMiddleware] Extracted requestImageKey: '${requestImageKey}' (Type: ${typeof requestImageKey})`); // Potentially sensitive if key is guessed or logged elsewhere
            
            const match = requestImageKey === serverImageKeyForAuth;
            if (pluginDebugMode) console.log(`[ImageAuthMiddleware] Key comparison result: ${match}`);

            if (match) {
                if (pluginDebugMode) console.log('[ImageAuthMiddleware] Authentication successful.');
                next();
            } else {
                if (pluginDebugMode) console.log('[ImageAuthMiddleware] Authentication failed: Invalid key.');
                return res.status(401).type('text/plain').send('Unauthorized: Invalid key for image access.');
            }
        } else {
            if (pluginDebugMode) console.log('[ImageAuthMiddleware] Authentication failed: Invalid path format (does not start with pw= or pathSegmentWithKey is missing).');
            return res.status(400).type('text/plain').send('Bad Request: Invalid image access path format.');
        }
    };
    
    // Determine the correct path to the global 'image' directory from the project root
    const globalImageDir = path.join(projectBasePath, 'image');

    app.use('/:pathSegmentWithKey/images', imageAuthMiddleware, express.static(globalImageDir)); // Reverted to 'images'
    
    const imageKeyForLog = serverImageKeyForAuth || "";
    const maskedImageKey = imageKeyForLog.length > 6
        ? imageKeyForLog.substring(0,3) + "***" + imageKeyForLog.slice(-3)
        : (imageKeyForLog.length > 1 ? imageKeyForLog[0] + "***" + imageKeyForLog.slice(-1) : (imageKeyForLog.length === 1 ? "*" : "NOT_CONFIGURED"));
    
    if (serverImageKeyForAuth) {
        console.log(`[ImageServerPlugin] Protected image service registered. Access path format: /pw=${maskedImageKey}/images/... serving from ${globalImageDir}`); // Reverted to 'images'
    } else {
        console.warn(`[ImageServerPlugin] Protected image service registered BUT Image_Key IS NOT CONFIGURED. Access will be denied.`);
    }
}

module.exports = { registerRoutes };