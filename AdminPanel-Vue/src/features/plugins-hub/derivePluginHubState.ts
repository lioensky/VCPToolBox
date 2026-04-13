import type { RecentVisit } from "@/composables/useRecentVisits";
import type { PluginInfo } from "@/types/api.plugin";

export type PluginFilter = "all" | "enabled" | "disabled" | "pinned" | "distributed";

export interface PluginHubSummary {
  total: number;
  enabled: number;
  disabled: number;
  pinned: number;
}

export interface RecentPluginVisitItem {
  pluginName: string;
  label: string;
  icon: string;
}

export interface PluginHubRecord {
  plugin: PluginInfo;
  pluginName: string;
  displayName: string;
  description: string;
  summary: string;
  icon: string;
  enabled: boolean;
  isDistributed: boolean;
  isPinned: boolean;
  searchText: string;
}

interface FilterPluginHubRecordsOptions {
  query: string;
  filter: PluginFilter;
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function getPluginName(plugin: PluginInfo): string {
  return plugin.manifest.name || plugin.name;
}

function getPluginDisplayName(plugin: PluginInfo): string {
  return plugin.manifest.displayName?.trim() || getPluginName(plugin);
}

function summarizePluginDescription(
  description: string,
  maxLength: number
): string {
  const normalizedDescription = description.replace(/\s+/g, " ").trim();
  if (!normalizedDescription) {
    return "该插件暂未提供描述信息。";
  }

  const graphemes = Array.from(normalizedDescription);
  if (graphemes.length <= maxLength) {
    return normalizedDescription;
  }

  return `${graphemes.slice(0, maxLength).join("").trimEnd()}…`;
}

function comparePluginHubRecords(
  a: PluginHubRecord,
  b: PluginHubRecord
): number {
  const pinDelta = Number(b.isPinned) - Number(a.isPinned);
  if (pinDelta !== 0) {
    return pinDelta;
  }

  const enabledDelta = Number(b.enabled) - Number(a.enabled);
  if (enabledDelta !== 0) {
    return enabledDelta;
  }

  return a.displayName.localeCompare(b.displayName, "zh-CN", {
    sensitivity: "base",
  });
}

function matchesFilter(record: PluginHubRecord, filter: PluginFilter): boolean {
  switch (filter) {
    case "enabled":
      return record.enabled;
    case "disabled":
      return !record.enabled;
    case "pinned":
      return record.isPinned;
    case "distributed":
      return record.isDistributed;
    case "all":
    default:
      return true;
  }
}

export function buildPluginHubRecords(
  plugins: readonly PluginInfo[],
  pinnedPluginNames: readonly string[],
  descriptionMaxLength: number
): PluginHubRecord[] {
  const pinnedPluginNameSet = new Set(pinnedPluginNames);

  return plugins.map((plugin) => {
    const pluginName = getPluginName(plugin);
    const displayName = getPluginDisplayName(plugin);
    const description = plugin.manifest.description?.trim() || "";

    return {
      plugin,
      pluginName,
      displayName,
      description,
      summary: summarizePluginDescription(description, descriptionMaxLength),
      icon: plugin.manifest.icon || "extension",
      enabled: plugin.enabled,
      isDistributed: Boolean(plugin.isDistributed),
      isPinned: pinnedPluginNameSet.has(pluginName),
      searchText: normalizeText([pluginName, displayName, description].join(" ")),
    };
  });
}

export function buildPluginHubRecordMap(
  records: readonly PluginHubRecord[]
): Map<string, PluginHubRecord> {
  return new Map(records.map((record) => [record.pluginName, record] as const));
}

export function buildPinnedPluginRecords(
  pinnedPluginNames: readonly string[],
  recordMap: ReadonlyMap<string, PluginHubRecord>
): PluginHubRecord[] {
  return pinnedPluginNames.flatMap((pluginName) => {
    const record = recordMap.get(pluginName);
    return record ? [record] : [];
  });
}

export function summarizePluginHubRecords(
  records: readonly PluginHubRecord[]
): PluginHubSummary {
  return records.reduce<PluginHubSummary>(
    (summary, record) => {
      summary.total += 1;
      summary.enabled += Number(record.enabled);
      summary.disabled += Number(!record.enabled);
      summary.pinned += Number(record.isPinned);
      return summary;
    },
    {
      total: 0,
      enabled: 0,
      disabled: 0,
      pinned: 0,
    }
  );
}

export function buildRecentPluginVisitItems(
  recentVisits: readonly RecentVisit[],
  recordMap: ReadonlyMap<string, PluginHubRecord>,
  limit = 6
): RecentPluginVisitItem[] {
  const seenPluginNames = new Set<string>();
  const result: RecentPluginVisitItem[] = [];

  for (const visit of recentVisits) {
    if (!visit.pluginName || seenPluginNames.has(visit.pluginName)) {
      continue;
    }

    const record = recordMap.get(visit.pluginName);
    if (!record) {
      continue;
    }

    seenPluginNames.add(visit.pluginName);
    result.push({
      pluginName: record.pluginName,
      label: record.displayName,
      icon: record.icon,
    });

    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

export function filterPluginHubRecords(
  records: readonly PluginHubRecord[],
  { query, filter }: FilterPluginHubRecordsOptions
): PluginHubRecord[] {
  const normalizedQuery = normalizeText(query);

  return records
    .filter((record) =>
      !normalizedQuery ? true : record.searchText.includes(normalizedQuery)
    )
    .filter((record) => matchesFilter(record, filter))
    .sort(comparePluginHubRecords);
}
