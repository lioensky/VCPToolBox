<template>
  <div class="right-panel">
    <!-- 配置文件管理 -->
    <UiCard class="config-manager" variant="default">
      <div class="panel-heading">
        <h2 class="section-header tle-section-header">配置管理</h2>
        <UiBadge v-if="isDirty" variant="warning" class="dirty-badge">未保存</UiBadge>
      </div>

      <div class="config-form-grid">
        <UiField class="config-row" label="已有配置" for-id="tool-config-select" size="sm">
          <UiSelect
            id="tool-config-select"
            size="sm"
            :model-value="selectedConfig"
            :disabled="saving || deleting || exporting || loadingConfig"
            aria-label="选择已有配置或新建"
            @change="
              emit(
                'update:selectedConfig',
                ($event.target as HTMLSelectElement).value
              )
            "
          >
            <option value="">-- 新建配置 --</option>
            <option
              v-for="config in availableConfigs"
              :key="config"
              :value="config"
            >
              {{ config }}
            </option>
          </UiSelect>
        </UiField>

        <UiField class="config-row" label="配置名称" for-id="tool-config-name" size="sm">
          <UiInput
            id="tool-config-name"
            type="text"
            size="sm"
            :model-value="configNameInput"
            :invalid="Boolean(configNameError)"
            :aria-invalid="configNameError ? 'true' : 'false'"
            :disabled="saving || deleting || exporting || loadingConfig"
            placeholder="输入名称后点击保存（改名即另存为）"
            @input="
              emit(
                'update:configNameInput',
                ($event.target as HTMLInputElement).value
              )
            "
          />
        </UiField>
      </div>

      <p v-if="configNameError" class="config-error" role="alert">
        {{ configNameError }}
      </p>

      <p
        v-if="missingToolCount > 0"
        class="missing-notice"
        role="status"
      >
        <span>当前包含 {{ missingToolCount }} 个失效工具 ID。</span>
        <UiButton
          variant="link"
          size="xs"
          :disabled="saving || deleting || exporting || loadingConfig"
          @click="emit('clearMissingTools')"
        >
          清理
        </UiButton>
      </p>

      <div class="config-actions">
        <UiButton
          variant="primary"
          size="sm"
          :disabled="Boolean(configNameError) || saving || deleting || exporting || loadingConfig"
          @click="emit('saveConfig')"
        >
          {{ saving ? "保存中..." : "保存" }}
        </UiButton>
        <UiButton
          variant="danger"
          size="sm"
          :disabled="!selectedConfig || saving || deleting || exporting || loadingConfig"
          @click="emit('deleteConfig')"
        >
          {{ deleting ? "删除中..." : "删除" }}
        </UiButton>
        <UiButton
          :disabled="!hasSelection || Boolean(configNameError) || saving || deleting || exporting || loadingConfig"
          variant="outline"
          size="sm"
          @click="emit('exportTxt')"
        >
          {{ exporting ? "导出中..." : "导出" }}
        </UiButton>
      </div>

      <p v-if="loadingConfig" class="config-loading" role="status" aria-live="polite">
        正在加载配置内容...
      </p>
    </UiCard>

    <!-- 预览区域 -->
    <UiCard class="preview-section" variant="default">
      <div class="panel-heading">
        <h2 class="section-header tle-section-header">生成预览</h2>
        <div class="preview-controls">
          <AppCheckbox
            class="checkbox-label tle-checkbox-label"
            :model-value="includeHeader"
            :disabled="saving || deleting || exporting || loadingConfig"
            label="包含文件头"
            @update:model-value="emit('update:includeHeader', $event)"
          />
          <AppCheckbox
            class="checkbox-label tle-checkbox-label"
            :model-value="includeExamples"
            :disabled="saving || deleting || exporting || loadingConfig"
            label="包含示例"
            @update:model-value="emit('update:includeExamples', $event)"
          />
        </div>
      </div>

      <div class="preview-output-wrapper">
        <UiTextarea
          id="preview-output"
          readonly
          class="preview-output"
          :model-value="previewContent"
          resize="none"
          placeholder="选择工具后将在此显示配置内容…"
        />
        <UiButton
          class="preview-copy-btn"
          variant="outline"
          size="sm"
          :disabled="copying || !previewContent"
          :aria-label="copying ? '正在复制预览内容' : '复制预览内容到剪贴板'"
          :title="copying ? '复制中...' : '复制预览内容'"
          @click="emit('copyPreview')"
        >
          {{ copying ? "复制中..." : "复制" }}
        </UiButton>
      </div>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";

defineProps<{
  availableConfigs: string[];
  selectedConfig: string;
  configNameInput: string;
  configNameError: string | null;
  includeHeader: boolean;
  includeExamples: boolean;
  previewContent: string;
  hasSelection: boolean;
  isDirty: boolean;
  saving: boolean;
  deleting: boolean;
  exporting: boolean;
  copying: boolean;
  loadingConfig: boolean;
  missingToolCount: number;
}>();

const emit = defineEmits<{
  "update:selectedConfig": [value: string];
  "update:configNameInput": [value: string];
  deleteConfig: [];
  saveConfig: [];
  exportTxt: [];
  clearMissingTools: [];
  "update:includeHeader": [value: boolean];
  "update:includeExamples": [value: boolean];
  copyPreview: [];
}>();
</script>

<style scoped>
.right-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 0;
}

.config-manager,
.preview-section {
  display: flex;
  flex-direction: column;
  border-color: color-mix(in srgb, var(--border-color) 94%, transparent);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.config-manager :deep(.ui-card__content),
.preview-section :deep(.ui-card__content) {
  min-height: 0;
  gap: var(--space-3);
}

.config-manager {
  flex-shrink: 0;
}

.preview-section {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.preview-section :deep(.ui-card__content) {
  flex: 1;
}

.dirty-badge {
  flex-shrink: 0;
}

.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.config-form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-3);
}

.config-row {
  min-width: 0;
}

.config-error {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-helper);
  color: var(--danger-text);
}

.missing-notice {
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-helper);
  color: var(--warning-text);
  background: color-mix(in srgb, var(--warning-color) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning-color) 36%, var(--border-color));
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.config-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
}

.config-actions :deep(.ui-button) {
  flex: 1 1 auto;
  min-width: 80px;
}

.config-loading {
  margin: var(--space-2) 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.preview-controls {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}

.preview-output-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.preview-output {
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding-right: 84px;
  border: 0;
  border-radius: 0;
  background: transparent;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.preview-output:hover:not(:disabled),
.preview-output:focus-visible {
  border-color: transparent;
  background: transparent;
  outline: none;
}

.preview-copy-btn {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  opacity: 0.85;
  transition: opacity var(--transition-fast);
}

.preview-copy-btn:hover:not(:disabled) {
  opacity: 1;
}

.preview-copy-btn:disabled {
  opacity: 0.4;
}

@media (max-width: 1024px) {
  .right-panel {
    overflow: visible;
  }
}

@media (max-width: 768px) {
  .panel-heading,
  .config-row {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
  }
  .config-form-grid {
    grid-template-columns: 1fr;
  }
  .config-label {
    flex: none;
  }
  .config-actions {
    gap: var(--space-2);
  }
  .config-actions :deep(.ui-button) {
    flex: 1 1 calc(33.333% - 8px);
    min-width: 0;
    padding-left: 8px;
    padding-right: 8px;
    font-size: var(--font-size-helper);
  }
  .preview-controls {
    gap: var(--space-2) var(--space-3);
  }
  .missing-notice {
    font-size: var(--font-size-helper);
  }
}

@media (prefers-reduced-motion: reduce) {
  .preview-copy-btn {
    transition: none;
  }
}
</style>
