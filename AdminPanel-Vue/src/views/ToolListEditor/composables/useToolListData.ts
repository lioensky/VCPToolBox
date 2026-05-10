import type { Tool } from "@/features/tool-list/types";

interface NormalizeToolsResult {
  tools: Tool[];
  duplicateIds: string[];
  fallbackIdCount: number;
}

function normalizeString(input: unknown, fallback: string): string {
  if (typeof input !== "string") {
    return fallback;
  }

  const trimmed = input.trim();
  return trimmed || fallback;
}

function createFallbackToolId(pluginName: string, toolName: string): string {
  return `${pluginName}::${toolName}`;
}

export function normalizeTools(inputTools: Tool[]): NormalizeToolsResult {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  let fallbackIdCount = 0;

  const tools = inputTools.reduce<Tool[]>((acc, rawTool) => {
    const pluginName = normalizeString(rawTool.pluginName, "unknown-plugin");
    const name = normalizeString(rawTool.name, "unknown-tool");

    const rawId = normalizeString(rawTool.uniqueId, "");
    const uniqueId = rawId || createFallbackToolId(pluginName, name);
    if (!rawId) {
      fallbackIdCount += 1;
    }

    if (seen.has(uniqueId)) {
      duplicateIds.push(uniqueId);
      return acc;
    }
    seen.add(uniqueId);

    const description =
      typeof rawTool.description === "string" ? rawTool.description : "";

    acc.push({
      ...rawTool,
      uniqueId,
      pluginName,
      name,
      description: description || undefined,
      searchText: `${name} ${pluginName} ${description}`.toLowerCase(),
    });

    return acc;
  }, []);

  return {
    tools,
    duplicateIds,
    fallbackIdCount,
  };
}

export function extractMissingToolIds(
  allTools: Tool[],
  selectedToolIds: Iterable<string>
): string[] {
  const allToolIdSet = new Set(allTools.map((tool) => tool.uniqueId));
  const missingIds: string[] = [];

  for (const id of selectedToolIds) {
    if (!allToolIdSet.has(id)) {
      missingIds.push(id);
    }
  }

  return missingIds;
}
