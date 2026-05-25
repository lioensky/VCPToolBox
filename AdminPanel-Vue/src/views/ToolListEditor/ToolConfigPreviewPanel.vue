<template>
  <div class="right-panel">
    <!-- 配置文件管理 -->
    <div class="config-manager card">
      <h2 class="section-header tle-section-header">
        配置管理
        <span v-if="isDirty" class="dirty-badge">未保存</span>
      </h2>

      <div class="config-row">
        <label class="config-label" for="tool-config-select">已有配置</label>
        <select
          id="tool-config-select"
          :value="selectedConfig"
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
        </select>
      </div>

      <div class="config-row">
        <label class="config-label" for="tool-config-name">配置名称</label>
        <input
          id="tool-config-name"
          type="text"
          :value="configNameInput"
          :class="{ 'input-invalid': Boolean(configNameError) }"
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
        <button
          type="button"
          class="btn-link"
          :disabled="saving || deleting || exporting || loadingConfig"
          @click="emit('clearMissingTools')"
        >
          清理
        </button>
      </p>

      <div class="config-actions">
        <button
          type="button"
          class="btn-success"
          :disabled="Boolean(configNameError) || saving || deleting || exporting || loadingConfig"
          @click="emit('saveConfig')"
        >
          {{ saving ? "保存中..." : "保存" }}
        </button>
        <button
          type="button"
          class="btn-danger"
          :disabled="!selectedConfig || saving || deleting || exporting || loadingConfig"
          @click="emit('deleteConfig')"
        >
          {{ deleting ? "删除中..." : "删除" }}
        </button>
        <button
          type="button"
          :disabled="!hasSelection || Boolean(configNameError) || saving || deleting || exporting || loadingConfig"
          class="btn-primary"
          @click="emit('exportTxt')"
        >
          {{ exporting ? "导出中..." : "导出" }}
        </button>
      </div>

      <p v-if="loadingConfig" class="config-loading" role="status" aria-live="polite">
        正在加载配置内容...
      </p>
    </div>

    <!-- 预览区域 -->
    <div class="preview-section card">
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

      <div class="preview-output-wrapper">
        <textarea
          id="preview-output"
          readonly
          :value="previewContent"
          placeholder="选择工具后将在此显示配置内容…"
        ></textarea>
        <button
          type="button"
          class="preview-copy-btn"
          :disabled="copying || !previewContent"
          :aria-label="copying ? '正在复制预览内容' : '复制预览内容到剪贴板'"
          :title="copying ? '复制中...' : '复制预览内容'"
          @click="emit('copyPreview')"
        >
          {{ copying ? "复制中..." : "复制" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppCheckbox from "@/components/ui/AppCheckbox.vue";

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
  gap: 20px;
  min-height: 0;
}

.config-manager,
.preview-section {
  padding: 20px;
  display: flex;
  flex-direction: column;
}

.config-manager {
  flex-shrink: 0;
}

.preview-section {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.dirty-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--font-size-helper);
  color: var(--warning-text);
  border: 1px solid var(--warning-text);
}

.config-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: var(--space-4);
}

.config-label {
  flex: 0 0 72px;
  font-size: var(--font-size-body);
  color: var(--secondary-text);
}

.config-row select,
.config-row input[type="text"] {
  flex: 1;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  box-sizing: border-box;
}

.config-row input[type="text"].input-invalid {
  border-color: var(--danger-color);
}

.config-row input[type="text"]:focus-visible,
.config-row select:focus-visible,
.config-actions button:focus-visible,
.preview-controls button:focus-visible,
.preview-copy-btn:focus-visible,
.checkbox-label:focus-within,
.btn-link:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 1px;
}

.config-row input[type="text"]:focus,
.config-row select:focus {
  border-color: var(--highlight-text);
}

.config-error {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-helper);
  color: var(--danger-text);
}

.missing-notice {
  margin: 0 0 var(--space-3);
  padding: 6px 10px;
  font-size: var(--font-size-helper);
  color: var(--warning-text);
  background: var(--warning-bg);
  border: 1px solid var(--warning-text);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.btn-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--highlight-text);
  font-size: var(--font-size-helper);
  cursor: pointer;
  text-decoration: underline;
}

.btn-link:disabled {
  color: var(--secondary-text);
  cursor: not-allowed;
  text-decoration: none;
}

.config-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.config-actions button {
  flex: 1 1 auto;
  min-width: 80px;
}

.config-loading {
  margin: 10px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.preview-controls {
  display: flex;
  gap: 15px;
  align-items: center;
  margin-bottom: 15px;
  flex-wrap: wrap;
}

.preview-output-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

#preview-output {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 12px;
  padding-right: 84px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-body);
  resize: none;
  box-sizing: border-box;
}

.preview-copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 10px;
  font-size: var(--font-size-helper);
  color: var(--primary-text);
  background: var(--secondary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s ease;
}

.preview-copy-btn:hover:not(:disabled) {
  opacity: 1;
  border-color: var(--highlight-text);
}

.preview-copy-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.preview-copy-btn:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 1px;
  opacity: 1;
}

@media (max-width: 1024px) {
  .right-panel {
    overflow: visible;
  }
  .config-manager,
  .preview-section {
    padding: 16px;
  }
}

@media (max-width: 768px) {
  .config-row {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .config-label {
    flex: none;
  }
  .config-actions {
    gap: 8px;
  }
  .config-actions button {
    flex: 1 1 calc(33.333% - 8px);
    min-width: 0;
    padding-left: 8px;
    padding-right: 8px;
    font-size: var(--font-size-helper);
  }
  .preview-controls {
    gap: 12px 16px;
  }
  .missing-notice {
    font-size: var(--font-size-helper);
  }
}
</style>
