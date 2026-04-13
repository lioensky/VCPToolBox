<template>
  <div v-if="selectedFolder" class="rag-tags-config-area card">
    <div class="rag-tags-header">
      <div class="rag-tags-title-row">
        <h3>知识库标签列表 - {{ selectedFolder }}</h3>
        <div class="rag-tags-actions">
          <button
            class="btn-secondary btn-sm"
            title="添加常用标签"
            @click="$emit('addCommonTags')"
          >
            <span class="material-symbols-outlined">add_reaction</span>
            常用标签
          </button>
          <button
            class="btn-danger btn-sm"
            title="清空所有标签"
            @click="$emit('clearAllTags')"
          >
            <span class="material-symbols-outlined">delete_sweep</span>
            清空全部
          </button>
        </div>
      </div>
      <p class="rag-tags-hint">
        点击标签可编辑，悬停显示删除按钮。支持拖拽排序（待实现）
      </p>
    </div>

    <div class="kb-entry">
      <div class="threshold-controls">
        <label class="switch-container">
          <span>启用阈值:</span>
          <label class="switch">
            <input
              :checked="ragTagsConfig.thresholdEnabled"
              type="checkbox"
              @change="$emit('toggleThreshold')"
            />
            <span class="slider"></span>
          </label>
        </label>
        <input
          :value="ragTagsConfig.threshold"
          type="range"
          min="0.1"
          max="1.0"
          step="0.01"
          :disabled="!ragTagsConfig.thresholdEnabled"
          @input="onThresholdInput"
        />
        <span class="threshold-value">{{
          ragTagsConfig.threshold.toFixed(2)
        }}</span>
      </div>

      <div class="tags-container">
        <div v-if="ragTagsConfig.tags.length === 0" class="empty-tags-hint">
          <span class="material-symbols-outlined">tag</span>
          <p>暂无标签，点击上方"常用标签"或"添加标签"按钮添加</p>
        </div>
        <div
          v-for="(tag, index) in ragTagsConfig.tags"
          :key="`${tag}-${index}`"
          class="tag-item"
        >
          <span class="tag-index">{{ index + 1 }}</span>
          <input
            :value="ragTagsConfig.tags[index]"
            class="tag-input"
            type="text"
            placeholder="标签名称"
            @input="onTagInput(index, $event)"
          />
          <button
            class="btn-delete-tag"
            :aria-label="`删除标签 ${tag}`"
            title="删除此标签"
            @click="$emit('removeTag', index)"
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>

      <div class="add-tag-controls">
        <button class="btn-secondary btn-sm" @click="$emit('addTag')">
          <span class="material-symbols-outlined">add</span>
          添加标签
        </button>
        <span class="tag-count"
          >当前标签数：{{ ragTagsConfig.tags.length }}</span
        >
      </div>

      <div class="rag-tags-controls">
        <button class="btn-primary" @click="$emit('saveRagTags')">
          <span class="material-symbols-outlined">save</span>
          保存更改到 rag_tags.json
        </button>
        <span
          v-if="ragTagsStatus"
          :class="['status-message', ragTagsStatusType]"
          >{{ ragTagsStatus }}</span
        >
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface RagTagsConfig {
  thresholdEnabled: boolean;
  threshold: number;
  tags: string[];
}

defineProps<{
  selectedFolder: string;
  ragTagsConfig: RagTagsConfig;
  ragTagsStatus: string;
  ragTagsStatusType: "info" | "success" | "error";
}>();

const emit = defineEmits<{
  (e: "addCommonTags"): void;
  (e: "clearAllTags"): void;
  (e: "toggleThreshold"): void;
  (e: "updateThreshold", value: number): void;
  (e: "addTag"): void;
  (e: "updateTag", payload: { index: number; value: string }): void;
  (e: "removeTag", index: number): void;
  (e: "saveRagTags"): void;
}>();

function onThresholdInput(event: Event) {
  const target = event.target as HTMLInputElement;
  emit("updateThreshold", Number(target.value));
}

function onTagInput(index: number, event: Event) {
  const target = event.target as HTMLInputElement;
  emit("updateTag", { index, value: target.value });
}
</script>

<style scoped>
.rag-tags-config-area {
  padding: var(--space-5);
}

.rag-tags-header {
  margin-bottom: var(--space-5);
}

.rag-tags-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-2);
  flex-wrap: wrap;
  gap: var(--space-3);
}

.rag-tags-title-row h3 {
  margin: 0;
  font-size: var(--font-size-title);
  color: var(--primary-text);
}

.rag-tags-actions {
  display: flex;
  gap: var(--space-2);
}

.rag-tags-actions button {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.rag-tags-hint {
  margin: 0;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.threshold-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  padding: var(--space-3);
  background: var(--tertiary-bg);
  border-radius: var(--radius-sm);
}

.threshold-controls input[type="range"] {
  flex: 1;
  max-width: 200px;
}

.threshold-value {
  min-width: 40px;
  text-align: right;
  font-weight: 600;
  color: var(--highlight-text);
}

.tags-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  padding: var(--space-3);
  background: var(--tertiary-bg);
  border-radius: var(--radius-sm);
}

.empty-tags-hint {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-7) var(--space-5);
  color: var(--secondary-text);
  text-align: center;
}

.empty-tags-hint .material-symbols-outlined {
  font-size: var(--font-size-icon-empty-lg) !important;
  opacity: 0.3;
}

.empty-tags-hint p {
  margin: 0;
  font-size: var(--font-size-body);
}

.tag-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  transition: background-color 0.2s ease, color 0.2s ease, opacity 0.2s ease;
  min-width: 0;
  max-width: 100%;
}

.tag-item:hover {
  border-color: var(--highlight-text);
  background: var(--info-bg);
}

.tag-index {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 600;
  min-width: 20px;
  text-align: center;
  flex-shrink: 0;
}

.tag-input {
  flex: 1;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  width: 100%;
}

.tag-input:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  background: var(--surface-overlay-soft);
  border-radius: 4px;
}

.tag-input:focus:not(:focus-visible) {
  background: var(--surface-overlay-soft);
  border-radius: 4px;
}

.btn-delete-tag {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--secondary-text);
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease,
    transform 0.2s ease;
  opacity: 0.6;
  flex-shrink: 0;
}

.btn-delete-tag:hover {
  background: var(--danger-bg);
  color: var(--danger-color);
  opacity: 1;
}

.btn-delete-tag .material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
}

.add-tag-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  padding: var(--space-3);
  background: var(--accent-bg);
  border-radius: var(--radius-sm);
}

.add-tag-controls button {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.tag-count {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 600;
}

.rag-tags-controls {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.rag-tags-controls button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
  vertical-align: middle;
}

@media (max-width: 768px) {
  .rag-tags-config-area {
    padding: 14px;
  }

  .rag-tags-title-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .rag-tags-actions {
    width: 100%;
    flex-wrap: wrap;
  }

  .rag-tags-actions button {
    flex: 1 1 calc(50% - 4px);
    justify-content: center;
    min-height: 40px;
  }

  .threshold-controls {
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .threshold-controls input[type="range"] {
    flex: 1 1 100%;
    max-width: none;
  }

  .tags-container {
    grid-template-columns: 1fr;
  }

  .tag-item {
    padding: var(--space-2);
  }

  .add-tag-controls {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .add-tag-controls button {
    width: 100%;
    justify-content: center;
    min-height: 40px;
  }

  .rag-tags-controls {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .rag-tags-controls button {
    width: 100%;
    justify-content: center;
    min-height: 40px;
  }
}
</style>
