<template>
  <div v-if="selectedFolder" class="notes-content-area">
    <div class="notes-toolbar">
      <input
        type="search"
        :value="searchQuery"
        placeholder="搜索日记…"
        autocomplete="off"
        aria-label="搜索日记"
        @input="onSearchInput"
      />
      <button
        class="btn-secondary"
        :disabled="selectedNotes.length === 0"
        @click="$emit('moveSelectedNotes')"
      >
        移动选中项到…
      </button>
      <select
        :value="moveTargetFolder"
        :disabled="selectedNotes.length === 0"
        @change="onMoveTargetChange"
      >
        <option value="">选择目标知识库…</option>
        <option
          v-for="folder in folders"
          :key="folder"
          :value="folder"
          :disabled="folder === selectedFolder"
        >
          {{ folder }}
        </option>
      </select>
      <button
        class="btn-danger"
        :disabled="selectedNotes.length === 0"
        @click="$emit('deleteSelectedNotes')"
      >
        批量删除选中项
      </button>
      <span v-if="notesStatus" :class="['status-message', notesStatusType]">{{
        notesStatus
      }}</span>
    </div>

    <div
      id="notes-list-view"
      ref="notesContainerRef"
      class="notes-list-view"
      :class="{
        'is-virtualized-host':
          shouldVirtualize && !loadingNotes && filteredNotes.length > 0,
      }"
    >
      <div v-if="loadingNotes" class="loading-state">
        <span class="loading-spinner"></span>
        <p>正在加载日记…</p>
      </div>
      <div v-else-if="filteredNotes.length === 0" class="empty-state">
        <span class="material-symbols-outlined empty-state-icon">article</span>
        <p>{{ searchQuery ? '没有找到匹配的日记' : '暂无日记' }}</p>
        <p class="empty-hint">{{ searchQuery ? '尝试调整搜索关键词' : '当添加日记后，它们将显示在这里' }}</p>
      </div>
      <div
        v-else-if="shouldVirtualize"
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
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
              }"
            >
              <div
                v-for="note in row.item"
                :key="note.file"
                class="note-card card virtual-card"
              >
                <div class="note-card-header">
                  <label class="note-select-label">
                    <input
                      type="checkbox"
                      :checked="selectedNotes.includes(note.file)"
                      @change="
                        toggleSelected(
                          note.file,
                          ($event.target as HTMLInputElement).checked
                        )
                      "
                    />
                    <span class="note-title">{{
                      note.title || note.file
                    }}</span>
                  </label>
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
                    <button
                      class="btn-secondary btn-sm"
                      @click="$emit('editNote', note)"
                    >
                      编辑
                    </button>
                    <button
                      class="btn-secondary btn-sm"
                      @click="$emit('discoveryNote', note)"
                    >
                      联想
                    </button>
                    <button
                      class="btn-danger btn-sm"
                      @click="$emit('deleteNote', note)"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        v-else
        v-for="note in filteredNotes"
        :key="note.file"
        class="note-card card"
      >
        <div class="note-card-header">
          <label class="note-select-label">
            <input
              type="checkbox"
              :checked="selectedNotes.includes(note.file)"
              @change="
                toggleSelected(
                  note.file,
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
            <span class="note-title">{{ note.title || note.file }}</span>
          </label>
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
            <button
              class="btn-secondary btn-sm"
              @click="$emit('editNote', note)"
            >
              编辑
            </button>
            <button
              class="btn-secondary btn-sm"
              @click="$emit('discoveryNote', note)"
            >
              联想
            </button>
            <button
              class="btn-danger btn-sm"
              @click="$emit('deleteNote', note)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useVirtualScroll } from "@/composables/useVirtualScroll";
import { useDebounceFn } from "@/composables/useDebounceFn";
import { formatDate } from "@/utils/format";

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

const shouldVirtualize = computed(() => props.filteredNotes.length > 50);
const virtualOverscan = computed(() =>
  props.filteredNotes.length > 1200 ? 16 : 10
);
const virtualListHeight = ref(640);
const notesContainerRef = ref<HTMLElement | null>(null);
const virtualListRef = ref<HTMLElement | null>(null);
const columnCount = ref(1);
let resizeObserver: ResizeObserver | null = null;

const CARD_MIN_WIDTH = 280;
const GRID_GAP = 12; // --space-3
const VIRTUAL_ROW_HEIGHT = 242;
const LIST_BOTTOM_GAP = 24; // --space-5
const MIN_LIST_HEIGHT = 320;

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
      Math.floor((width + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP))
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
  gap: var(--space-3);
  align-items: center;
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

.notes-toolbar input[type="search"] {
  flex: 1;
  min-width: 200px;
  padding: 8px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
}

.notes-toolbar select {
  padding: 8px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
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
  padding: var(--space-3);
}

.note-card-header {
  display: flex;
  align-items: center;
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
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--tertiary-bg);
}

.note-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  margin-top: auto;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-color);
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

.loading-spinner {
  display: inline-block;
  width: 40px;
  height: 40px;
  border: 4px solid var(--border-color);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: var(--space-4);
}

@media (max-width: 768px) {
  .notes-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .notes-toolbar input[type="search"],
  .notes-toolbar select,
  .notes-toolbar .btn-secondary,
  .notes-toolbar .btn-danger {
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
