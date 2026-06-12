const express = require('express');

const PLUGIN_NAME = 'OpenHerPersona';

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;

    async function callOpenHerPersona(params) {
        if (!pluginManager || typeof pluginManager.processToolCall !== 'function') {
            throw new Error('Plugin manager is not available.');
        }

        return pluginManager.processToolCall(PLUGIN_NAME, params, null, 'admin/openher-persona');
    }

    function normalizeAgentSummary(agent) {
        return {
            agentKey: agent.agentKey || agent.agentId || '__default__',
            agentLabel: agent.agentLabel || agent.agentName || agent.agentKey || 'default',
            turnCount: Number(agent.turnCount) || 0,
            updatedAt: agent.updatedAt || null,
            lastActiveAt: agent.lastActiveAt || null,
        };
    }

    function isHeadlessAgentNameBucket(summary) {
        if (!summary) return true;
        const key = String(summary.agentKey || '').trim();
        const label = String(summary.agentLabel || '').trim();
        const normalizedKey = key.toLowerCase();
        const normalizedLabel = label.toLowerCase();

        return (
            !key ||
            key === '__default__' ||
            normalizedKey === 'default' ||
            normalizedKey === 'agentname' ||
            normalizedLabel === 'default' ||
            normalizedLabel === 'agentname'
        );
    }

    router.get('/openher-persona/status', async (req, res) => {
        try {
            const baseStatus = await callOpenHerPersona({ command: 'status' });
            const summaries = Array.isArray(baseStatus.agents)
                ? baseStatus.agents.map(normalizeAgentSummary)
                : [];

            const seen = new Set();
            const agentStates = [];

            for (const summary of summaries) {
                if (!summary.agentKey || seen.has(summary.agentKey) || isHeadlessAgentNameBucket(summary)) continue;
                seen.add(summary.agentKey);

                try {
                    const status = await callOpenHerPersona({
                        command: 'status',
                        agentId: summary.agentKey,
                        agentName: summary.agentLabel,
                    });

                    agentStates.push({
                        summary,
                        status,
                    });
                } catch (error) {
                    agentStates.push({
                        summary,
                        error: error.message,
                    });
                }
            }

            if (agentStates.length === 0 && baseStatus.state) {
                const summary = normalizeAgentSummary({
                    agentKey: baseStatus.state.agentKey || (baseStatus.agent && baseStatus.agent.agentKey),
                    agentLabel: baseStatus.state.agentLabel || (baseStatus.agent && baseStatus.agent.agentLabel),
                    turnCount: baseStatus.state.turnCount,
                    updatedAt: baseStatus.state.updatedAt,
                    lastActiveAt: baseStatus.state.lastActiveAt,
                });
                if (!isHeadlessAgentNameBucket(summary)) {
                    agentStates.push({ summary, status: baseStatus });
                }
            }

            res.json({
                status: 'success',
                plugin: PLUGIN_NAME,
                overview: {
                    version: baseStatus.version,
                    enabled: Boolean(baseStatus.enabled),
                    hintEnabled: Boolean(baseStatus.hintEnabled),
                    observeOnly: Boolean(baseStatus.observeOnly),
                    tickEnabled: Boolean(baseStatus.tickEnabled),
                    contextBridgeAvailable: Boolean(baseStatus.contextBridgeAvailable),
                    semanticContext: baseStatus.semanticContext || null,
                    activeAgent: baseStatus.agent || null,
                    boundaries: baseStatus.boundaries || null,
                },
                agents: agentStates,
            });
        } catch (error) {
            console.error('[AdminAPI] Error getting OpenHerPersona status:', error);
            res.status(500).json({
                status: 'error',
                error: 'Failed to get OpenHerPersona status',
                details: error.message,
            });
        }
    });

    router.get('/openher-persona/config', async (req, res) => {
        try {
            const result = await callOpenHerPersona({ command: 'config' });
            res.json(result);
        } catch (error) {
            console.error('[AdminAPI] Error getting OpenHerPersona config:', error);
            res.status(500).json({
                status: 'error',
                error: 'Failed to get OpenHerPersona config',
                details: error.message,
            });
        }
    });

    router.post('/openher-persona/config', async (req, res) => {
        try {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({ status: 'error', error: 'Invalid config payload.' });
            }
            const result = await callOpenHerPersona({
                command: 'save_config',
                config: req.body.config || req.body,
            });
            res.json(result);
        } catch (error) {
            console.error('[AdminAPI] Error saving OpenHerPersona config:', error);
            res.status(500).json({
                status: 'error',
                error: 'Failed to save OpenHerPersona config',
                details: error.message,
            });
        }
    });

    router.post('/openher-persona/:agentKey/tick', async (req, res) => {
        try {
            const agentKey = decodeURIComponent(req.params.agentKey);
            const agentName = typeof req.body.agentName === 'string' ? req.body.agentName : agentKey;
            const result = await callOpenHerPersona({
                command: 'tick',
                agentId: agentKey,
                agentName,
                reason: 'admin_panel_manual_tick',
            });
            res.json(result);
        } catch (error) {
            console.error('[AdminAPI] Error ticking OpenHerPersona agent:', error);
            res.status(500).json({
                status: 'error',
                error: 'Failed to tick OpenHerPersona agent',
                details: error.message,
            });
        }
    });

    router.post('/openher-persona/:agentKey/reset', async (req, res) => {
        try {
            const agentKey = decodeURIComponent(req.params.agentKey);
            const agentName = typeof req.body.agentName === 'string' ? req.body.agentName : agentKey;
            const result = await callOpenHerPersona({
                command: 'reset',
                agentId: agentKey,
                agentName,
            });
            res.json(result);
        } catch (error) {
            console.error('[AdminAPI] Error resetting OpenHerPersona agent:', error);
            res.status(500).json({
                status: 'error',
                error: 'Failed to reset OpenHerPersona agent',
                details: error.message,
            });
        }
    });

    return router;
};