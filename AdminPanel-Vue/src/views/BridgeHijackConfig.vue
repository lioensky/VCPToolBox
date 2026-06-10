<template>
  <section class="config-section active-section">
    <div class="bridge-config">
      <header class="bridge-header">
        <div class="bridge-title">
          <span class="material-symbols-outlined">settings_input_component</span>
          <div>
            <h2>前端劫持配置</h2>
            <p>配置 VCPBridgeServer 的 System Prompt 劫持代理。JSON 配置文件是运行真相源，保存后自动热加载。</p>
          </div>
        </div>

        <div class="bridge-actions">
          <button type="button" class="btn-secondary" @click="loadConfig" :disabled="isLoading || isSaving">
            <span class="material-symbols-outlined" :class="{ spinning: isLoading }">sync</span>
            刷新
          </button>
          <button type="button" class="btn-primary" @click="saveConfig" :disabled="isLoading || isSaving">
            <span v-if="isSaving" class="material-symbols-outlined spinning">sync</span>
            保存配置
          </button>
        </div>
      </header>

      <section class="notice-card">
        <span class="material-symbols-outlined">info</span>
        <div>
          <strong>配置文件：{{ configPath || 'Plugin/VCPBridgeServer/bridge-config.json' }}</strong>
          <p>{{ statusMessage || '首次读取时会自动从 config.env 迁移；若 env 中也没有对应项，则从 config.env.example 或默认值生成。' }}</p>
          <p class="warning">端口变更需要重启插件/主服务后生效，其余字段由 VCPBridgeServer 通过 chokidar 热加载。</p>
        </div>
      </section>

      <form class="config-grid" @submit.prevent="saveConfig">
        <label class="config-field">
          <span>监听端口</span>
          <input v-model.number="draft.port" type="number" min="1" max="65535" step="1" />
          <small>{{ descriptions.port }}</small>
        </label>

        <label class="config-field">
          <span>上游 API 地址</span>
          <input v-model.trim="draft.upstreamUrl" type="text" placeholder="http://127.0.0.1:6005" />
          <small>{{ descriptions.upstreamUrl }}</small>
        </label>

        <label class="config-field">
          <span>上游 API Key</span>
          <input v-model="draft.upstreamKey" :type="showKey ? 'text' : 'password'" placeholder="留空则使用主服务 Key 或透传下游 Key" />
          <small>{{ descriptions.upstreamKey }}</small>
        </label>

        <label class="config-field">
          <span>上游协议类型</span>
          <select v-model="draft.upstreamType">
            <option value="chat">chat：OpenAI Chat Completions</option>
            <option value="anthropic">anthropic：Claude Messages</option>
            <option value="gemini">gemini：Google Gemini</option>
          </select>
          <small>{{ descriptions.upstreamType }}</small>
        </label>

        <label class="config-field">
          <span>默认模型</span>
          <input v-model.trim="draft.defaultModel" type="text" />
          <small>{{ descriptions.defaultModel }}</small>
        </label>

        <label class="config-field">
          <span>劫持模式</span>
          <select v-model="draft.hijackMode">
            <option value="off">off：关闭劫持</option>
            <option value="replace">replace：替换所有 system</option>
            <option value="prepend">prepend：前置插入 system</option>
            <option value="append">append：追加到最后一条 system 后</option>
            <option value="merge">merge：合并为一条置顶 system</option>
          </select>
          <small>{{ descriptions.hijackMode }}</small>
        </label>

        <label class="config-toggle-row">
          <input v-model="draft.debugMode" type="checkbox" />
          <span>
            <strong>开启调试日志</strong>
            <small>{{ descriptions.debugMode }}</small>
          </span>
        </label>

        <label class="config-toggle-row">
          <input v-model="showKey" type="checkbox" />
          <span>
            <strong>显示 API Key</strong>
            <small>仅影响当前页面输入框显示方式，不会修改配置语义。</small>
          </span>
        </label>

        <label class="config-field span-2">
          <span>注入 System Prompt</span>
          <textarea v-model="draft.systemPrompt" rows="9" placeholder="可直接填写提示词，也可填写插件目录下的 .txt 文件名"></textarea>
          <small>{{ descriptions.systemPrompt }}</small>
        </label>

        <label class="config-field span-2">
          <span>模型映射（每行 alias=target 或 alias:target）</span>
          <textarea v-model="modelMapText" rows="7" placeholder="gpt-4.1-mini=gemini-2.5-flash&#10;claude-sonnet=gpt-4.1"></textarea>
          <small>{{ descriptions.modelMap }}</small>
        </label>
      </form>

      <section class="preview-card">
        <header>
          <strong>JSON 预览</strong>
          <button type="button" class="btn-secondary" @click="copyJsonPreview">
            <span class="material-symbols-outlined">content_copy</span>
            复制
          </button>
        </header>
        <pre>{{ jsonPreview }}</pre>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { systemApi } from '@/api'
import type { BridgeHijackConfig } from '@/types/api.system'
import { copyToClipboard, showMessage } from '@/utils'

const defaultConfig: BridgeHijackConfig = {
  port: 3100,
  upstreamUrl: '',
  upstreamKey: '',
  upstreamType: 'chat',
  defaultModel: 'gpt-4.1-mini',
  systemPrompt: '',
  hijackMode: 'off',
  modelMap: {},
  debugMode: false,
}

const draft = ref<BridgeHijackConfig>({ ...defaultConfig })
const descriptions = ref<Record<string, string>>({})
const configPath = ref('')
const statusMessage = ref('')
const modelMapText = ref('')
const showKey = ref(false)
const isLoading = ref(false)
const isSaving = ref(false)

const normalizedDraft = computed<BridgeHijackConfig>(() => ({
  port: normalizePort(draft.value.port),
  upstreamUrl: String(draft.value.upstreamUrl || '').trim().replace(/\/+$/, ''),
  upstreamKey: String(draft.value.upstreamKey || ''),
  upstreamType: normalizeUpstreamType(draft.value.upstreamType),
  defaultModel: String(draft.value.defaultModel || defaultConfig.defaultModel).trim() || defaultConfig.defaultModel,
  systemPrompt: String(draft.value.systemPrompt || ''),
  hijackMode: normalizeHijackMode(draft.value.hijackMode),
  modelMap: parseModelMapText(modelMapText.value),
  debugMode: Boolean(draft.value.debugMode),
}))

const jsonPreview = computed(() => JSON.stringify(normalizedDraft.value, null, 2))

function normalizePort(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : defaultConfig.port
}

function normalizeUpstreamType(value: string): BridgeHijackConfig['upstreamType'] {
  return value === 'anthropic' || value === 'gemini' ? value : 'chat'
}

function normalizeHijackMode(value: string): BridgeHijackConfig['hijackMode'] {
  return value === 'replace' || value === 'prepend' || value === 'append' || value === 'merge' ? value : 'off'
}

function formatModelMap(map: Record<string, string>): string {
  return Object.entries(map || {})
    .map(([alias, target]) => `${alias}=${target}`)
    .join('\n')
}

function parseModelMapText(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separatorIndex = trimmed.includes('=') ? trimmed.indexOf('=') : trimmed.indexOf(':')
    if (separatorIndex <= 0) continue
    const alias = trimmed.slice(0, separatorIndex).trim()
    const target = trimmed.slice(separatorIndex + 1).trim()
    if (alias && target) result[alias] = target
  }
  return result
}

function applyConfig(config: BridgeHijackConfig) {
  draft.value = {
    port: normalizePort(config.port),
    upstreamUrl: config.upstreamUrl || '',
    upstreamKey: config.upstreamKey || '',
    upstreamType: normalizeUpstreamType(config.upstreamType),
    defaultModel: config.defaultModel || defaultConfig.defaultModel,
    systemPrompt: config.systemPrompt || '',
    hijackMode: normalizeHijackMode(config.hijackMode),
    modelMap: config.modelMap || {},
    debugMode: Boolean(config.debugMode),
  }
  modelMapText.value = formatModelMap(draft.value.modelMap)
}

async function loadConfig() {
  isLoading.value = true
  try {
    const response = await systemApi.getBridgeHijackConfig(
      {},
      {
        showLoader: false,
        suppressErrorMessage: true,
      }
    )
    applyConfig(response.config)
    descriptions.value = response.description || {}
    configPath.value = response.path || 'Plugin/VCPBridgeServer/bridge-config.json'
    statusMessage.value = response.message || '前端劫持配置已加载。'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`加载前端劫持配置失败：${message}`, 'error')
  } finally {
    isLoading.value = false
  }
}

async function saveConfig() {
  isSaving.value = true
  try {
    const response = await systemApi.saveBridgeHijackConfig(normalizedDraft.value, {}, { showLoader: false })
    applyConfig(response.config)
    descriptions.value = response.description || descriptions.value
    configPath.value = response.path || configPath.value
    statusMessage.value = response.message || '前端劫持配置已保存。'
    showMessage(statusMessage.value, 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`保存前端劫持配置失败：${message}`, 'error')
  } finally {
    isSaving.value = false
  }
}

async function copyJsonPreview() {
  const success = await copyToClipboard(jsonPreview.value)
  showMessage(success ? 'JSON 预览已复制' : '复制失败，请手动选择文本复制', success ? 'success' : 'error')
}

onMounted(() => {
  void loadConfig()
})
</script>

<style scoped>
.bridge-config {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.bridge-header,
.notice-card,
.preview-card {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
}

.bridge-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  padding: 16px;
}

.bridge-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.bridge-title .material-symbols-outlined {
  font-size: 32px !important;
  color: var(--highlight-text);
}

.bridge-title h2 {
  margin: 0;
  font-size: var(--font-size-title);
}

.bridge-title p,
.notice-card p,
.config-field small,
.config-toggle-row small {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.bridge-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.notice-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 14px 16px;
  border-color: color-mix(in srgb, var(--highlight-text) 45%, var(--border-color));
  background: linear-gradient(135deg, color-mix(in srgb, var(--highlight-bg) 18%, var(--secondary-bg)), var(--secondary-bg));
}

.notice-card > .material-symbols-outlined {
  color: var(--highlight-text);
}

.notice-card .warning {
  color: var(--warning-text);
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(260px, 1fr));
  gap: var(--space-3);
}

.config-field,
.config-toggle-row {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
}

.config-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
}

.config-field > span,
.config-toggle-row strong {
  color: var(--primary-text);
  font-weight: 700;
}

.config-field input,
.config-field select,
.config-field textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--input-bg);
  color: var(--primary-text);
  font: inherit;
}

.config-field textarea {
  resize: vertical;
  min-height: 120px;
  font-family: Consolas, Monaco, "Courier New", monospace;
  line-height: 1.5;
}

.config-toggle-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 14px 16px;
}

.config-toggle-row input {
  margin-top: 4px;
}

.config-toggle-row span {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.span-2 {
  grid-column: 1 / -1;
}

.preview-card {
  overflow: hidden;
}

.preview-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--tertiary-bg);
}

.preview-card pre {
  margin: 0;
  padding: 16px;
  max-height: 420px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--primary-text);
  background: var(--primary-bg);
  font-family: Consolas, Monaco, "Courier New", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .bridge-header {
    flex-direction: column;
    align-items: stretch;
  }

  .config-grid {
    grid-template-columns: 1fr;
  }
}
</style>