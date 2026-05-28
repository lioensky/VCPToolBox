const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const SEMANTIC_ROUTER_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'SemanticModelRouter.json');

const DEFAULT_CONFIG = {
  enabled: true,
  autoModelName: 'VCPModelAuto',
  defaultPreset: 'default',
  matchThreshold: 0.18,
  contextWeights: [0.7, 0.3],
  presets: {
    default: {
      displayName: 'VCPModelAuto',
      defaultModel: '',
      fallbackModels: [],
      matchThreshold: 0.18,
      contextWeights: [0.7, 0.3],
      routes: [],
    },
  },
};

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = asNonEmptyString(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeWeights(weights, fallback) {
  const normalized = Array.isArray(weights) && weights.length > 0
    ? weights.map(value => Number(value)).filter(value => Number.isFinite(value) && value >= 0)
    : fallback;

  return normalized.length > 0 ? normalized : fallback;
}

function normalizeConfig(rawConfig) {
  const normalized = {
    ...DEFAULT_CONFIG,
    ...(isPlainObject(rawConfig) ? rawConfig : {}),
  };

  normalized.enabled = normalized.enabled !== false;
  normalized.autoModelName = asNonEmptyString(normalized.autoModelName, DEFAULT_CONFIG.autoModelName);
  normalized.defaultPreset = asNonEmptyString(normalized.defaultPreset, DEFAULT_CONFIG.defaultPreset);
  normalized.matchThreshold = Number.isFinite(Number(normalized.matchThreshold))
    ? Number(normalized.matchThreshold)
    : DEFAULT_CONFIG.matchThreshold;
  normalized.contextWeights = normalizeWeights(normalized.contextWeights, DEFAULT_CONFIG.contextWeights);

  const rawPresets = isPlainObject(normalized.presets) ? normalized.presets : DEFAULT_CONFIG.presets;
  normalized.presets = {};

  for (const [presetName, preset] of Object.entries(rawPresets)) {
    if (!isPlainObject(preset)) continue;

    const safeName = asNonEmptyString(presetName);
    if (!safeName) continue;

    const routes = Array.isArray(preset.routes)
      ? preset.routes
        .filter(route => isPlainObject(route))
        .map(route => ({
          name: asNonEmptyString(route.name, route.model || 'unnamed'),
          model: asNonEmptyString(route.model),
          description: asNonEmptyString(route.description),
          failoverPool: route.failoverPool !== false,
          enabled: route.enabled !== false,
        }))
        .filter(route => route.model && route.description)
      : [];

    normalized.presets[safeName] = {
      displayName: asNonEmptyString(
        preset.displayName,
        safeName === normalized.defaultPreset ? normalized.autoModelName : safeName
      ),
      defaultModel: asNonEmptyString(preset.defaultModel),
      fallbackModels: uniqueStrings(preset.fallbackModels),
      matchThreshold: Number.isFinite(Number(preset.matchThreshold))
        ? Number(preset.matchThreshold)
        : normalized.matchThreshold,
      contextWeights: normalizeWeights(preset.contextWeights, normalized.contextWeights),
      routes,
    };
  }

  if (!normalized.presets[normalized.defaultPreset]) {
    const firstPresetName = Object.keys(normalized.presets)[0];
    if (firstPresetName) {
      normalized.defaultPreset = firstPresetName;
    } else {
      normalized.presets.default = JSON.parse(JSON.stringify(DEFAULT_CONFIG.presets.default));
      normalized.defaultPreset = DEFAULT_CONFIG.defaultPreset;
    }
  }

  return normalized;
}

function getVirtualModels(config) {
  if (!config.enabled) return [];

  const models = new Map();
  models.set(config.autoModelName, {
    id: config.autoModelName,
    object: 'model',
    owned_by: 'vcp-semantic-router',
  });

  for (const [presetName, preset] of Object.entries(config.presets || {})) {
    const publicName = presetName === config.defaultPreset ? config.autoModelName : presetName;
    models.set(publicName, {
      id: publicName,
      object: 'model',
      owned_by: 'vcp-semantic-router',
      display_name: preset.displayName || publicName,
    });
  }

  return Array.from(models.values());
}

async function ensureConfigFile() {
  try {
    await fs.access(SEMANTIC_ROUTER_CONFIG_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(
      SEMANTIC_ROUTER_CONFIG_PATH,
      `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
      'utf-8'
    );
  }
}

function getRequestConfig(req) {
  return isPlainObject(req.body?.config) ? req.body.config : req.body;
}

function buildMessagesForPreview({ userText, assistantText, messages }) {
  if (Array.isArray(messages)) {
    return messages;
  }

  const previewMessages = [];
  if (typeof assistantText === 'string' && assistantText.trim()) {
    previewMessages.push({ role: 'assistant', content: assistantText.trim() });
  }
  if (typeof userText === 'string' && userText.trim()) {
    previewMessages.push({ role: 'user', content: userText.trim() });
  }
  return previewMessages;
}

function normalizeUpstreamModels(modelsData) {
  if (!modelsData || typeof modelsData !== 'object' || !Array.isArray(modelsData.data)) {
    return [];
  }

  return modelsData.data
    .map(model => {
      if (typeof model === 'string') {
        return { id: model, object: 'model', owned_by: 'unknown' };
      }
      if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim()) {
        return null;
      }
      return model;
    })
    .filter(Boolean);
}

module.exports = function (options) {
  const router = express.Router();
  const {
    apiKey,
    apiUrl,
    modelRedirectHandler,
    pluginManager,
    semanticModelRouter,
  } = options;

  function getRuntimeRouter() {
    return semanticModelRouter && typeof semanticModelRouter.resolveRoute === 'function'
      ? semanticModelRouter
      : null;
  }

  router.get('/semantic-router/config', async (req, res) => {
    try {
      await ensureConfigFile();
      const content = await fs.readFile(SEMANTIC_ROUTER_CONFIG_PATH, 'utf-8');
      const rawConfig = JSON.parse(content);
      const normalizer = typeof semanticModelRouter?.normalizeConfig === 'function'
        ? semanticModelRouter.normalizeConfig.bind(semanticModelRouter)
        : normalizeConfig;
      const normalizedConfig = normalizer(rawConfig);
      const virtualModels = typeof semanticModelRouter?.getVirtualModels === 'function'
        ? semanticModelRouter.getVirtualModels()
        : getVirtualModels(normalizedConfig);

      res.json({
        config: rawConfig,
        normalizedConfig,
        virtualModels,
        path: path.basename(SEMANTIC_ROUTER_CONFIG_PATH),
      });
    } catch (error) {
      console.error('[AdminAPI] Error reading semantic router config:', error);
      res.status(500).json({
        error: 'Failed to read semantic router config',
        details: error.message,
      });
    }
  });

  router.put('/semantic-router/config', async (req, res) => {
    try {
      const incomingConfig = getRequestConfig(req);
      if (!isPlainObject(incomingConfig)) {
        return res.status(400).json({
          error: 'Invalid configuration data',
          message: 'Expected a JSON object or { config: object }.',
        });
      }

      const normalizer = typeof semanticModelRouter?.normalizeConfig === 'function'
        ? semanticModelRouter.normalizeConfig.bind(semanticModelRouter)
        : normalizeConfig;
      const normalizedConfig = normalizer(incomingConfig);
      if (!isPlainObject(normalizedConfig.presets) || Object.keys(normalizedConfig.presets).length === 0) {
        return res.status(400).json({
          error: 'Invalid semantic router config',
          message: 'At least one preset is required.',
        });
      }

      await fs.writeFile(
        SEMANTIC_ROUTER_CONFIG_PATH,
        `${JSON.stringify(normalizedConfig, null, 2)}\n`,
        'utf-8'
      );

      if (typeof semanticModelRouter?.loadConfig === 'function') {
        await semanticModelRouter.loadConfig();
      }

      const activeConfig = semanticModelRouter?.config || normalizedConfig;
      res.json({
        success: true,
        message: '语义模型路由配置已保存并重新加载。',
        config: activeConfig,
        virtualModels: typeof semanticModelRouter?.getVirtualModels === 'function'
          ? semanticModelRouter.getVirtualModels()
          : getVirtualModels(activeConfig),
      });
    } catch (error) {
      const isSyntaxOrValidationError = error instanceof SyntaxError || error.name === 'TypeError';
      console.error('[AdminAPI] Error writing semantic router config:', error);
      res.status(isSyntaxOrValidationError ? 400 : 500).json({
        error: isSyntaxOrValidationError ? 'Invalid semantic router config' : 'Failed to write semantic router config',
        details: error.message,
      });
    }
  });

  router.get('/semantic-router/upstream-models', async (req, res) => {
    try {
      const redirectRules = modelRedirectHandler && typeof modelRedirectHandler.getAllRules === 'function'
        ? modelRedirectHandler.getAllRules()
        : {};
      const redirectEnabled = modelRedirectHandler && typeof modelRedirectHandler.isEnabled === 'function'
        ? modelRedirectHandler.isEnabled()
        : false;

      if (!apiUrl || !apiKey) {
        return res.json({
          models: [],
          redirectEnabled,
          redirectRules,
          warning: 'API_URL or API_Key is not configured.',
        });
      }

      const { default: fetch } = await import('node-fetch');
      const response = await fetch(`${apiUrl}/v1/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });

      const responseText = await response.text();
      if (!response.ok) {
        return res.status(response.status).json({
          error: 'Failed to fetch upstream models',
          status: response.status,
          details: responseText,
          redirectEnabled,
          redirectRules,
        });
      }

      let modelsData;
      try {
        modelsData = JSON.parse(responseText);
      } catch (parseError) {
        return res.status(502).json({
          error: 'Failed to parse upstream models response',
          details: parseError.message,
          raw: responseText.slice(0, 1000),
          redirectEnabled,
          redirectRules,
        });
      }

      const models = normalizeUpstreamModels(modelsData).map(model => {
        const publicId = modelRedirectHandler && typeof modelRedirectHandler.redirectModelForClient === 'function'
          ? modelRedirectHandler.redirectModelForClient(model.id)
          : model.id;

        return {
          ...model,
          id: publicId,
          upstreamId: model.id,
          redirected: publicId !== model.id,
        };
      });

      const existingIds = new Set(models.map(model => model.id));
      for (const [publicModel, internalModel] of Object.entries(redirectRules)) {
        if (!existingIds.has(publicModel)) {
          models.push({
            id: publicModel,
            upstreamId: internalModel,
            object: 'model',
            owned_by: 'vcp-model-redirect',
            redirected: true,
            redirectOnly: true,
          });
          existingIds.add(publicModel);
        }
      }

      res.json({
        models,
        redirectEnabled,
        redirectRules,
        source: `${apiUrl}/v1/models`,
      });
    } catch (error) {
      console.error('[AdminAPI] Error fetching upstream models for semantic router:', error);
      res.status(500).json({
        error: 'Failed to fetch upstream models',
        details: error.message,
      });
    }
  });

  router.post('/semantic-router/preview', async (req, res) => {
    const routerInstance = getRuntimeRouter();
    if (!routerInstance) {
      return res.status(503).json({
        error: 'Semantic model router preview unavailable',
        message: '预览需要业务主进程中的 semanticModelRouter 和 RAG 插件运行态；独立后台进程仅支持配置读写。',
      });
    }

    try {
      const {
        presetName,
        requestedModel,
        userText,
        assistantText,
        messages,
      } = req.body || {};

      const modelForPreview = requestedModel || presetName || routerInstance.config?.autoModelName;
      if (!modelForPreview || typeof modelForPreview !== 'string') {
        return res.status(400).json({
          error: 'Invalid preview request',
          message: 'requestedModel or presetName is required.',
        });
      }

      const previewMessages = buildMessagesForPreview({ userText, assistantText, messages });
      if (!Array.isArray(previewMessages) || previewMessages.length === 0) {
        return res.status(400).json({
          error: 'Invalid preview request',
          message: 'Provide messages array or userText/assistantText.',
        });
      }

      const plan = await routerInstance.resolveRoute({
        requestedModel: modelForPreview,
        messages: previewMessages,
        pluginManager,
      });

      res.json({
        plan,
        rankedRoutes: plan?.rankedRoutes || [],
        candidates: plan?.candidates || [],
        selectedModel: plan?.selectedModel || null,
      });
    } catch (error) {
      console.error('[AdminAPI] Error previewing semantic router route:', error);
      res.status(500).json({
        error: 'Failed to preview semantic router route',
        details: error.message,
      });
    }
  });

  return router;
};
