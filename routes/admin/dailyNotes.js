const express = require('express');

module.exports = function(options) {
    const { dailyNoteRootPath, DEBUG_MODE } = options;
    const express = require('express');
    const router = express.Router();
    
    // Mount the original dailyNotesRoutes at /dailynotes
    const dailyNotesRoutes = require('../dailyNotesRoutes')(dailyNoteRootPath, DEBUG_MODE);
    router.use('/dailynotes', dailyNotesRoutes);
    
    return router;
};
