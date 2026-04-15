// routes/admin/sarPrompts.js
const express = require('express');
const sarPromptManager = require('../../modules/sarPromptManager.js');

module.exports = function (options) {
    const router = express.Router();
    const { DEBUG_MODE } = options;

    /**
     * GET /admin_api/sarprompts
     * Retrieves all sarPrompt groups.
     */
    router.get('/sarprompts', (req, res) => {
        try {
            const prompts = sarPromptManager.getAllPrompts();
            res.status(200).json(prompts);
        } catch (error) {
            console.error('[AdminAPI] Error fetching sarPrompts:', error);
            res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    });

    /**
     * POST /admin_api/sarprompts
     * Updates all sarPrompt groups.
     */
    router.post('/sarprompts', async (req, res) => {
        try {
            const newPrompts = req.body;
            if (!Array.isArray(newPrompts)) {
                return res.status(400).json({ error: 'Invalid data format', message: 'Expected an array of prompts' });
            }

            await sarPromptManager.updateAllPrompts(newPrompts);
            res.status(200).json({ message: 'SarPrompts updated successfully' });
        } catch (error) {
            console.error('[AdminAPI] Error updating sarPrompts:', error);
            res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    });

    return router;
};
