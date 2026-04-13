<template>
  <section id="base-config-section" class="config-section active-section">
    <p v-if="isLoading" class="config-loading">
      <span class="loading-spinner"></span>
      加载全局配置中…
    </p>

    <form v-else-if="configEntries.length > 0" id="base-config-form" @submit.prevent="handleSubmit">
      <div v-for="entry in configEntries" :key="entry.uid">
        <!-- 注释或空行 -->
        <div v-if="entry.isCommentOrEmpty" class="form-group-comment">
          <pre>{{ entry.value }}</pre>
        </div>
        
        <!-- 配置项 -->
        <div v-else class="form-group">
          <label :for="`config-${entry.key}`">
            <span class="key-name">{{ entry.key }}</span>
          </label>
          
          <!-- 布尔类型 -->
          <div v-if="entry.type === 'boolean'" class="switch-container">
            <label class="switch">
              <input 
                type="checkbox" 
                :id="`config-${entry.key}`"
                v-model="entry.value"
                :data-expected-type="'boolean'"
              >
              <span class="slider"></span>
            </label>
            <span>{{ entry.value ? '启用' : '禁用' }}</span>
          </div>
          
          <!-- 整数类型 -->
          <div v-else-if="entry.type === 'integer'">
            <input 
              type="number" 
              :id="`config-${entry.key}`"
              v-model.number="entry.value"
              step="1"
              :data-expected-type="'integer'"
            >
          </div>
          
          <!-- 多行文本或长文本 -->
          <div v-else-if="entry.isMultilineQuoted || (entry.value && String(entry.value).length > 60)">
            <textarea 
              :id="`config-${entry.key}`"
              v-model="entry.value"
              :rows="Math.min(10, Math.max(3, String(entry.value).split('\\n').length + 1))"
            ></textarea>
          </div>
          
          <!-- 单行文本 -->
          <div v-else>
            <input 
              type="text" 
              :id="`config-${entry.key}`"
              v-model="entry.value"
              :data-original-key="entry.key"
            >
          </div>
          
          <span class="description">根目录 config.env 配置项：{{ entry.key }}</span>
        </div>
      </div>
      
      <div class="form-actions">
        <button type="submit" class="btn-primary">保存全局配置</button>
        <span v-if="statusMessage" :class="['status-message', statusType]">{{ statusMessage }}</span>
      </div>
    </form>

    <div v-else class="config-empty">
      <span class="material-symbols-outlined">settings_suggest</span>
      <h3>暂无配置项</h3>
      <p>全局配置文件为空或加载失败，请检查 config.env 文件是否存在。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adminConfigApi } from '@/api'
import { showMessage, parseEnvToList, serializeEnvAssignment, type EnvEntry } from '@/utils'

interface ConfigEntry extends EnvEntry {
  uid: string
  type: 'string' | 'boolean' | 'integer'
}

const configEntries = ref<ConfigEntry[]>([])
const statusMessage = ref('')
const statusType = ref<'info' | 'success' | 'error'>('info')
const isLoading = ref(true)

// 推断类型
function inferType(key: string | null, value: string): 'string' | 'boolean' | 'integer' {
  if (!key) return 'string'
  if (/^(true|false)$/i.test(value)) return 'boolean'
  if (!isNaN(parseFloat(value)) && isFinite(parseFloat(value)) && !value.includes('.')) return 'integer'
  return 'string'
}

// 加载配置
async function loadConfig() {
  isLoading.value = true
  try {
    const content = await adminConfigApi.getMainConfig({
      showLoader: false,
      loadingKey: 'base-config.load'
    })
    const entries = parseEnvToList(content)

    configEntries.value = entries.map((entry, index) => ({
      ...entry,
      uid: `${entry.key ?? 'line'}-${String(entry.value)}-${index}`,
      type: entry.isCommentOrEmpty ? 'string' : inferType(entry.key, entry.value)
    }))
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`加载全局配置失败：${errorMessage}`, 'error')
  } finally {
    isLoading.value = false
  }
}

// 保存配置
async function handleSubmit() {
  const newConfigString = buildEnvStringForEntries(configEntries.value)
  
  try {
    await adminConfigApi.saveMainConfig(newConfigString, {
      loadingKey: 'base-config.save'
    })
    statusMessage.value = '全局配置已保存！部分更改可能需要重启服务生效。'
    statusType.value = 'success'
    showMessage('全局配置已保存！', 'success')
    await loadConfig()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    statusMessage.value = `保存失败：${errorMessage}`
    statusType.value = 'error'
  }
}

// 构建配置字符串
function buildEnvStringForEntries(entries: ConfigEntry[]): string {
  return entries.map(entry => {
    if (entry.isCommentOrEmpty) {
      return entry.value
    }
    
    let value = entry.value
    if (entry.type === 'boolean') {
      value = value ? 'true' : 'false'
    }
    
    return serializeEnvAssignment(entry.key!, value)
  }).join('\n')
}

onMounted(() => {
  loadConfig()
})
</script>

<style scoped>
#base-config-section {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.config-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-9) var(--space-4);
  color: var(--secondary-text);
}

.config-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-9) var(--space-4);
  color: var(--secondary-text);
  text-align: center;
}

.config-empty .material-symbols-outlined {
  font-size: var(--font-size-icon-empty-lg);
  opacity: 0.3;
  color: var(--highlight-text);
}

.config-empty h3 {
  color: var(--primary-text);
  font-size: var(--font-size-emphasis);
}

.config-empty p {
  max-width: 45ch;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.form-group-comment pre {
  color: var(--secondary-text);
  font-family: inherit;
  white-space: pre-wrap;
  margin: 8px 0;
}
</style>
