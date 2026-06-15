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
          <span>注入 System Prompt（全局兜底）</span>
          <textarea v-model="draft.systemPrompt" rows="9" placeholder="可直接填写提示词，也可填写插件目录下的 .txt 文件名"></textarea>
          <small>{{ descriptions.systemPrompt }}</small>
        </label>

        <label class="config-field span-2">
          <span>模型映射（每行 alias=target 或 alias:target）</span>
          <textarea v-model="modelMapText" rows="7" placeholder="gpt-4.1-mini=gemini-2.5-flash&#10;claude-sonnet=gpt-4.1"></textarea>
          <small>{{ descriptions.modelMap }}</small>
        </label>
      </form>

      <!-- ═══════════════════════════════════════════════════════════════
           Profiles 管理区域
           ═══════════════════════════════════════════════════════════════ -->

      <section class="profiles-section">
        <header class="profiles-header">
          <div class="profiles-title">
            <span class="material-symbols-outlined">switch_account</span>
            <div>
              <h3>多 Profile 管理</h3>
              <p>每个 Profile 定义独立的 systemPrompt + hijackMode。下游 CLI 通过 URL 路径前缀（如 /v1/research/chat/completions）自动选择 Profile。</p>
            </div>
          </div>
          <div class="profiles-actions">
            <button type="button" class="btn-secondary" @click="loadProfiles" :disabled="profilesLoading">
              <span class="material-symbols-outlined" :class="{ spinning: profilesLoading }">sync</span>
              刷新
            </button>
            <button type="button" class="btn-primary" @click="showCreateDialog = true">
              <span class="material-symbols-outlined">add</span>
              新建
            </button>
          </div>
        </header>

        <div class="profiles-body" v-if="profiles.length > 0">
          <ul class="profiles-list">
            <li
              v-for="p in profiles"
              :key="p.name"
              :class="{ active: selectedProfile?.name === p.name, 'is-default': p.name === activeDefault }"
              @click="selectProfile(p)"
            >
              <span class="profile-indicator" :class="{ default: p.name === activeDefault }"></span>
              <div class="profile-meta">
                <strong>{{ p.displayName || p.name }}</strong>
                <small>{{ p.name }}</small>
              </div>
            </li>
          </ul>

          <div class="profile-editor" v-if="selectedProfile">
            <label class="config-field">
              <span>显示名称</span>
              <input v-model="profileDraft.displayName" type="text" />
            </label>
            <label class="config-field">
              <span>System Prompt（.txt 文件名或直接文本）</span>
              <input v-model="profileDraft.systemPrompt" type="text" placeholder="Research_Rule.txt" />
            </label>
            <label class="config-field">
              <span>劫持模式</span>
              <select v-model="profileDraft.hijackMode">
                <option value="off">off</option>
                <option value="replace">replace</option>
                <option value="prepend">prepend</option>
                <option value="append">append</option>
                <option value="merge">merge</option>
              </select>
            </label>
            <label class="config-field">
              <span>模型覆盖（留空则使用全局 defaultModel）</span>
              <input v-model="profileDraft.modelOverride" type="text" placeholder="" />
            </label>
            <label class="config-field span-2">
              <span>描述</span>
              <textarea v-model="profileDraft.description" rows="3"></textarea>
            </label>

            <div class="profile-editor-actions">
              <button type="button" class="btn-primary" @click="saveCurrentProfile" :disabled="profileSaving">
                <span v-if="profileSaving" class="material-symbols-outlined spinning">sync</span>
                保存 Profile
              </button>
              <button
                type="button"
                class="btn-secondary"
                @click="activateProfile"
                :disabled="selectedProfile.name === activeDefault"
              >
                <span class="material-symbols-outlined">star</span>
                {{ selectedProfile.name === activeDefault ? '已是默认' : '设为默认' }}
              </button>
              <button type="button" class="btn-danger" @click="deleteCurrentProfile" :disabled="selectedProfile.name === activeDefault">
                <span class="material-symbols-outlined">delete</span>
                删除
              </button>
            </div>

            <div class="profile-usage-hint">
              <span class="material-symbols-outlined">terminal</span>
              <code>base_url: http://127.0.0.1:{{ draft.port }}/v1/{{ selectedProfile.name }}</code>
            </div>
          </div>
        </div>

        <div class="profiles-empty" v-else-if="!profilesLoading">
          <span class="material-symbols-outlined">folder_open</span>
          <p>暂无 Profile。点击"新建"创建第一个分身配置。</p>
        </div>
      </section>

      <!-- 新建 Profile 对话框 -->
      <div class="modal-overlay" v-if="showCreateDialog" @click.self="showCreateDialog = false">
        <div class="modal-card">
          <h3>新建 Profile</h3>
          <label class="config-field">
            <span>Profile 名称（小写字母、数字、连字符）</span>
            <input v-model="newProfileName" type="text" placeholder="research" pattern="[a-z0-9][a-z0-9_-]*" />
          </label>
          <label class="config-field">
            <span>显示名称</span>
            <input v-model="newProfileDisplayName" type="text" placeholder="科研分身" />
          </label>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" @click="showCreateDialog = false">取消</button>
            <button type="button" class="btn-primary" @click="createProfile" :disabled="!newProfileName.trim()">创建</button>
          </div>
        </div>
      </div>

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
import type { BridgeHijackConfig, BridgeProfile } from '@/types/api.system'
import { copyToClipboard, showMessage } from '@/utils'

// ─── Global Config State ─────────────────────────────────────────────────────

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
  defaultProfile: '',
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
  defaultProfile: String(draft.value.defaultProfile || ''),
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
    defaultProfile: config.defaultProfile || '',
  }
  modelMapText.value = formatModelMap(draft.value.modelMap)
}

async function loadConfig() {
  isLoading.value = true
  try {
    const response = await systemApi.getBridgeHijackConfig({}, { showLoader: false, suppressErrorMessage: true })
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

// ─── Profiles State ──────────────────────────────────────────────────────────

const profiles = ref<BridgeProfile[]>([])
const activeDefault = ref('')
const selectedProfile = ref<BridgeProfile | null>(null)
const profileDraft = ref<BridgeProfile>({ name: '', displayName: '', systemPrompt: '', hijackMode: 'off', modelOverride: '', description: '' })
const profilesLoading = ref(false)
const profileSaving = ref(false)
const showCreateDialog = ref(false)
const newProfileName = ref('')
const newProfileDisplayName = ref('')

function selectProfile(p: BridgeProfile) {
  selectedProfile.value = p
  profileDraft.value = { ...p }
}

async function loadProfiles() {
  profilesLoading.value = true
  try {
    const response = await systemApi.getBridgeProfiles({}, { showLoader: false, suppressErrorMessage: true })
    profiles.value = response.profiles || []
    activeDefault.value = response.activeDefault || ''
    if (selectedProfile.value) {
      const updated = profiles.value.find(p => p.name === selectedProfile.value!.name)
      if (updated) selectProfile(updated)
      else selectedProfile.value = null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`加载 Profiles 失败：${message}`, 'error')
  } finally {
    profilesLoading.value = false
  }
}

async function saveCurrentProfile() {
  if (!selectedProfile.value) return
  profileSaving.value = true
  try {
    const response = await systemApi.saveBridgeProfile(selectedProfile.value.name, profileDraft.value, {}, { showLoader: false })
    showMessage(response.message || 'Profile 已保存', 'success')
    await loadProfiles()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`保存 Profile 失败：${message}`, 'error')
  } finally {
    profileSaving.value = false
  }
}

async function deleteCurrentProfile() {
  if (!selectedProfile.value) return
  const name = selectedProfile.value.name
  if (!confirm(`确定删除 Profile "${name}" 吗？此操作不可撤销。`)) return
  try {
    await systemApi.deleteBridgeProfile(name, {}, { showLoader: false })
    showMessage(`Profile "${name}" 已删除`, 'success')
    selectedProfile.value = null
    await loadProfiles()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`删除 Profile 失败：${message}`, 'error')
  }
}

async function activateProfile() {
  if (!selectedProfile.value) return
  try {
    const response = await systemApi.activateBridgeProfile(selectedProfile.value.name, {}, { showLoader: false })
    activeDefault.value = response.activeDefault || ''
    showMessage(response.message || '已设为默认 Profile', 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`激活 Profile 失败：${message}`, 'error')
  }
}

async function createProfile() {
  const name = newProfileName.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (!name) return
  try {
    await systemApi.saveBridgeProfile(name, {
      displayName: newProfileDisplayName.value.trim() || name,
      systemPrompt: '',
      hijackMode: 'off',
      modelOverride: '',
      description: '',
    }, {}, { showLoader: false })
    showMessage(`Profile "${name}" 创建成功`, 'success')
    showCreateDialog.value = false
    newProfileName.value = ''
    newProfileDisplayName.value = ''
    await loadProfiles()
    const created = profiles.value.find(p => p.name === name)
    if (created) selectProfile(created)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showMessage(`创建 Profile 失败：${message}`, 'error')
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

onMounted(() => {
  void loadConfig()
  void loadProfiles()
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
.preview-card,
.profiles-section {
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

/* ─── Profiles Section ──────────────────────────────────────────────── */

.profiles-section {
  overflow: hidden;
}

.profiles-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.profiles-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.profiles-title .material-symbols-outlined {
  font-size: 28px !important;
  color: var(--highlight-text);
}

.profiles-title h3 {
  margin: 0;
  font-size: var(--font-size-subtitle, 1.1rem);
}

.profiles-title p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.profiles-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.profiles-body {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 280px;
}

.profiles-list {
  list-style: none;
  margin: 0;
  padding: 8px;
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  max-height: 420px;
}

.profiles-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.15s;
}

.profiles-list li:hover {
  background: var(--tertiary-bg);
}

.profiles-list li.active {
  background: color-mix(in srgb, var(--highlight-bg) 25%, var(--secondary-bg));
  border: 1px solid var(--highlight-text);
}

.profile-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--secondary-text);
  flex-shrink: 0;
}

.profile-indicator.default {
  background: #4caf50;
  box-shadow: 0 0 6px #4caf5080;
}

.profile-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.profile-meta strong {
  font-size: 0.9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.profile-meta small {
  color: var(--secondary-text);
  font-size: 0.75rem;
}

.profile-editor {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
  padding: 16px;
}

.profile-editor .config-field {
  border: none;
  padding: 8px 0;
}

.profile-editor-actions {
  grid-column: 1 / -1;
  display: flex;
  gap: var(--space-2);
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}

.profile-usage-hint {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  background: var(--tertiary-bg);
  font-size: 0.85rem;
}

.profile-usage-hint code {
  font-family: Consolas, Monaco, "Courier New", monospace;
  color: var(--highlight-text);
}

.profiles-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 48px 16px;
  color: var(--secondary-text);
}

.profiles-empty .material-symbols-outlined {
  font-size: 48px !important;
  opacity: 0.4;
}

/* ─── Modal ─────────────────────────────────────────────────────────── */

.modal-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  z-index: 1000;
}

.modal-card {
  background: var(--secondary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: min(420px, 90vw);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.modal-card h3 {
  margin: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* ─── Buttons ───────────────────────────────────────────────────────── */

.btn-danger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid #f44336;
  border-radius: var(--radius-md);
  background: transparent;
  color: #f44336;
  font: inherit;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.btn-danger:hover {
  background: #f44336;
  color: #fff;
}

.btn-danger:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ─── Preview Card ──────────────────────────────────────────────────── */

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
  .bridge-header,
  .profiles-header {
    flex-direction: column;
    align-items: stretch;
  }

  .config-grid {
    grid-template-columns: 1fr;
  }

  .profiles-body {
    grid-template-columns: 1fr;
  }

  .profiles-list {
    border-right: none;
    border-bottom: 1px solid var(--border-color);
    max-height: 200px;
  }
}
</style>