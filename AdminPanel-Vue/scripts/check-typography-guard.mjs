import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = process.cwd();

const pxGuardTargets = [
  "src",
  "src/views",
  "src/layouts/MainLayout.vue",
  "src/views/ImageCacheEditor.vue",
  "src/views/RagTuning.vue",
  "src/components/layout",
  "src/views/PlaceholderViewer.vue",
  "src/views/PlaceholderViewer",
  "src/components/feedback",
  "src/components/dashboard",
  "src/views/AgentAssistantConfig.vue",
  "src/views/ScheduleManager.vue",
  "src/views/Login.vue",
  "src/views/BaseConfig.vue",
  "src/views/ForumAssistantConfig.vue",
  "src/views/AgentScores.vue",
  "src/views/ToolboxManager.vue",
  "src/views/SemanticGroupsEditor.vue",
  "src/views/ServerLogViewer.vue",
  "src/views/ToolApprovalManager.vue",
  "src/views/ThinkingChainsEditor.vue",
  "src/views/DreamManager.vue",
  "src/views/AgentFilesEditor.vue",
  "src/views/PluginsHub.vue",
];

const duplicateGuardFile = "src/style/layout.css";
const allowedExtensions = new Set([".css", ".vue"]);
const issues = [];

function toPosixPath(filePath) {
  return normalize(filePath).replaceAll("\\", "/");
}

function walkAbsolute(absolutePath) {
  const stats = statSync(absolutePath);

  if (stats.isFile()) {
    return allowedExtensions.has(extname(absolutePath)) ? [absolutePath] : [];
  }

  const files = [];
  for (const name of readdirSync(absolutePath)) {
    files.push(...walkAbsolute(join(absolutePath, name)));
  }

  return files;
}

function getLine(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function checkNoFixedPxFontSize(filePath) {
  const content = readFileSync(filePath, "utf8");
  const regex = /font-size\s*:\s*\d+(?:\.\d+)?px\b/gi;
  let match;

  while ((match = regex.exec(content)) !== null) {
    issues.push({
      filePath,
      line: getLine(content, match.index),
      message: `禁止使用固定字号：${match[0]}，请改为语义字号变量（var(--font-size-*)）`,
    });
  }
}

function checkNoDirectClampFontSize(filePath) {
  const content = readFileSync(filePath, "utf8");
  const regex = /font-size\s*:\s*clamp\s*\(/gi;
  let match;

  while ((match = regex.exec(content)) !== null) {
    issues.push({
      filePath,
      line: getLine(content, match.index),
      message: "禁止直接使用 font-size: clamp(...)，请封装为语义字号变量后再引用",
    });
  }
}

function checkLayoutUtilityDuplicates(filePath) {
  const content = readFileSync(filePath, "utf8");
  const utilitySelectors = [".text-sm", ".text-lg"];

  for (const selector of utilitySelectors) {
    const escaped = selector.replace(".", "\\.");
    const regex = new RegExp(`${escaped}\\s*\\{`, "g");
    const matches = [...content.matchAll(regex)];

    if (matches.length > 1) {
      const lines = matches
        .map((entry) => getLine(content, entry.index ?? 0))
        .join(", ");
      issues.push({
        filePath,
        line: getLine(content, matches[1].index ?? 0),
        message: `${selector} 重复定义（共 ${matches.length} 处，行：${lines}），会造成流体排版被覆盖`,
      });
    }
  }
}

function main() {
  const fileSet = new Set();

  for (const target of pxGuardTargets) {
    const absoluteTargetPath = join(root, target);
    for (const filePath of walkAbsolute(absoluteTargetPath)) {
      fileSet.add(filePath);
    }
  }

  for (const filePath of fileSet) {
    checkNoFixedPxFontSize(filePath);
    checkNoDirectClampFontSize(filePath);
  }

  const layoutFilePath = join(root, duplicateGuardFile);
  checkLayoutUtilityDuplicates(layoutFilePath);

  if (issues.length === 0) {
    console.log("Typography guard passed.");
    return;
  }

  console.error("Typography guard failed:\n");
  for (const issue of issues) {
    const displayPath = toPosixPath(issue.filePath).replace(`${toPosixPath(root)}/`, "");
    console.error(`- ${displayPath}:${issue.line} ${issue.message}`);
  }

  process.exitCode = 1;
}

main();
