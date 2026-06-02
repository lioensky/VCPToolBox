const fsSync = require('fs');
const path = require('path');
const {
  DEFAULT_CONFIG,
  asNonEmptyString,
  ensureBaseConfigFile,
  normalizeConfig,
  readLayeredConfig,
  resolveLocalConfigPath,
  uniqueStrings,
} = require('./semanticRouterConfig');

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
    this.localConfigPath = resolveLocalConfigPath(this.configPath);
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.debugMode = false;
    this.watchHandles = [];
    this.reloadTimer = null;
    this.descriptionVectorCache = new Map();
  }

  setDebugMode(debugMode) {
    this.debugMode = !!debugMode;
  }

  async initialize(configPath = null, debugMode = false) {
    this.setDebugMode(debugMode);
    this.configPath = configPath || this.configPath;
    this.localConfigPath = resolveLocalConfigPath(this.configPath);
    await this.loadConfig();
    this.startWatcher();
  }

  async ensureConfigFile() {
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

    const existed = fsSync.existsSync(this.configPath);
    await ensureBaseConfigFile(this.configPath, exampleConfig);
    if (!existed) {
      console.log(`[SemanticModelRouter] 未找到配置文件，已创建示例配置: ${this.configPath}`);
    }
  }

  normalizeConfig(rawConfig) {
    return normalizeConfig(rawConfig);
  }

  async loadConfig() {
    try {
      await this.ensureConfigFile();
      const result = await readLayeredConfig(this.configPath, { localConfigPath: this.localConfigPath });
      this.config = result.config;
      this.descriptionVectorCache.clear();

      if (result.localConfigError) {
        console.warn(
          `[SemanticModelRouter] 本地覆盖配置解析失败，已回退到默认配置文件: ${result.localConfigError.message}`
        );
      }
      console.log(
        `[SemanticModelRouter] 配置已加载: enabled=${this.config.enabled}, presets=${Object.keys(this.config.presets).length}, local=${result.usesLocalConfig}`
      );
    } catch (error) {
      console.error(`[SemanticModelRouter] 加载配置失败，使用内置默认配置: ${error.message}`);
      this.config = this.normalizeConfig(DEFAULT_CONFIG);
      this.descriptionVectorCache.clear();
    }
  }

  scheduleConfigReload() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.loadConfig()
        .then(() => this.startWatcher())
        .catch(error => {
          console.error('[SemanticModelRouter] 热加载配置失败:', error.message);
        });
    }, 250);
  }

  startWatcher() {
    const watchDir = path.resolve(path.dirname(this.configPath));
    const targetNames = new Set([
      path.basename(this.configPath),
      path.basename(this.localConfigPath),
    ]);

    if (this.watchHandles.some(entry => entry.type === 'directory' && entry.path === watchDir)) {
      return;
    }

    try {
      if (!fsSync.existsSync(watchDir)) return;
      const handle = fsSync.watch(watchDir, { persistent: false }, (_eventType, filename) => {
        const changedName = filename ? filename.toString() : '';
        if (changedName && !targetNames.has(changedName)) return;
        this.scheduleConfigReload();
      });
      this.watchHandles.push({ type: 'directory', path: watchDir, handle });
      console.log('[SemanticModelRouter] 已启用配置热加载。');
    } catch (error) {
      console.warn(`[SemanticModelRouter] 启用配置热加载失败(${watchDir}): ${error.message}`);
    }
  }

  closeWatchers() {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    for (const watcher of this.watchHandles) {
      watcher.handle.close();
    }
    this.watchHandles = [];
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
