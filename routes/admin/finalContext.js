const express = require('express');
const finalContextStore = require('../../modules/finalContextStore.js');

module.exports = function() {
    const router = express.Router();

    router.get('/final-context', (req, res) => {
        const snapshot = finalContextStore.getLastFinalContext();

        if (!snapshot) {
            return res.json({
                available: false,
                message: '尚未捕获任何最终上下文。请先发起一次 /v1/chat/completions 请求。'
            });
        }

        res.json({
            available: true,
            snapshot
        });
    });

    return router;
};