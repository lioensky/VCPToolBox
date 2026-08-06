"use strict";

const fs = require("fs").promises;
const path = require("path");
const dotenv = require("dotenv");
const { normalizePlaceholder, pathExists } = require("./pathUtils");

async function buildPluginDescriptions(pluginRoot) {
  const descriptions = new Map();
  if (!(await pathExists(pluginRoot))) return descriptions;
  const folders = await fs.readdir(pluginRoot, { withFileTypes: true });
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const manifestPath = path.join(
      pluginRoot,
      folder.name,
      "plugin-manifest.json"
    );
    if (!(await pathExists(manifestPath))) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const commands = manifest?.capabilities?.invocationCommands;
      if (!manifest.name || !Array.isArray(commands) || commands.length === 0)
        continue;
      const text = commands
        .filter((command) => command?.description)
        .map(
          (command) =>
            `- ${manifest.displayName || manifest.name} (${
              manifest.name
            }) - 命令: ${
              command.commandIdentifier || command.command || "N/A"
            }:\n${command.description}`
        )
        .join("\n\n");
      if (text) descriptions.set(`VCP${manifest.name}`, text);
    } catch (error) {
      // 无效 manifest 已由扫描器报告；预览跳过即可。
    }
  }
  return descriptions;
}

async function loadEmojiLists(projectRoot) {
  const result = new Map();
  const listRoot = path.join(
    projectRoot,
    "Plugin",
    "EmojiListGenerator",
    "generated_lists"
  );
  if (!(await pathExists(listRoot))) return result;
  const files = await fs.readdir(listRoot, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !file.name.toLowerCase().endsWith(".txt")) continue;
    result.set(
      file.name.replace(/\.txt$/i, ""),
      await fs.readFile(path.join(listRoot, file.name), "utf8")
    );
  }
  return result;
}

async function previewPlaceholder(placeholder, options = {}) {
  const config = options.config;
  dotenv.config({ path: config.envPath, override: false, quiet: true });

  const agentManager = require(path.join(
    config.projectRoot,
    "modules",
    "agentManager.js"
  ));
  const toolboxManager = require(path.join(
    config.projectRoot,
    "modules",
    "toolboxManager.js"
  ));
  const tvsManager = require(path.join(
    config.projectRoot,
    "modules",
    "tvsManager.js"
  ));
  const sarPromptManager = require(path.join(
    config.projectRoot,
    "modules",
    "sarPromptManager.js"
  ));
  const messageProcessor = require(path.join(
    config.projectRoot,
    "modules",
    "messageProcessor.js"
  ));

  agentManager.setAgentDir(config.agentDir);
  toolboxManager.setTvsDir(config.tvsDir);
  tvsManager.setTvsDir(config.tvsDir);
  await Promise.all([
    agentManager.loadMap(),
    toolboxManager.loadMap(),
    sarPromptManager.loadPrompts(),
  ]);

  const individualPluginDescriptions = await buildPluginDescriptions(
    config.pluginRoot
  );
  const pluginManager = {
    messagePreprocessors: new Map(),
    getAllPlaceholderValues: () => new Map(),
    getIndividualPluginDescriptions: () => individualPluginDescriptions,
    getResolvedPluginConfigValue: (_pluginName, key) => process.env[key],
  };
  const role = options.role || "system";
  const input =
    options.text !== undefined
      ? String(options.text)
      : normalizePlaceholder(placeholder);
  const contextText = options.context || "预览占位符展开结果";
  const context = {
    pluginManager,
    cachedEmojiLists: await loadEmojiLists(config.projectRoot),
    detectors: [],
    superDetectors: [],
    DEBUG_MODE: false,
    messages: [{ role: "user", content: contextText }],
    expandedAgentName: null,
    expandedToolboxes: new Set(),
  };
  const output = await messageProcessor.replaceAgentVariables(
    input,
    options.model || "placeholder-explorer-preview",
    role,
    context
  );
  return {
    placeholder: normalizePlaceholder(placeholder),
    role,
    model: options.model || "placeholder-explorer-preview",
    input,
    output,
    expanded: output !== input,
    securityNote:
      role === "system"
        ? "使用 resolveAllVariables 的 system 特权角色路径执行。"
        : "使用调用方指定角色执行；普通 user/assistant 不会获得 system 特权。",
    limitation:
      "独立命令进程无法读取主进程内存中的静态插件实时值；工具说明、Tar/Var/Sar、Agent、Toolbox、时间及表情包按现有引擎语义预览。",
  };
}

module.exports = { previewPlaceholder };
