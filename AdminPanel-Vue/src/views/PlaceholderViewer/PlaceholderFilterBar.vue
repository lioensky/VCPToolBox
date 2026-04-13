<template>
  <!-- 视图切换 -->
  <div class="placeholder-view-mode">
    <button
      :class="['view-mode-btn', { active: viewMode === 'grouped' }]"
      @click="emit('update:viewMode', 'grouped')"
    >
      <span class="material-symbols-outlined">view_agenda</span>
      分组视图
    </button>
    <button
      :class="['view-mode-btn', { active: viewMode === 'list' }]"
      @click="emit('update:viewMode', 'list')"
    >
      <span class="material-symbols-outlined">view_list</span>
      列表视图
    </button>
  </div>

  <!-- 筛选器 -->
  <div class="placeholder-viewer-filters">
    <label for="placeholder-filter-type">快速跳转：</label>
    <select
      id="placeholder-filter-type"
      :value="selectedType"
      class="placeholder-filter-select"
      @change="
        emit('update:selectedType', ($event.target as HTMLSelectElement).value)
      "
    >
      <option value="">全部类型</option>
      <option
        v-for="option in typeOptions"
        :key="option.value"
        :value="option.value"
      >
        {{ option.label }} ({{ option.count }})
      </option>
    </select>
    <label for="placeholder-filter-keyword">搜索：</label>
    <input
      type="text"
      id="placeholder-filter-keyword"
      :value="filterKeyword"
      class="placeholder-filter-input"
      placeholder="搜索占位符名称或预览…"
      @input="
        emit('update:filterKeyword', ($event.target as HTMLInputElement).value)
      "
    />
  </div>
</template>

<script setup lang="ts">
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
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.view-mode-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--tertiary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--secondary-text);
  cursor: pointer;
  font-size: var(--font-size-body);
  box-shadow: inset 0 1px 0 var(--surface-overlay-soft);
  transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.view-mode-btn:hover {
  background: var(--accent-bg);
  color: var(--primary-text);
}

.view-mode-btn.active {
  background: var(--button-bg);
  color: var(--on-accent-text);
  border-color: var(--button-bg);
}

.view-mode-btn:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.view-mode-btn .material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
}

.placeholder-viewer-filters {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin-bottom: var(--space-5);
  flex-wrap: wrap;
}

.placeholder-viewer-filters label {
  font-size: var(--font-size-body);
  color: var(--secondary-text);
  font-weight: 500;
}

.placeholder-filter-select,
.placeholder-filter-input {
  padding: 8px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  min-width: 150px;
}
.placeholder-filter-input {
  flex: 1;
  min-width: 180px;
}

.placeholder-filter-select:focus-visible,
.placeholder-filter-input:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

@media (max-width: 768px) {
  .placeholder-view-mode {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .view-mode-btn {
    justify-content: center;
    min-height: 40px;
    padding: 8px 10px;
  }

  .placeholder-viewer-filters {
    flex-direction: column;
    align-items: stretch;
  }

  .placeholder-viewer-filters label {
    margin-bottom: 2px;
  }

  .placeholder-filter-select,
  .placeholder-filter-input {
    width: 100%;
    min-width: 0;
  }
}
</style>
