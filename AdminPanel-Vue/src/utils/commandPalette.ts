import type { NavItem } from "@/stores/app";
import type { PluginInfo } from "@/types/api.plugin";
import {
  getNavigationUsageKey,
  type NavigationUsageMap,
  type RecentVisit,
} from "@/composables/useRecentVisits";

export type CommandPaletteEntryKind = "recent" | "page" | "plugin";

export interface CommandPaletteEntry {
  id: string;
  kind: CommandPaletteEntryKind;
  label: string;
  subtitle: string;
  icon: string;
  target: string;
  pluginName?: string;
  badges: string[];
  priority: number;
  searchText: string;
}

export interface CommandPaletteSection {
  id: string;
  title: string;
  items: CommandPaletteEntry[];
}

interface BuildCommandPaletteSectionsOptions {
  navItems: readonly NavItem[];
  plugins: readonly PluginInfo[];
  recentVisits: readonly RecentVisit[];
  navigationUsage: Readonly<NavigationUsageMap>;
  pinnedPluginNames: readonly string[];
  query: string;
  limit?: number;
}

interface BuildCommandPaletteIndexOptions {
  navItems: readonly NavItem[];
  plugins: readonly PluginInfo[];
  recentVisits: readonly RecentVisit[];
  navigationUsage: Readonly<NavigationUsageMap>;
  pinnedPluginNames: readonly string[];
}

interface BuildCommandPaletteSectionsFromIndexOptions {
  query: string;
  limit?: number;
}

export interface CommandPaletteIndex {
  recentEntries: readonly CommandPaletteEntry[];
  pageEntries: readonly CommandPaletteEntry[];
  pluginEntries: readonly CommandPaletteEntry[];
  allEntries: readonly CommandPaletteEntry[];
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

function getPluginName(plugin: PluginInfo): string {
  return plugin.manifest.name || plugin.name;
}

function getPluginDisplayName(plugin: PluginInfo): string {
  return plugin.manifest.displayName?.trim() || getPluginName(plugin);
}

function getSearchText(parts: Array<string | undefined>): string {
  return normalizeText(parts.filter(Boolean).join(" "));
}

function getDestinationKey(entry: CommandPaletteEntry): string {
  return entry.pluginName ? `plugin:${entry.pluginName}` : `page:${entry.target}`;
}

function hasBadge(entry: CommandPaletteEntry, badge: string): boolean {
  return entry.badges.includes(badge);
}

function assignPriorities(
  entries: readonly CommandPaletteEntry[]
): CommandPaletteEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    priority: index,
  }));
}

function buildPageEntries(navItems: readonly NavItem[]): CommandPaletteEntry[] {
  let priority = 0;

  return navItems.flatMap((item) => {
    if (!item.target || !item.label || item.category || item.pluginName) {
      return [];
    }

    const subtitle = item.target === "dashboard" ? "控制台主页" : "控制台页面";
    return [
      {
        id: `page:${item.target}`,
        kind: "page" as const,
        label: item.label,
        subtitle,
        icon: item.icon || "arrow_outward",
        target: item.target,
        badges: [],
        priority: priority++,
        searchText: getSearchText([item.label, item.target, subtitle]),
      },
    ];
  });
}

function buildPluginEntries(
  plugins: readonly PluginInfo[],
  pinnedPluginNames: readonly string[]
): CommandPaletteEntry[] {
  const pinnedSet = new Set(pinnedPluginNames);

  const sortedPlugins = [...plugins].sort((a, b) => {
    const aName = getPluginName(a);
    const bName = getPluginName(b);
    const pinDelta = Number(pinnedSet.has(bName)) - Number(pinnedSet.has(aName));
    if (pinDelta !== 0) {
      return pinDelta;
    }

    const enabledDelta = Number(b.enabled) - Number(a.enabled);
    if (enabledDelta !== 0) {
      return enabledDelta;
    }

    return getPluginDisplayName(a).localeCompare(
      getPluginDisplayName(b),
      "zh-CN",
      { sensitivity: "base" }
    );
  });

  return sortedPlugins.map((plugin, index) => {
    const pluginName = getPluginName(plugin);
    const badges = [
      ...(pinnedSet.has(pluginName) ? ["已固定"] : []),
      plugin.enabled ? "已启用" : "已禁用",
      ...(plugin.isDistributed ? ["分布式"] : []),
    ];
    const subtitle = plugin.manifest.description?.trim() || pluginName;

    return {
      id: `plugin:${pluginName}`,
      kind: "plugin" as const,
      label: getPluginDisplayName(plugin),
      subtitle,
      icon: plugin.manifest.icon || "extension",
      target: `plugin-${pluginName}-config`,
      pluginName,
      badges,
      priority: index,
      searchText: getSearchText([
        getPluginDisplayName(plugin),
        pluginName,
        subtitle,
        ...badges,
      ]),
    };
  });
}

function getEntryUsageRecord(
  entry: CommandPaletteEntry,
  navigationUsage: Readonly<NavigationUsageMap>
) {
  return navigationUsage[getNavigationUsageKey(entry.target, entry.pluginName)];
}

function buildRecentRankMap(
  recentEntries: readonly CommandPaletteEntry[]
): Map<string, number> {
  return new Map(
    recentEntries.map((entry, index) => [getDestinationKey(entry), index] as const)
  );
}

function compareEntriesByUsage(
  a: CommandPaletteEntry,
  b: CommandPaletteEntry,
  recentRankMap: ReadonlyMap<string, number>,
  navigationUsage: Readonly<NavigationUsageMap>
): number {
  const aUsage = getEntryUsageRecord(a, navigationUsage);
  const bUsage = getEntryUsageRecord(b, navigationUsage);
  const countDelta = (bUsage?.count ?? 0) - (aUsage?.count ?? 0);
  if (countDelta !== 0) {
    return countDelta;
  }

  const aRecentRank = recentRankMap.get(getDestinationKey(a)) ?? Number.MAX_SAFE_INTEGER;
  const bRecentRank = recentRankMap.get(getDestinationKey(b)) ?? Number.MAX_SAFE_INTEGER;
  if (aRecentRank !== bRecentRank) {
    return aRecentRank - bRecentRank;
  }

  const lastVisitedDelta = (bUsage?.lastVisitedAt ?? 0) - (aUsage?.lastVisitedAt ?? 0);
  if (lastVisitedDelta !== 0) {
    return lastVisitedDelta;
  }

  return (
    a.priority -
      b.priority ||
    a.label.localeCompare(b.label, "zh-CN", {
      sensitivity: "base",
    })
  );
}

function rankPageEntries(
  pageEntries: readonly CommandPaletteEntry[],
  recentEntries: readonly CommandPaletteEntry[],
  navigationUsage: Readonly<NavigationUsageMap>
): CommandPaletteEntry[] {
  const recentRankMap = buildRecentRankMap(recentEntries);

  return assignPriorities(
    [...pageEntries].sort((a, b) =>
      compareEntriesByUsage(a, b, recentRankMap, navigationUsage)
    )
  );
}

function rankPluginEntries(
  pluginEntries: readonly CommandPaletteEntry[],
  recentEntries: readonly CommandPaletteEntry[],
  navigationUsage: Readonly<NavigationUsageMap>,
  pinnedPluginNames: readonly string[]
): CommandPaletteEntry[] {
  const recentRankMap = buildRecentRankMap(recentEntries);
  const pinnedIndexMap = new Map(
    pinnedPluginNames.map((pluginName, index) => [pluginName, index] as const)
  );

  return assignPriorities(
    [...pluginEntries].sort((a, b) => {
      const aPinnedIndex =
        a.pluginName !== undefined ? pinnedIndexMap.get(a.pluginName) : undefined;
      const bPinnedIndex =
        b.pluginName !== undefined ? pinnedIndexMap.get(b.pluginName) : undefined;
      const aPinned = aPinnedIndex !== undefined;
      const bPinned = bPinnedIndex !== undefined;

      if (aPinned !== bPinned) {
        return Number(bPinned) - Number(aPinned);
      }

      if (
        aPinned &&
        bPinned &&
        aPinnedIndex !== undefined &&
        bPinnedIndex !== undefined &&
        aPinnedIndex !== bPinnedIndex
      ) {
        return aPinnedIndex - bPinnedIndex;
      }

      const enabledDelta =
        Number(!hasBadge(b, "已禁用")) - Number(!hasBadge(a, "已禁用"));
      if (enabledDelta !== 0) {
        return enabledDelta;
      }

      return compareEntriesByUsage(a, b, recentRankMap, navigationUsage);
    })
  );
}

function buildRecentEntries(
  recentVisits: readonly RecentVisit[],
  navItems: readonly NavItem[],
  plugins: readonly PluginInfo[],
  pinnedPluginNames: readonly string[]
): CommandPaletteEntry[] {
  const pageMap = new Map(
    navItems
      .filter((item): item is NavItem & { target: string; label: string } =>
        Boolean(item.target && item.label && !item.category)
      )
      .map((item) => [item.target, item])
  );
  const pluginMap = new Map(
    plugins.map((plugin) => [getPluginName(plugin), plugin] as const)
  );
  const pinnedSet = new Set(pinnedPluginNames);

  return recentVisits.flatMap((visit, index) => {
    if (visit.pluginName) {
      const plugin = pluginMap.get(visit.pluginName);
      if (!plugin) {
        return [];
      }

      const pluginName = getPluginName(plugin);
      const badges = [
        "最近访问",
        ...(pinnedSet.has(pluginName) ? ["已固定"] : []),
        ...(plugin.isDistributed ? ["分布式"] : []),
      ];
      const subtitle = plugin.manifest.description?.trim() || `插件 · ${pluginName}`;

      return [
        {
          id: `recent:plugin:${pluginName}`,
          kind: "recent" as const,
          label: getPluginDisplayName(plugin),
          subtitle,
          icon: plugin.manifest.icon || "extension",
          target: `plugin-${pluginName}-config`,
          pluginName,
          badges,
          priority: index,
          searchText: getSearchText([
            getPluginDisplayName(plugin),
            pluginName,
            subtitle,
            ...badges,
          ]),
        },
      ];
    }

    const page = pageMap.get(visit.target);
    if (!page?.label) {
      return [];
    }

    const subtitle = "最近访问的页面";
    return [
      {
        id: `recent:page:${page.target}`,
        kind: "recent" as const,
        label: page.label,
        subtitle,
        icon: page.icon || visit.icon || "arrow_outward",
        target: page.target!,
        badges: ["最近访问"],
        priority: index,
        searchText: getSearchText([page.label, page.target, subtitle]),
      },
    ];
  });
}

function getMatchScore(entry: CommandPaletteEntry, query: string): number {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => entry.searchText.includes(term))) {
    return -1;
  }

  const label = normalizeText(entry.label);
  const subtitle = normalizeText(entry.subtitle);
  let score = 0;

  for (const term of terms) {
    if (label === term) {
      score += 160;
      continue;
    }

    if (label.startsWith(term)) {
      score += 120;
      continue;
    }

    if (label.includes(term)) {
      score += 90;
      continue;
    }

    if (subtitle.startsWith(term)) {
      score += 60;
      continue;
    }

    if (subtitle.includes(term)) {
      score += 45;
      continue;
    }

    score += 25;
  }

  if (entry.kind === "recent") {
    score += 18;
  }
  if (hasBadge(entry, "已固定")) {
    score += 10;
  }
  if (hasBadge(entry, "已启用")) {
    score += 4;
  }

  return score;
}

function buildDefaultSections(
  pageEntries: readonly CommandPaletteEntry[],
  pluginEntries: readonly CommandPaletteEntry[],
  recentEntries: readonly CommandPaletteEntry[]
): CommandPaletteSection[] {
  const pinnedPluginEntries = pluginEntries.filter((entry) =>
    hasBadge(entry, "已固定")
  );
  const frequentPluginEntries = pluginEntries.filter(
    (entry) => !hasBadge(entry, "已固定") && !hasBadge(entry, "已禁用")
  );
  const shortcutPlugins = [...pinnedPluginEntries, ...frequentPluginEntries].slice(
    0,
    6
  );

  return [
    {
      id: "recent",
      title: "最近访问",
      items: recentEntries.slice(0, 5),
    },
    {
      id: "page",
      title: "常用页面",
      items: pageEntries.slice(0, 6),
    },
    {
      id: "plugin-shortcuts",
      title: "插件捷径",
      items: shortcutPlugins,
    },
  ].filter((section) => section.items.length > 0);
}

function buildSearchSections(
  entries: readonly CommandPaletteEntry[],
  query: string,
  limit: number
): CommandPaletteSection[] {
  const rankedEntries = entries
    .map((entry) => ({
      entry,
      score: getMatchScore(entry, query),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.priority - b.entry.priority ||
        a.entry.label.localeCompare(b.entry.label, "zh-CN", {
          sensitivity: "base",
        })
    );

  const seenDestinations = new Set<string>();
  const limitedEntries: CommandPaletteEntry[] = [];

  for (const candidate of rankedEntries) {
    const destinationKey = getDestinationKey(candidate.entry);
    if (seenDestinations.has(destinationKey)) {
      continue;
    }

    seenDestinations.add(destinationKey);
    limitedEntries.push(candidate.entry);

    if (limitedEntries.length >= limit) {
      break;
    }
  }

  return [
    {
      id: "recent",
      title: "最近访问",
      items: limitedEntries.filter((entry) => entry.kind === "recent"),
    },
    {
      id: "page",
      title: "页面",
      items: limitedEntries.filter((entry) => entry.kind === "page"),
    },
    {
      id: "plugin",
      title: "插件",
      items: limitedEntries.filter((entry) => entry.kind === "plugin"),
    },
  ].filter((section) => section.items.length > 0);
}

export function buildCommandPaletteIndex({
  navItems,
  plugins,
  recentVisits,
  navigationUsage,
  pinnedPluginNames,
}: BuildCommandPaletteIndexOptions): CommandPaletteIndex {
  const recentEntries = buildRecentEntries(
    recentVisits,
    navItems,
    plugins,
    pinnedPluginNames
  );
  const pageEntries = rankPageEntries(
    buildPageEntries(navItems),
    recentEntries,
    navigationUsage
  );
  const pluginEntries = rankPluginEntries(
    buildPluginEntries(plugins, pinnedPluginNames),
    recentEntries,
    navigationUsage,
    pinnedPluginNames
  );

  return {
    recentEntries,
    pageEntries,
    pluginEntries,
    allEntries: [...recentEntries, ...pageEntries, ...pluginEntries],
  };
}

export function buildCommandPaletteSectionsFromIndex(
  index: CommandPaletteIndex,
  { query, limit = 12 }: BuildCommandPaletteSectionsFromIndexOptions
): CommandPaletteSection[] {
  if (!normalizeText(query)) {
    return buildDefaultSections(
      index.pageEntries,
      index.pluginEntries,
      index.recentEntries
    );
  }

  return buildSearchSections(index.allEntries, query, limit);
}

export function buildCommandPaletteSections({
  query,
  limit = 12,
  ...indexOptions
}: BuildCommandPaletteSectionsOptions): CommandPaletteSection[] {
  return buildCommandPaletteSectionsFromIndex(
    buildCommandPaletteIndex(indexOptions),
    { query, limit }
  );
}
