const fs = require('fs').promises;
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
      matchThreshold: 0.18,
      contextWeights: [0.7, 0.3],
      routes: [],
    },
  },
};
const DELETED_PRESETS_FIELD = 'deletedPresets';

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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDeletedPresets(config) {
  return uniqueStrings(config?.[DELETED_PRESETS_FIELD]);
}

function mergeConfig(baseConfig, localConfig, options = {}) {
  if (!isPlainObject(localConfig)) return cloneJson(baseConfig);
  if (!isPlainObject(baseConfig)) return cloneJson(localConfig);

  const applyPresetDeletions = options.applyPresetDeletions !== false;
  const result = { ...cloneJson(baseConfig) };
  for (const [key, value] of Object.entries(localConfig)) {
    if (Array.isArray(value)) {
      result[key] = cloneJson(value);
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeConfig(result[key], value, { applyPresetDeletions: false });
    } else {
      result[key] = cloneJson(value);
    }
  }
  if (applyPresetDeletions) {
    for (const presetName of getDeletedPresets(localConfig)) {
      if (isPlainObject(result.presets)) {
        delete result.presets[presetName];
      }
    }
  }
  return result;
}

function normalizeConfig(rawConfig, options = {}) {
  const includeDisabledRoutes = options.includeDisabledRoutes === true;
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
        .filter(route => route.model && route.description && (includeDisabledRoutes || route.enabled))
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
      normalized.presets.default = cloneJson(DEFAULT_CONFIG.presets.default);
      normalized.defaultPreset = DEFAULT_CONFIG.defaultPreset;
    }
  }

  return normalized;
}

function resolveLocalConfigPath(configPath) {
  const parsed = path.parse(configPath);
  return path.join(parsed.dir, `${parsed.name}.local${parsed.ext}`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureBaseConfigFile(configPath, initialConfig = DEFAULT_CONFIG) {
  if (await pathExists(configPath)) return;
  await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf-8');
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

async function readLayeredConfig(configPath, options = {}) {
  await ensureBaseConfigFile(configPath, options.initialConfig || DEFAULT_CONFIG);

  const localConfigPath = options.localConfigPath || resolveLocalConfigPath(configPath);
  const baseConfig = await readJsonFile(configPath);
  const hasLocalConfig = await pathExists(localConfigPath);
  let localConfig = null;
  let localConfigError = null;

  if (hasLocalConfig) {
    try {
      localConfig = await readJsonFile(localConfigPath);
    } catch (error) {
      localConfigError = {
        message: error.message,
        name: error.name,
      };
    }
  }

  const usesLocalConfig = hasLocalConfig && !localConfigError;
  const mergedConfig = usesLocalConfig ? mergeConfig(baseConfig, localConfig) : baseConfig;

  return {
    config: normalizeConfig(mergedConfig),
    mergedConfig,
    baseConfig,
    localConfig,
    hasLocalConfig,
    usesLocalConfig,
    localConfigError,
    configPath,
    localConfigPath,
  };
}

async function writeLocalConfig(configPath, config) {
  const localConfigPath = resolveLocalConfigPath(configPath);
  await fs.writeFile(localConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return localConfigPath;
}

module.exports = {
  DEFAULT_CONFIG,
  DELETED_PRESETS_FIELD,
  asNonEmptyString,
  cloneJson,
  ensureBaseConfigFile,
  getDeletedPresets,
  isPlainObject,
  mergeConfig,
  normalizeConfig,
  readLayeredConfig,
  resolveLocalConfigPath,
  uniqueStrings,
  writeLocalConfig,
};
