<template>
  <section id="base-config-section" class="config-section active-section">
    <div v-if="isLoading && configEntries.length === 0" class="config-loading">
      <span class="loading-spinner"></span>
      加载全局配置中…
    </div>

    <form v-if="configEntries.length > 0" id="base-config-form" @submit.prevent="handleSubmit">
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
            <div v-if="entry.key && isSensitiveConfigKey(entry.key)" class="input-with-toggle">
              <textarea 
                :id="`config-${entry.key}`"
                :value="String(entry.value)"
                @input="entry.value = ($event.target as HTMLTextAreaElement).value"
                :rows="Math.min(10, Math.max(3, String(entry.value).split('\n').length + 1))"
                :class="{ 'password-masked': !sensitiveFields[entry.key] }"
                autocomplete="off"
              ></textarea>
              <button 
                type="button" 
                class="toggle-visibility-btn"
                @click="toggleSensitiveField(entry.key)"
                :aria-label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
              >
                {{ sensitiveFields[entry.key] ? '隐藏' : '显示' }}
              </button>
            </div>
            
            <textarea 
              v-else
              :id="`config-${entry.key}`"
              :value="String(entry.value)"
              @input="entry.value = ($event.target as HTMLTextAreaElement).value"
              :rows="Math.min(10, Math.max(3, String(entry.value).split('\n').length + 1))"
            ></textarea>
          </div>
          
          <!-- 单行文本 -->
          <div v-else>
            <!-- 敏感信息打码输入框 -->
            <div v-if="entry.key && isSensitiveConfigKey(entry.key)" class="input-with-toggle">
              <input 
                :type="sensitiveFields[entry.key] ? 'text' : 'password'" 
                :id="`config-${entry.key}`"
                v-model="entry.value"
                :data-original-key="entry.key"
                autocomplete="off"
              >
              <button 
                type="button" 
                class="toggle-visibility-btn"
                @click="toggleSensitiveField(entry.key)"
                :aria-label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
              >
                {{ sensitiveFields[entry.key] ? '隐藏' : '显示' }}
              </button>
            </div>
            
            <!-- 普通文本输入框 -->
            <input 
              v-else
              type="text" 
              :id="`config-${entry.key}`"
              v-model="entry.value"
              :data-original-key="entry.key"
            >
          </div>
          
          <span class="description">根目录 config.env 配置项：{{ entry.key }}</span>
        </div>
      </div>
      
      <div class="config-action-capsule-container">
        <div class="config-action-capsule">
          <!-- 保存按钮部分 -->
          <button 
            type="submit" 
            class="capsule-segment save-segment" 
            :disabled="isLoading"
            :title="'保存全局配置'"
          >
            <span v-if="isLoading" class="loading-spinner-sm"></span>
            <span v-else class="material-symbols-outlined">save</span>
            <Transition name="fade-text" mode="out-in">
              <span v-if="statusMessage" :key="'status'" class="status-text" :class="statusType">
                {{ statusMessage }}
              </span>
              <span v-else :key="'label'" class="label-text">保存配置</span>
            </Transition>
          </button>

          <!-- 分割线 (始终显示) -->
          <div class="capsule-divider"></div>

          <!-- 回到顶部部分 (始终显示) -->
          <button 
            type="button" 
            class="capsule-segment top-segment" 
            @click="scrollToTop"
            title="回到顶部"
          >
            <span class="material-symbols-outlined">keyboard_arrow_up</span>
          </button>
        </div>
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
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { adminConfigApi } from '@/api'
import { 
  showMessage, 
  parseEnvToList, 
  serializeEnvAssignment, 
  castEnvValue, 
  isSensitiveConfigKey, 
  type EnvEntry 
} from '@/utils'

interface ConfigEntry extends Omit<EnvEntry, 'value'> {
  uid: string
  type: 'string' | 'boolean' | 'integer'
  value: string | boolean | number
}

const configEntries = ref<ConfigEntry[]>([])
const statusMessage = ref('')
const statusType = ref<'info' | 'success' | 'error'>('info')
const isLoading = ref(true)
const sensitiveFields = reactive<Record<string, boolean>>({})

// 回到顶部逻辑
function scrollToTop() {
  const container = document.getElementById('config-details-container')
  if (container) {
    container.scrollTo({ top: 0, behavior: 'smooth' })
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// 切换敏感字段可见性
function toggleSensitiveField(key: string) {
  sensitiveFields[key] = !sensitiveFields[key]
}

// 推断类型
function inferType(key: string | null, value: string): 'string' | 'boolean' | 'integer' {
  if (!key) return 'string'
  
  // 如果是敏感字段（Token/Key等），强制设为字符串，防止因为当前值为纯数字而被误判为整数
  if (isSensitiveConfigKey(key)) return 'string'
  
  if (/^(true|false)$/i.test(value)) return 'boolean'
  if (!isNaN(parseFloat(value)) && isFinite(parseFloat(value)) && !value.includes('.')) return 'integer'
  return 'string'
}

// 加载配置
async function loadConfig(silent = false) {
  if (!silent) isLoading.value = true
  try {
    const content = await adminConfigApi.getMainConfig({
      showLoader: false,
      loadingKey: 'base-config.load'
    })
    const entries = parseEnvToList(content)

    configEntries.value = entries.map((entry, index) => {
      const type = entry.isCommentOrEmpty ? 'string' : inferType(entry.key, entry.value)
      return {
        ...entry,
        uid: `${entry.key ?? 'line'}-${index}`,
        type,
        value: entry.isCommentOrEmpty || !entry.key ? entry.value : castEnvValue(entry.value, type)
      }
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`加载全局配置失败：${errorMessage}`, 'error')
  } finally {
    if (!silent) isLoading.value = false
  }
}

// 保存配置
async function handleSubmit() {
  const newConfigString = buildEnvStringForEntries(configEntries.value)
  
  try {
    await adminConfigApi.saveMainConfig(newConfigString, {
      loadingKey: 'base-config.save'
    })
    statusMessage.value = '全局配置已保存！'
    statusType.value = 'success'
    showMessage('全局配置已保存！', 'success')
    
    // 静默刷新数据，避免加载动画导致滚动重置
    await loadConfig(true)
    
    // 3秒后自动隐藏提示
    setTimeout(() => {
      if (statusType.value === 'success') {
        statusMessage.value = ''
      }
    }, 4000)
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
  document.documentElement.classList.add('hide-global-back-to-top')
})

onUnmounted(() => {
  document.documentElement.classList.remove('hide-global-back-to-top')
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

/* 敏感信息打码样式 */
.input-with-toggle {
  position: relative;
  display: flex;
  align-items: center;
}

.input-with-toggle input {
  flex: 1;
  padding-right: 70px;
}

.toggle-visibility-btn {
  position: absolute;
  right: 8px;
  min-height: 30px;
  padding: 4px 10px;
  background: var(--tertiary-bg);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  cursor: pointer;
  z-index: 2;
}

/* 文本掩码样式 (用于 textarea) */
.password-masked {
  -webkit-text-security: disc !important;
  text-security: disc !important;
}

.toggle-visibility-btn:hover {
  background: var(--accent-bg);
}

/* 一体化胶囊操作中心 */
.config-action-capsule-container {
  position: fixed;
  bottom: 30px;
  right: 30px;
  z-index: var(--z-index-message);
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
  transition: all var(--transition-normal);
}

.config-action-capsule {
  pointer-events: auto;
  display: flex;
  align-items: center;
  height: 50px;
  background-color: var(--button-bg);
  color: var(--on-accent-text);
  border-radius: 25px;
  box-shadow: var(--shadow-overlay-soft);
  overflow: hidden;
  transition: all var(--transition-spring);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.config-action-capsule:hover {
  background-color: var(--button-hover-bg);
  transform: translateY(-4px);
  box-shadow: var(--overlay-panel-shadow);
}

.capsule-segment {
  height: 100%;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  transition: background-color var(--transition-fast);
}

.capsule-segment:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.save-segment {
  gap: 8px;
  min-width: 120px;
}

.top-segment {
  width: 50px;
  padding: 0;
}

.capsule-divider {
  width: 1px;
  height: 24px;
  background-color: rgba(255, 255, 255, 0.2);
}

.label-text, .status-text {
  font-size: var(--font-size-helper);
  font-weight: 500;
}

.status-text.success {
  color: #a7f3d0;
}

.status-text.error {
  color: #fecaca;
}

.loading-spinner-sm {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* 文本切换动画 */
.fade-text-enter-active,
.fade-text-leave-active {
  transition: all 0.2s ease;
}

.fade-text-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.fade-text-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* 隐藏全局回到顶部 */
:global(.hide-global-back-to-top .back-to-top-btn) {
  display: none !important;
}

#base-config-section {
  padding-bottom: 100px;
}

@media (max-width: 768px) {
  .config-action-capsule-container {
    bottom: 20px;
    right: 20px;
  }
}

@media (max-width: 480px) {
  .config-action-capsule-container {
    right: 12px;
    bottom: 20px;
  }
  
  .label-text {
    display: none; /* 极窄屏幕隐藏文字只留图标 */
  }
  
  .save-segment {
    min-width: 50px;
    padding: 0 12px;
  }
}
</style>
