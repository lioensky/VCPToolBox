<template>
  <!-- 视图切换 -->
  <div class="placeholder-view-mode">
    <UiButton
      type="button"
      :variant="viewMode === 'grouped' ? 'primary' : 'outline'"
      @click="emit('update:viewMode', 'grouped')"
    >
      <template #leading><span class="material-symbols-outlined">view_agenda</span></template>
      分组视图
    </UiButton>
    <UiButton
      type="button"
      :variant="viewMode === 'list' ? 'primary' : 'outline'"
      @click="emit('update:viewMode', 'list')"
    >
      <template #leading><span class="material-symbols-outlined">view_list</span></template>
      列表视图
    </UiButton>
  </div>

  <!-- 筛选器 -->
  <div class="placeholder-viewer-filters">
    <UiField label="类型筛选" for-id="placeholder-filter-type" size="sm">
      <UiSelect
        id="placeholder-filter-type"
        size="sm"
        :model-value="selectedType"
        @update:model-value="value => emit('update:selectedType', String(value))"
      >
        <option value="">全部类型</option>
        <option
          v-for="option in typeOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }} ({{ option.count }})
        </option>
      </UiSelect>
    </UiField>
    <UiField label="搜索" for-id="placeholder-filter-keyword" size="sm">
      <UiInput
        type="text"
        id="placeholder-filter-keyword"
        size="sm"
        :model-value="filterKeyword"
        placeholder="搜索占位符名称、预览或描述…"
        @update:model-value="value => emit('update:filterKeyword', String(value))"
      />
    </UiField>
  </div>
</template>

<script setup lang="ts">
import UiButton from "@/components/ui/UiButton.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import type {
  PlaceholderTypeOption,
  PlaceholderViewMode,
} from "@/features/placeholder-viewer/types";

defineProps<{
  viewMode: PlaceholderViewMode;
  selectedType: string;
  filterKeyword: string;
  typeOptions: PlaceholderTypeOption[];
}>();

const emit = defineEmits<{
  "update:viewMode": [mode: PlaceholderViewMode];
  "update:selectedType": [value: string];
  "update:filterKeyword": [value: string];
}>();
</script>

<style scoped>
.placeholder-view-mode {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.placeholder-viewer-filters {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin-bottom: var(--space-5);
  flex-wrap: wrap;
}

.placeholder-viewer-filters :deep(.ui-field) {
  min-width: 150px;
}

.placeholder-viewer-filters :deep(.ui-field:last-child) {
  flex: 1;
  min-width: 180px;
}

@media (max-width: 768px) {
  .placeholder-view-mode {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .placeholder-view-mode :deep(.ui-button) {
    justify-content: center;
  }

  .placeholder-viewer-filters {
    flex-direction: column;
    align-items: stretch;
  }

  .placeholder-viewer-filters :deep(.ui-field) {
    width: 100%;
    min-width: 0;
  }
}
</style>
