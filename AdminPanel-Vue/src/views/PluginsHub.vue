<template>
  <section class="plugins-hub">
    <section class="hub-hero card">
      <div class="hero-copy">
        <span class="hero-eyebrow">Plugin Center</span>
        <h2>插件中心与启用管理</h2>
        <p>
          集中查看全部插件的启用状态、固定情况与分布式属性，支持搜索、筛选、刷新列表，并可直接进入插件配置或执行启停管理。
        </p>
      </div>

      <div class="hero-stats">
        <article class="stat-chip">
          <span class="stat-label">总数</span>
          <strong>{{ pluginSummary.total }}</strong>
        </article>
        <article class="stat-chip enabled">
          <span class="stat-label">已启用</span>
          <strong>{{ pluginSummary.enabled }}</strong>
        </article>
        <article class="stat-chip disabled">
          <span class="stat-label">已禁用</span>
          <strong>{{ pluginSummary.disabled }}</strong>
        </article>
        <article class="stat-chip">
          <span class="stat-label">已固定</span>
          <strong>{{ pluginSummary.pinned }}</strong>
        </article>
      </div>
    </section>

    <section class="card controls-card">
      <div class="controls-top">
        <label class="search-field">
          <span class="material-symbols-outlined">search</span>
          <input
            v-model="searchQuery"
            type="search"
            placeholder="搜索插件名称、原始名或描述…"
            aria-label="搜索插件"
          />
        </label>

        <button
          type="button"
          class="btn-secondary"
          :disabled="isRefreshing"
          @click="refreshPlugins()"
        >
          <span class="material-symbols-outlined">refresh</span>
          <span>{{ isRefreshing ? "刷新中…" : "刷新列表" }}</span>
        </button>
      </div>

      <div class="filter-row" aria-label="插件筛选">
        <button
          v-for="filter in filterOptions"
          :key="filter.value"
          type="button"
          class="filter-pill"
          :class="{ active: activeFilter === filter.value }"
          :aria-pressed="activeFilter === filter.value"
          @click="activeFilter = filter.value"
        >
          {{ filter.label }}
        </button>
      </div>
    </section>

    <section
      v-if="pinnedPluginRecords.length > 0 || recentPluginVisits.length > 0"
      class="quick-grid"
    >
      <article v-if="pinnedPluginRecords.length > 0" class="card quick-card">
        <div class="card-header quick-card-header">
          <h3 class="card-title">
            <span class="material-symbols-outlined">keep</span>
            <span>侧栏固定插件</span>
          </h3>
        </div>

        <div class="quick-list">
          <button
            v-for="plugin in pinnedPluginRecords"
            :key="plugin.pluginName"
            type="button"
            class="quick-link"
            @click="openPluginConfig(plugin.pluginName)"
          >
            <span class="material-symbols-outlined">{{ plugin.icon }}</span>
            <span>{{ plugin.displayName }}</span>
          </button>
        </div>
      </article>

      <article v-if="recentPluginVisits.length > 0" class="card quick-card">
        <div class="card-header quick-card-header">
          <h3 class="card-title">
            <span class="material-symbols-outlined">history</span>
            <span>最近访问插件</span>
          </h3>
        </div>

        <div class="quick-list">
          <button
            v-for="item in recentPluginVisits"
            :key="item.pluginName"
            type="button"
            class="quick-link"
            @click="openPluginConfig(item.pluginName)"
          >
            <span class="material-symbols-outlined">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </button>
        </div>
      </article>
    </section>

    <section class="results-header">
      <div>
        <h3>插件列表</h3>
        <p>
          共展示 {{ visiblePluginRecords.length }} 个结果，按
          {{ visiblePluginTypeGroups.length }} 个类型分组
        </p>
      </div>
    </section>

    <section v-if="visiblePluginRecords.length === 0" class="card empty-state">
      <span class="material-symbols-outlined">search_off</span>
      <h3>没有匹配的插件</h3>
      <p>试试切换筛选条件，或者搜索插件原始名称。</p>
    </section>

    <section v-else class="plugin-grouped-view">
      <article
        v-for="group in visiblePluginTypeGroups"
        :key="group.type"
        class="plugin-type-group"
      >
        <div class="type-group-header">
          <h3>
            <span class="material-symbols-outlined">folder</span>
            {{ group.label }}
            <span class="type-count">{{ group.records.length }}</span>
          </h3>

          <button
            type="button"
            class="group-collapse-toggle"
            :class="{ 'is-collapsed': isTypeGroupCollapsed(group.type) }"
            :aria-expanded="!isTypeGroupCollapsed(group.type)"
            :aria-controls="getPluginTypeGroupContentId(group.type)"
            @click="toggleTypeGroupCollapsed(group.type)"
          >
            <span>{{ isTypeGroupCollapsed(group.type) ? "展开" : "折叠" }}</span>
            <span class="material-symbols-outlined group-collapse-icon"
              >expand_more</span
            >
          </button>
        </div>

        <transition name="group-collapse">
          <div
            v-show="!isTypeGroupCollapsed(group.type)"
            :id="getPluginTypeGroupContentId(group.type)"
            class="type-group-content"
          >
            <div class="plugin-grid">
              <article
                v-for="plugin in group.records"
                :key="plugin.pluginName"
                class="plugin-card"
              >
                <div class="plugin-card-top">
                  <div class="plugin-identity">
                    <div class="plugin-icon-shell">
                      <span class="material-symbols-outlined">{{ plugin.icon }}</span>
                    </div>

                    <div class="plugin-heading">
                      <div class="plugin-title-row">
                        <h3>{{ plugin.displayName }}</h3>
                        <span
                          class="status-badge"
                          :class="plugin.enabled ? 'status-enabled' : 'status-disabled'"
                        >
                          {{ plugin.enabled ? "启用中" : "已禁用" }}
                        </span>
                        <span
                          v-if="plugin.isDistributed"
                          class="status-badge status-neutral"
                        >
                          分布式
                        </span>
                        <span
                          v-if="plugin.isPinned"
                          class="status-badge status-pinned"
                        >
                          已固定
                        </span>
                      </div>
                      <p class="plugin-original-name">{{ plugin.pluginName }}</p>
                    </div>
                  </div>

                  <div class="plugin-card-side">
                    <button
                      type="button"
                      class="pin-toggle"
                      :class="{ 'is-active': plugin.isPinned }"
                      :title="plugin.isPinned ? '取消固定' : '固定到侧栏'"
                      :aria-label="
                        plugin.isPinned ? '取消固定到侧栏' : '固定到侧栏'
                      "
                      :aria-pressed="plugin.isPinned"
                      @click="togglePinned(plugin.pluginName)"
                    >
                      <span class="material-symbols-outlined">
                        {{ plugin.isPinned ? "keep" : "keep_off" }}
                      </span>
                    </button>

                    <span class="plugin-version-badge">
                      v{{ plugin.plugin.manifest.version || "0.0.0" }}
                    </span>
                  </div>
                </div>

                <div class="plugin-card-main">
                  <p
                    class="plugin-description"
                    :title="plugin.description || '该插件暂未提供描述信息。'"
                  >
                    {{ plugin.summary }}
                  </p>

                  <div
                    v-if="plugin.isDistributed || plugin.isPinned"
                    class="plugin-status-pills"
                  >
                    <span
                      v-if="plugin.isDistributed"
                      class="mini-pill mini-pill--sensitive"
                    >
                      <span class="material-symbols-outlined mini-pill-icon">hub</span>
                      分布式
                    </span>
                    <span
                      v-if="plugin.isPinned"
                      class="mini-pill mini-pill--changed"
                    >
                      <span class="material-symbols-outlined mini-pill-icon"
                        >push_pin</span
                      >
                      已固定
                    </span>
                  </div>

                  <div class="plugin-actions">
                    <button
                      type="button"
                      class="btn-primary"
                      @click="openPluginConfig(plugin.pluginName)"
                    >
                      <span class="material-symbols-outlined">open_in_new</span>
                      <span>打开配置</span>
                    </button>

                    <button
                      type="button"
                      :class="plugin.enabled ? 'btn-danger' : 'btn-secondary'"
                      :disabled="
                        plugin.isDistributed || isPluginPending(plugin.pluginName)
                      "
                      :title="
                        plugin.isDistributed ? '分布式插件状态由所属节点管理' : undefined
                      "
                      @click="togglePlugin(plugin.plugin)"
                    >
                      <span class="material-symbols-outlined">
                        {{ plugin.enabled ? "power_settings_new" : "bolt" }}
                      </span>
                      <span>{{
                        isPluginPending(plugin.pluginName)
                          ? "处理中…"
                          : plugin.enabled
                            ? "禁用插件"
                            : "启用插件"
                      }}</span>
                    </button>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </transition>
      </article>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { pluginApi } from "@/api";
import {
  recordNavigationVisit,
  useNavigationUsage,
  useRecentVisits,
} from "@/composables/useRecentVisits";
import {
  buildPinnedPluginRecords,
  buildPluginHubRecordMap,
  buildPluginHubRecords,
  buildRecentPluginVisitItems,
  filterPluginHubRecords,
  summarizePluginHubRecords,
  type PluginFilter,
  type PluginHubRecord,
} from "@/features/plugins-hub/derivePluginHubState";
import { useAppStore } from "@/stores/app";
import { showMessage } from "@/utils";
import type { PluginInfo } from "@/types/api.plugin";

const router = useRouter();
const appStore = useAppStore();

const searchQuery = ref("");
const activeFilter = ref<PluginFilter>("all");
const isRefreshing = ref(false);
const pendingPluginNames = ref<string[]>([]);
const recentVisits = useRecentVisits();
const navigationUsage = useNavigationUsage();
const collapsedTypeGroups = ref<Record<string, boolean>>({});

const plugins = computed(() => appStore.plugins);
const pinnedPluginNames = computed(() => appStore.pinnedPluginNames);
const pluginsLoaded = computed(() => appStore.pluginsLoaded);

const filterOptions: Array<{ value: PluginFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "enabled", label: "已启用" },
  { value: "disabled", label: "已禁用" },
  { value: "pinned", label: "已固定" },
  { value: "distributed", label: "分布式" },
];
const PLUGIN_TYPE_LABELS: Record<string, string> = {
  static: "静态插件",
  messagePreprocessor: "消息预处理",
  synchronous: "同步插件",
  asynchronous: "异步插件",
  service: "服务插件",
  hybridservice: "混合服务",
  unknown: "未标注类型",
};
const PLUGIN_DESCRIPTION_MAX_LENGTH = 96;

const pluginRecords = computed(() =>
  buildPluginHubRecords(
    plugins.value,
    pinnedPluginNames.value,
    PLUGIN_DESCRIPTION_MAX_LENGTH
  )
);
const pluginRecordMap = computed(() =>
  buildPluginHubRecordMap(pluginRecords.value)
);
const pinnedPluginRecords = computed(() =>
  buildPinnedPluginRecords(pinnedPluginNames.value, pluginRecordMap.value)
);
const pluginSummary = computed(() =>
  summarizePluginHubRecords(pluginRecords.value)
);
const recentPluginVisits = computed(() =>
  buildRecentPluginVisitItems(recentVisits.value, pluginRecordMap.value)
);
const visiblePluginRecords = computed(() =>
  filterPluginHubRecords(pluginRecords.value, {
    query: searchQuery.value,
    filter: activeFilter.value,
  })
);

interface PluginTypeGroup {
  type: string;
  label: string;
  records: PluginHubRecord[];
}

function getPluginType(record: PluginHubRecord): string {
  const rawType = record.plugin.manifest.pluginType?.trim();
  return rawType || "unknown";
}

function getPluginTypeLabel(type: string): string {
  return PLUGIN_TYPE_LABELS[type] || type;
}

const visiblePluginTypeGroups = computed<PluginTypeGroup[]>(() => {
  const groups: Record<string, PluginHubRecord[]> = {};

  for (const record of visiblePluginRecords.value) {
    const pluginType = getPluginType(record);
    if (!groups[pluginType]) {
      groups[pluginType] = [];
    }
    groups[pluginType].push(record);
  }

  return Object.entries(groups)
    .map(([type, records]) => ({
      type,
      label: getPluginTypeLabel(type),
      records,
    }))
    .sort((a, b) =>
      a.label.localeCompare(b.label, "zh-CN", {
        sensitivity: "base",
      })
    );
});

function isTypeGroupCollapsed(type: string): boolean {
  return collapsedTypeGroups.value[type] ?? false;
}

function toggleTypeGroupCollapsed(type: string): void {
  collapsedTypeGroups.value = {
    ...collapsedTypeGroups.value,
    [type]: !isTypeGroupCollapsed(type),
  };
}

function getPluginTypeGroupContentId(type: string): string {
  const normalizedType = type.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `plugin-type-group-content-${normalizedType}`;
}

function isPluginPinned(pluginName: string): boolean {
  return appStore.isPluginPinned(pluginName);
}

function isPluginPending(pluginName: string): boolean {
  return pendingPluginNames.value.includes(pluginName);
}

function recordPluginVisit(pluginName: string) {
  const nextNavigationState = recordNavigationVisit({
    target: `plugin-${pluginName}-config`,
    navItems: appStore.navItems,
    plugins: appStore.plugins,
    recentVisits: recentVisits.value,
    navigationUsage: navigationUsage.value,
    pluginName,
  });
  recentVisits.value = nextNavigationState.recentVisits;
  navigationUsage.value = nextNavigationState.navigationUsage;
}

function openPluginConfig(pluginName: string) {
  recordPluginVisit(pluginName);
  router.push({ name: "PluginConfig", params: { pluginName } });
}

function togglePinned(pluginName: string) {
  const willPin = !isPluginPinned(pluginName);
  appStore.togglePinnedPlugin(pluginName);
  showMessage(
    willPin ? "已固定到侧栏快捷区。" : "已从侧栏快捷区移除。",
    "success"
  );
}

async function refreshPlugins(showSuccessMessage = true) {
  isRefreshing.value = true;

  try {
    await appStore.refreshPlugins();
    if (showSuccessMessage) {
      showMessage("插件列表已刷新。", "success");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`刷新插件列表失败：${message}`, "error");
  } finally {
    isRefreshing.value = false;
  }
}

async function togglePlugin(plugin: PluginInfo) {
  if (plugin.isDistributed) {
    showMessage("分布式插件需要在所属节点侧启停。", "warning");
    return;
  }

  const pluginName = plugin.manifest.name || plugin.name;
  const enable = !plugin.enabled;
  const action = enable ? "启用" : "禁用";

  if (
    !confirm(
      `确定要${action}插件 "${plugin.manifest.displayName?.trim() || pluginName}" 吗？`
    )
  ) {
    return;
  }

  pendingPluginNames.value = [...pendingPluginNames.value, pluginName];

  try {
    const result = await pluginApi.togglePlugin(pluginName, enable, {
      showLoader: false,
    });
    showMessage(result.message || `${action}插件成功。`, "success");
    await refreshPlugins(false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`${action}插件失败：${message}`, "error");
  } finally {
    pendingPluginNames.value = pendingPluginNames.value.filter(
      (item) => item !== pluginName
    );
  }
}

onMounted(async () => {
  if (!pluginsLoaded.value) {
    try {
      await appStore.ensurePluginsLoaded();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showMessage(`Failed to load plugins: ${message}`, "error");
    }
  }
});
</script>

<style scoped>
.plugins-hub {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.hub-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr);
  gap: var(--space-5);
  background: var(--secondary-bg);
  border: 1px solid var(--border-color);
}

.hero-copy h2 {
  font-size: var(--font-size-headline);
  line-height: 1.2;
  margin-bottom: var(--space-3);
}

.hero-copy p {
  max-width: 56ch;
  color: var(--secondary-text);
}

.hero-eyebrow {
  display: inline-flex;
  margin-bottom: var(--space-3);
  padding: 4px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--button-bg) 16%, transparent);
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.hero-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.stat-chip {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--tertiary-bg);
}

.stat-chip strong {
  font-size: var(--font-size-display);
}

.stat-chip.enabled strong {
  color: var(--success-color);
}

.stat-chip.disabled strong {
  color: var(--danger-color);
}

.stat-label {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.controls-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.controls-top {
  display: flex;
  gap: var(--space-3);
  align-items: center;
}

.search-field {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 14px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--input-bg);
}

.search-field .material-symbols-outlined {
  color: var(--secondary-text);
}

.search-field input {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 14px 0;
}

.search-field input:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: -2px;
}

.search-field input:focus:not(:focus-visible) {
  outline: none;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.filter-pill {
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  padding: 8px 14px;
  cursor: pointer;
  box-shadow: inset 0 1px 0 var(--surface-overlay-soft);
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.filter-pill:hover,
.filter-pill.active {
  background: color-mix(in srgb, var(--button-bg) 14%, var(--tertiary-bg));
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--button-bg) 36%, transparent);
}

.filter-pill:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 50%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-5);
}

.quick-card-header {
  margin-bottom: var(--space-4);
}

.quick-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.quick-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--tertiary-bg);
  color: var(--primary-text);
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}

.quick-link:hover {
  border-color: color-mix(in srgb, var(--button-bg) 36%, transparent);
  background: var(--accent-bg);
}

.quick-link:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 50%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.results-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
}

.results-header h3 {
  font-size: var(--font-size-title);
}

.results-header p {
  color: var(--secondary-text);
  margin-top: 4px;
}

/* .empty-state 已在全局 layout.css 中统一定义 */

.plugin-grouped-view {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.plugin-type-group {
  background: var(--secondary-bg);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.type-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  background: var(--tertiary-bg);
  border-bottom: 1px solid var(--border-color);
}

.type-group-header h3 {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-emphasis);
  margin: 0;
}

.type-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1;
}

.group-collapse-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--secondary-bg);
  color: var(--secondary-text);
  cursor: pointer;
  transition:
    color 0.2s ease,
    background-color 0.2s ease,
    border-color 0.2s ease;
}

.group-collapse-toggle:hover {
  color: var(--primary-text);
  background: color-mix(in srgb, var(--button-bg) 10%, transparent);
  border-color: color-mix(in srgb, var(--button-bg) 28%, transparent);
}

.group-collapse-toggle:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.group-collapse-icon {
  font-size: var(--font-size-title);
  line-height: 1;
  transition: transform 0.24s ease;
}

.group-collapse-toggle.is-collapsed .group-collapse-icon {
  transform: rotate(-90deg);
}

.type-group-content {
  padding: 16px;
}

.group-collapse-enter-active,
.group-collapse-leave-active {
  overflow: hidden;
  transition:
    max-height 0.28s ease,
    opacity 0.24s ease,
    transform 0.24s ease,
    padding-top 0.24s ease,
    padding-bottom 0.24s ease;
}

.group-collapse-enter-from,
.group-collapse-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-6px);
  padding-top: 0;
  padding-bottom: 0;
}

.group-collapse-enter-to,
.group-collapse-leave-from {
  max-height: 2600px;
  opacity: 1;
  transform: translateY(0);
}

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 18px;
}

.plugin-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  padding: 20px;
  background: var(--secondary-bg);
  box-shadow: var(--shadow-sm);
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}

.plugin-card:hover {
  box-shadow: var(--shadow-md);
  border-color: color-mix(in srgb, var(--button-bg) 28%, var(--border-color));
}

.plugin-card-top {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.plugin-identity {
  display: flex;
  gap: 14px;
  min-width: 0;
}

.plugin-icon-shell {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--button-bg) 18%, transparent);
  color: var(--highlight-text);
  flex-shrink: 0;
}

.plugin-heading {
  flex: 1;
  min-width: 0;
}

.plugin-title-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.plugin-title-row h3 {
  font-size: var(--font-size-emphasis);
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.plugin-original-name {
  margin-top: 6px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  overflow-wrap: anywhere;
}

.plugin-card-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
  flex-shrink: 0;
}

.plugin-version-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--tertiary-bg);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: var(--font-size-caption);
  font-weight: 600;
  border: 1px solid transparent;
}

.status-enabled {
  color: var(--success-text);
  background: var(--success-bg);
  border-color: var(--success-border);
}

.status-disabled {
  color: var(--danger-text);
  background: var(--danger-bg);
  border-color: var(--danger-border);
}

.status-neutral {
  color: var(--warning-text);
  background: var(--warning-bg);
  border-color: var(--warning-border);
}

.status-pinned {
  color: var(--info-text);
  background: var(--info-bg);
  border-color: var(--info-border);
}

/* ========== Mini Pills (RagTuning 风格) ========== */

.plugin-status-pills {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: 12px;
}

.mini-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: var(--font-size-caption);
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.mini-pill-icon {
  font-size: var(--font-size-body);
  line-height: 1;
}

.mini-pill--sensitive {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.mini-pill--changed {
  background: var(--info-bg);
  color: var(--info-text);
}

.mini-pill--neutral {
  background: var(--tertiary-bg);
  color: var(--secondary-text);
}

.pin-toggle {
  display: inline-grid;
  place-items: center;
  align-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background-color 0.2s ease,
    transform 0.2s ease;
}

.pin-toggle:hover {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--button-bg) 30%, transparent);
  background: color-mix(in srgb, var(--button-bg) 10%, transparent);
}

.pin-toggle.is-active {
  color: var(--highlight-text);
  border-color: color-mix(in srgb, var(--button-bg) 38%, transparent);
  background: color-mix(in srgb, var(--button-bg) 14%, transparent);
}

.pin-toggle:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 50%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.plugin-card-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.plugin-description {
  color: var(--secondary-text);
  line-height: 1.55;
  min-height: calc(1.55em * 3);
  max-height: calc(1.55em * 3);
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  margin-bottom: 14px;
}

.plugin-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-bottom: 18px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.plugin-meta span {
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--tertiary-bg);
}

.plugin-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: auto;
  padding-top: 4px;
}

@media (max-width: 1024px) {
  .hub-hero,
  .quick-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .controls-top {
    flex-direction: column;
    align-items: stretch;
  }

  .type-group-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .group-collapse-toggle {
    align-self: flex-end;
  }

  .type-group-content {
    padding: 12px;
  }

  .controls-top .btn-secondary {
    justify-content: center;
  }

  .plugin-grid {
    grid-template-columns: 1fr;
  }

  .plugin-card-top {
    flex-direction: column;
  }

  .plugin-card-side {
    align-self: flex-start;
    align-items: flex-start;
    flex-direction: row;
  }
}

@media (max-width: 480px) {
  .hub-hero {
    gap: var(--space-4);
  }

  .hero-copy h2 {
    font-size: var(--font-size-display);
  }

  .hero-stats {
    grid-template-columns: 1fr 1fr;
  }

  .plugin-card {
    padding: 16px;
  }

  .plugin-actions {
    flex-direction: column;
  }

  .plugin-actions :deep(button) {
    width: 100%;
    justify-content: center;
  }
}
</style>
