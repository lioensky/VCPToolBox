// Plugin/ImageServer/image-server.js
const express = require('express');
const path = require('path');

let serverImageKeyForAuth; // Stores Image_Key from config
let serverFileKeyForAuth; // Stores File_Key from config
let pluginDebugMode = false; // To store the debug mode state for this plugin

/**
 * Creates an authentication middleware.
 * @param {() => string} getKey - A function that returns the correct key for authentication.
 * @param {string} serviceType - A string like 'Image' or 'File' for logging.
 * @returns {function} Express middleware.
 */
function createAuthMiddleware(getKey, serviceType) {
    return (req, res, next) => {
        const correctKey = getKey();
        if (!correctKey) {
            console.error(`[${serviceType}AuthMiddleware] ${serviceType} Key is not configured in plugin. Denying access.`);
            return res.status(500).type('text/plain').send(`Server Configuration Error: ${serviceType} key not set for plugin.`);
        }

        const pathSegmentWithKey = req.params.pathSegmentWithKey;
        if (pluginDebugMode) console.log(`[${serviceType}AuthMiddleware] req.params.pathSegmentWithKey: '${pathSegmentWithKey}'`);

        if (pathSegmentWithKey && pathSegmentWithKey.startsWith('pw=')) {
            const requestKey = pathSegmentWithKey.substring(3);
            
            const match = requestKey === correctKey;
            if (pluginDebugMode) console.log(`[${serviceType}AuthMiddleware] Key comparison result: ${match}`);

            if (match) {
                if (pluginDebugMode) console.log(`[${serviceType}AuthMiddleware] Authentication successful.`);
                next();
            } else {
                if (pluginDebugMode) console.log(`[${serviceType}AuthMiddleware] Authentication failed: Invalid key.`);
                return res.status(401).type('text/plain').send(`Unauthorized: Invalid key for ${serviceType.toLowerCase()} access.`);
            }
        } else {
            if (pluginDebugMode) console.log(`[${serviceType}AuthMiddleware] Authentication failed: Invalid path format.`);
            return res.status(400).type('text/plain').send(`Bad Request: Invalid ${serviceType.toLowerCase()} access path format.`);
        }
    };
}


/**
 * Registers the image and file server routes and middleware with the Express app.
 * @param {object} app - The Express application instance.
 * @param {object} pluginConfig - Configuration for this plugin.
 * @param {string} projectBasePath - The absolute path to the project's root directory.
 */
function registerRoutes(app, pluginConfig, projectBasePath) {
    pluginDebugMode = pluginConfig && pluginConfig.DebugMode === true;

    if (pluginDebugMode) console.log(`[ImageServerPlugin] Registering routes. DebugMode is ON.`);
    else console.log(`[ImageServerPlugin] Registering routes. DebugMode is OFF.`);

    if (!app || typeof app.use !== 'function') {
        console.error('[ImageServerPlugin] Express app instance is required.');
        return;
    }

    // Configure keys
    serverImageKeyForAuth = pluginConfig.Image_Key || null;
    serverFileKeyForAuth = pluginConfig.File_Key || null;

    if (!serverImageKeyForAuth) {
        console.error('[ImageServerPlugin] Image_Key configuration is missing.');
    }
    if (!serverFileKeyForAuth) {
        console.error('[ImageServerPlugin] File_Key configuration is missing.');
    }

    // Create middleware instances
    const imageAuthMiddleware = createAuthMiddleware(() => serverImageKeyForAuth, 'Image');
    const fileAuthMiddleware = createAuthMiddleware(() => serverFileKeyForAuth, 'File');

    // Helper for logging
    const maskKey = (key) => {
        if (!key) return "NOT_CONFIGURED";
        if (key.length > 6) return key.substring(0, 3) + "***" + key.slice(-3);
        if (key.length > 1) return key[0] + "***" + key.slice(-1);
        return "*";
    };

    // Register image service
    if (serverImageKeyForAuth) {
        const globalImageDir = path.join(projectBasePath, 'image');
        app.use('/:pathSegmentWithKey/images', imageAuthMiddleware, express.static(globalImageDir));
        console.log(`[ImageServerPlugin] Protected image service registered. Access path: /pw=${maskKey(serverImageKeyForAuth)}/images/... serving from ${globalImageDir}`);
    } else {
        console.warn(`[ImageServerPlugin] Image service NOT registered due to missing Image_Key.`);
    }

    // Register file service
    if (serverFileKeyForAuth) {
        const globalFileDir = path.join(projectBasePath, 'file'); // Assuming 'file' directory at root
        app.use('/:pathSegmentWithKey/files', fileAuthMiddleware, express.static(globalFileDir));
        console.log(`[ImageServerPlugin] Protected file service registered. Access path: /pw=${maskKey(serverFileKeyForAuth)}/files/... serving from ${globalFileDir}`);
    } else {
        console.warn(`[ImageServerPlugin] File service NOT registered due to missing File_Key.`);
    }
}

module.exports = { registerRoutes };