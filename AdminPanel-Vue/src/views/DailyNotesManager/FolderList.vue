<template>
  <aside
    class="notes-sidebar card"
    :class="{ 'is-collapsed': collapsed }"
    :aria-label="collapsed ? '知识库操作台（已折叠）' : '知识库操作台'"
  >
    <template v-if="collapsed">
      <div class="console-rail">
        <button
          type="button"
          class="console-rail-toggle"
          aria-label="展开操作台"
          title="展开操作台"
          @click="toggleSidebar"
        >
          <span class="material-symbols-outlined">left_panel_open</span>
        </button>
        <div class="console-rail-divider"></div>
        <button
          v-for="folder in filteredFolders.slice(0, 8)"
          :key="folder"
          type="button"
          class="console-rail-icon"
          :class="{ 'is-active': folder === selectedFolder }"
          :title="folder"
          @click="selectFolder(folder)"
        >
          <span class="material-symbols-outlined">folder</span>
        </button>
      </div>
    </template>
    <template v-else>
      <div class="folder-console__section">
        <span class="folder-console__label">操作台</span>
        <div class="notes-sidebar-header">
          <h3>知识库列表</h3>
          <div class="sidebar-header-meta">
            <span class="folder-count">{{ filteredFolders.length }}/{{ folders.length }} 个</span>
            <button
              type="button"
              class="console-rail-toggle"
              aria-label="折叠操作台"
              title="折叠操作台"
              @click="toggleSidebar"
            >
              <span class="material-symbols-outlined">left_panel_close</span>
            </button>
          </div>
        </div>
      </div>

      <div class="folder-console__section">
        <label class="folder-search-label" for="folder-search-input">搜索筛选</label>
        <div class="folder-search-box">
          <input
            id="folder-search-input"
            v-model="folderQuery"
            type="search"
            class="folder-search-input"
            placeholder="按知识库名称筛选..."
          >
          <button
            v-if="folderQuery"
            type="button"
            class="folder-search-clear"
            aria-label="清空筛选"
            @click="clearFolderQuery"
          >
            清空
          </button>
        </div>
      </div>

      <ul class="notes-folder-list">
        <li
          v-for="folder in filteredFolders"
          :key="folder"
          class="folder-list-item"
        >
          <button
            type="button"
            :class="['folder-row', { 'is-active': selectedFolder === folder }]"
            @click="selectFolder(folder)"
          >
            <span class="folder-row-name">{{ folder }}</span>
          </button>
        </li>
        <li v-if="folders.length === 0" class="no-folders">
          暂无知识库
        </li>
        <li v-else-if="filteredFolders.length === 0" class="no-folders">
          未找到匹配“{{ folderQuery }}”的知识库
        </li>
      </ul>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useConsoleCollapse } from '@/composables/useConsoleCollapse'

const props = defineProps<{
  folders: string[];
  selectedFolder: string;
}>();

const emit = defineEmits<{
  (e: "selectFolder", folder: string): void;
  (e: "update:collapsed", collapsed: boolean): void;
}>();

const folderQuery = ref('')

const filteredFolders = computed(() => {
  const query = folderQuery.value.trim().toLowerCase()
  if (!query) {
    return props.folders
  }

  return props.folders.filter((folder) => folder.toLowerCase().includes(query))
})

function clearFolderQuery(): void {
  folderQuery.value = ''
}

function selectFolder(folder: string): void {
  emit('selectFolder', folder)
}

const { collapsed, toggle } = useConsoleCollapse('daily-notes-folders')

function toggleSidebar(): void {
  toggle()
  emit('update:collapsed', collapsed.value)
}

// expose collapsed to parent if it wants to react via v-model
defineExpose({ collapsed })
</script>

<style scoped>
.notes-sidebar {
  --folder-console-viewport-gap: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  position: sticky;
  top: var(--folder-console-viewport-gap);
  align-self: start;
  height: calc(100vh - (var(--folder-console-viewport-gap) * 2));
  max-height: calc(100vh - (var(--folder-console-viewport-gap) * 2));
  overflow: hidden;
  padding: var(--space-5);
  border-radius: var(--radius-xl);
  transition: padding 0.2s ease;
}

.notes-sidebar.is-collapsed {
  padding: var(--space-3) 0;
  gap: 0;
  align-items: center;
}

.sidebar-header-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.folder-console__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.folder-console__label {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.notes-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.notes-sidebar-header h3 {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--primary-text);
}

.folder-count {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 500;
}

.folder-search-label {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.folder-search-box {
  display: flex;
  gap: var(--space-2);
}

.folder-search-input {
  flex: 1;
  min-width: 0;
}

.folder-search-clear {
  flex-shrink: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
}

.folder-search-clear:hover {
  border-color: var(--highlight-text);
  color: var(--highlight-text);
  background: var(--info-bg);
}

.folder-search-clear:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.notes-folder-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  flex: 1;
}

.folder-list-item {
  display: flex;
  padding: 0;
}

.folder-row {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  min-height: 52px;
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
}

.folder-row:hover {
  border-color: var(--highlight-text);
  background: var(--info-bg);
  transform: translateY(-1px);
}

.folder-row.is-active {
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-text) 14%, transparent);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--highlight-text) 20%, transparent);
}

.folder-row:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.folder-row-name {
  font-weight: 600;
  color: var(--primary-text);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-row.is-active .folder-row-name {
  color: var(--highlight-text);
}

.no-folders {
  padding: var(--space-4);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--secondary-text);
  text-align: center;
  font-size: var(--font-size-helper);
}

@media (max-width: 768px) {
  .notes-sidebar {
    position: static;
    top: auto;
    height: auto;
    max-height: none;
    padding: var(--space-4);
  }

  .notes-folder-list {
    max-height: 40vh;
  }

  .folder-search-box {
    flex-direction: column;
  }
}
</style>
