"use strict";

const fs = require("fs").promises;
const path = require("path");
const { scanEnvFile, scanSarPromptFile } = require("./envScanner");
const { scanPluginManifests } = require("./manifestScanner");
const {
  getBuiltinDefinitions,
  scanEmojiSources,
  scanJsonMap,
} = require("./sourceScanner");
const { buildIndex, saveIndex } = require("./indexStore");
const { extractPlaceholders, scanUsageFiles } = require("./usageScanner");
const { listFilesRecursive, pathExists, toRelative } = require("./pathUtils");

function resolveConfiguredPath(projectRoot, value, fallback) {
  const candidate =
    value && String(value).trim() ? String(value).trim() : fallback;
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(projectRoot, candidate);
}

function createScanConfig(
  env = process.env,
  pluginDir = path.resolve(__dirname, "..")
) {
  const defaultProjectRoot = path.resolve(pluginDir, "..", "..");
  const projectRoot = resolveConfiguredPath(
    defaultProjectRoot,
    env.PLACEHOLDER_SCAN_ROOT || env.PROJECT_BASE_PATH,
    "."
  );
  const tvsDir = resolveConfiguredPath(
    projectRoot,
    env.PLACEHOLDER_TVS_DIR || env.TVSTXT_DIR_PATH,
    "TVStxt"
  );
  const agentDir = resolveConfiguredPath(
    projectRoot,
    env.PLACEHOLDER_AGENT_DIR || env.AGENT_DIR_PATH,
    "Agent"
  );
  const pluginRoot = resolveConfiguredPath(
    projectRoot,
    env.PLACEHOLDER_PLUGIN_DIR,
    "Plugin"
  );
  const envPath = resolveConfiguredPath(
    projectRoot,
    env.PLACEHOLDER_ENV_FILE,
    "config.env"
  );
  const sarPromptPath = resolveConfiguredPath(
    projectRoot,
    env.PLACEHOLDER_SAR_FILE,
    "sarprompt.json"
  );
  const indexPath = resolveConfiguredPath(
    pluginDir,
    env.PLACEHOLDER_INDEX_FILE,
    "generated/placeholder-index.json"
  );
  return {
    projectRoot,
    pluginDir,
    tvsDir,
    agentDir,
    pluginRoot,
    envPath,
    sarPromptPath,
    indexPath,
    imageRoot: resolveConfiguredPath(
      projectRoot,
      env.PLACEHOLDER_IMAGE_DIR,
      "image"
    ),
    agentMapPath: resolveConfiguredPath(
      projectRoot,
      env.PLACEHOLDER_AGENT_MAP_FILE,
      "agent_map.json"
    ),
    toolboxMapPath: resolveConfiguredPath(
      projectRoot,
      env.PLACEHOLDER_TOOLBOX_MAP_FILE,
      "toolbox_map.json"
    ),
    maxFiles: Number.isFinite(Number(env.PLACEHOLDER_MAX_SCAN_FILES))
      ? Number(env.PLACEHOLDER_MAX_SCAN_FILES)
      : 20000,
  };
}

function referencesFromEnvEntries(entries, relativeFile) {
  const references = [];
  for (const entry of entries || []) {
    const extracted = extractPlaceholders(
      entry.value,
      relativeFile,
      "config_env_value"
    );
    for (const reference of extracted) {
      references.push({
        ...reference,
        line: entry.startLine + reference.line - 1,
      });
    }
  }
  return references;
}

function referencesFromSarGroups(groups, relativeFile, content) {
  const references = [];
  let fromIndex = 0;
  for (const group of groups || []) {
    if (!group || typeof group.content !== "string") continue;
    const marker = JSON.stringify(group.promptKey || "");
    const markerIndex = content.indexOf(marker, fromIndex);
    const groupLine = content
      .slice(0, Math.max(0, markerIndex))
      .split(/\r?\n/).length;
    fromIndex = Math.max(fromIndex, markerIndex + marker.length);
    const extracted = extractPlaceholders(
      group.content,
      relativeFile,
      "sarprompt_value"
    );
    for (const reference of extracted) {
      references.push({ ...reference, line: groupLine + reference.line - 1 });
    }
  }
  return references;
}

async function collectUsageFiles(config, manifestResult) {
  const sourceKinds = new Map();
  const tvsFiles = await listFilesRecursive(config.tvsDir, [".txt", ".md"], {
    maxFiles: config.maxFiles,
  });
  const agentFiles = await listFilesRecursive(
    config.agentDir,
    [".txt", ".md"],
    { maxFiles: config.maxFiles }
  );
  for (const filePath of tvsFiles)
    sourceKinds.set(path.resolve(filePath), "tvs");
  for (const filePath of agentFiles)
    sourceKinds.set(path.resolve(filePath), "agent");
  const manifestFiles = manifestResult.manifests.map((item) => item.path);
  for (const filePath of manifestFiles)
    sourceKinds.set(path.resolve(filePath), "plugin_manifest");
  return { files: [...tvsFiles, ...agentFiles, ...manifestFiles], sourceKinds };
}

async function scanProject(configInput = {}) {
  const config = { ...createScanConfig(), ...configInput };
  const scanOptions = {
    projectRoot: config.projectRoot,
    tvsDir: config.tvsDir,
  };
  const [
    envResult,
    sarResult,
    manifestResult,
    agentMapResult,
    toolboxMapResult,
    emojiResult,
    builtinDefinitions,
  ] = await Promise.all([
    scanEnvFile(config.envPath, scanOptions),
    scanSarPromptFile(config.sarPromptPath, scanOptions),
    scanPluginManifests(config.pluginRoot, { projectRoot: config.projectRoot }),
    scanJsonMap(config.agentMapPath, "agent", {
      projectRoot: config.projectRoot,
      targetDir: config.agentDir,
    }),
    scanJsonMap(config.toolboxMapPath, "toolbox", {
      projectRoot: config.projectRoot,
      targetDir: config.tvsDir,
    }),
    scanEmojiSources(config.imageRoot, { projectRoot: config.projectRoot }),
    getBuiltinDefinitions({ projectRoot: config.projectRoot }),
  ]);

  const usageFiles = await collectUsageFiles(config, manifestResult);
  const usageResult = await scanUsageFiles(usageFiles.files, {
    projectRoot: config.projectRoot,
    sourceKinds: usageFiles.sourceKinds,
  });
  const envRelative = toRelative(config.projectRoot, config.envPath);
  const sarRelative = toRelative(config.projectRoot, config.sarPromptPath);
  const definitions = [
    ...envResult.definitions,
    ...sarResult.definitions,
    ...manifestResult.definitions,
    ...agentMapResult.definitions,
    ...toolboxMapResult.definitions,
    ...emojiResult.definitions,
    ...builtinDefinitions,
  ];
  const references = [
    ...usageResult.references,
    ...referencesFromEnvEntries(envResult.entries, envRelative),
    ...referencesFromSarGroups(
      sarResult.groups,
      sarRelative,
      sarResult.content || ""
    ),
  ];
  const missingFileErrors = [];
  const missingFileKeys = new Set();
  for (const item of definitions) {
    if (!item.resolvesTo || path.isAbsolute(item.resolvesTo)) continue;
    if (
      require("fs").existsSync(
        path.resolve(config.projectRoot, item.resolvesTo)
      )
    )
      continue;
    const key = `${item.file}:${item.line}:${item.resolvesTo}`;
    if (missingFileKeys.has(key)) continue;
    missingFileKeys.add(key);
    missingFileErrors.push({
      file: item.file,
      line: item.line,
      message: `引用文件不存在：${item.resolvesTo}`,
    });
  }
  const errors = [
    ...envResult.errors,
    ...sarResult.errors,
    ...manifestResult.errors,
    ...agentMapResult.errors,
    ...toolboxMapResult.errors,
    ...emojiResult.errors,
    ...usageResult.errors,
    ...missingFileErrors,
  ];
  const index = buildIndex({
    definitions,
    references,
    errors,
    projectRoot: config.projectRoot,
    lastScan: new Date().toISOString(),
  });
  await saveIndex(config.indexPath, index);
  return { index, config };
}

async function ensureIndex(configInput = {}) {
  const config = { ...createScanConfig(), ...configInput };
  if (!(await pathExists(config.indexPath))) return scanProject(config);
  try {
    const index = JSON.parse(await fs.readFile(config.indexPath, "utf8"));
    return { index, config };
  } catch (error) {
    return scanProject(config);
  }
}

module.exports = {
  createScanConfig,
  ensureIndex,
  referencesFromEnvEntries,
  scanProject,
};
