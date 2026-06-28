<template>
  <div v-if="selectedFolder" class="notes-content-area">
    <div class="notes-toolbar">
      <UiInput
        type="search"
        :model-value="searchQuery"
        size="md"
        :placeholder="`搜索${itemLabel}…`"
        autocomplete="off"
        :aria-label="`搜索${itemLabel}`"
        @input="onSearchInput"
      />
      <UiButton
        v-if="showMoveActions"
        variant="outline"
        :disabled="selectedNotes.length === 0"
        @click="$emit('moveSelectedNotes')"
      >
        移动选中项到…
      </UiButton>
      <UiSelect
        v-if="showMoveActions"
        :model-value="moveTargetFolder"
        :disabled="selectedNotes.length === 0"
        @change="onMoveTargetChange"
      >
        <option value="">选择目标{{ folderLabel }}…</option>
        <option
          v-for="folder in folders"
          :key="folder"
          :value="folder"
          :disabled="folder === selectedFolder"
        >
          {{ folder }}
        </option>
      </UiSelect>
      <UiButton
        variant="danger"
        :disabled="selectedNotes.length === 0"
        @click="$emit('deleteSelectedNotes')"
      >
        批量删除选中项
      </UiButton>
      <UiBadge v-if="notesStatus" :variant="notesStatusBadgeVariant">
        {{ notesStatus }}
      </UiBadge>
    </div>

    <div
      id="notes-list-view"
      ref="notesContainerRef"
      class="notes-list-view"
      :style="notesListGridStyle"
      :class="{
        'is-virtualized-host': isVirtualListMode,
      }"
    >
      <div v-if="loadingNotes" class="loading-state">
        <span class="loading-spinner loading-spinner--thick loading-spinner--primary loading-spinner--mb-4"></span>
        <p>正在加载{{ itemLabel }}…</p>
      </div>
      <div v-else-if="filteredNotes.length === 0" class="empty-state">
        <span class="material-symbols-outlined empty-state-icon">article</span>
        <p>{{ searchQuery ? `没有找到匹配的${itemLabel}` : `暂无${itemLabel}` }}</p>
        <p class="empty-hint">{{ searchQuery ? '尝试调整搜索关键词' : `当添加${itemLabel}后，它们将显示在这里` }}</p>
      </div>
      <div
        v-else-if="isVirtualListMode"
        ref="virtualListRef"
        class="notes-list-view virtualized"
        :style="{ height: `${virtualListHeight}px` }"
        @scroll="handleVirtualScroll"
      >
        <div
          class="virtual-scroll-spacer"
          :style="{ height: `${totalHeight}px` }"
        >
          <div
            class="virtual-scroll-content"
            :style="{ transform: `translateY(${offsetY}px)` }"
          >
            <div
              v-for="row in visibleRows"
              :key="row.index"
              class="virtual-note-row"
              :style="{
                gridTemplateColumns: `repeat(${displayColumnCount}, minmax(0, 1fr))`,
              }"
            >
              <UiCard
                v-for="note in row.item"
                :key="note.file"
                class="note-card virtual-card"
                size="sm"
                variant="subtle"
              >
                <div class="note-card-header">
                  <AppCheckbox
                    class="note-select-label"
                    :model-value="selectedNotes.includes(note.file)"
                    @update:model-value="toggleSelected(note.file, $event)"
                  >
                    <span class="note-title">{{
                      note.title || note.file
                    }}</span>
                  </AppCheckbox>
                </div>

                <div
                  class="note-card-preview"
                  :title="
                    note.preview || '暂无内容预览，点击编辑可查看完整内容。'
                  "
                >
                  {{ note.preview || "暂无内容预览，点击编辑可查看完整内容。" }}
                </div>

                <div class="note-card-footer">
                  <span class="note-meta">{{ formatDate(note.modified) }}</span>
                  <div class="note-actions">
                    <UiButton
                      variant="outline"
                      size="sm"
                      @click="$emit('editNote', note)"
                    >
                      编辑
                    </UiButton>
                    <UiButton
                      v-if="showDiscoveryAction"
                      variant="outline"
                      size="sm"
                      @click="$emit('discoveryNote', note)"
                    >
                      联想
                    </UiButton>
                    <UiButton
                      variant="danger"
                      size="sm"
                      @click="$emit('deleteNote', note)"
                    >
                      删除
                    </UiButton>
                  </div>
                </div>
              </UiCard>
            </div>
          </div>
        </div>
      </div>
      <UiCard
        v-else
        v-for="note in filteredNotes"
        :key="note.file"
        class="note-card"
        size="sm"
        variant="subtle"
      >
        <div class="note-card-header">
          <AppCheckbox
            class="note-select-label"
            :model-value="selectedNotes.includes(note.file)"
            @update:model-value="toggleSelected(note.file, $event)"
          >
            <span class="note-title">{{ note.title || note.file }}</span>
          </AppCheckbox>
        </div>

        <div
          class="note-card-preview"
          :title="note.preview || '暂无内容预览，点击编辑可查看完整内容。'"
        >
          {{ note.preview || "暂无内容预览，点击编辑可查看完整内容。" }}
        </div>

        <div class="note-card-footer">
          <span class="note-meta">{{ formatDate(note.modified) }}</span>
          <div class="note-actions">
            <UiButton
              variant="outline"
              size="sm"
              @click="$emit('editNote', note)"
            >
              编辑
            </UiButton>
            <UiButton
              v-if="showDiscoveryAction"
              variant="outline"
              size="sm"
              @click="$emit('discoveryNote', note)"
            >
              联想
            </UiButton>
            <UiButton
              variant="danger"
              size="sm"
              @click="$emit('deleteNote', note)"
            >
              删除
            </UiButton>
          </div>
        </div>
      </UiCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useVirtualScroll } from "@/composables/useVirtualScroll";
import { useDebounceFn } from "@/composables/useDebounceFn";
import { formatDate } from "@/utils/format";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";

interface Note {
  file: string;
  title?: string;
  modified: string;
  preview?: string;
}

const props = defineProps<{
  selectedFolder: string;
  folders: string[];
  filteredNotes: Note[];
  selectedNotes: string[];
  moveTargetFolder: string;
  searchQuery: string;
  loadingNotes: boolean;
  notesStatus: string;
  notesStatusType: "info" | "success" | "error";
  itemLabel?: string;
  folderLabel?: string;
  showMoveActions?: boolean;
  showDiscoveryAction?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:searchQuery", value: string): void;
  (e: "filterNotes"): void;
  (e: "moveSelectedNotes"): void;
  (e: "update:moveTargetFolder", value: string): void;
  (e: "deleteSelectedNotes"): void;
  (e: "update:selectedNotes", value: string[]): void;
  (e: "editNote", note: Note): void;
  (e: "deleteNote", note: Note): void;
  (e: "discoveryNote", note: Note): void;
}>();

// 使用防抖处理搜索输入（300ms 延迟）
const debouncedSearch = useDebounceFn(
  (...args: unknown[]) => {
    const value = args[0] as string;
    emit("update:searchQuery", value);
    emit("filterNotes");
  },
  { delay: 300 }
);

const itemLabel = computed(() => props.itemLabel || "日记");
const folderLabel = computed(() => props.folderLabel || "知识库");
const showMoveActions = computed(() => props.showMoveActions !== false);
const showDiscoveryAction = computed(() => props.showDiscoveryAction !== false);
const notesStatusBadgeVariant = computed(() =>
  props.notesStatusType === "error" ? "danger" : props.notesStatusType
);
const shouldVirtualize = computed(() => props.filteredNotes.length > 50);
const isVirtualListMode = computed(
  () => shouldVirtualize.value && !props.loadingNotes && props.filteredNotes.length > 0
);
const virtualOverscan = computed(() =>
  props.filteredNotes.length > 1200 ? 16 : 10
);
const virtualListHeight = ref(640);
const notesContainerRef = ref<HTMLElement | null>(null);
const virtualListRef = ref<HTMLElement | null>(null);
const columnCount = ref(1);
let resizeObserver: ResizeObserver | null = null;

const CARD_MIN_WIDTH = 280;
const MAX_COLUMN_COUNT = 3;
const GRID_GAP = 12; // --space-3
const VIRTUAL_ROW_HEIGHT = 242;
const LIST_BOTTOM_GAP = 24; // --space-5
const MIN_LIST_HEIGHT = 320;
const displayColumnCount = computed(() =>
  Math.max(1, Math.min(MAX_COLUMN_COUNT, columnCount.value))
);
const notesListGridStyle = computed(() => {
  if (isVirtualListMode.value) return undefined;
  return {
    gridTemplateColumns: `repeat(${displayColumnCount.value}, minmax(0, 1fr))`,
  };
});

const virtualRows = computed(() => {
  const cols = Math.max(1, columnCount.value);
  const rows: Note[][] = [];
  for (let index = 0; index < props.filteredNotes.length; index += cols) {
    rows.push(props.filteredNotes.slice(index, index + cols));
  }
  return rows;
});

function updateVirtualListHeight() {
  const containerEl = virtualListRef.value ?? notesContainerRef.value;
  if (containerEl) {
    // 获取父容器 .notes-main-area
    const parentEl = containerEl.closest<HTMLElement>(".notes-main-area");
    if (parentEl) {
      // 计算父容器中除了 RAG-Tags 配置区域和工具栏外的可用空间
      const ragTagsEl = parentEl.querySelector<HTMLElement>(
        ".rag-tags-config-area"
      );
      const toolbarEl = containerEl
        .closest<HTMLElement>(".notes-content-area")
        ?.querySelector<HTMLElement>(".notes-toolbar");

      const parentStyles = window.getComputedStyle(parentEl);
      const parentGap = parseFloat(parentStyles.gap) || 0;

      const ragTagsHeight = ragTagsEl ? ragTagsEl.offsetHeight : 0;
      const toolbarHeight = toolbarEl ? toolbarEl.offsetHeight : 0;

      // 使用 offsetHeight 而不是 getBoundingClientRect，更准确
      const available =
        parentEl.offsetHeight -
        ragTagsHeight -
        toolbarHeight -
        LIST_BOTTOM_GAP -
        parentGap;
      virtualListHeight.value = Math.max(MIN_LIST_HEIGHT, available);
    } else {
      // 回退到原始计算方式
      const hostRect = containerEl.getBoundingClientRect();
      const available = Math.floor(
        window.innerHeight - hostRect.top - LIST_BOTTOM_GAP
      );
      virtualListHeight.value = Math.max(MIN_LIST_HEIGHT, available);
    }
  }

  const width =
    virtualListRef.value?.clientWidth ??
    notesContainerRef.value?.clientWidth ??
    0;
  if (width > 0) {
    columnCount.value = Math.max(
      1,
      Math.min(
        MAX_COLUMN_COUNT,
        Math.floor((width + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP))
      )
    );
  }
}

const {
  onScroll,
  setScrollTop,
  visibleItems: visibleRows,
  totalHeight,
  offsetY,
} = useVirtualScroll(
  computed(() => virtualRows.value),
  {
    itemHeight: VIRTUAL_ROW_HEIGHT,
    containerHeight: computed(() => virtualListHeight.value),
    overscan: computed(() => virtualOverscan.value),
  }
);

function handleVirtualScroll(event: Event) {
  onScroll(event);
  // 确保滚动位置不超过最大范围
  const target = event.target as HTMLElement;
  const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
  if (target.scrollTop > maxScroll) {
    target.scrollTop = maxScroll;
  }
}

watch(
  () => props.searchQuery,
  () => {
    // 搜索后回到列表顶部，防止过滤结果与旧滚动位置错位
    setScrollTop(0);
    if (virtualListRef.value) {
      virtualListRef.value.scrollTop = 0;
    }
  }
);

watch(
  () => props.filteredNotes.length,
  () => {
    void nextTick(updateVirtualListHeight);
    if (!shouldVirtualize.value || !virtualListRef.value) return;
    const maxScrollTop = Math.max(
      0,
      totalHeight.value - virtualListHeight.value
    );
    const clamped = Math.min(virtualListRef.value.scrollTop, maxScrollTop);
    virtualListRef.value.scrollTop = clamped;
    setScrollTop(clamped);
  }
);

watch(
  () => shouldVirtualize.value,
  (enabled) => {
    if (!enabled) return;
    void nextTick(updateVirtualListHeight);
  },
  { immediate: true }
);

onMounted(() => {
  updateVirtualListHeight();
  window.addEventListener("resize", updateVirtualListHeight);

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => updateVirtualListHeight());
    if (notesContainerRef.value) {
      resizeObserver.observe(notesContainerRef.value);
    }
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", updateVirtualListHeight);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

function onSearchInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  // 使用防抖处理搜索，减少不必要的过滤操作
  debouncedSearch(value);
}

function onMoveTargetChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  emit("update:moveTargetFolder", value);
}

function toggleSelected(file: string, checked: boolean) {
  if (checked) {
    if (!props.selectedNotes.includes(file)) {
      emit("update:selectedNotes", [...props.selectedNotes, file]);
    }
    return;
  }
  emit(
    "update:selectedNotes",
    props.selectedNotes.filter((item) => item !== file)
  );
}
</script>

<style scoped>
.notes-toolbar {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}

.notes-toolbar :deep(.ui-input) {
  flex: 1;
  min-width: 200px;
}

.notes-toolbar :deep(.ui-select) {
  width: auto;
  min-width: 180px;
}

.notes-list-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
  gap: var(--space-3);
}

.notes-list-view.is-virtualized-host {
  display: block;
}

.notes-list-view.virtualized {
  display: block;
  min-height: 360px;
  overflow-y: auto;
}

.virtual-scroll-spacer {
  position: relative;
  width: 100%;
}

.virtual-scroll-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: var(--space-3); /* 增加底部内边距，防止最后一项被截断 */
}

.virtual-note-row {
  display: grid;
  gap: var(--space-3);
}

.note-card.virtual-card {
  min-height: 210px;
}

.note-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 190px;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}

.note-card:hover {
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.note-card-header {
  display: flex;
  align-items: center;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
}

.note-select-label {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  cursor: pointer;
  min-width: 0;
}

.note-title {
  min-width: 0;
  word-break: break-word;
  font-weight: 500;
}

.note-card-preview {
  color: var(--secondary-text);
  font-size: var(--font-size-body);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 68%, transparent);
}

.note-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  margin-top: auto;
  padding-top: var(--space-3);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
}

.note-meta {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.note-actions {
  display: flex;
  gap: var(--space-2);
}

/* .empty-state 已在全局 layout.css 中统一定义 */

.loading-state {
  text-align: center;
  padding: var(--space-9) var(--space-5);
  color: var(--secondary-text);
}

.empty-state-icon {
  display: block;
  font-size: var(--font-size-icon-empty-lg);
  opacity: 0.3;
  margin-bottom: var(--space-4);
  color: var(--highlight-text);
}

.empty-hint {
  font-size: var(--font-size-helper);
  opacity: 0.7;
  max-width: 45ch;
  margin-inline: auto;
}

@media (max-width: 768px) {
  .notes-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .notes-toolbar :deep(.ui-input),
  .notes-toolbar :deep(.ui-select),
  .notes-toolbar :deep(.ui-button) {
    width: 100%;
    min-width: 0;
  }

  .note-card {
    min-height: 0;
  }

  .note-card-footer {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .note-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
    width: 100%;
  }
}
</style>
