import type { Ref } from "vue";
import { useLocalStorage } from "@/composables/useLocalStorage";
import type { NavItem } from "@/stores/app";
import type { PluginInfo } from "@/types/api.plugin";

export interface RecentVisit {
  target: string;
  label: string;
  icon?: string;
  pluginName?: string;
}

export interface NavigationUsageRecord {
  count: number;
  lastVisitedAt: number;
}

export type NavigationUsageMap = Record<string, NavigationUsageRecord>;

interface CreateRecentVisitOptions {
  target: string;
  navItems: readonly NavItem[];
  plugins: readonly PluginInfo[];
  pluginName?: string;
}

interface PushNavigationUsageOptions {
  target: string;
  pluginName?: string;
  timestamp?: number;
}

interface RecordNavigationVisitOptions extends CreateRecentVisitOptions {
  recentVisits: readonly RecentVisit[];
  navigationUsage: Readonly<NavigationUsageMap>;
  timestamp?: number;
}

export const RECENT_VISITS_STORAGE_KEY = "sidebarRecentVisits";
export const RECENT_VISITS_LIMIT = 5;
export const NAVIGATION_USAGE_STORAGE_KEY = "navigationUsage";

function getPluginName(plugin: PluginInfo): string {
  return plugin.manifest.name || plugin.name;
}

function getPluginDisplayName(plugin: PluginInfo): string {
  return plugin.manifest.displayName?.trim() || getPluginName(plugin);
}

function getPluginByName(
  plugins: readonly PluginInfo[],
  pluginName: string
): PluginInfo | undefined {
  return plugins.find((plugin) => getPluginName(plugin) === pluginName);
}

export function createRecentVisit({
  target,
  navItems,
  plugins,
  pluginName,
}: CreateRecentVisitOptions): RecentVisit | null {
  if (pluginName) {
    const plugin = getPluginByName(plugins, pluginName);
    if (!plugin) {
      return null;
    }

    return {
      target: `plugin-${pluginName}-config`,
      label: getPluginDisplayName(plugin),
      icon: plugin.manifest.icon || "extension",
      pluginName,
    };
  }

  const navItem = navItems.find((item) => item.target === target && item.label);
  if (!navItem?.label) {
    return null;
  }

  return {
    target,
    label: navItem.label,
    icon: navItem.icon,
    pluginName: navItem.pluginName,
  };
}

export function pushRecentVisit(
  recentVisits: readonly RecentVisit[],
  nextVisit: RecentVisit,
  limit = RECENT_VISITS_LIMIT
): RecentVisit[] {
  const nextVisits = recentVisits.filter((item) =>
    nextVisit.pluginName
      ? item.pluginName !== nextVisit.pluginName
      : item.target !== nextVisit.target
  );

  return [nextVisit, ...nextVisits].slice(0, limit);
}

export function getNavigationUsageKey(
  target: string,
  pluginName?: string
): string {
  return pluginName ? `plugin:${pluginName}` : `page:${target}`;
}

export function pushNavigationUsage(
  navigationUsage: Readonly<NavigationUsageMap>,
  {
    target,
    pluginName,
    timestamp = Date.now(),
  }: PushNavigationUsageOptions
): NavigationUsageMap {
  const usageKey = getNavigationUsageKey(target, pluginName);
  const currentRecord = navigationUsage[usageKey];

  return {
    ...navigationUsage,
    [usageKey]: {
      count: (currentRecord?.count ?? 0) + 1,
      lastVisitedAt: timestamp,
    },
  };
}

export function recordNavigationVisit({
  target,
  navItems,
  plugins,
  recentVisits,
  navigationUsage,
  pluginName,
  timestamp,
}: RecordNavigationVisitOptions): {
  recentVisits: RecentVisit[];
  navigationUsage: NavigationUsageMap;
} {
  const nextNavigationUsage = pushNavigationUsage(navigationUsage, {
    target,
    pluginName,
    timestamp,
  });
  const nextVisit = createRecentVisit({
    target,
    navItems,
    plugins,
    pluginName,
  });

  return {
    recentVisits: nextVisit
      ? pushRecentVisit(recentVisits, nextVisit)
      : [...recentVisits],
    navigationUsage: nextNavigationUsage,
  };
}

export function useRecentVisits(): Ref<RecentVisit[]> {
  return useLocalStorage<RecentVisit[]>(RECENT_VISITS_STORAGE_KEY, []);
}

export function useNavigationUsage(): Ref<NavigationUsageMap> {
  return useLocalStorage<NavigationUsageMap>(NAVIGATION_USAGE_STORAGE_KEY, {});
}
