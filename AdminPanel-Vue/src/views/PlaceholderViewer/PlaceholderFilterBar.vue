<template>
  <div class="placeholder-toolbar" aria-label="占位符筛选与视图切换">
    <div class="placeholder-view-mode" role="tablist" aria-label="视图模式">
      <UiButton
        type="button"
        size="sm"
        :variant="viewMode === 'grouped' ? 'primary' : 'outline'"
        :aria-pressed="viewMode === 'grouped'"
        @click="emit('update:viewMode', 'grouped')"
      >
        <template #leading><span class="material-symbols-outlined">view_agenda</span></template>
        分组
      </UiButton>
      <UiButton
        type="button"
        size="sm"
        :variant="viewMode === 'list' ? 'primary' : 'outline'"
        :aria-pressed="viewMode === 'list'"
        @click="emit('update:viewMode', 'list')"
      >
        <template #leading><span class="material-symbols-outlined">view_list</span></template>
        列表
      </UiButton>
    </div>

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

    <UiField class="placeholder-search-field" label="搜索" for-id="placeholder-filter-keyword" size="sm">
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
.placeholder-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.placeholder-view-mode {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--border-color) 96%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1.5%, transparent);
}

.placeholder-view-mode :deep(.ui-button) {
  min-width: 68px;
  justify-content: center;
  border-color: transparent;
}

.placeholder-toolbar :deep(.ui-field) {
  min-width: 160px;
  gap: 4px;
}

.placeholder-toolbar :deep(.ui-field__label) {
  font-size: var(--font-size-caption);
  line-height: 1.25;
}

.placeholder-search-field {
  flex: 1;
  min-width: min(240px, 100%);
}

@media (max-width: 768px) {
  .placeholder-toolbar {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-3);
  }

  .placeholder-view-mode {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .placeholder-toolbar :deep(.ui-field),
  .placeholder-search-field {
    width: 100%;
    min-width: 0;
  }

  .placeholder-view-mode :deep(.ui-button) {
    width: 100%;
  }
}
</style>
