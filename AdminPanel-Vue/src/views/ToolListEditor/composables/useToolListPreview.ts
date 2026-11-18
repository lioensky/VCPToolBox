import type { Tool } from "@/features/tool-list/types";

// NOTE: 这些常量与正则必须与后端 routes/admin/toolListEditor.js 的定义保持一致。
const CONFIG_NAME_RE =
  /^[A-Za-z0-9_\-\u4e00-\u9fa5][A-Za-z0-9_\-. \u4e00-\u9fa5]{0,63}$/;
const WINDOWS_PATH_SEP_RE = /[\\/]/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const MARKDOWN_HEADING_RE = /^\s{0,3}#{1,6}\s+/gm;
const FENCE_RE = /```/g;
const DANGEROUS_PROMPT_PHRASE_RE =
  /(ignore\s+previous\s+instructions|disregard\s+all\s+previous\s+instructions|system\s+prompt|developer\s+message)/gi;

export const MAX_TOOL_DESCRIPTION_LENGTH = 2000;

export interface PreviewOptions {
  includeHeader: boolean;
  includeExamples: boolean;
  /** 行分隔符，预览使用 \n，后端导出使用 \r\n */
  eol?: string;
}

export interface EditorStateFingerprintInput {
  configName: string;
  selectedToolIds: Iterable<string>;
  toolDescriptions: Record<string, string>;
  includeHeader: boolean;
  includeExamples: boolean;
}

export function validateToolConfigName(name: string): string | null {
  if (!name) {
    return "名称不能为空。";
  }
  if (!CONFIG_NAME_RE.test(name)) {
    return "名称仅允许中文/字母/数字/_-. 空格，长度 1-64。";
  }
  if (name.includes("..") || WINDOWS_PATH_SEP_RE.test(name)) {
    return "名称不能包含路径分隔符或连续点号。";
  }
  return null;
}

export function clampToolDescription(
  value: string,
  maxLength = MAX_TOOL_DESCRIPTION_LENGTH
): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength);
}

export function sanitizeDescriptionForPrompt(value: string): string {
  const normalized = clampToolDescription(value)
    .replace(HTML_COMMENT_RE, "")
    .replace(MARKDOWN_HEADING_RE, "")
    .replace(FENCE_RE, "'''")
    .replace(DANGEROUS_PROMPT_PHRASE_RE, "[已移除潜在注入语句]")
    .trim();

  if (!normalized) {
    return "";
  }

  return normalized;
}

function renderHeaderLines(): string[] {
  return [
    "VCP工具调用格式与指南",
    "",
    "<<<[TOOL_REQUEST]>>>",
    "maid:「始」你的署名「末」, //重要字段，以进行任务追踪",
    "tool_name:「始」工具名「末」, //必要字段",
    "arg:「始」工具参数「末」, //具体视不同工具需求而定",
    "<<<[END_TOOL_REQUEST]>>>",
    "",
    "使用「始」「末」包裹参数来兼容富文本识别。",
    "主动判断当前需求，灵活使用各类工具调用。",
    "",
    "========================================",
    "",
  ];
}

function resolveToolDescription(
  tool: Tool,
  overrides: Record<string, string>
): string {
  const raw = overrides[tool.uniqueId] ?? overrides[tool.name] ?? tool.description ?? "";
  return sanitizeDescriptionForPrompt(raw) || "暂无描述";
}

/**
 * 构建与后端 /export 相同格式的工具列表文本。
 * 与 routes/admin/toolListEditor.js 的导出逻辑保持同构；仅行分隔符可通过 eol 切换。
 */
export function buildToolListPreview(
  toolsById: ReadonlyMap<string, Tool>,
  selectedToolIds: Iterable<string>,
  toolDescriptions: Record<string, string>,
  options: PreviewOptions
): string {
  const selectedTools: Tool[] = [];
  for (const id of selectedToolIds) {
    const tool = toolsById.get(id);
    if (tool) {
      selectedTools.push(tool);
    }
  }

  if (selectedTools.length === 0) {
    return "";
  }

  const lines: string[] = [];
  if (options.includeHeader) {
    lines.push(...renderHeaderLines());
  }

  const toolsByPlugin = new Map<string, Tool[]>();
  for (const tool of selectedTools) {
    const bucket = toolsByPlugin.get(tool.pluginName);
    if (bucket) {
      bucket.push(tool);
    } else {
      toolsByPlugin.set(tool.pluginName, [tool]);
    }
  }

  const sortedPluginNames = Array.from(toolsByPlugin.keys()).sort((a, b) =>
    a.localeCompare(b)
  );

  sortedPluginNames.forEach((pluginName, idx) => {
    const pluginIndex = idx + 1;
    const pluginTools = toolsByPlugin.get(pluginName)!;
    const displayName = pluginTools[0].displayName || pluginName;

    if (pluginTools.length === 1) {
      const tool = pluginTools[0];
      const desc = resolveToolDescription(tool, toolDescriptions);
      lines.push(`${pluginIndex}. ${displayName} (${tool.name})`);
      lines.push(`插件: ${pluginName}`);
      lines.push(`说明: ${desc}`);
      if (options.includeExamples && tool.example) {
        lines.push("");
        lines.push("示例:");
        lines.push(tool.example);
      }
    } else {
      lines.push(`${pluginIndex}. ${displayName}`);
      lines.push(`插件: ${pluginName}`);
      lines.push(`该插件包含 ${pluginTools.length} 个工具调用:`);
      lines.push("");

      pluginTools.forEach((tool, toolIdx) => {
        const desc = resolveToolDescription(tool, toolDescriptions);
        lines.push(`  ${pluginIndex}.${toolIdx + 1} ${tool.name}`);
        const descLines = desc.split("\n");
        descLines.forEach((line, lineIdx) => {
          lines.push(lineIdx === 0 ? `  说明: ${line}` : `  ${line}`);
        });
        if (options.includeExamples && tool.example) {
          lines.push("");
          tool.example.split("\n").forEach((line) => {
            lines.push(`  ${line}`);
          });
        }
        if (toolIdx < pluginTools.length - 1) {
          lines.push("");
        }
      });
    }
    lines.push("");
    lines.push("----------------------------------------");
    lines.push("");
  });

  return lines.join(options.eol ?? "\n");
}

export function normalizeToolDescriptionsForSave(
  input: Record<string, string>
): Record<string, string> {
  const output: Record<string, string> = {};
  Object.entries(input).forEach(([key, value]) => {
    if (typeof value !== "string") {
      return;
    }

    const safe = sanitizeDescriptionForPrompt(value);
    if (!safe) {
      return;
    }

    output[key] = safe;
  });

  return output;
}

export function createEditorStateFingerprint(
  input: EditorStateFingerprintInput
): string {
  const orderedDescriptions = Object.entries(input.toolDescriptions)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => [key, clampToolDescription(value)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

  return JSON.stringify({
    configName: input.configName.trim(),
    selectedToolIds: Array.from(input.selectedToolIds),
    toolDescriptions: orderedDescriptions,
    includeHeader: input.includeHeader,
    includeExamples: input.includeExamples,
  });
}
