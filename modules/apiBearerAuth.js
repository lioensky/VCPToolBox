'use strict';
// Shared, behavior-preserving extraction of server.js's existing API gate.
module.exports = function createApiBearerAuth(serverKey) {
    return (req, res, next) => {
    // Skip bearer token check for admin panel API and static files, as they use basic auth or no auth
    if (req.path.startsWith('/admin_api') || req.path.startsWith('/AdminPanel')) {
        return next();
    }

    const imageServicePathRegex = /^\/pw=[^/]+\/images\//;
    if (imageServicePathRegex.test(req.path)) {
        return next();
    }

    // Add a similar check for the FileServer plugin path
    const fileServicePathRegex = /^\/pw=[^/]+\/files\//;
    if (fileServicePathRegex.test(req.path)) {
        return next();
    }

    // Skip bearer token check for plugin callbacks
    if (req.path.startsWith('/plugin-callback')) {
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${serverKey}`) {
        return res.status(401).json({ error: 'Unauthorized (Bearer token required)' });
    }
    next();
};
};
