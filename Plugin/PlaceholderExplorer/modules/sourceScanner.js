"use strict";

const fs = require("fs").promises;
const path = require("path");
const {
  findLine,
  normalizePlaceholder,
  pathExists,
  toRelative,
} = require("./pathUtils");

const BUILTIN_PLACEHOLDERS = [
  ["Date", "当前日期，由 messageProcessor 按 REPORT_TIMEZONE 生成"],
  ["Time", "当前时间，由 messageProcessor 按 REPORT_TIMEZONE 生成"],
  ["Today", "当前星期，由 messageProcessor 按 REPORT_TIMEZONE 生成"],
  ["Festival", "农历、节气及节日信息，由 messageProcessor 生成"],
  ["Port", "VCP 服务端口，来自 process.env.PORT"],
  ["Image_Key", "图床访问密钥，由 ImageServer 插件配置解析"],
  ["VCPDynamicTools", "动态工具注册表按上下文聚合生成"],
  ["VCPAllTools", "全部插件调用说明聚合生成"],
  ["VCPDistributedServerList", "分布式服务器运行时列表"],
];

async function scanJsonMap(mapPath, kind, options = {}) {
  if (!(await pathExists(mapPath))) return { definitions: [], errors: [] };
  const relativeFile = options.projectRoot
    ? toRelative(options.projectRoot, mapPath)
    : mapPath;
  try {
    const content = await fs.readFile(mapPath, "utf8");
    const data = JSON.parse(content);
    const definitions = [];
    for (const [alias, rawValue] of Object.entries(data || {})) {
      const value = typeof rawValue === "string" ? rawValue : rawValue?.file;
      const baseDefinition = {
        type: kind === "agent" ? "agent" : "toolbox",
        file: relativeFile,
        line: findLine(content, JSON.stringify(alias)),
        value: value || "",
        resolvesTo:
          value && options.targetDir
            ? toRelative(
                options.projectRoot,
                path.resolve(options.targetDir, value)
              )
            : null,
        editable: false,
        source: `${kind}_map`,
      };
      definitions.push({
        placeholder: normalizePlaceholder(alias),
        ...baseDefinition,
      });
      definitions.push({
        placeholder: normalizePlaceholder(`${kind}:${alias}`),
        ...baseDefinition,
      });
    }
    return { definitions, errors: [] };
  } catch (error) {
    return {
      definitions: [],
      errors: [{ file: relativeFile, line: 1, message: error.message }],
    };
  }
}

async function scanEmojiSources(imageRoot, options = {}) {
  const definitions = [];
  const errors = [];
  if (!(await pathExists(imageRoot))) return { definitions, errors };
  try {
    const entries = await fs.readdir(imageRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith("表情包")) continue;
      const directoryPath = path.join(imageRoot, entry.name);
      let imageCount = 0;
      try {
        const files = await fs.readdir(directoryPath, { withFileTypes: true });
        imageCount = files.filter(
          (file) =>
            file.isFile() && /\.(?:jpg|jpeg|png|gif|webp)$/i.test(file.name)
        ).length;
      } catch (error) {
        errors.push({
          file: toRelative(options.projectRoot, directoryPath),
          line: 1,
          message: error.message,
        });
      }
      definitions.push({
        placeholder: normalizePlaceholder(entry.name),
        type: "emoji",
        file: toRelative(options.projectRoot, directoryPath),
        line: 1,
        value: `${imageCount} 个图片文件`,
        resolvesTo: null,
        editable: false,
        source: "emoji_directory",
      });
    }
  } catch (error) {
    errors.push({
      file: toRelative(options.projectRoot, imageRoot),
      line: 1,
      message: error.message,
    });
  }
  return { definitions, errors };
}

async function getBuiltinDefinitions(options = {}) {
  const sourceFile = "modules/messageProcessor.js";
  const sourcePath = options.projectRoot
    ? path.resolve(options.projectRoot, sourceFile)
    : null;
  const content =
    sourcePath && (await pathExists(sourcePath))
      ? await fs.readFile(sourcePath, "utf8")
      : "";
  return BUILTIN_PLACEHOLDERS.map(([name, description]) => {
    const literalNeedle = `{{${name}}}`;
    const regexNeedle = `\\{\\{${name}\\}\\}`;
    const candidateIndexes = [
      content.indexOf(literalNeedle),
      content.indexOf(regexNeedle),
    ].filter((index) => index >= 0);
    const sourceIndex =
      candidateIndexes.length > 0 ? Math.min(...candidateIndexes) : -1;
    const line =
      sourceIndex >= 0
        ? content.slice(0, sourceIndex).split(/\r?\n/).length
        : 1;
    return {
      placeholder: normalizePlaceholder(name),
      type: name.startsWith("VCP") ? "aggregate" : "builtin",
      file: sourceFile,
      line,
      value: description,
      resolvesTo: null,
      editable: false,
      source: "engine_builtin",
    };
  });
}

module.exports = { getBuiltinDefinitions, scanEmojiSources, scanJsonMap };
