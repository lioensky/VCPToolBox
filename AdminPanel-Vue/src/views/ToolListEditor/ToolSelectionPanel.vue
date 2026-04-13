<template>
  <div class="left-panel">
    <div class="tools-container card">
      <h2 class="section-header">
        可用工具
        <span class="tool-count">({{ filteredTools.length }})</span>
      </h2>

      <div class="filter-section">
        <input
          type="search"
          :value="searchQuery"
          placeholder="🔍 搜索工具…"
          class="tool-search"
          @input="
            emit(
              'update:searchQuery',
              ($event.target as HTMLInputElement).value
            )
          "
        />
        <div class="filter-actions">
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="showSelectedOnly"
              @change="
                emit(
                  'update:showSelectedOnly',
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
            <span>只显示已选</span>
          </label>
          <button @click="emit('selectAll')" class="btn-secondary btn-sm">
            全选
          </button>
          <button @click="emit('deselectAll')" class="btn-secondary btn-sm">
            清空
          </button>
        </div>
      </div>

      <div v-if="loading" class="loading-state">
        <span class="loading-spinner"></span>
        <p>正在加载工具列表…</p>
      </div>

      <div v-else class="tools-list">
        <div
          v-for="tool in filteredTools"
          :key="tool.uniqueId"
          class="tool-item"
        >
          <label class="tool-checkbox">
            <input
              type="checkbox"
              :checked="selectedTools.has(tool.uniqueId)"
              @change="
                emit(
                  'toggleTool',
                  tool.uniqueId,
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
            <span class="tool-name">{{ tool.name }}</span>
            <span class="tool-plugin">{{ tool.pluginName }}</span>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Tool } from "@/features/tool-list/types";

defineProps<{
  loading: boolean;
  filteredTools: Tool[];
  selectedTools: Set<string>;
  searchQuery: string;
  showSelectedOnly: boolean;
}>();

const emit = defineEmits<{
  "update:searchQuery": [value: string];
  "update:showSelectedOnly": [value: boolean];
  toggleTool: [uniqueId: string, checked: boolean];
  selectAll: [];
  deselectAll: [];
}>();
</script>

<style scoped>
.left-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: 0;
}

.tools-container {
  padding: 20px;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.section-header {
  margin: 0 0 20px;
  font-size: var(--font-size-title);
  color: var(--primary-text);
  display: flex;
  align-items: center;
  gap: 10px;
}

.tool-count {
  font-size: var(--font-size-body);
  color: var(--secondary-text);
  font-weight: normal;
}

.filter-section {
  margin-bottom: var(--space-5);
}

.tool-search {
  width: 100%;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  margin-bottom: var(--space-3);
  box-sizing: border-box;
}

.filter-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-body);
  color: var(--secondary-text);
  cursor: pointer;
}

.tools-list {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 10px;
  background: var(--tertiary-bg);
  min-height: 0;
}

.tool-item {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
}

.tool-item:last-child {
  border-bottom: none;
}

.tool-checkbox {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.tool-checkbox input[type="checkbox"] {
  cursor: pointer;
}

.tool-name {
  font-weight: 600;
  color: var(--primary-text);
  flex: 1;
}

.tool-plugin {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  background: var(--input-bg);
  padding: 2px 8px;
  border-radius: 4px;
}

.loading-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--secondary-text);
}

.loading-spinner {
  display: inline-block;
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-color);
  border-top-color: var(--highlight-text);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@media (max-width: 1024px) {
  .left-panel {
    overflow: visible;
  }

  .tools-container {
    padding: 16px;
  }

  .tools-list {
    max-height: 400px;
  }
}

@media (max-width: 768px) {
  .section-header {
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
  }

  .filter-actions {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .filter-actions .checkbox-label,
  .filter-actions .btn-secondary {
    width: 100%;
  }

  .tool-item {
    padding: 10px;
  }

  .tool-checkbox {
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 8px;
  }

  .tool-name {
    min-width: 0;
    word-break: break-word;
  }

  .tool-plugin {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
