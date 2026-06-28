<template>
  <section class="plugins-hub">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton
          type="button"
          variant="outline"
          size="lg"
          :disabled="isRefreshing"
          @click="refreshPlugins()"
        >
          <template #leading><span class="material-symbols-outlined">refresh</span></template>
          <span>{{ isRefreshing ? "刷新中…" : "刷新列表" }}</span>
        </UiButton>
      </UiPageActions>
    </Teleport>

    <UiCard class="hub-hero">
      <div class="hero-copy">
        <span class="eyebrow hero-eyebrow">Plugin Center</span>
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
    </UiCard>

    <section class="plugins-toolbar" aria-label="插件筛选与视图">
      <div class="view-mode-switch" role="group" aria-label="插件视图切换">
        <UiButton
          type="button"
          size="sm"
          :variant="viewMode === 'grouped' ? 'primary' : 'outline'"
          :aria-pressed="viewMode === 'grouped'"
          @click="viewMode = 'grouped'"
        >
          <template #leading><span class="material-symbols-outlined">view_agenda</span></template>
          <span>分组视图</span>
        </UiButton>
        <UiButton
          type="button"
          size="sm"
          :variant="viewMode === 'list' ? 'primary' : 'outline'"
          :aria-pressed="viewMode === 'list'"
          @click="viewMode = 'list'"
        >
          <template #leading><span class="material-symbols-outlined">view_list</span></template>
          <span>列表视图</span>
        </UiButton>
      </div>

      <div class="controls-main-row">
        <label class="search-field">
          <span class="material-symbols-outlined">search</span>
          <UiInput
            ref="pluginSearchInputRef"
            v-model="searchQuery"
            type="search"
            size="sm"
            placeholder="搜索插件名称、原始名或描述…"
            aria-label="搜索插件"
          />
        </label>
      </div>

      <div class="filter-row" aria-label="插件筛选">
        <UiButton
          v-for="filter in visibleFilterOptions"
          :key="filter.value"
          type="button"
          size="xs"
          :variant="activeFilter === filter.value ? 'primary' : 'outline'"
          :aria-pressed="activeFilter === filter.value"
          @click="selectFilter(filter.value)"
        >
          {{ filter.label }}
        </UiButton>

        <details
          v-if="overflowFilterOptions.length > 0"
          class="filters-overflow"
          :open="filterOverflowOpen"
          @toggle="handleFilterOverflowToggle"
        >
          <summary class="filters-overflow-trigger">
            更多
            <span class="pill-count">{{ overflowFilterOptions.length }}</span>
          </summary>
          <div class="filters-overflow-menu" role="menu" aria-label="更多插件筛选">
            <UiButton
              v-for="filter in overflowFilterOptions"
              :key="filter.value"
              type="button"
              size="xs"
              :variant="activeFilter === filter.value ? 'primary' : 'ghost'"
              :aria-pressed="activeFilter === filter.value"
              @click="selectFilter(filter.value)"
            >
              {{ filter.label }}
            </UiButton>
          </div>
        </details>
      </div>
    </section>

    <section
      v-if="pinnedPluginRecords.length > 0 || recentPluginVisits.length > 0"
      class="quick-grid"
    >
      <UiCard v-if="pinnedPluginRecords.length > 0" class="quick-card" title="侧栏固定插件" size="sm" variant="subtle">
        <template #icon><span class="material-symbols-outlined">keep</span></template>
        <div class="quick-list">
          <UiButton
            v-for="plugin in pinnedPluginRecords"
            :key="plugin.pluginName"
            type="button"
            variant="outline"
            size="sm"
            @click="openPluginConfig(plugin.pluginName)"
          >
            <template #leading><span class="material-symbols-outlined">{{ plugin.icon }}</span></template>
            <span>{{ plugin.displayName }}</span>
          </UiButton>
        </div>
      </UiCard>

      <UiCard v-if="recentPluginVisits.length > 0" class="quick-card" title="最近访问插件" size="sm" variant="subtle">
        <template #icon><span class="material-symbols-outlined">history</span></template>

        <div class="quick-list">
          <UiButton
            v-for="item in recentPluginVisits"
            :key="item.pluginName"
            type="button"
            variant="outline"
            size="sm"
            @click="openPluginConfig(item.pluginName)"
          >
            <template #leading><span class="material-symbols-outlined">{{ item.icon }}</span></template>
            <span>{{ item.label }}</span>
          </UiButton>
        </div>
      </UiCard>
    </section>

    <section class="results-header">
      <div>
        <h3>插件列表</h3>
        <p v-if="viewMode === 'grouped'">
          共展示 {{ visiblePluginRecords.length }} 个结果，按
          {{ visiblePluginTypeGroups.length }} 个类型分组
        </p>
        <p v-else>共展示 {{ visiblePluginRecords.length }} 个结果，当前为列表视图</p>
      </div>
    </section>

    <UiCard v-if="visiblePluginRecords.length === 0" class="empty-state" variant="subtle">
      <UiEmptyState title="没有匹配的插件" description="试试切换筛选条件，或者搜索插件原始名称。" />
    </UiCard>

    <section v-else-if="viewMode === 'grouped'" class="plugin-grouped-view">
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

          <UiButton
            type="button"
            class="group-collapse-toggle"
            variant="outline"
            size="sm"
            :aria-expanded="!isTypeGroupCollapsed(group.type)"
            :aria-controls="getPluginTypeGroupContentId(group.type)"
            @click="toggleTypeGroupCollapsed(group.type)"
          >
            <span>{{ isTypeGroupCollapsed(group.type) ? "展开" : "折叠" }}</span>
            <template #trailing>
              <span
                class="material-symbols-outlined group-collapse-icon"
                :class="{ 'is-collapsed': isTypeGroupCollapsed(group.type) }"
              >expand_more</span>
            </template>
          </UiButton>
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
                        <UiBadge :variant="plugin.enabled ? 'success' : 'danger'">
                          {{ plugin.enabled ? "启用中" : "已禁用" }}
                        </UiBadge>
                        <UiBadge
                          v-if="plugin.isDistributed"
                          variant="warning"
                        >
                          分布式
                        </UiBadge>
                        <UiBadge
                          v-if="plugin.isPinned"
                          variant="info"
                        >
                          已固定
                        </UiBadge>
                      </div>
                      <p class="plugin-original-name">{{ plugin.pluginName }}</p>
                    </div>
                  </div>

                  <div class="plugin-card-side">
                    <UiIconButton
                      type="button"
                      :active="plugin.isPinned"
                      :title="plugin.isPinned ? '取消固定' : '固定到侧栏'"
                      :label="plugin.isPinned ? '取消固定到侧栏' : '固定到侧栏'"
                      :aria-pressed="plugin.isPinned"
                      @click="togglePinned(plugin.pluginName)"
                    >
                      <span class="material-symbols-outlined">
                        {{ plugin.isPinned ? "keep" : "keep_off" }}
                      </span>
                    </UiIconButton>

                    <UiBadge class="plugin-version-badge" variant="outline">
                      v{{ plugin.plugin.manifest.version || "0.0.0" }}
                    </UiBadge>
                  </div>
                </div>

                <div class="plugin-card-main">
                  <p
                    class="plugin-description"
                    :title="plugin.description || '该插件暂未提供描述信息。'"
                  >
                    {{ plugin.summary }}
                  </p>

                  <div class="plugin-actions">
                    <UiButton
                      type="button"
                      size="sm"
                      @click="openPluginConfig(plugin.pluginName)"
                    >
                      <template #leading><span class="material-symbols-outlined">open_in_new</span></template>
                      <span>打开配置</span>
                    </UiButton>

                    <UiButton
                      type="button"
                      size="sm"
                      :variant="plugin.enabled ? 'danger' : 'outline'"
                      :disabled="
                        plugin.isDistributed || isPluginPending(plugin.pluginName)
                      "
                      :title="
                        plugin.isDistributed ? '分布式插件状态由所属节点管理' : undefined
                      "
                      @click="togglePlugin(plugin.plugin)"
                    >
                      <template #leading><span class="material-symbols-outlined">
                        {{ plugin.enabled ? "power_settings_new" : "bolt" }}
                      </span></template>
                      <span>{{
                        isPluginPending(plugin.pluginName)
                          ? "处理中…"
                          : plugin.enabled
                            ? "禁用插件"
                            : "启用插件"
                      }}</span>
                    </UiButton>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </transition>
      </article>
    </section>

    <section v-else class="plugin-list-view">
      <div class="plugin-grid">
        <article
          v-for="plugin in visiblePluginRecords"
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
                  <UiBadge :variant="plugin.enabled ? 'success' : 'danger'">
                    {{ plugin.enabled ? "启用中" : "已禁用" }}
                  </UiBadge>
                  <UiBadge
                    v-if="plugin.isDistributed"
                    variant="warning"
                  >
                    分布式
                  </UiBadge>
                  <UiBadge v-if="plugin.isPinned" variant="info">
                    已固定
                  </UiBadge>
                </div>
                <p class="plugin-original-name">{{ plugin.pluginName }}</p>
              </div>
            </div>

            <div class="plugin-card-side">
              <UiIconButton
                type="button"
                :active="plugin.isPinned"
                :title="plugin.isPinned ? '取消固定' : '固定到侧栏'"
                :label="plugin.isPinned ? '取消固定到侧栏' : '固定到侧栏'"
                :aria-pressed="plugin.isPinned"
                @click="togglePinned(plugin.pluginName)"
              >
                <span class="material-symbols-outlined">
                  {{ plugin.isPinned ? "keep" : "keep_off" }}
                </span>
              </UiIconButton>

              <UiBadge class="plugin-version-badge" variant="outline">
                v{{ plugin.plugin.manifest.version || "0.0.0" }}
              </UiBadge>
            </div>
          </div>

          <div class="plugin-card-main">
            <p
              class="plugin-description"
              :title="plugin.description || '该插件暂未提供描述信息。'"
            >
              {{ plugin.summary }}
            </p>

            <div class="plugin-actions">
              <UiButton
                type="button"
                size="sm"
                @click="openPluginConfig(plugin.pluginName)"
              >
                <template #leading><span class="material-symbols-outlined">open_in_new</span></template>
                <span>打开配置</span>
              </UiButton>

              <UiButton
                type="button"
                size="sm"
                :variant="plugin.enabled ? 'danger' : 'outline'"
                :disabled="plugin.isDistributed || isPluginPending(plugin.pluginName)"
                :title="plugin.isDistributed ? '分布式插件状态由所属节点管理' : undefined"
                @click="togglePlugin(plugin.plugin)"
              >
                <template #leading><span class="material-symbols-outlined">
                  {{ plugin.enabled ? "power_settings_new" : "bolt" }}
                </span></template>
                <span>{{
                  isPluginPending(plugin.pluginName)
                    ? "处理中…"
                    : plugin.enabled
                      ? "禁用插件"
                      : "启用插件"
                }}</span>
              </UiButton>
            </div>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { pluginApi } from "@/api";
import { useLocalStorage } from "@/composables/useLocalStorage";
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
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { useAppStore } from "@/stores/app";
import { showMessage } from "@/utils";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import type { PluginInfo } from "@/types/api.plugin";

const router = useRouter();
const appStore = useAppStore();

type PluginViewMode = "grouped" | "list";
type PersistedPluginViewMode = PluginViewMode | "";

const searchQuery = ref("");
const activeFilter = ref<PluginFilter>("all");
const storedViewMode = useLocalStorage<PersistedPluginViewMode>(
  "pluginsHub.viewMode",
  "grouped",
  {
    parser: (value) => {
      try {
        const parsed = JSON.parse(value) as string;
        return parsed === "list" ? "list" : "grouped";
      } catch {
        return "grouped";
      }
    },
    serializer: (value) => JSON.stringify(value === "list" ? "list" : "grouped"),
  }
);
const viewMode = computed<PluginViewMode>({
  get: () => (storedViewMode.value === "list" ? "list" : "grouped"),
  set: (value) => {
    storedViewMode.value = value;
  },
});
const isRefreshing = ref(false);
const pendingPluginNames = ref<string[]>([]);
const recentVisits = useRecentVisits();
const navigationUsage = useNavigationUsage();
const collapsedTypeGroups = ref<Record<string, boolean>>({});
const pluginSearchInputRef = ref<{ focus: () => void; select: () => void } | null>(null);
const filterOverflowOpen = ref(false);
const MAX_VISIBLE_FILTERS = 5;

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

const visibleFilterOptions = computed(() => {
  if (filterOptions.length <= MAX_VISIBLE_FILTERS) {
    return filterOptions;
  }

  const base = filterOptions.slice(0, MAX_VISIBLE_FILTERS);
  const selected = filterOptions.find((item) => item.value === activeFilter.value);
  if (!selected || base.some((item) => item.value === selected.value)) {
    return base;
  }

  return [...base.slice(0, MAX_VISIBLE_FILTERS - 1), selected];
});

const overflowFilterOptions = computed(() => {
  const visibleValues = new Set(visibleFilterOptions.value.map((item) => item.value));
  return filterOptions.filter((item) => !visibleValues.has(item.value));
});

function selectFilter(filter: PluginFilter): void {
  activeFilter.value = filter;
  filterOverflowOpen.value = false;
}

function handleFilterOverflowToggle(event: Event): void {
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement)) {
    return;
  }
  filterOverflowOpen.value = details.open;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function handlePageHotkeys(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey) {
    return;
  }

  if (!event.ctrlKey && !event.metaKey && event.key === "/" && !isEditableTarget(event.target)) {
    event.preventDefault();
    pluginSearchInputRef.value?.focus();
    pluginSearchInputRef.value?.select();
    return;
  }

  if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "r" && !isEditableTarget(event.target)) {
    event.preventDefault();
    void refreshPlugins();
  }
}
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
    !(await askConfirm({
      message: `确定要${action}插件 "${plugin.manifest.displayName?.trim() || pluginName}" 吗？`,
      danger: !enable,
      confirmText: action,
    }))
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

  document.addEventListener("keydown", handlePageHotkeys);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handlePageHotkeys);
});

watch(activeFilter, () => {
  filterOverflowOpen.value = false;
});
</script>

<style scoped>
.plugins-hub {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.hub-hero {
  padding: var(--space-4);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 94%, transparent);
}

.hub-hero :deep(.ui-card__content) {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr);
  gap: var(--space-3);
  align-items: stretch;
}

.hero-copy h2 {
  margin: 0 0 var(--space-1);
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.hero-copy p {
  margin: 0;
  max-width: 56ch;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.hero-eyebrow {
  display: inline-flex;
  margin-bottom: var(--space-1);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.stat-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 54px;
  justify-content: center;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.stat-chip strong {
  font-size: var(--font-size-emphasis);
  line-height: 1.1;
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

.plugins-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  position: sticky;
  top: 0;
  z-index: 17;
  padding: var(--space-2) 0 var(--space-1);
  background: color-mix(in srgb, var(--primary-bg) 82%, transparent);
  backdrop-filter: blur(10px);
}

.controls-main-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.controls-main-row {
  flex: 1 1 240px;
  min-width: 220px;
}

.search-field {
  width: 100%;
}

.view-mode-switch {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  position: relative;
}

.pill-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  margin-left: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--button-bg) 16%, transparent);
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  line-height: 1;
}

.filters-overflow {
  position: relative;
}

.filters-overflow > summary {
  list-style: none;
}

.filters-overflow > summary::-webkit-details-marker {
  display: none;
}

.filters-overflow-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  cursor: pointer;
  background: transparent;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.filters-overflow-trigger:hover {
  background: color-mix(in srgb, var(--primary-text) 2.5%, transparent);
  color: var(--primary-text);
}

.filters-overflow[open] .filters-overflow-trigger {
  border-style: solid;
  border-color: color-mix(in srgb, var(--button-bg) 28%, var(--border-color));
  color: var(--primary-text);
}

.filters-overflow-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 92%, transparent);
  box-shadow: var(--shadow-lg);
  z-index: 5;
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.quick-card {
  border-color: color-mix(in srgb, var(--border-color) 92%, transparent);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.quick-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.results-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  padding-top: var(--space-1);
}

.results-header h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
  line-height: 1.35;
}

.results-header p {
  color: var(--secondary-text);
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-helper);
}

/* .empty-state 已在全局 layout.css 中统一定义 */

.plugin-grouped-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.plugin-list-view {
  display: block;
}

.plugin-type-group {
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--border-color) 94%, transparent);
  overflow: hidden;
}

.type-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 42px;
  padding: 7px 10px;
  background: color-mix(in srgb, var(--primary-text) 2.2%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
}

.type-group-header h3 {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-helper);
  font-weight: 700;
  margin: 0;
}

.type-group-header .material-symbols-outlined {
  color: var(--secondary-text);
  font-size: 16px;
}

.type-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1;
}

.group-collapse-toggle {
  flex: 0 0 auto;
}

.group-collapse-icon {
  font-size: var(--font-size-title);
  line-height: 1;
  transition: transform var(--transition-fast);
}

.group-collapse-icon.is-collapsed {
  transform: rotate(-90deg);
}

.type-group-content {
  padding: 10px;
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
  gap: var(--space-3);
}

.plugin-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid color-mix(in srgb, var(--border-color) 92%, transparent);
  border-radius: var(--radius-md);
  padding: 10px;
  background: color-mix(in srgb, var(--primary-text) 0.7%, transparent);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.plugin-card:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 24%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 3.5%, transparent);
}

.plugin-card-top {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.plugin-identity {
  display: flex;
  gap: var(--space-2);
  min-width: 0;
}

.plugin-icon-shell {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--highlight-text) 8%, transparent);
  color: var(--highlight-text);
  flex-shrink: 0;
}

.plugin-icon-shell .material-symbols-outlined {
  font-size: 18px;
}

.plugin-heading {
  flex: 1;
  min-width: 0;
}

.plugin-title-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  align-items: center;
}

.plugin-title-row h3 {
  font-size: var(--font-size-body);
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.plugin-original-name {
  margin-top: 2px;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  overflow-wrap: anywhere;
}

.plugin-card-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-xs);
  flex-shrink: 0;
}

.plugin-card-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.plugin-description {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.5;
  min-height: calc(1.5em * 2);
  max-height: calc(1.5em * 3);
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  margin-bottom: var(--space-2);
}

.plugin-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-top: auto;
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
}

@media (max-width: 1024px) {
  .hub-hero :deep(.ui-card__content),
  .quick-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .controls-main-row {
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
    padding: var(--space-3);
  }

  .view-mode-switch {
    width: 100%;
  }

  .view-mode-switch :deep(.ui-button) {
    flex: 1;
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
  .hub-hero :deep(.ui-card__content) {
    gap: var(--space-4);
  }

  .hero-copy h2 {
    font-size: var(--font-size-display);
  }

  .hero-stats {
    grid-template-columns: 1fr 1fr;
  }

  .plugin-card {
    padding: var(--space-3);
  }

  .plugin-actions {
    flex-direction: column;
  }

  .plugin-actions :deep(button) {
    width: 100%;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .filters-overflow-trigger,
  .group-collapse-icon,
  .plugin-card {
    transition: none;
  }
}
</style>
