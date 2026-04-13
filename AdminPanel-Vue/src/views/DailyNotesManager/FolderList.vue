<template>
  <div class="notes-sidebar">
    <h3>知识库列表</h3>
    <ul id="notes-folder-list">
      <li
        v-for="folder in folders"
        :key="folder"
        :class="{ active: selectedFolder === folder }"
        @click="$emit('selectFolder', folder)"
      >
        {{ folder }}
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  folders: string[];
  selectedFolder: string;
}>();

defineEmits<{
  (e: "selectFolder", folder: string): void;
}>();
</script>

<style scoped>
.notes-sidebar {
  background: var(--secondary-bg);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  height: fit-content;
}

.notes-sidebar h3 {
  margin-bottom: var(--space-3);
  font-size: var(--font-size-body);
}

.notes-sidebar ul {
  list-style: none;
  padding: 0;
  margin: 0 0 16px 0;
}

.notes-sidebar li {
  padding: 10px 12px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-1);
  transition: border-color 0.2s ease, background 0.2s ease;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.notes-sidebar li:hover {
  background: var(--accent-bg);
}

.notes-sidebar li.active {
  background: var(--button-bg);
  color: var(--on-accent-text);
}

@media (max-width: 768px) {
  .notes-sidebar {
    border-radius: var(--radius-sm);
    padding: var(--space-3);
  }

  .notes-sidebar ul {
    max-height: 40vh;
    overflow-y: auto;
  }
}
</style>
