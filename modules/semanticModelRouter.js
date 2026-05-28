const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

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
      routes: []
    }
  }
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

function cosineSimilarity(vectorA, vectorB) {
  if (!Array.isArray(vectorA) && !(vectorA instanceof Float32Array)) return 0;
  if (!Array.isArray(vectorB) && !(vectorB instanceof Float32Array)) return 0;

  const len = Math.min(vectorA.length, vectorB.length);
  if (len <= 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const a = Number(vectorA[i]) || 0;
    const b = Number(vectorB[i]) || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  return normA === 0 || normB === 0
    ? 0
    : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function findLastMessageText(messages, role) {
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== role) continue;

    const text = extractTextFromContent(message.content).trim();
    if (!text) continue;

    if (role === 'user') {
      if (text.startsWith('[系统提示:]') || text.startsWith('[系统邀请指令:]')) continue;
      if (text.startsWith('<!-- VCP_TOOL_PAYLOAD -->')) continue;
    }

    return text;
  }

  return '';
}

class SemanticModelRouter {
  constructor() {
    this.configPath = path.join(process.cwd(), 'SemanticModelRouter.json');
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.debugMode = false;
    this.watchHandle = null;
    this.reloadTimer = null;
    this.descriptionVectorCache = new Map();
  }

  setDebugMode(debugMode) {
    this.debugMode = !!debugMode;
  }

  async initialize(configPath = null, debugMode = false) {
    this.setDebugMode(debugMode);
    this.configPath = configPath || this.configPath;
    await this.loadConfig();
    this.startWatcher();
  }

  async ensureConfigFile() {
    try {
      await fs.access(this.configPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;

      const exampleConfig = {
        enabled: true,
        autoModelName: 'VCPModelAuto',
        defaultPreset: 'default',
        matchThreshold: 0.18,
        contextWeights: [0.7, 0.3],
        presets: {
          default: {
            displayName: 'VCPModelAuto',
            defaultModel: '请填写默认模型ID',
            fallbackModels: [
              '请填写容灾备用模型ID-1',
              '请填写容灾备用模型ID-2'
            ],
            routes: [
              {
                name: 'coding',
                model: '请填写代码模型ID',
                description: '编程、代码修改、调试、架构设计、软件工程任务'
              },
              {
                name: 'creative',
                model: '请填写创作模型ID',
                description: '文学创作、角色扮演、剧情续写、情感表达、长文本润色'
              }
            ]
          }
        }
      };

      await fs.writeFile(this.configPath, JSON.stringify(exampleConfig, null, 2), 'utf-8');
      console.log(`[SemanticModelRouter] 未找到配置文件，已创建示例配置: ${this.configPath}`);
    }
  }

  normalizeConfig(rawConfig) {
    const normalized = {
      ...DEFAULT_CONFIG,
      ...(isPlainObject(rawConfig) ? rawConfig : {})
    };

    normalized.enabled = normalized.enabled !== false;
    normalized.autoModelName = asNonEmptyString(normalized.autoModelName, DEFAULT_CONFIG.autoModelName);
    normalized.defaultPreset = asNonEmptyString(normalized.defaultPreset, DEFAULT_CONFIG.defaultPreset);
    normalized.matchThreshold = Number.isFinite(Number(normalized.matchThreshold))
      ? Number(normalized.matchThreshold)
      : DEFAULT_CONFIG.matchThreshold;

    normalized.contextWeights = Array.isArray(normalized.contextWeights) && normalized.contextWeights.length > 0
      ? normalized.contextWeights.map(value => Number(value)).filter(value => Number.isFinite(value) && value >= 0)
      : DEFAULT_CONFIG.contextWeights;

    if (normalized.contextWeights.length === 0) {
      normalized.contextWeights = DEFAULT_CONFIG.contextWeights;
    }

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
            enabled: route.enabled !== false
          }))
          .filter(route => route.model && route.description && route.enabled)
        : [];

      normalized.presets[safeName] = {
        displayName: asNonEmptyString(preset.displayName, safeName === normalized.defaultPreset ? normalized.autoModelName : safeName),
        defaultModel: asNonEmptyString(preset.defaultModel),
        fallbackModels: uniqueStrings(preset.fallbackModels),
        matchThreshold: Number.isFinite(Number(preset.matchThreshold))
          ? Number(preset.matchThreshold)
          : normalized.matchThreshold,
        contextWeights: Array.isArray(preset.contextWeights) && preset.contextWeights.length > 0
          ? preset.contextWeights.map(value => Number(value)).filter(value => Number.isFinite(value) && value >= 0)
          : normalized.contextWeights,
        routes
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

  async loadConfig() {
    try {
      await this.ensureConfigFile();
      const content = await fs.readFile(this.configPath, 'utf-8');
      const rawConfig = JSON.parse(content);
      this.config = this.normalizeConfig(rawConfig);
      this.descriptionVectorCache.clear();

      console.log(
        `[SemanticModelRouter] 配置已加载: enabled=${this.config.enabled}, presets=${Object.keys(this.config.presets).length}`
      );
    } catch (error) {
      console.error(`[SemanticModelRouter] 加载配置失败，使用内置默认配置: ${error.message}`);
      this.config = this.normalizeConfig(DEFAULT_CONFIG);
      this.descriptionVectorCache.clear();
    }
  }

  startWatcher() {
    if (this.watchHandle) return;

    try {
      this.watchHandle = fsSync.watch(this.configPath, { persistent: false }, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.loadConfig().catch(error => {
            console.error('[SemanticModelRouter] 热加载配置失败:', error.message);
          });
        }, 250);
      });
      console.log('[SemanticModelRouter] 已启用配置热加载。');
    } catch (error) {
      console.warn(`[SemanticModelRouter] 启用配置热加载失败: ${error.message}`);
    }
  }

  getVirtualModels() {
    if (!this.config.enabled) return [];

    const models = new Map();
    models.set(this.config.autoModelName, {
      id: this.config.autoModelName,
      object: 'model',
      owned_by: 'vcp-semantic-router'
    });

    for (const [presetName, preset] of Object.entries(this.config.presets || {})) {
      const publicName = presetName === this.config.defaultPreset
        ? this.config.autoModelName
        : presetName;

      models.set(publicName, {
        id: publicName,
        object: 'model',
        owned_by: 'vcp-semantic-router',
        display_name: preset.displayName || publicName
      });
    }

    return Array.from(models.values());
  }

  resolvePresetName(requestedModel) {
    const modelName = asNonEmptyString(requestedModel);
    if (!modelName) return null;

    if (modelName === this.config.autoModelName) {
      return this.config.defaultPreset;
    }

    if (this.config.presets && this.config.presets[modelName]) {
      return modelName;
    }

    return null;
  }

  isRoutingModel(requestedModel) {
    return !!this.resolvePresetName(requestedModel);
  }

  getRagPlugin(pluginManager) {
    const ragPlugin = pluginManager?.messagePreprocessors?.get('RAGDiaryPlugin');
    if (!ragPlugin || typeof ragPlugin.getSingleEmbeddingCached !== 'function') {
      return null;
    }
    return ragPlugin;
  }

  async getDescriptionVector(ragPlugin, description) {
    const key = String(description || '').trim();
    if (!key) return null;

    if (this.descriptionVectorCache.has(key)) {
      return this.descriptionVectorCache.get(key);
    }

    let vector = null;
    if (ragPlugin.vectorDBManager && typeof ragPlugin.vectorDBManager.getPluginDescriptionVector === 'function') {
      vector = await ragPlugin.vectorDBManager.getPluginDescriptionVector(
        key,
        ragPlugin.getSingleEmbeddingCached.bind(ragPlugin)
      );
    } else {
      vector = await ragPlugin.getSingleEmbeddingCached(key);
    }

    this.descriptionVectorCache.set(key, vector);
    return vector;
  }

  async buildContextVector(messages, ragPlugin, preset) {
    let userContent = findLastMessageText(messages, 'user');
    let aiContent = findLastMessageText(messages, 'assistant');

    if (!userContent && !aiContent) return null;

    if (typeof ragPlugin.sanitizeForEmbedding === 'function') {
      userContent = userContent ? ragPlugin.sanitizeForEmbedding(userContent, 'user') : '';
      aiContent = aiContent ? ragPlugin.sanitizeForEmbedding(aiContent, 'assistant') : '';
    }

    const [userVector, aiVector] = await Promise.all([
      userContent ? ragPlugin.getSingleEmbeddingCached(userContent) : Promise.resolve(null),
      aiContent ? ragPlugin.getSingleEmbeddingCached(aiContent) : Promise.resolve(null)
    ]);

    const weights = Array.isArray(preset.contextWeights) && preset.contextWeights.length > 0
      ? preset.contextWeights
      : this.config.contextWeights;

    if (typeof ragPlugin._getWeightedAverageVector === 'function') {
      return ragPlugin._getWeightedAverageVector([userVector, aiVector], weights);
    }

    return userVector || aiVector || null;
  }

  buildFallbackPlan(preset, rankedRoutes = []) {
    const models = [];

    if (rankedRoutes.length > 0) {
      const primary = rankedRoutes[0];
      if (primary && primary.model) models.push(primary.model);

      if (primary && primary.failoverPool !== false) {
        for (let i = 1; i < rankedRoutes.length; i++) {
          const route = rankedRoutes[i];
          if (!route || !route.model) continue;
          if (route.failoverPool === false) continue;
          models.push(route.model);
        }
      }
    }

    if (preset.defaultModel) models.push(preset.defaultModel);
    models.push(...preset.fallbackModels);

    return uniqueStrings(models);
  }

  buildDefaultPlan({ requestedModel, presetName, preset, reason }) {
    const candidates = this.buildFallbackPlan(preset, []);
    const selectedModel = candidates[0] || requestedModel;

    return {
      active: true,
      requestedModel,
      presetName,
      selectedModel,
      candidates: candidates.length > 0 ? candidates : [selectedModel],
      match: null,
      reason
    };
  }

  async resolveRoute({ requestedModel, messages, pluginManager }) {
    const presetName = this.resolvePresetName(requestedModel);
    if (!this.config.enabled || !presetName) {
      return {
        active: false,
        requestedModel,
        presetName: null,
        selectedModel: requestedModel,
        candidates: [requestedModel],
        match: null,
        reason: 'not_routing_model'
      };
    }

    const preset = this.config.presets[presetName];
    if (!preset) {
      return {
        active: false,
        requestedModel,
        presetName: null,
        selectedModel: requestedModel,
        candidates: [requestedModel],
        match: null,
        reason: 'preset_not_found'
      };
    }

    try {
      const ragPlugin = this.getRagPlugin(pluginManager);
      if (!ragPlugin) {
        return this.buildDefaultPlan({
          requestedModel,
          presetName,
          preset,
          reason: 'rag_plugin_unavailable'
        });
      }

      const contextVector = await this.buildContextVector(messages, ragPlugin, preset);
      if (!contextVector) {
        return this.buildDefaultPlan({
          requestedModel,
          presetName,
          preset,
          reason: 'context_embedding_unavailable'
        });
      }

      const scoredRoutes = [];
      for (const route of preset.routes || []) {
        const descriptionVector = await this.getDescriptionVector(ragPlugin, route.description);
        const similarity = cosineSimilarity(contextVector, descriptionVector);
        scoredRoutes.push({
          name: route.name,
          model: route.model,
          description: route.description,
          failoverPool: route.failoverPool !== false,
          similarity
        });
      }

      scoredRoutes.sort((a, b) => b.similarity - a.similarity);

      const threshold = Number.isFinite(Number(preset.matchThreshold))
        ? Number(preset.matchThreshold)
        : this.config.matchThreshold;

      const matchedRoutes = scoredRoutes.filter(route => route.similarity >= threshold);
      const selectedRoutes = matchedRoutes.length > 0 ? matchedRoutes : [];
      const candidates = this.buildFallbackPlan(preset, selectedRoutes);
      const selectedModel = candidates[0] || preset.defaultModel || requestedModel;

      if (this.debugMode) {
        const top = scoredRoutes.slice(0, 5).map(route => `${route.name}:${route.model}:${route.similarity.toFixed(3)}`).join(', ');
        console.log(`[SemanticModelRouter] preset=${presetName}, selected=${selectedModel}, threshold=${threshold}, top=[${top}]`);
      }

      return {
        active: true,
        requestedModel,
        presetName,
        selectedModel,
        candidates: candidates.length > 0 ? candidates : [selectedModel],
        match: selectedRoutes[0] || null,
        rankedRoutes: scoredRoutes,
        reason: selectedRoutes.length > 0 ? 'semantic_match' : 'below_threshold_default'
      };
    } catch (error) {
      console.error('[SemanticModelRouter] 语义模型路由失败，回退默认模型:', error.message);
      return this.buildDefaultPlan({
        requestedModel,
        presetName,
        preset,
        reason: `routing_error:${error.message}`
      });
    }
  }
}

module.exports = SemanticModelRouter;
