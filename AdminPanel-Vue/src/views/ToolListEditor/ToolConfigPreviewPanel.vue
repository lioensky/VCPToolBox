<template>
  <div class="right-panel">
    <!-- 配置文件管理 -->
    <div class="config-manager card">
      <h2 class="section-header">📁 配置管理</h2>

      <div class="config-selector">
        <select
          :value="selectedConfig"
          @change="
            emit(
              'update:selectedConfig',
              ($event.target as HTMLSelectElement).value
            )
          "
        >
          <option value="">-- 新建配置文件 --</option>
          <option
            v-for="config in availableConfigs"
            :key="config"
            :value="config"
          >
            {{ config }}
          </option>
        </select>
      </div>

      <div class="config-actions">
        <button
          @click="emit('loadConfig')"
          :disabled="!selectedConfig"
          class="btn-primary"
        >
          加载
        </button>
        <button @click="emit('createConfig')" class="btn-primary">新建</button>
        <button
          @click="emit('deleteConfig')"
          :disabled="!selectedConfig"
          class="btn-danger"
        >
          删除
        </button>
        <button @click="emit('saveConfig')" class="btn-success">💾 保存</button>
      </div>

      <span v-if="statusMessage" :class="['status-message', statusType]">
        {{ statusMessage }}
      </span>
    </div>

    <!-- 预览区域 -->
    <div class="preview-section card">
      <h2 class="section-header">📝 生成预览</h2>

      <div class="preview-controls">
        <label class="checkbox-label">
          <input
            type="checkbox"
            :checked="includeHeader"
            @change="
              emit(
                'update:includeHeader',
                ($event.target as HTMLInputElement).checked
              )
            "
          />
          <span>包含文件头</span>
        </label>
        <label class="checkbox-label">
          <input
            type="checkbox"
            :checked="includeExamples"
            @change="
              emit(
                'update:includeExamples',
                ($event.target as HTMLInputElement).checked
              )
            "
          />
          <span>包含示例</span>
        </label>
        <button @click="emit('copyPreview')" class="btn-secondary">📋 复制</button>
      </div>

      <textarea
        id="preview-output"
        readonly
        :value="previewContent"
        placeholder="选择工具后将在此显示配置内容…"
      ></textarea>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  availableConfigs: string[];
  selectedConfig: string;
  statusMessage: string;
  statusType: "info" | "success" | "error";
  includeHeader: boolean;
  includeExamples: boolean;
  previewContent: string;
}>();

const emit = defineEmits<{
  "update:selectedConfig": [value: string];
  loadConfig: [];
  createConfig: [];
  deleteConfig: [];
  saveConfig: [];
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

.section-header {
  margin: 0 0 20px;
  font-size: var(--font-size-title);
  color: var(--primary-text);
  display: flex;
  align-items: center;
  gap: 10px;
}

.config-selector {
  margin-bottom: var(--space-5);
}

.config-selector select {
  width: 100%;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  box-sizing: border-box;
}

.config-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 15px;
}

.config-actions button {
  flex: 1;
  min-width: 80px;
}

.status-message {
  font-size: var(--font-size-body);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
}

.status-message.success {
  background: var(--success-bg);
  color: var(--success-color);
}

.status-message.error {
  background: var(--danger-bg);
  color: var(--danger-color);
}

.status-message.info {
  background: var(--info-bg);
  color: var(--highlight-text);
}

.preview-controls {
  display: flex;
  gap: 15px;
  align-items: center;
  margin-bottom: 15px;
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

#preview-output {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-body);
  resize: none;
  box-sizing: border-box;
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
  .section-header {
    margin-bottom: 14px;
    gap: 8px;
    flex-wrap: wrap;
  }

  .config-actions,
  .preview-controls {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .config-actions button,
  .preview-controls .btn-secondary {
    width: 100%;
  }

  .checkbox-label {
    width: 100%;
  }
}
</style>
