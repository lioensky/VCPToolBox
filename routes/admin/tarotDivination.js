const express = require('express');

const PLUGIN_NAME = 'TarotDivination';

function sanitizeCommand(command) {
  const allowed = new Set([
    'get_celestial_snapshot',
    'get_celestial_data',
    'draw_single_card',
    'draw_three_card_spread',
    'draw_celtic_cross',
  ]);
  return allowed.has(command) ? command : null;
}

module.exports = function(options) {
  const router = express.Router();
  const { pluginManager } = options;

  async function callTarotDivination(params) {
    if (!pluginManager || typeof pluginManager.processToolCall !== 'function') {
      throw new Error('Plugin manager is not available.');
    }

    return pluginManager.processToolCall(PLUGIN_NAME, params, null, 'admin/tarot-divination');
  }

  router.get('/tarot-divination/celestial-snapshot', async (req, res) => {
    try {
      const origin = typeof req.query.origin === 'string' ? req.query.origin : undefined;
      const result = await callTarotDivination({
        command: 'get_celestial_snapshot',
        origin,
      });

      res.json({
        status: 'success',
        result,
      });
    } catch (error) {
      console.error('[AdminAPI] Error getting TarotDivination celestial snapshot:', error);
      res.status(500).json({
        status: 'error',
        error: 'Failed to get celestial snapshot',
        details: error.message,
      });
    }
  });

  router.post('/tarot-divination/invoke', async (req, res) => {
    try {
      const body = req.body || {};
      const command = sanitizeCommand(body.command);
      if (!command) {
        return res.status(400).json({
          status: 'error',
          error: 'Invalid TarotDivination command.',
        });
      }

      const payload = {
        command,
        origin: typeof body.origin === 'string' ? body.origin : undefined,
        fate_check_number:
          body.fate_check_number !== undefined && body.fate_check_number !== ''
            ? body.fate_check_number
            : undefined,
      };

      const result = await callTarotDivination(payload);
      res.json({
        status: 'success',
        result,
      });
    } catch (error) {
      console.error('[AdminAPI] Error invoking TarotDivination:', error);
      res.status(500).json({
        status: 'error',
        error: 'Failed to invoke TarotDivination',
        details: error.message,
      });
    }
  });

  return router;
};