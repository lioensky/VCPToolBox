<template>
  <section class="config-section active-section">
    <p class="description">
      当前可用的系统提示词占位符列表，按类型分类展示。点击「查看详情」可查看完整内容。
    </p>

    <PlaceholderFilterBar
      :view-mode="viewMode"
      :selected-type="selectedType"
      :filter-keyword="filterKeyword"
      :type-options="typeOptions"
      @update:viewMode="viewMode = $event"
      @update:selectedType="selectedType = $event"
      @update:filterKeyword="filterKeyword = $event"
    />

    <!-- 分组视图 -->
    <div v-if="viewMode === 'grouped'" class="placeholder-grouped-view">
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
            <span class="type-count">{{
              getFilteredGroupCount(type)
            }}</span>
          </h3>

          <button
            type="button"
            class="group-collapse-toggle"
            :class="{ 'is-collapsed': isTypeGroupCollapsed(type) }"
            :aria-expanded="!isTypeGroupCollapsed(type)"
            :aria-controls="getTypeGroupContentId(type)"
            @click="toggleTypeGroupCollapsed(type)"
          >
            <span>{{ isTypeGroupCollapsed(type) ? "展开" : "折叠" }}</span>
            <span class="material-symbols-outlined group-collapse-icon"
              >expand_more</span
            >
          </button>
        </div>

        <transition name="group-collapse">
          <div
            v-show="!isTypeGroupCollapsed(type)"
            :id="getTypeGroupContentId(type)"
            class="type-group-content"
          >
          <div
            v-for="placeholder in getFilteredGroupPlaceholders(type)"
            :key="placeholder.name"
            class="placeholder-item card"
          >
            <div class="placeholder-header">
              <span class="placeholder-name" :title="placeholder.name">{{
                placeholder.name
              }}</span>
            </div>
            <div class="placeholder-preview" :title="placeholder.preview">
              {{ placeholder.preview }}
            </div>
            <div v-if="placeholder.description" class="placeholder-description">
              {{ placeholder.description }}
            </div>
            <div class="placeholder-footer">
              <span class="placeholder-charcount">
                {{
                  placeholder.charCount ? `${placeholder.charCount} 字符` : "—"
                }}
              </span>
              <button
                @click="openDetail(placeholder)"
                class="btn-secondary btn-sm"
              >
                查看详情
              </button>
            </div>
          </div>
          </div>
        </transition>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-else class="placeholder-list-view">
      <div
        v-for="placeholder in filteredPlaceholders"
        :key="placeholder.name"
        class="placeholder-item card"
      >
        <div class="placeholder-header">
          <span class="placeholder-name" :title="placeholder.name">{{
            placeholder.name
          }}</span>
          <span class="placeholder-type" :title="placeholder.type">
            {{ getTypeLabel(placeholder.type) }}
          </span>
        </div>
        <div class="placeholder-preview" :title="placeholder.preview">
          {{ placeholder.preview }}
        </div>
        <div v-if="placeholder.description" class="placeholder-description">
          {{ placeholder.description }}
        </div>
        <div class="placeholder-footer">
          <span class="placeholder-charcount">
            {{ placeholder.charCount ? `${placeholder.charCount} 字符` : "—" }}
          </span>
          <button @click="openDetail(placeholder)" class="btn-secondary btn-sm">
            查看详情
          </button>
        </div>
      </div>
    </div>

    <PlaceholderDetailModal
      :selected-placeholder="selectedPlaceholder"
      :active-tab="activeTab"
      :detail-content="detailContent"
      :rendered-markdown="renderedMarkdown"
      :get-type-label="getTypeLabel"
      @close="closeDetail"
      @update:activeTab="activeTab = $event"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { placeholderApi } from "@/api";
import type {
  Placeholder,
  PlaceholderDetailTab,
  PlaceholderTypeOption,
  PlaceholderViewMode,
} from "@/features/placeholder-viewer/types";
import { showMessage } from "@/utils";
import { createLogger } from "@/utils/logger";
import { useMarkdownRenderer } from "@/composables/useMarkdownRenderer";
import PlaceholderFilterBar from "./PlaceholderViewer/PlaceholderFilterBar.vue";
import PlaceholderDetailModal from "./PlaceholderViewer/PlaceholderDetailModal.vue";

const logger = createLogger("PlaceholderViewer");

const TYPE_LABELS: Record<string, string> = {
  static_plugin: "Static Plugin",
  async_placeholder: "Async Placeholder",
  agent: "Agent",
  env_tar_var: "Target Variable",
  env_sar: "Sar Prompt",
  fixed: "Fixed Value",
  tool_description: "Tool Description",
  vcp_all_tools: "All Tools",
  image_key: "Image Key",
  diary: "Diary",
  diary_character: "Diary Character",
};

const { renderMarkdown: renderMarkdownContent } = useMarkdownRenderer();

const placeholders = ref<Placeholder[]>([]);
const selectedType = ref("");
const filterKeyword = ref("");
const viewMode = ref<PlaceholderViewMode>("grouped");
const selectedPlaceholder = ref<Placeholder | null>(null);
const activeTab = ref<PlaceholderDetailTab>("raw");
const detailContent = ref("");
const renderedMarkdown = ref("");
const lastFocusedElement = ref<HTMLElement | null>(null);
const collapsedTypeGroups = ref<Record<string, boolean>>({});

function getTypeLabel(type: string): string {
  return TYPE_LABELS[type] || type;
}

const availableTypes = computed(() => {
  const types = new Set(placeholders.value.map((placeholder) => placeholder.type));
  return Array.from(types).sort();
});

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

function getFilteredGroupPlaceholders(type: string): Placeholder[] {
  const items = groupedPlaceholders.value[type] || [];
  
  if (!filterKeyword.value) {
    return items;
  }
  
  const keyword = filterKeyword.value.toLowerCase();
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(keyword) ||
      item.preview.toLowerCase().includes(keyword) ||
      (item.description && item.description.toLowerCase().includes(keyword))
  );
}

function getFilteredGroupCount(type: string): number {
  return getFilteredGroupPlaceholders(type).length;
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

const filteredTypes = computed(() => {
  if (filterKeyword.value) {
    const keyword = filterKeyword.value.toLowerCase();

    return availableTypes.value.filter((type) => {
      const items = groupedPlaceholders.value[type] || [];
      return items.some(
        (item) =>
          item.name.toLowerCase().includes(keyword) ||
          item.preview.toLowerCase().includes(keyword)
      );
    });
  }

  if (selectedType.value) {
    return [selectedType.value];
  }

  return availableTypes.value;
});

const filteredPlaceholders = computed(() =>
  placeholders.value.filter((placeholder) => {
    if (selectedType.value && placeholder.type !== selectedType.value) {
      return false;
    }

    if (!filterKeyword.value) {
      return true;
    }

    const keyword = filterKeyword.value.toLowerCase();
    return (
      placeholder.name.toLowerCase().includes(keyword) ||
      placeholder.preview.toLowerCase().includes(keyword)
    );
  })
);

async function loadPlaceholders(): Promise<void> {
  try {
    placeholders.value = await placeholderApi.getPlaceholders();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load placeholders", error);
    showMessage(`Failed to load placeholders: ${errorMessage}`, "error");
  }
}

async function openDetail(placeholder: Placeholder): Promise<void> {
  lastFocusedElement.value = document.activeElement as HTMLElement;
  selectedPlaceholder.value = placeholder;
  activeTab.value = "raw";
  detailContent.value = "Loading detail...";

  try {
    const detailValue = await placeholderApi.getPlaceholderDetail(
      placeholder.type,
      placeholder.name
    );

    detailContent.value = detailValue ?? placeholder.content ?? placeholder.preview;
    
    // 渲染 Markdown
    if (detailContent.value) {
      renderedMarkdown.value = await renderMarkdownContent(detailContent.value);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load placeholder detail", error);
    detailContent.value = `Failed to load detail: ${errorMessage}`;
    showMessage(`Failed to load detail: ${errorMessage}`, "error");
  }
}

function closeDetail(): void {
  selectedPlaceholder.value = null;

  void nextTick(() => {
    lastFocusedElement.value?.focus();
  });
}

onMounted(() => {
  void loadPlaceholders();
});
</script>

<style scoped>
/* 分组视图 */
.placeholder-grouped-view {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.placeholder-type-group {
  background: var(--secondary-bg);
  border-radius: var(--radius-md);
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
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-title);
  color: var(--primary-text);
}

.type-group-header .material-symbols-outlined {
  font-size: var(--font-size-title) !important;
  color: var(--highlight-text);
}

.type-count {
  font-size: var(--font-size-helper);
  padding: 2px 10px;
  background: var(--button-bg);
  color: var(--on-accent-text);
  border-radius: var(--radius-md);
  font-weight: 600;
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
  padding: var(--space-5);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
  align-items: stretch;
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

/* 列表视图 */
.placeholder-list-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
  align-items: stretch;
}

/* 卡片样式 */
.placeholder-item {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  min-height: 210px;
}

.placeholder-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.placeholder-name {
  font-weight: 600;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-body);
  color: var(--primary-text);
  word-break: break-all;
}

.placeholder-type {
  font-size: var(--font-size-helper);
  padding: 2px 8px;
  background: var(--tertiary-bg);
  border-radius: 4px;
  color: var(--primary-text);
  white-space: nowrap;
  flex-shrink: 0;
}

.placeholder-preview {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  line-height: 1.5;
}

.placeholder-description {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  padding: 8px;
  background: var(--tertiary-bg);
  border-radius: var(--radius-sm);
  line-height: 1.5;
}

.placeholder-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.placeholder-charcount {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 600;
}

/* 响应式 */
@media (max-width: 768px) {
  .type-group-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .group-collapse-toggle {
    align-self: flex-end;
  }

  .type-group-content {
    grid-template-columns: 1fr;
  }

  .placeholder-list-view {
    grid-template-columns: 1fr;
  }
}
</style>
