<template>
  <aside
    class="notes-sidebar"
    :class="{ 'is-collapsed': collapsed }"
    :aria-label="collapsed ? `${folderLabel}操作台（已折叠）` : `${folderLabel}操作台`"
  >
    <template v-if="collapsed">
      <div class="console-rail">
        <UiIconButton
          class="console-rail-toggle"
          label="展开操作台"
          title="展开操作台"
          @click="toggleSidebar"
        >
          <span class="material-symbols-outlined">left_panel_open</span>
        </UiIconButton>
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
          <h3>{{ folderLabel }}列表</h3>
          <div class="sidebar-header-meta">
            <span class="folder-count">{{ filteredFolders.length }}/{{ folders.length }} 个</span>
            <UiIconButton
              class="console-rail-toggle"
              label="折叠操作台"
              title="折叠操作台"
              @click="toggleSidebar"
            >
              <span class="material-symbols-outlined">left_panel_close</span>
            </UiIconButton>
          </div>
        </div>
      </div>

      <div class="folder-console__section">
        <label class="folder-search-label" for="folder-search-input">搜索筛选</label>
        <div class="folder-search-box">
          <UiInput
            id="folder-search-input"
            v-model="folderQuery"
            type="search"
            class="folder-search-input"
            size="md"
            :placeholder="`按${folderLabel}名称筛选...`"
          />
          <UiButton
            v-if="folderQuery"
            variant="ghost"
            size="md"
            class="folder-search-clear"
            @click="clearFolderQuery"
          >
            清空
          </UiButton>
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
          暂无{{ folderLabel }}
        </li>
        <li v-else-if="filteredFolders.length === 0" class="no-folders">
          未找到匹配“{{ folderQuery }}”的{{ folderLabel }}
        </li>
      </ul>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useConsoleCollapse } from '@/composables/useConsoleCollapse'
import UiButton from '@/components/ui/UiButton.vue'
import UiIconButton from '@/components/ui/UiIconButton.vue'
import UiInput from '@/components/ui/UiInput.vue'

const props = defineProps<{
  folders: string[];
  selectedFolder: string;
  folderLabel?: string;
}>();

const emit = defineEmits<{
  (e: "selectFolder", folder: string): void;
  (e: "update:collapsed", collapsed: boolean): void;
}>();

const folderLabel = computed(() => props.folderLabel || '知识库')
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
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(135deg, var(--surface-overlay-soft), transparent),
    var(--secondary-bg);
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
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0;
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
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  min-height: 36px;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}

.folder-row:hover {
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
}

.folder-row.is-active {
  border-color: color-mix(in srgb, var(--highlight-text) 58%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 8%, transparent);
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
  border: 1px dashed color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-md);
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
