<template>
  <aside
    class="sidebar"
    aria-label="主导航侧边栏"
    :class="{
      'mobile-active': isMobileMenuOpen,
      collapsed: isSidebarCollapsed,
      hovering: isHoveringSidebar,
    }"
    @mouseenter="handleSidebarHover(true)"
    @mouseleave="handleSidebarHover(false)"
  >
    <div
      class="sidebar-search"
      :class="{ 'sidebar-collapsed': isSidebarCollapsed && !isHoveringSidebar }"
    >
      <TopBarSearch
        :model-value="sidebarSearchQuery"
        @update:model-value="emit('update:sidebarSearchQuery', $event)"
        @open-command-palette="emit('openCommandPalette')"
      />
    </div>

    <SidebarRecentVisits
      :recent-visits="recentVisits"
      :is-sidebar-collapsed="isSidebarCollapsed"
      :is-hovering-sidebar="isHoveringSidebar"
      :is-recent-visits-collapsed="isRecentVisitsCollapsed"
      @toggleRecent="toggleRecentVisits"
      @navigateTo="navigateTo"
    />

    <SidebarNavList
      :filtered-nav-items="filteredNavItems"
      :is-expanded-state="isExpandedState"
      :is-sidebar-collapsed="isSidebarCollapsed"
      :is-hovering-sidebar="isHoveringSidebar"
      :is-active-route="isActiveRoute"
      @navigateTo="navigateTo"
    />

  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { stripAppRouterBase } from "@/app/routes/base";
import { useAppStore, type NavItem } from "@/stores/app";
import { useLocalStorage } from "@/composables/useLocalStorage";
import type { RecentVisit } from "@/composables/useRecentVisits";
import type { PluginInfo } from "@/types/api.plugin";
import SidebarRecentVisits from "./sidebar/SidebarRecentVisits.vue";
import SidebarNavList from "./sidebar/SidebarNavList.vue";
import TopBarSearch from "@/components/layout/TopBarSearch.vue";

interface Props {
  isMobileMenuOpen: boolean;
  isSidebarCollapsed: boolean;
  isHoveringSidebar: boolean;
  isHoverEnabled: boolean;
  recentVisits: readonly RecentVisit[];
  sidebarSearchQuery: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: "navigateTo", target: string, pluginName?: string): void;
  (e: "update:isHoveringSidebar", value: boolean): void;
  (e: "update:sidebarSearchQuery", value: string): void;
  (e: "openCommandPalette"): void;
}>();

const route = useRoute();
const appStore = useAppStore();

const navItems = computed(() => appStore.navItems);
const plugins = computed(() => appStore.plugins);
const isExpandedState = computed(
  () => !props.isSidebarCollapsed || props.isHoveringSidebar
);
const isRecentVisitsCollapsed = useLocalStorage<boolean>(
  "sidebarRecentCollapsed",
  false
);

const filteredNavItems = computed(() => {
  const searchTerm = props.sidebarSearchQuery.toLowerCase().trim();
  if (!searchTerm) {
    return appendPinnedPluginItems(navItems.value);
  }

  const matchedCoreNav = filterCategorizedNavItems(navItems.value, searchTerm);
  const matchedPlugins = buildPluginSearchItems(searchTerm);

  if (matchedPlugins.length === 0) {
    return matchedCoreNav;
  }

  return [...matchedCoreNav, ...matchedPlugins];
});

function filterCategorizedNavItems(
  items: readonly NavItem[],
  searchTerm: string
): NavItem[] {
  const result: NavItem[] = [];
  let pendingCategory: NavItem | null = null;

  for (const item of items) {
    if (item.category) {
      pendingCategory = item;
      continue;
    }

    if (!item.label?.toLowerCase().includes(searchTerm)) {
      continue;
    }

    if (pendingCategory) {
      result.push(pendingCategory);
      pendingCategory = null;
    }

    result.push(item);
  }

  return result;
}

function matchesPlugin(plugin: PluginInfo, searchTerm: string): boolean {
  const label = appStore
    .getPluginDisplayName(plugin.manifest.name)
    .toLowerCase();
  const pluginName = plugin.manifest.name.toLowerCase();
  const description = plugin.manifest.description?.toLowerCase() || "";

  return (
    label.includes(searchTerm) ||
    pluginName.includes(searchTerm) ||
    description.includes(searchTerm)
  );
}

function buildPluginSearchItems(searchTerm: string): NavItem[] {
  const matchedPlugins = [...plugins.value]
    .filter((plugin) => matchesPlugin(plugin, searchTerm))
    .sort((a, b) => {
      const pinDelta =
        Number(appStore.isPluginPinned(b.manifest.name)) -
        Number(appStore.isPluginPinned(a.manifest.name));
      if (pinDelta !== 0) {
        return pinDelta;
      }

      return appStore
        .getPluginDisplayName(a.manifest.name)
        .localeCompare(appStore.getPluginDisplayName(b.manifest.name), "zh-CN", {
          sensitivity: "base",
        });
    })
    .slice(0, 8)
    .map<NavItem>((plugin) => ({
      target: `plugin-${plugin.manifest.name}-config`,
      label: appStore.getPluginDisplayName(plugin.manifest.name),
      icon: plugin.manifest.icon || "extension",
      pluginName: plugin.manifest.name,
      enabled: plugin.enabled,
    }));

  if (matchedPlugins.length === 0) {
    return [];
  }

  return [{ category: "插件搜索结果" }, ...matchedPlugins];
}

function buildPinnedPluginItems(): NavItem[] {
  if (appStore.pinnedPlugins.length === 0) {
    return [];
  }

  return [
    { category: "固定插件" },
    ...appStore.pinnedPlugins.map<NavItem>((plugin) => ({
      target: `plugin-${plugin.manifest.name}-config`,
      label: appStore.getPluginDisplayName(plugin.manifest.name),
      icon: plugin.manifest.icon || "extension",
      pluginName: plugin.manifest.name,
      enabled: plugin.enabled,
    })),
  ];
}

function appendPinnedPluginItems(items: readonly NavItem[]): NavItem[] {
  return [...items, ...buildPinnedPluginItems()];
}

function navigateTo(target: string | undefined, pluginName?: string) {
  if (!target) {
    return;
  }

  emit("navigateTo", target, pluginName);
}

function isActiveRoute(target: string | undefined, pluginName?: string): boolean {
  if (!target) {
    return false;
  }

  if (pluginName) {
    return (
      route.name === "PluginConfig" &&
      String(route.params.pluginName || "") === pluginName
    );
  }

  const currentPath = stripAppRouterBase(route.path);
  if (target === "dashboard") {
    return currentPath === "/" || currentPath === "/dashboard";
  }

  return currentPath === `/${target}`;
}

function handleSidebarHover(entering: boolean) {
  if (props.isHoverEnabled) {
    emit("update:isHoveringSidebar", entering);
  }
}

function toggleRecentVisits() {
  isRecentVisitsCollapsed.value = !isRecentVisitsCollapsed.value;
}

defineExpose({
  filteredNavItems,
});
</script>

<style scoped>
.sidebar {
  width: var(--app-sidebar-width, 280px);
  flex-shrink: 0;
  background-color: var(--app-shell-bg);
  border-right: 0;
  padding: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.sidebar.collapsed {
  width: var(--app-sidebar-width-icon, 72px);
}

.sidebar-search {
  padding: 0 8px;
}

.sidebar-search.sidebar-collapsed {
  padding: 0 8px;
}

:global(html[data-theme-shell-layout="sidebar"] .sidebar) {
  padding: 4px 8px 0;
  border-radius: 0;
  box-shadow: none;
}

:global(html[data-theme-shell-layout="sidebar"] .sidebar-search) {
  padding: 4px 8px 0;
}

.sidebar-search.sidebar-collapsed :deep(.top-bar-search) {
  width: 100%;
}

.sidebar-search.sidebar-collapsed :deep(input) {
  padding-right: 0;
  color: transparent;
  caret-color: transparent;
  pointer-events: none;
}

.sidebar-search.sidebar-collapsed :deep(input::placeholder) {
  color: transparent;
}

.sidebar-search.sidebar-collapsed :deep(.search-shortcut),
.sidebar-search.sidebar-collapsed :deep(.search-clear) {
  display: none;
}

@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    top: var(--app-top-bar-height, 60px);
    left: 0;
    bottom: 0;
    width: min(var(--app-sidebar-width, 280px), calc(100vw - 20px));
    max-width: calc(100vw - 20px);
    transform: translateX(-100%);
    z-index: 999;
    box-shadow: var(--overlay-panel-shadow);
  }

  .sidebar.mobile-active {
    transform: translateX(0);
  }

  .sidebar.collapsed {
    width: min(var(--app-sidebar-width, 280px), calc(100vw - 20px));
  }
}

@media (max-width: 480px) {
  .sidebar {
    width: min(260px, calc(100vw - 16px));
    max-width: calc(100vw - 16px);
  }

  .sidebar.collapsed {
    width: min(260px, calc(100vw - 16px));
  }
}
</style>
