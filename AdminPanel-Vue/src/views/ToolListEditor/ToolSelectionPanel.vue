<template>
  <div class="left-panel">
    <UiCard class="tools-container" variant="default">
      <div class="tools-header">
        <div>
          <h2 class="section-header tle-section-header">可用工具</h2>
          <p class="tools-subtitle">
            显示 {{ filteredTools.length }} / {{ allToolsCount }} 个工具
          </p>
        </div>
        <UiBadge v-if="selectedTools.size > 0" variant="info">
          已选 {{ selectedTools.size }}
        </UiBadge>
      </div>

      <div class="filter-section">
        <div class="search-row">
          <UiInput
            type="search"
            :model-value="searchQuery"
            placeholder="搜索工具 / 插件 / 说明…"
            class="tool-search"
            size="md"
            aria-label="搜索工具"
            @input="handleSearchInput"
            @compositionstart="emit('searchCompositionStart')"
            @compositionend="handleSearchCompositionEnd"
          />
          <UiButton
            v-if="searchQuery"
            variant="ghost"
            size="xs"
            class="search-clear-btn"
            aria-label="清除搜索关键词"
            @click="emit('clearSearch')"
          >
            清除
          </UiButton>
        </div>

        <UiBadge
          v-if="searching || isSearchComposing"
          class="search-status"
          variant="outline"
          role="status"
          aria-live="polite"
        >
          {{ isSearchComposing ? "输入法组合中…" : "正在更新搜索结果…" }}
        </UiBadge>

        <div class="filter-actions">
          <div class="filter-primary">
            <AppCheckbox
              class="checkbox-label tle-checkbox-label"
              :model-value="showSelectedOnly"
              aria-label="只显示已选工具"
              label="只显示已选"
              @update:model-value="emit('update:showSelectedOnly', $event)"
            />
          </div>
          <UiButton
            variant="outline"
            size="xs"
            :disabled="loading"
            :title="selectCurrentTitle"
            @click="emit('selectAll')"
          >
            选中当前结果
          </UiButton>
          <UiButton
            variant="outline"
            size="xs"
            :disabled="loading"
            @click="emit('deselectAll')"
          >
            取消全选
          </UiButton>
          <UiButton
            variant="outline"
            size="xs"
            :disabled="loading"
            aria-label="刷新工具列表"
            title="重新从后端拉取工具列表"
            @click="emit('refreshTools')"
          >
            刷新
          </UiButton>
        </div>
      </div>

      <div v-if="loading" class="loading-state">
        <span class="loading-spinner"></span>
        <p>正在加载工具列表…</p>
      </div>

      <div
        v-else
        ref="scrollerRef"
        class="tools-list"
        role="list"
        :aria-busy="searching ? 'true' : 'false'"
        @scroll.passive="onScroll"
      >
        <div
          v-if="filteredTools.length > 0"
          class="virtual-spacer"
          :style="{ height: totalHeight + 'px' }"
        >
          <div
            class="virtual-window"
            :style="{ transform: `translateY(${offsetY}px)` }"
          >
            <div
              v-for="(tool, index) in visibleTools"
              :key="tool.uniqueId"
              class="tool-item"
              role="listitem"
              :aria-setsize="filteredTools.length"
              :aria-posinset="startIndex + index + 1"
              :style="{ height: ITEM_HEIGHT + 'px' }"
            >
              <AppCheckbox
                class="tool-checkbox"
                :model-value="selectedTools.has(tool.uniqueId)"
                :aria-label="`选择工具 ${tool.name}`"
                @update:model-value="emit('toggleTool', tool.uniqueId, $event)"
              >
                <span class="tool-name">{{ tool.name }}</span>
                <UiBadge class="tool-plugin" variant="secondary">{{ tool.pluginName }}</UiBadge>
                <UiBadge
                  v-if="toolDescriptions[tool.uniqueId]"
                  variant="info"
                  class="tool-badge"
                  title="已自定义说明"
                >已自定义</UiBadge>
              </AppCheckbox>
              <UiButton
                variant="outline"
                size="xs"
                :aria-label="`编辑 ${tool.name} 的说明`"
                @click="emit('editDescription', tool)"
              >
                编辑说明
              </UiButton>
            </div>
          </div>
        </div>

        <div
          v-if="filteredTools.length === 0"
          class="empty-state"
          role="status"
          aria-live="polite"
        >
          <template v-if="allToolsCount === 0">
            尚未加载到任何工具，请检查后端插件状态。
          </template>
          <template v-else-if="showSelectedOnly && selectedTools.size === 0">
            当前“只显示已选”已开启，但尚未选择工具。关闭该选项后可浏览全部工具。
          </template>
          <template v-else-if="searchQuery">
            没有匹配的工具，请调整搜索关键词。
          </template>
          <template v-else>
            暂无可显示工具。
          </template>
        </div>
      </div>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Tool } from "@/features/tool-list/types";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiInput from "@/components/ui/UiInput.vue";

const props = defineProps<{
  loading: boolean;
  allToolsCount: number;
  filteredTools: Tool[];
  selectedTools: Set<string>;
  toolDescriptions: Record<string, string>;
  searchQuery: string;
  searching: boolean;
  isSearchComposing: boolean;
  showSelectedOnly: boolean;
}>();

const emit = defineEmits<{
  "update:searchQuery": [value: string];
  clearSearch: [];
  searchCompositionStart: [];
  searchCompositionEnd: [value: string];
  "update:showSelectedOnly": [value: boolean];
  toggleTool: [uniqueId: string, checked: boolean];
  selectAll: [];
  deselectAll: [];
  editDescription: [tool: Tool];
  refreshTools: [];
}>();

const ITEM_HEIGHT = 52;
const BUFFER = 4;

const scrollerRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);

let resizeObserver: ResizeObserver | null = null;

const totalHeight = computed(() => props.filteredTools.length * ITEM_HEIGHT);

const selectCurrentTitle = computed(() => {
  const count = props.filteredTools.length;
  if (props.searchQuery || props.showSelectedOnly) {
    return `将当前 ${count} 个可见结果加入选择`;
  }
  return `将全部 ${count} 个工具加入选择`;
});

const startIndex = computed(() => {
  const raw = Math.floor(scrollTop.value / ITEM_HEIGHT) - BUFFER;
  return Math.max(0, raw);
});

const endIndex = computed(() => {
  if (viewportHeight.value <= 0) {
    return Math.min(props.filteredTools.length, startIndex.value + 30);
  }
  const count = Math.ceil(viewportHeight.value / ITEM_HEIGHT) + BUFFER * 2;
  return Math.min(props.filteredTools.length, startIndex.value + count);
});

const visibleTools = computed(() =>
  props.filteredTools.slice(startIndex.value, endIndex.value)
);

const offsetY = computed(() => startIndex.value * ITEM_HEIGHT);
const filteredSignature = computed(() =>
  props.filteredTools.map((tool) => tool.uniqueId).join("|")
);

function handleSearchInput(event: Event): void {
  emit("update:searchQuery", (event.target as HTMLInputElement).value);
}

function handleSearchCompositionEnd(event: CompositionEvent): void {
  const target = event.target as HTMLInputElement | null;
  emit("searchCompositionEnd", target?.value ?? props.searchQuery);
}

function onScroll(event: Event): void {
  scrollTop.value = (event.target as HTMLElement).scrollTop;
}

function measureViewport(): void {
  if (!scrollerRef.value) return;
  viewportHeight.value = scrollerRef.value.clientHeight;
}

watch(
  () => [props.searchQuery, props.showSelectedOnly, filteredSignature.value],
  () => {
    if (scrollerRef.value) {
      scrollerRef.value.scrollTop = 0;
      scrollTop.value = 0;
    }
  },
  { flush: "post" }
);

watch(
  () => props.loading,
  async (isLoading) => {
    if (!isLoading) {
      await nextTick();
      measureViewport();
    }
  }
);

onMounted(() => {
  void nextTick(() => {
    measureViewport();
    if (scrollerRef.value && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => measureViewport());
      resizeObserver.observe(scrollerRef.value);
    }
  });
});

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});
</script>

<style scoped>
.left-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 0;
}

.tools-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 0;
  padding: 0;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--border-color) 94%, transparent);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.tools-container :deep(.ui-card__content) {
  flex: 1;
  min-height: 0;
  gap: 0;
}

.tools-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-2);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
}

.tools-subtitle {
  margin: 3px 0 0;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.filter-section {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.search-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.tool-search {
  flex: 1;
}

.search-status {
  justify-self: flex-start;
}

.search-clear-btn {
  flex-shrink: 0;
}

.filter-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}

.filter-primary {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  margin-right: auto;
}

.tools-list {
  flex: 1;
  overflow-y: auto;
  border: 0;
  border-radius: 0;
  background: transparent;
  min-height: 0;
  position: relative;
}

.virtual-spacer {
  position: relative;
  width: 100%;
}

.virtual-window {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  will-change: transform;
}

.tool-item {
  padding: 6px var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  transition: background-color var(--transition-fast);
}

.tool-item:hover {
  background: color-mix(in srgb, var(--highlight-text) 4%, transparent);
}

.tool-checkbox {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  flex: 1;
  min-width: 0;
}

.tool-name {
  font-weight: 600;
  color: var(--primary-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-plugin {
  flex-shrink: 0;
}

.tool-plugin :deep(.ui-badge) {
  max-width: 128px;
}

.tool-badge {
  flex-shrink: 0;
}

.loading-state {
  text-align: center;
  padding: var(--space-6) var(--space-4);
  color: var(--secondary-text);
}

.empty-state {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  text-align: center;
  color: var(--secondary-text);
  padding: var(--space-4);
  pointer-events: none;
}

@media (max-width: 1024px) {
  .left-panel {
    overflow: visible;
  }
  .tools-list {
    max-height: 480px;
  }
}

@media (max-width: 768px) {
  .filter-actions {
    gap: var(--space-2);
  }
  .filter-actions :deep(.ui-button) {
    flex: 0 1 auto;
    padding-left: 10px;
    padding-right: 10px;
    font-size: var(--font-size-helper);
  }
  .search-row {
    gap: var(--space-2);
  }
  .search-clear-btn {
    flex: 0 0 auto;
    padding-left: 10px;
    padding-right: 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tool-item {
    transition: none;
  }
}
</style>
