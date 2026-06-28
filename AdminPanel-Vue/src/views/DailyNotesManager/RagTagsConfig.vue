<template>
  <UiCard
    v-if="selectedFolder"
    class="rag-tags-config-area"
    size="sm"
    variant="subtle"
  >
    <div class="rag-tags-header">
      <div class="rag-tags-title-row">
        <h3>{{ titleLabel }} - {{ selectedFolder }}</h3>
        <div class="rag-tags-actions">
          <UiButton
            variant="danger"
            size="sm"
            title="清空所有标签"
            @click="$emit('clearAllTags')"
          >
            <template #leading>
              <span class="material-symbols-outlined">delete_sweep</span>
            </template>
            清空全部
          </UiButton>
        </div>
      </div>
      <p class="rag-tags-hint">
        {{ hintText }}
      </p>
    </div>

    <div class="kb-entry">
      <div v-if="showDescription" class="description-controls">
        <label class="description-label" for="rag-tags-description">
          主题描述 / 门控增强文本
        </label>
        <UiTextarea
          id="rag-tags-description"
          :model-value="ragTagsConfig.description || ''"
          class="description-input"
          rows="3"
          placeholder="用于知识库门控与增强向量，例如：该知识库覆盖 VCP 架构、插件开发、部署运维等官方资料。"
          @input="onDescriptionInput"
        />
        <p class="description-hint">
          描述会写入 {{ targetFileName }}，并参与 《《...知识库》》 的增强向量与阈值判断。
        </p>
      </div>

      <div class="threshold-controls">
        <div class="switch-container">
          <span>启用阈值:</span>
          <AppSwitch
            :model-value="ragTagsConfig.thresholdEnabled"
            @change="$emit('toggleThreshold', $event)"
          />
        </div>
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
          <p>暂无标签，点击上方"添加标签"按钮添加</p>
        </div>
        <div
          v-for="(tag, index) in ragTagsConfig.tags"
          :key="index"
          class="tag-item"
        >
          <span class="tag-index">{{ index + 1 }}</span>
          <UiInput
            :model-value="ragTagsConfig.tags[index]"
            class="tag-input"
            type="text"
            size="sm"
            placeholder="标签名称"
            @input="onTagInput(index, $event)"
          />
          <UiIconButton
            class="tag-delete-button"
            :label="`删除标签 ${tag}`"
            title="删除此标签"
            size="sm"
            @click="$emit('removeTag', index)"
          >
            <span class="material-symbols-outlined">close</span>
          </UiIconButton>
        </div>
      </div>

      <div class="add-tag-controls">
        <UiButton variant="outline" size="sm" @click="$emit('addTag')">
          <template #leading>
            <span class="material-symbols-outlined">add</span>
          </template>
          添加标签
        </UiButton>
        <span class="tag-count"
          >当前标签数：{{ ragTagsConfig.tags.length }}</span
        >
      </div>

      <div class="rag-tags-controls">
        <UiButton variant="primary" @click="$emit('saveRagTags')">
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          保存更改到 {{ targetFileName }}
        </UiButton>
        <UiBadge
          v-if="ragTagsStatus"
          :variant="ragTagsStatusBadgeVariant"
        >
          {{ ragTagsStatus }}
        </UiBadge>
      </div>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppSwitch from '@/components/ui/AppSwitch.vue'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiCard from '@/components/ui/UiCard.vue'
import UiIconButton from '@/components/ui/UiIconButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'

interface RagTagsConfig {
  thresholdEnabled: boolean;
  threshold: number;
  tags: string[];
  description?: string;
}

const props = withDefaults(defineProps<{
  selectedFolder: string;
  ragTagsConfig: RagTagsConfig;
  ragTagsStatus: string;
  ragTagsStatusType: "info" | "success" | "error";
  mode?: "diary" | "knowledge";
}>(), {
  mode: "diary"
});

const isKnowledgeMode = computed(() => props.mode === "knowledge");
const ragTagsStatusBadgeVariant = computed(() =>
  props.ragTagsStatusType === "error" ? "danger" : props.ragTagsStatusType
);
const targetFileName = computed(() => isKnowledgeMode.value ? "tdb_tags.json" : "rag_tags.json");
const titleLabel = computed(() => isKnowledgeMode.value ? "冷知识库标签与门控配置" : "知识库标签列表");
const showDescription = computed(() => isKnowledgeMode.value);
const hintText = computed(() => isKnowledgeMode.value
  ? "编辑冷知识库的标签、阈值与主题描述。标签和描述会共同增强 《《知识库》》 门控判断。"
  : "点击标签可编辑，悬停显示删除按钮。支持拖拽排序（待实现）"
);

const emit = defineEmits<{
  (e: "clearAllTags"): void;
  (e: "toggleThreshold", enabled: boolean): void;
  (e: "updateThreshold", value: number): void;
  (e: "addTag"): void;
  (e: "updateTag", payload: { index: number; value: string }): void;
  (e: "removeTag", index: number): void;
  (e: "updateDescription", value: string): void;
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

function onDescriptionInput(event: Event) {
  const target = event.target as HTMLTextAreaElement;
  emit("updateDescription", target.value);
}
</script>

<style scoped>
.rag-tags-header {
  margin-bottom: var(--space-4);
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

.description-controls {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.description-label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 600;
}

.description-input {
  min-height: 84px;
  line-height: 1.6;
}

.description-input :deep(.ui-textarea),
.description-input.ui-textarea {
  min-height: 84px;
  line-height: 1.6;
}

.description-hint {
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
  border: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
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
  border: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
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
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-md);
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
  min-width: 0;
  max-width: 100%;
}

.tag-item:hover {
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
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
}

.tag-delete-button {
  opacity: 0.6;
  flex-shrink: 0;
}

.tag-delete-button:hover {
  color: var(--danger-color);
  opacity: 1;
}

.tag-delete-button .material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
}

.add-tag-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
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
  padding-top: var(--space-3);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
}

.material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
  vertical-align: middle;
}

@media (max-width: 768px) {
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
