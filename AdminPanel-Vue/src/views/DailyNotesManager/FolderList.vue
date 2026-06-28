<template>
  <aside
    class="notes-sidebar"
    :aria-label="`${folderLabel}操作台`"
  >
    <div class="folder-console__search">
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

    <UiSideConsoleNav
      class="notes-sidebar__nav"
      :items="folderNavItems"
      :open-ids="[]"
      @item-click="handleFolderNavClick"
    />

    <p v-if="folders.length === 0" class="no-folders">
      暂无{{ folderLabel }}
    </p>
    <p v-else-if="filteredFolders.length === 0" class="no-folders">
      未找到匹配“{{ folderQuery }}”的{{ folderLabel }}
    </p>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiSideConsoleNav, { type UiSideConsoleNavItem } from '@/components/ui/UiSideConsoleNav.vue'

const props = defineProps<{
  folders: string[];
  selectedFolder: string;
  folderLabel?: string;
}>();

const emit = defineEmits<{
  (e: "selectFolder", folder: string): void;
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
const folderNavItems = computed<UiSideConsoleNavItem[]>(() =>
  filteredFolders.value.map((folder) => ({
    id: folder,
    label: folder,
    title: folder,
    active: folder === props.selectedFolder,
  }))
)

function clearFolderQuery(): void {
  folderQuery.value = ''
}

function selectFolder(folder: string): void {
  emit('selectFolder', folder)
}

function handleFolderNavClick(item: UiSideConsoleNavItem): void {
  selectFolder(item.id)
}
</script>

<style scoped>
.notes-sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  align-self: start;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  background: transparent;
}

.folder-search-label {
  display: block;
  margin: 0 0 var(--space-2);
  padding: 0 8px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.folder-console__search {
  padding: 0 0 var(--space-3);
}

.folder-search-box {
  display: flex;
  gap: var(--space-2);
  padding: 0 8px;
}

.folder-search-input {
  flex: 1;
  min-width: 0;
}

.folder-search-clear {
  flex-shrink: 0;
}

.notes-sidebar__nav {
  flex: 1;
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
    height: auto;
    max-height: none;
    padding: var(--space-4);
  }

  .notes-sidebar__nav {
    max-height: 40vh;
  }

  .folder-search-box {
    flex-direction: column;
  }
}
</style>
