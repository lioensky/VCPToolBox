<template>
  <div class="left-panel">
    <div class="tools-container card">
      <h2 class="section-header tle-section-header">
        可用工具
        <span class="tool-count">({{ filteredTools.length }})</span>
      </h2>

      <div class="filter-section">
        <div class="search-row">
          <input
            type="search"
            :value="searchQuery"
            placeholder="搜索工具 / 插件 / 说明…"
            class="tool-search"
            aria-label="搜索工具"
            @input="handleSearchInput"
            @compositionstart="emit('searchCompositionStart')"
            @compositionend="handleSearchCompositionEnd"
          />
          <button
            v-if="searchQuery"
            type="button"
            class="btn-secondary btn-sm search-clear-btn"
            aria-label="清除搜索关键词"
            @click="emit('clearSearch')"
          >
            清除
          </button>
        </div>

        <p
          v-if="searching || isSearchComposing"
          class="search-status"
          role="status"
          aria-live="polite"
        >
          {{ isSearchComposing ? "输入法组合中…" : "正在更新搜索结果…" }}
        </p>

        <div class="filter-actions">
          <AppCheckbox
            class="checkbox-label tle-checkbox-label"
            :model-value="showSelectedOnly"
            aria-label="只显示已选工具"
            label="只显示已选"
            @update:model-value="emit('update:showSelectedOnly', $event)"
          />
          <button
            type="button"
            class="btn-secondary btn-sm"
            :disabled="loading"
            :title="selectCurrentTitle"
            @click="emit('selectAll')"
          >
            选中当前结果
          </button>
          <button
            type="button"
            class="btn-secondary btn-sm"
            :disabled="loading"
            @click="emit('deselectAll')"
          >
            取消全选
          </button>
          <button
            type="button"
            class="btn-secondary btn-sm"
            :disabled="loading"
            aria-label="刷新工具列表"
            title="重新从后端拉取工具列表"
            @click="emit('refreshTools')"
          >
            刷新
          </button>
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
                <span class="tool-plugin">{{ tool.pluginName }}</span>
                <span
                  v-if="toolDescriptions[tool.uniqueId]"
                  class="tool-badge"
                  title="已自定义说明"
                >已自定义</span>
              </AppCheckbox>
              <button
                type="button"
                class="btn-secondary btn-sm"
                :aria-label="`编辑 ${tool.name} 的说明`"
                @click="emit('editDescription', tool)"
              >
                编辑说明
              </button>
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Tool } from "@/features/tool-list/types";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";

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
  gap: 20px;
  min-height: 0;
}

.tools-container {
  padding: 20px;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.tool-count {
  font-size: var(--font-size-body);
  color: var(--secondary-text);
  font-weight: normal;
}

.filter-section {
  margin-bottom: var(--space-5);
}

.search-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.tool-search {
  flex: 1;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  box-sizing: border-box;
}

.tool-search:focus-visible,
.search-clear-btn:focus-visible,
.tool-checkbox:focus-within,
.tool-item button:focus-visible,
.filter-actions button:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 1px;
}

.search-status {
  margin: 8px 0 0;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.search-clear-btn {
  flex-shrink: 0;
}

.tool-search:focus {
  border-color: var(--highlight-text);
}

.filter-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: var(--space-3);
}

.tools-list {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--tertiary-bg);
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
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
}

.tool-checkbox {
  display: flex;
  align-items: center;
  gap: 10px;
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
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  background: var(--input-bg);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.tool-badge {
  font-size: var(--font-size-helper);
  color: var(--highlight-text);
  background: var(--info-bg);
  border: 1px solid var(--highlight-text);
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.loading-state {
  text-align: center;
  padding: 60px 20px;
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
  padding: 20px;
  pointer-events: none;
}

@media (max-width: 1024px) {
  .left-panel {
    overflow: visible;
  }
  .tools-container {
    padding: 16px;
  }
  .tools-list {
    max-height: 480px;
  }
}

@media (max-width: 768px) {
  .filter-actions {
    gap: 8px 10px;
  }
  .filter-actions .btn-secondary {
    flex: 0 1 auto;
    padding-left: 10px;
    padding-right: 10px;
    font-size: var(--font-size-helper);
  }
  .search-row {
    gap: 6px;
  }
  .search-clear-btn {
    flex: 0 0 auto;
    padding-left: 10px;
    padding-right: 10px;
  }
}
</style>
