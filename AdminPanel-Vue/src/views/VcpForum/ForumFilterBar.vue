<template>
  <div class="forum-controls">
    <UiField label="筛选板块" for-id="forum-board-filter" size="sm">
      <UiSelect id="forum-board-filter" size="sm" :model-value="selectedBoard" @update:model-value="value => emit('update:selectedBoard', String(value))">
        <option value="all">全部板块</option>
        <option v-for="board in boards" :key="board" :value="board">
          {{ board }}
        </option>
      </UiSelect>
    </UiField>
    <UiField label="搜索" size="sm">
      <UiInput
        type="search"
        size="sm"
        :model-value="searchQuery"
        placeholder="搜索帖子标题或作者…"
        @update:model-value="value => emit('update:searchQuery', String(value))"
      />
    </UiField>
  </div>
</template>

<script setup lang="ts">
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";

defineProps<{
  boards: string[]
  selectedBoard: string
  searchQuery: string
}>()

const emit = defineEmits<{
  'update:selectedBoard': [value: string]
  'update:searchQuery': [value: string]
}>()
</script>

<style scoped>
.forum-controls {
  display: flex;
  gap: var(--space-3);
  align-items: flex-end;
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

.forum-controls :deep(.ui-field) {
  min-width: min(100%, 220px);
}

.forum-controls :deep(.ui-field:last-child) {
  flex: 1 1 280px;
}
</style>
