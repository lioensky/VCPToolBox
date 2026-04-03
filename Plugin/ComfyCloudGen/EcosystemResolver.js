/**
 * EcosystemResolver.js - 模型→生态自动匹配器
 * 
 * 职责：
 * 1. 根据模型文件名自动匹配ecosystem（前缀匹配，variant优先）
 * 2. 根据模型文件名判断loader类型（查cloud_models.json）
 * 3. 合并参数优先级：用户传参 > ecosystem.defaults > node_defs默认值
 */
const fs = require('fs');
const path = require('path');

class EcosystemResolver {
  constructor(dataDir) {
    this.dataDir = dataDir;

    // 加载数据文件
    this.ecosystems = this._loadJSON('ecosystems.json');
    this.cloudModels = this._loadJSON('cloud_models.json');
    this.nodeDefs = this._tryLoadJSON('cloud_node_defs.json');
    this.workflowParams = this._tryLoadJSON('cloud_workflow_params.json');

    // 构建模型→加载器类型的查找表
    this._modelLoaderMap = this._buildModelLoaderMap();
  }

  /**
   * 核心方法：根据模型名解析出完整的生态配置
   * @param {string} modelName - 模型文件名（如 z_image_bf16.safetensors）
   * @param {string|null} loaderHint - 用户指定的loader类型 ('unet'|'checkpoint'|null)
   * @returns {object} 解析后的完整配置
   */
  resolve(modelName, loaderHint = null) {
    // 1. 确定loader类型
    const loader = loaderHint || this._detectLoader(modelName);
    if (!loader) {
      throw new Error(
        `Cannot determine loader type for model "${modelName}". ` +
        `Not found in cloud_models.json. Please specify loader_type parameter.`
      );
    }

    // 2. 匹配ecosystem（variant优先）
    const eco = this._matchEcosystem(modelName, loader);

    // 3. 构建完整配置
    const config = {
      ecosystem_id: eco.id,
      ecosystem_name: eco.name,
      loader: loader,
      pipeline: eco.pipeline,
      model: modelName,
      clip: eco.clip || null,
      clip_type: eco.clip_type || null,
      vae: eco.vae || null,
      extra_nodes: eco.extra_nodes || [],
      sampler_class: eco.sampler_class || null,
      defaults: { ...eco.defaults },
    };

    return config;
  }

  /**
   * 合并参数：用户传参 > ecosystem.defaults > node_defs默认值
   * @param {object} ecoConfig - resolve()返回的配置
   * @param {object} userParams - 用户传入的参数
   * @returns {object} 最终合并后的参数
   */
  mergeParams(ecoConfig, userParams) {
    // 层1: node_defs默认值（真正的兜底）
    const nodeDefaults = this._getNodeDefaults();

    // 层2: ecosystem默认值
    const ecoDefaults = ecoConfig.defaults || {};

    // 层3: 用户传参（最高优先级）
    const cleaned = this._cleanUserParams(userParams);

    // 三层合并
    const merged = { ...nodeDefaults, ...ecoDefaults, ...cleaned };

    // 确保数值类型正确
    const numericKeys = ['steps', 'cfg', 'width', 'height', 'seed', 'denoise',
                         'batch_size', 'shift', 'lora_strength', 'clip_strength'];
    for (const k of numericKeys) {
      if (merged[k] !== undefined && merged[k] !== null) {
        merged[k] = Number(merged[k]);
      }
    }

    // seed特殊处理：未指定或-1则随机
    if (!merged.seed || merged.seed < 0) {
      merged.seed = require('crypto').randomBytes(4).readUInt32BE(0);
    }

    // 尺寸默认值
    if (!merged.width) merged.width = 1024;
    if (!merged.height) merged.height = 1024;
    if (!merged.denoise) merged.denoise = 1;
    if (!merged.batch_size) merged.batch_size = 1;

    return merged;
  }

  /**
   * 验证COMBO参数合法性（使用cloud_workflow_params.json）
   * @param {string} nodeType - 节点类型如 "KSampler"
   * @param {string} paramName - 参数名如 "sampler_name"
   * @param {*} value - 要验证的值
   * @returns {boolean}
   */
  validateCombo(nodeType, paramName, value) {
    if (!this.workflowParams) return true; // 无校验数据则跳过
    const nodeDef = this.workflowParams[nodeType];
    if (!nodeDef || !nodeDef[paramName]) return true;
    const allowed = nodeDef[paramName];
    if (!Array.isArray(allowed)) return true;
    return allowed.includes(value);
  }

  /**
   * 获取某个COMBO参数的所有可选值
   */
  getComboOptions(nodeType, paramName) {
    if (!this.workflowParams) return null;
    const nodeDef = this.workflowParams[nodeType];
    if (!nodeDef || !nodeDef[paramName]) return null;
    return nodeDef[paramName];
  }

  /**
   * 验证模型是否存在于云端
   * @param {string} modelName
   * @param {string} loaderType - 'unet'|'checkpoint'|'clip'|'vae'|'lora'
   * @returns {boolean}
   */
  modelExists(modelName, loaderType) {
    return this._modelLoaderMap.has(modelName) ||
           this._checkModelInLoader(modelName, loaderType);
  }

  /**
   * 列出所有可用的ecosystem ID
   */
  listEcosystems() {
    return this.ecosystems.ecosystems.map(e => ({
      id: e.id,
      name: e.name,
      pipeline: e.pipeline,
      loader: e.loader
    }));
  }

  // ============ 内部方法 ============

  _loadJSON(filename) {
    const p = path.join(this.dataDir, filename);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  _tryLoadJSON(filename) {
    try { return this._loadJSON(filename); }
    catch { return null; }
  }

  /**
   * 构建模型→加载器类型的查找表
   * cloud_models.json结构: { models_by_loader: { LoaderName: { param_name: [model_list] } } }
   */
  _buildModelLoaderMap() {
    const map = new Map();
    if (!this.cloudModels || !this.cloudModels.models_by_loader) return map;

    const loaderMapping = {
      'CheckpointLoaderSimple': 'checkpoint',
      'UNETLoader': 'unet',
      'CLIPLoader': 'clip',
      'VAELoader': 'vae',
      'LoraLoader': 'lora',
    };

    for (const [loaderName, params] of Object.entries(this.cloudModels.models_by_loader)) {
      const type = loaderMapping[loaderName];
      if (!type) continue;
      for (const [, models] of Object.entries(params)) {
        if (Array.isArray(models)) {
          for (const m of models) {
            map.set(m, type);
          }
        }
      }
    }
    return map;
  }

  /**
   * 从cloud_models.json判断模型的loader类型
   */
  _detectLoader(modelName) {
    // 直接查找
    const direct = this._modelLoaderMap.get(modelName);
    if (direct === 'unet' || direct === 'checkpoint') return direct;

    // 如果在unet和checkpoint里都没找到，可能是用户只给了部分名字
    // 尝试模糊匹配
    for (const [name, type] of this._modelLoaderMap) {
      if (type !== 'unet' && type !== 'checkpoint') continue;
      if (name.includes(modelName) || modelName.includes(name)) {
        return type;
      }
    }

    return null;
  }

  _checkModelInLoader(modelName, loaderType) {
    for (const [name, type] of this._modelLoaderMap) {
      if (type === loaderType && name === modelName) return true;
    }
    return false;
  }

  /**
   * 匹配ecosystem：先检查variant，再检查父级
   * variant的detect比父级更具体，所以优先匹配
   */
  _matchEcosystem(modelName, loader) {
    const ecoList = this.ecosystems.ecosystems;
    const lowerModel = modelName.toLowerCase();

    // 第一遍：检查所有variant（更具体的匹配优先）
    for (const eco of ecoList) {
      if (eco.variants) {
        for (const variant of eco.variants) {
          if (this._detectMatch(lowerModel, variant.detect)) {
            // variant继承父级，覆盖差异
            return this._mergeVariant(eco, variant);
          }
        }
      }
    }

    // 第二遍：检查父级ecosystem
    for (const eco of ecoList) {
      if (this._detectMatch(lowerModel, eco.detect)) {
        return eco;
      }
    }

    // fallback
    const fb = this.ecosystems.fallback[loader];
    if (fb) {
      process.stderr.write(`[ECO] No ecosystem matched for "${modelName}", using ${loader} fallback\n`);
      return { id: '_fallback', name: `Fallback (${loader})`, ...fb };
    }

    throw new Error(`No ecosystem found for model "${modelName}" (loader: ${loader})`);
  }

  /**
   * 前缀匹配：模型名（小写）是否以detect数组中任一前缀开头
   */
  _detectMatch(lowerModel, detectArr) {
    if (!detectArr || !Array.isArray(detectArr)) return false;
    return detectArr.some(prefix => lowerModel.startsWith(prefix.toLowerCase()));
  }

  /**
   * variant继承父级并覆盖
   */
  _mergeVariant(parent, variant) {
    return {
      id: parent.id,
      name: parent.name,
      loader: parent.loader,
      pipeline: variant.pipeline || parent.pipeline,
      clip: variant.clip || parent.clip,
      clip_type: variant.clip_type || parent.clip_type,
      vae: variant.vae || parent.vae,
      extra_nodes: variant.extra_nodes || parent.extra_nodes || [],
      sampler_class: variant.sampler_class || parent.sampler_class || null,
      defaults: { ...parent.defaults, ...(variant.defaults || {}) },
    };
  }

  /**
   * 从node_defs获取KSampler等节点的默认值作为兜底
   */
  _getNodeDefaults() {
    if (!this.nodeDefs) return {};
    const defaults = {};
    // KSampler默认值
    const ks = this.nodeDefs['KSampler'];
    if (ks && ks.defaults) {
      Object.assign(defaults, ks.defaults);
    }
    return defaults;
  }

  /**
   * 清理用户参数：去除undefined/null/空字符串
   */
  _cleanUserParams(params) {
    const cleaned = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') {
        cleaned[k] = v;
      }
    }
    return cleaned;
  }
}

module.exports = EcosystemResolver;