<template>
  <section class="config-section active-section placeholder-viewer-page">
    <header class="placeholder-viewer-intro">
      <h2>占位符列表</h2>
      <p>按类型浏览当前可用的系统提示词占位符；点击查看详情可阅读完整内容并复制名称或 JSON。</p>
    </header>

    <PlaceholderFilterBar
      :view-mode="viewMode"
      :selected-type="selectedType"
      :filter-keyword="filterKeywordInput"
      :type-options="typeOptions"
      @update:viewMode="viewMode = $event"
      @update:selectedType="selectedType = $event"
      @update:filterKeyword="handleFilterKeywordUpdate"
    />

    <UiEmptyState
      v-if="isLoadingPlaceholders"
      title="正在加载占位符..."
      role="status"
      aria-live="polite"
    >
      <template #icon>
        <span class="material-symbols-outlined">hourglass_top</span>
      </template>
    </UiEmptyState>

    <UiEmptyState
      v-else-if="loadErrorMessage"
      title="占位符加载失败"
      :description="loadErrorMessage"
      role="status"
      aria-live="polite"
    >
      <template #icon>
        <span class="material-symbols-outlined">error</span>
      </template>
    </UiEmptyState>

    <template v-else>
      <!-- 分组视图 -->
      <div v-if="viewMode === 'grouped'" class="placeholder-grouped-view">
        <UiEmptyState
          v-if="shouldShowEmptyState"
          :title="emptyStateText"
          role="status"
          aria-live="polite"
        >
          <template #icon>
            <span class="material-symbols-outlined">search_off</span>
          </template>
        </UiEmptyState>

        <div
          v-for="type in filteredTypes"
          :key="type"
          :id="`type-group-${type}`"
          class="placeholder-type-group"
        >
          <div class="type-group-header">
            <h3>
              <span class="material-symbols-outlined">folder</span>
              {{ getTypeLabel(type) }}
              <UiBadge variant="outline">{{
                filteredGroupedPlaceholders[type]?.length ?? 0
              }}</UiBadge>
            </h3>

            <UiButton
              type="button"
              class="group-collapse-toggle"
              variant="outline"
              size="sm"
              :aria-expanded="!isTypeGroupCollapsed(type)"
              :aria-controls="getTypeGroupContentId(type)"
              @click="toggleTypeGroupCollapsed(type)"
            >
              <span>{{ isTypeGroupCollapsed(type) ? "展开" : "折叠" }}</span>
              <template #trailing>
                <span
                  class="material-symbols-outlined group-collapse-icon"
                  :class="{ 'is-collapsed': isTypeGroupCollapsed(type) }"
                >expand_more</span>
              </template>
            </UiButton>
          </div>

          <div
            class="type-group-collapse"
            :class="{ 'is-collapsed': isTypeGroupCollapsed(type) }"
          >
            <div class="type-group-content-shell">
              <div
                :id="getTypeGroupContentId(type)"
                class="type-group-content"
              >
                <PlaceholderCard
                  v-for="placeholder in filteredGroupedPlaceholders[type] ?? []"
                  :key="`${placeholder.type}-${placeholder.name}`"
                  :placeholder="placeholder"
                  @viewDetail="openDetail"
                  @copyName="handleCopyPlaceholderName"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 列表视图 -->
      <div v-else class="placeholder-list-view">
        <UiEmptyState
          v-if="shouldShowEmptyState"
          class="placeholder-empty-state"
          :title="emptyStateText"
          role="status"
          aria-live="polite"
        >
          <template #icon>
            <span class="material-symbols-outlined">search_off</span>
          </template>
        </UiEmptyState>

        <PlaceholderCard
          v-for="placeholder in filteredPlaceholders"
          :key="`${placeholder.type}-${placeholder.name}`"
          :placeholder="placeholder"
          :show-type-badge="true"
          :type-label="getTypeLabel(placeholder.type)"
          @viewDetail="openDetail"
          @copyName="handleCopyPlaceholderName"
        />
      </div>
    </template>

    <PlaceholderDetailModal
      :selected-placeholder="selectedPlaceholder"
      :active-tab="activeTab"
      :detail-content="detailContent"
      :rendered-markdown="renderedMarkdown"
      :json-content="detailJsonContent"
      @close="closeDetail"
      @update:activeTab="activeTab = $event"
      @copyDetail="handleCopyDetailContent"
      @copyJson="handleCopyJsonContent"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { placeholderApi } from "@/api";
import { useDebounceFn } from "@/composables/useDebounceFn";
import { useMarkdownRenderer } from "@/composables/useMarkdownRenderer";
import { getPlaceholderTypeLabel } from "@/features/placeholder-viewer/placeholderTypeLabel";
import type {
  Placeholder,
  PlaceholderDetailTab,
  PlaceholderTypeOption,
  PlaceholderViewMode,
} from "@/features/placeholder-viewer/types";
import { showMessage } from "@/utils";
import { createLogger } from "@/utils/logger";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import PlaceholderCard from "./PlaceholderViewer/PlaceholderCard.vue";
import PlaceholderFilterBar from "./PlaceholderViewer/PlaceholderFilterBar.vue";
import PlaceholderDetailModal from "./PlaceholderViewer/PlaceholderDetailModal.vue";

const logger = createLogger("PlaceholderViewer");
const VIEW_MODE_STORAGE_KEY = "placeholder-viewer:view-mode";
const COLLAPSED_GROUP_STORAGE_KEY = "placeholder-viewer:collapsed-type-groups";
const DETAIL_EMPTY_TEXT = "暂无详细内容。";

const { renderMarkdown: renderMarkdownContent } = useMarkdownRenderer();
const route = useRoute();

function normalizeViewMode(value: unknown): PlaceholderViewMode {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized === "list" ? "list" : "grouped";
}

function isBrowserEnvironment(): boolean {
  return typeof window !== "undefined";
}

function readStoredViewMode(): PlaceholderViewMode | null {
  if (!isBrowserEnvironment()) {
    return null;
  }

  const rawValue = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  if (rawValue === "grouped" || rawValue === "list") {
    return rawValue;
  }

  return null;
}

function resolveInitialViewMode(routeValue: unknown): PlaceholderViewMode {
  const normalizedRoute = Array.isArray(routeValue) ? routeValue[0] : routeValue;

  if (normalizedRoute === "grouped" || normalizedRoute === "list") {
    return normalizedRoute;
  }

  return readStoredViewMode() ?? "grouped";
}

function readCollapsedTypeGroups(): Record<string, boolean> {
  if (!isBrowserEnvironment()) {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(COLLAPSED_GROUP_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return Object.entries(parsed).reduce<Record<string, boolean>>(
      (result, [type, collapsed]) => {
        if (typeof collapsed === "boolean") {
          result[type] = collapsed;
        }

        return result;
      },
      {}
    );
  } catch {
    return {};
  }
}

function persistViewMode(mode: PlaceholderViewMode): void {
  if (!isBrowserEnvironment()) {
    return;
  }

  window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
}

function persistCollapsedTypeGroups(value: Record<string, boolean>): void {
  if (!isBrowserEnvironment()) {
    return;
  }

  window.localStorage.setItem(COLLAPSED_GROUP_STORAGE_KEY, JSON.stringify(value));
}

const placeholders = ref<Placeholder[]>([]);
const isLoadingPlaceholders = ref(false);
const loadErrorMessage = ref("");
const selectedType = ref("");
const filterKeywordInput = ref("");
const filterKeyword = ref("");
const viewMode = ref<PlaceholderViewMode>(resolveInitialViewMode(route.query.view));
const selectedPlaceholder = ref<Placeholder | null>(null);
const activeTab = ref<PlaceholderDetailTab>("raw");
const detailContent = ref("");
const renderedMarkdown = ref("");
const lastFocusedElement = ref<HTMLElement | null>(null);
const detailRequestId = ref(0);
const collapsedTypeGroups = ref<Record<string, boolean>>(readCollapsedTypeGroups());

function getTypeLabel(type: string): string {
  return getPlaceholderTypeLabel(type);
}

function matchesKeyword(placeholder: Placeholder, normalizedKeyword: string): boolean {
  if (!normalizedKeyword) {
    return true;
  }

  const searchableText = [
    placeholder.name,
    placeholder.preview,
    placeholder.description ?? "",
  ]
    .join("\n")
    .toLowerCase();

  return searchableText.includes(normalizedKeyword);
}

const applyFilterKeyword = useDebounceFn(
  (value: unknown) => {
    filterKeyword.value = String(value ?? "").trim();
  },
  { delay: 220 }
);

function handleFilterKeywordUpdate(value: string): void {
  filterKeywordInput.value = value;
  applyFilterKeyword(value);
}

const availableTypes = computed(() => {
  const types = new Set(placeholders.value.map((placeholder) => placeholder.type));
  return Array.from(types).sort();
});

const normalizedFilterKeyword = computed(() => filterKeyword.value.toLowerCase());

const groupedPlaceholders = computed(() => {
  const groups: Record<string, Placeholder[]> = {};

  placeholders.value.forEach((placeholder) => {
    if (!groups[placeholder.type]) {
      groups[placeholder.type] = [];
    }

    groups[placeholder.type].push(placeholder);
  });

  return groups;
});

function getTypeCount(type: string): number {
  return groupedPlaceholders.value[type]?.length || 0;
}

function isTypeGroupCollapsed(type: string): boolean {
  return collapsedTypeGroups.value[type] ?? false;
}

function toggleTypeGroupCollapsed(type: string): void {
  collapsedTypeGroups.value = {
    ...collapsedTypeGroups.value,
    [type]: !isTypeGroupCollapsed(type),
  };
}

function getTypeGroupContentId(type: string): string {
  const normalizedType = type.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `placeholder-type-group-content-${normalizedType}`;
}

const typeOptions = computed<PlaceholderTypeOption[]>(() =>
  availableTypes.value.map((type) => ({
    value: type,
    label: getTypeLabel(type),
    count: getTypeCount(type),
  }))
);

const filteredGroupedPlaceholders = computed<Record<string, Placeholder[]>>(() => {
  const filteredGroups: Record<string, Placeholder[]> = {};
  const sourceTypes = selectedType.value ? [selectedType.value] : availableTypes.value;
  const keyword = normalizedFilterKeyword.value;

  sourceTypes.forEach((type) => {
    const items = groupedPlaceholders.value[type] || [];
    const filteredItems = items.filter((item) => matchesKeyword(item, keyword));

    if (filteredItems.length > 0) {
      filteredGroups[type] = filteredItems;
    }
  });

  return filteredGroups;
});

const filteredTypes = computed(() => Object.keys(filteredGroupedPlaceholders.value));

const filteredPlaceholders = computed(() => {
  const keyword = normalizedFilterKeyword.value;

  return placeholders.value.filter((placeholder) => {
    if (selectedType.value && placeholder.type !== selectedType.value) {
      return false;
    }

    return matchesKeyword(placeholder, keyword);
  });
});

const hasAnyPlaceholder = computed(() => placeholders.value.length > 0);

const hasVisibleResults = computed(() => {
  return viewMode.value === "grouped"
    ? filteredTypes.value.length > 0
    : filteredPlaceholders.value.length > 0;
});

const hasActiveFilter = computed(() => {
  return Boolean(selectedType.value || filterKeywordInput.value.trim());
});

const shouldShowEmptyState = computed(() => !hasVisibleResults.value);

const emptyStateText = computed(() => {
  if (!hasAnyPlaceholder.value) {
    return "暂无可用占位符。";
  }

  if (hasActiveFilter.value) {
    return "没有匹配当前筛选条件的占位符。";
  }

  return "暂无可展示的占位符。";
});

const detailJsonContent = computed(() => {
  if (!selectedPlaceholder.value) {
    return "{}";
  }

  const safeDetailPayload = {
    name: selectedPlaceholder.value.name,
    type: selectedPlaceholder.value.type,
    preview: selectedPlaceholder.value.preview,
    description: selectedPlaceholder.value.description ?? null,
    charCount: selectedPlaceholder.value.charCount ?? null,
    content: detailContent.value || selectedPlaceholder.value.content || null,
  };

  return JSON.stringify(safeDetailPayload, null, 2);
});

async function loadPlaceholders(): Promise<void> {
  isLoadingPlaceholders.value = true;
  loadErrorMessage.value = "";

  try {
    placeholders.value = await placeholderApi.getPlaceholders();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load placeholders", error);
    loadErrorMessage.value = `加载占位符失败: ${errorMessage}`;
    showMessage(`Failed to load placeholders: ${errorMessage}`, "error");
  } finally {
    isLoadingPlaceholders.value = false;
  }
}

async function openDetail(placeholder: Placeholder): Promise<void> {
  const currentRequestId = detailRequestId.value + 1;
  detailRequestId.value = currentRequestId;

  lastFocusedElement.value = document.activeElement as HTMLElement;
  selectedPlaceholder.value = placeholder;
  activeTab.value = "raw";
  detailContent.value = "正在加载详情...";
  renderedMarkdown.value = "";

  try {
    const detailValue = await placeholderApi.getPlaceholderDetail(
      placeholder.type,
      placeholder.name
    );

    if (currentRequestId !== detailRequestId.value) {
      return;
    }

    detailContent.value = detailValue ?? placeholder.content ?? DETAIL_EMPTY_TEXT;

    if (detailContent.value) {
      const markdown = await renderMarkdownContent(detailContent.value);

      if (currentRequestId !== detailRequestId.value) {
        return;
      }

      renderedMarkdown.value = markdown;
    }
  } catch (error: unknown) {
    if (currentRequestId !== detailRequestId.value) {
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load placeholder detail", error);
    detailContent.value = `Failed to load detail: ${errorMessage}`;
    showMessage(`Failed to load detail: ${errorMessage}`, "error");
  }
}

function isClipboardWritable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  );
}

async function copyToClipboard(text: string, successMessage: string): Promise<void> {
  if (!isClipboardWritable()) {
    showMessage("当前环境不支持剪贴板写入", "warning");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showMessage(successMessage, "success");
  } catch (error) {
    logger.error("Failed to copy text", error);
    showMessage("复制失败，请稍后重试", "error");
  }
}

function handleCopyPlaceholderName(name: string): void {
  void copyToClipboard(name, "占位符名称已复制");
}

function handleCopyDetailContent(): void {
  const text = detailContent.value.trim();
  if (!text) {
    showMessage("当前无可复制内容", "warning");
    return;
  }

  void copyToClipboard(text, "占位符内容已复制");
}

function handleCopyJsonContent(): void {
  void copyToClipboard(detailJsonContent.value, "占位符 JSON 已复制");
}

function closeDetail(): void {
  detailRequestId.value += 1;
  selectedPlaceholder.value = null;

  void nextTick(() => {
    lastFocusedElement.value?.focus();
  });
}

watch(
  viewMode,
  (mode) => {
    persistViewMode(mode);
  },
  { immediate: true }
);

watch(
  collapsedTypeGroups,
  (value) => {
    persistCollapsedTypeGroups(value);
  },
  { deep: true }
);

watch(
  availableTypes,
  (types) => {
    const typeSet = new Set(types);
    let hasInvalidType = false;
    const normalizedValue: Record<string, boolean> = {};

    Object.entries(collapsedTypeGroups.value).forEach(([type, collapsed]) => {
      if (typeSet.has(type)) {
        normalizedValue[type] = collapsed;
        return;
      }

      hasInvalidType = true;
    });

    if (hasInvalidType) {
      collapsedTypeGroups.value = normalizedValue;
    }
  },
  { immediate: true }
);

watch(
  () => route.query.view,
  (value) => {
    const normalized = Array.isArray(value) ? value[0] : value;
    if (normalized === "grouped" || normalized === "list") {
      const nextMode = normalizeViewMode(normalized);
      if (viewMode.value !== nextMode) {
        viewMode.value = nextMode;
      }
    }
  }
);

onMounted(() => {
  void loadPlaceholders();
});
</script>

<style scoped>
/* 分组视图 */
.placeholder-grouped-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.placeholder-type-group {
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--border-color) 96%, transparent);
  overflow: hidden;
}

.placeholder-viewer-page {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: var(--space-4);
}

.placeholder-viewer-intro {
  display: grid;
  gap: var(--space-1);
}

.placeholder-viewer-intro h2 {
  margin: 0;
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.placeholder-viewer-intro p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.type-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 40px;
  padding: 7px 10px;
  background: color-mix(in srgb, var(--primary-text) 2.6%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
}

.type-group-header h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-helper);
  font-weight: 700;
  color: var(--primary-text);
  min-width: 0;
}

.type-group-header .material-symbols-outlined {
  font-size: 16px !important;
  color: var(--secondary-text);
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

.type-group-collapse {
  display: grid;
  grid-template-rows: 1fr;
  transition:
    grid-template-rows var(--transition-fast),
    opacity var(--transition-fast);
}

.type-group-collapse.is-collapsed {
  grid-template-rows: 0fr;
  opacity: 0.7;
}

.type-group-content-shell {
  overflow: hidden;
  min-height: 0;
}

.type-group-content {
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-3);
  align-items: stretch;
}

/* 列表视图 */
.placeholder-list-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-3);
  align-items: stretch;
}

.placeholder-empty-state {
  grid-column: 1 / -1;
}

/* 响应式 */
@media (max-width: 768px) {
  .type-group-header {
    align-items: center;
  }

  .group-collapse-toggle {
    align-self: auto;
  }

  .type-group-content {
    grid-template-columns: 1fr;
  }

  .placeholder-list-view {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .group-collapse-icon,
  .type-group-collapse {
    transition: none;
  }
}
</style>
