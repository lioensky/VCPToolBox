<template>
  <section class="config-section active-section">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiDirtyIndicator :dirty="isDirty" label="配置未保存" />
        <UiButton variant="outline" size="lg" @click="loadConfig" :disabled="isLoading || isSaving">
          <template #leading>
            <span class="material-symbols-outlined" :class="{ spinning: isLoading }">sync</span>
          </template>
          刷新
        </UiButton>
        <UiButton variant="secondary" size="lg" @click="saveConfig" :disabled="isLoading || isSaving || !isDirty">
          <template #leading>
            <span v-if="isSaving" class="material-symbols-outlined spinning">sync</span>
            <span v-else class="material-symbols-outlined">save</span>
          </template>
          保存配置
        </UiButton>
      </UiPageActions>
    </Teleport>

    <div class="bridge-config">
      <header class="bridge-header">
        <div class="bridge-title">
          <div>
            <h2>前端劫持配置</h2>
            <p>配置 VCPBridgeServer 的 System Prompt 劫持代理。JSON 配置文件是运行真相源，保存后自动热加载。</p>
          </div>
        </div>
      </header>

      <div class="bridge-workspace">
        <main class="bridge-main">
          <section class="notice-card">
            <span class="material-symbols-outlined">info</span>
            <div>
              <strong>配置文件：{{ configPath || 'Plugin/VCPBridgeServer/bridge-config.json' }}</strong>
              <p>{{ statusMessage || '首次读取时会自动从 config.env 迁移；若 env 中也没有对应项，则从 config.env.example 或默认值生成。' }}</p>
              <p class="warning">端口变更需要重启插件/主服务后生效，其余字段由 VCPBridgeServer 通过 chokidar 热加载。</p>
            </div>
          </section>

          <form class="settings-stack" @submit.prevent="saveConfig">
            <UiSettingsCard class="bridge-settings-surface" title="基础连接" description="定义桥接服务监听端口、上游 API 地址和默认模型。">
              <UiSettingsForm as="div" :columns="2" gap="md">
                <UiField label="监听端口" :description="descriptions.port" class="config-field">
                  <UiInput v-model.number="draft.port" type="number" min="1" max="65535" step="1" />
                </UiField>

                <UiField label="上游 API 地址" :description="descriptions.upstreamUrl" class="config-field">
                  <UiInput v-model.trim="draft.upstreamUrl" type="text" placeholder="http://127.0.0.1:6005" />
                </UiField>

                <UiField label="上游协议类型" :description="descriptions.upstreamType" class="config-field">
                  <UiSelect v-model="draft.upstreamType">
                    <option value="chat">chat：OpenAI Chat Completions</option>
                    <option value="anthropic">anthropic：Claude Messages</option>
                    <option value="gemini">gemini：Google Gemini</option>
                  </UiSelect>
                </UiField>

                <UiField label="默认模型" :description="descriptions.defaultModel" class="config-field">
                  <UiInput v-model.trim="draft.defaultModel" type="text" />
                </UiField>
              </UiSettingsForm>
            </UiSettingsCard>

            <UiSettingsCard class="bridge-settings-surface" title="认证与劫持行为" description="控制上游鉴权、System Prompt 注入方式与调试输出。">
              <UiSettingsForm as="div" :columns="2" gap="md">
                <UiField label="上游 API Key" :description="descriptions.upstreamKey" class="config-field">
                  <UiInput v-model="draft.upstreamKey" :type="showKey ? 'text' : 'password'" placeholder="留空则使用主服务 Key 或透传下游 Key" />
                </UiField>

                <UiField label="劫持模式" :description="descriptions.hijackMode" class="config-field">
                  <UiSelect v-model="draft.hijackMode">
                    <option value="off">off：关闭劫持</option>
                    <option value="replace">replace：替换所有 system</option>
                    <option value="prepend">prepend：前置插入 system</option>
                    <option value="append">append：追加到最后一条 system 后</option>
                    <option value="merge">merge：合并为一条置顶 system</option>
                  </UiSelect>
                </UiField>

                <UiSettingsSwitchRow v-model="draft.debugMode" label="开启调试日志" :description="descriptions.debugMode" />
                <UiSettingsSwitchRow v-model="showKey" label="显示 API Key" description="仅影响当前页面输入框显示方式，不会修改配置语义。" />
              </UiSettingsForm>
            </UiSettingsCard>

            <UiSettingsCard class="bridge-settings-surface" title="Prompt 与模型映射" description="配置全局兜底 Prompt，并把客户端模型名映射到真实上游模型。">
              <UiSettingsForm as="div" :columns="1" gap="md">
                <UiField label="注入 System Prompt（全局兜底）" :description="descriptions.systemPrompt" class="config-field">
                  <UiTextarea v-model="draft.systemPrompt" rows="8" placeholder="可直接填写提示词，也可填写插件目录下的 .txt 文件名" class="code-textarea" />
                </UiField>

                <UiField label="模型映射" :description="descriptions.modelMap" class="config-field">
                  <div class="mapping-editor">
                    <div class="mapping-toolbar">
                      <div class="mapping-mode" role="tablist" aria-label="模型映射编辑模式">
                        <button type="button" :class="{ active: mappingMode === 'visual' }" @click="mappingMode = 'visual'">
                          <span class="material-symbols-outlined">table_rows</span>
                          可视化
                        </button>
                        <button type="button" :class="{ active: mappingMode === 'text' }" @click="mappingMode = 'text'">
                          <span class="material-symbols-outlined">code</span>
                          文本
                        </button>
                      </div>
                      <UiButton v-if="mappingMode === 'visual'" variant="outline" size="sm" type="button" @click="addMappingRow">
                        <span class="material-symbols-outlined">add</span>
                        添加映射
                      </UiButton>
                    </div>

                    <div v-if="mappingMode === 'visual'" class="mapping-table">
                      <div class="mapping-head">
                        <span>客户端模型</span>
                        <span>上游模型</span>
                        <span></span>
                      </div>
                      <div v-if="modelMapRows.length === 0" class="mapping-empty">
                        暂无模型映射。未配置时会直接使用请求中的模型名。
                      </div>
                      <div v-for="row in modelMapRows" :key="row.id" class="mapping-row">
                        <UiInput :model-value="row.alias" placeholder="gpt-4.1-mini" @update:model-value="updateMappingRow(row.id, 'alias', String($event))" />
                        <UiInput :model-value="row.target" placeholder="gemini-2.5-flash" @update:model-value="updateMappingRow(row.id, 'target', String($event))" />
                        <UiButton variant="ghost" size="sm" type="button" aria-label="删除映射" @click="deleteMappingRow(row.id)">
                          <span class="material-symbols-outlined">delete</span>
                        </UiButton>
                      </div>
                    </div>

                    <UiTextarea
                      v-else
                      v-model="modelMapText"
                      rows="7"
                      placeholder="gpt-4.1-mini=gemini-2.5-flash&#10;claude-sonnet=gpt-4.1"
                      class="code-textarea"
                    />
                  </div>
                </UiField>
              </UiSettingsForm>
            </UiSettingsCard>
          </form>

          <!-- ═══════════════════════════════════════════════════════════════
               Profiles 管理区域
               ═══════════════════════════════════════════════════════════════ -->

          <section class="profiles-section">
            <header class="profiles-header">
              <div class="profiles-title">
                <div>
                  <h3>多 Profile 管理</h3>
                  <p>每个 Profile 定义独立的 systemPrompt + hijackMode。下游 CLI 通过 URL 路径前缀（如 /v1/research/chat/completions）自动选择 Profile。</p>
                </div>
              </div>
              <div class="profiles-actions">
                <UiButton variant="outline" @click="loadProfiles" :disabled="profilesLoading">
                  <span class="material-symbols-outlined" :class="{ spinning: profilesLoading }">sync</span>
                  刷新
                </UiButton>
                <UiButton variant="primary" @click="showCreateDialog = true">
                  <span class="material-symbols-outlined">add</span>
                  新建
                </UiButton>
              </div>
            </header>

            <div class="profiles-body" v-if="profiles.length > 0">
              <ul class="profiles-list" role="tablist" aria-label="Profile 列表">
                <li
                  v-for="p in profiles"
                  :key="p.name"
                  :class="{ active: selectedProfile?.name === p.name, 'is-default': p.name === activeDefault }"
                  role="tab"
                  :aria-selected="selectedProfile?.name === p.name"
                  @click="selectProfile(p)"
                >
                  <span class="profile-indicator" :class="{ default: p.name === activeDefault }"></span>
                  <div class="profile-meta">
                    <strong>{{ p.displayName || p.name }}</strong>
                    <small>{{ p.name }}</small>
                  </div>
                  <span v-if="p.name === activeDefault" class="profile-default-badge">默认</span>
                </li>
              </ul>

              <div class="profile-editor" v-if="selectedProfile">
                <div class="profile-editor-summary">
                  <div class="profile-summary-main">
                    <strong>{{ profileDraft.displayName || selectedProfile.name }}</strong>
                    <p>{{ profileDraft.description || '当前 Profile 暂无描述。' }}</p>
                    <div class="profile-usage-hint">
                      <span class="material-symbols-outlined">terminal</span>
                      <code>base_url: http://127.0.0.1:{{ draft.port }}/v1/{{ selectedProfile.name }}</code>
                    </div>
                  </div>
                  <div class="profile-summary-side">
                    <div class="profile-summary-tags">
                      <span>{{ profileDraft.hijackMode || 'off' }}</span>
                      <span v-if="selectedProfile.name === activeDefault">默认路由</span>
                      <span v-if="profileDraft.modelOverride">模型覆盖</span>
                    </div>
                    <UiButton
                      variant="outline"
                      size="sm"
                      @click="activateProfile"
                      :disabled="selectedProfile.name === activeDefault"
                    >
                      <span class="material-symbols-outlined">star</span>
                      {{ selectedProfile.name === activeDefault ? '当前默认' : '设为默认' }}
                    </UiButton>
                    <UiButton variant="primary" size="sm" @click="saveCurrentProfile" :disabled="profileSaving">
                      <span v-if="profileSaving" class="material-symbols-outlined spinning">sync</span>
                      <span v-else class="material-symbols-outlined">save</span>
                      保存
                    </UiButton>
                  </div>
                </div>

                <UiField label="显示名称" class="config-field">
                  <UiInput v-model="profileDraft.displayName" type="text" />
                </UiField>
                <UiField label="System Prompt（.txt 文件名或直接文本）" class="config-field">
                  <UiInput v-model="profileDraft.systemPrompt" type="text" placeholder="Research_Rule.txt" />
                </UiField>
                <UiField label="劫持模式" class="config-field">
                  <UiSelect v-model="profileDraft.hijackMode">
                    <option value="off">off</option>
                    <option value="replace">replace</option>
                    <option value="prepend">prepend</option>
                    <option value="append">append</option>
                    <option value="merge">merge</option>
                  </UiSelect>
                </UiField>
                <UiField label="模型覆盖（留空则使用全局 defaultModel）" class="config-field">
                  <UiInput v-model="profileDraft.modelOverride" type="text" placeholder="" />
                </UiField>
                <UiField label="描述" class="config-field" data-settings-span="full">
                  <UiTextarea v-model="profileDraft.description" rows="2" />
                </UiField>

                <div class="profile-danger-zone">
                  <div>
                    <strong>删除当前 Profile</strong>
                    <p>不可恢复，默认 Profile 不能删除。</p>
                  </div>
                  <UiButton variant="danger" size="sm" @click="deleteCurrentProfile" :disabled="selectedProfile.name === activeDefault">
                    <span class="material-symbols-outlined">delete</span>
                    删除
                  </UiButton>
                </div>
              </div>
            </div>

            <div class="profiles-empty" v-else-if="!profilesLoading">
              <span class="material-symbols-outlined">folder_open</span>
              <p>暂无 Profile。点击"新建"创建第一个分身配置。</p>
            </div>
          </section>
        </main>
      </div>

      <aside class="bridge-preview-aside">
        <section class="preview-card">
          <header>
              <div>
                <strong>JSON 预览</strong>
                <p>保存前的最终配置结构</p>
              </div>
            </header>
            <div class="preview-code-shell">
              <UiButton class="preview-copy-button" variant="ghost" size="sm" aria-label="复制 JSON 预览" title="复制 JSON 预览" @click="copyJsonPreview">
                <span class="material-symbols-outlined">content_copy</span>
              </UiButton>
              <pre>{{ jsonPreview }}</pre>
            </div>
          </section>
      </aside>

      <!-- 新建 Profile 对话框 -->
      <div class="modal-overlay" v-if="showCreateDialog" @click.self="showCreateDialog = false">
        <div class="modal-card">
          <h3>新建 Profile</h3>
          <UiField label="Profile 名称（小写字母、数字、连字符）" class="config-field">
            <UiInput v-model="newProfileName" type="text" placeholder="research" pattern="[a-z0-9][a-z0-9_-]*" />
          </UiField>
          <UiField label="显示名称" class="config-field">
            <UiInput v-model="newProfileDisplayName" type="text" placeholder="科研分身" />
          </UiField>
          <div class="modal-actions">
            <UiButton variant="outline" @click="showCreateDialog = false">取消</UiButton>
            <UiButton variant="primary" @click="createProfile" :disabled="!newProfileName.trim()">创建</UiButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiDirtyIndicator from '@/components/ui/UiDirtyIndicator.vue'
import UiField from '@/components/ui/UiField.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiSettingsCard from '@/components/ui/UiSettingsCard.vue'
import UiSettingsForm from '@/components/ui/UiSettingsForm.vue'
import UiSettingsSwitchRow from '@/components/ui/UiSettingsSwitchRow.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
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
const mappingMode = ref<'visual' | 'text'>('visual')
const showKey = ref(false)
const isLoading = ref(false)
const isSaving = ref(false)
const savedSignature = ref('')

type ModelMapRow = {
  id: string
  alias: string
  target: string
}

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
const isDirty = computed(() => Boolean(savedSignature.value) && jsonPreview.value !== savedSignature.value)
const modelMapRows = computed<ModelMapRow[]>(() =>
  parseModelMapRows(modelMapText.value)
)

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

function parseModelMapRows(text: string): ModelMapRow[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => {
      const trimmed = line.trim()
      const separatorIndex = trimmed.includes('=') ? trimmed.indexOf('=') : trimmed.indexOf(':')
      if (!trimmed || trimmed.startsWith('#')) return null
      if (separatorIndex < 0) {
        return { id: `row-${index}-${trimmed}`, alias: trimmed, target: '' }
      }
      const alias = trimmed.slice(0, separatorIndex).trim()
      const target = trimmed.slice(separatorIndex + 1).trim()
      return { id: `row-${index}-${alias || 'empty'}`, alias, target }
    })
    .filter((row): row is ModelMapRow => Boolean(row))
}

function serializeModelMapRows(rows: ModelMapRow[]): string {
  return rows
    .map(row => {
      const alias = row.alias.trim()
      const target = row.target.trim()
      return alias || target ? `${alias}=${target}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

function addMappingRow() {
  const rows = modelMapRows.value
  let index = rows.length + 1
  let alias = `client-model-${index}`
  while (rows.some(row => row.alias === alias)) {
    index += 1
    alias = `client-model-${index}`
  }
  modelMapText.value = serializeModelMapRows([...rows, { id: alias, alias, target: '' }])
}

function updateMappingRow(id: string, field: 'alias' | 'target', value: string) {
  const rows = modelMapRows.value.map(row => (row.id === id ? { ...row, [field]: value } : row))
  modelMapText.value = serializeModelMapRows(rows)
}

function deleteMappingRow(id: string) {
  modelMapText.value = serializeModelMapRows(modelMapRows.value.filter(row => row.id !== id))
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

function markConfigSaved() {
  savedSignature.value = jsonPreview.value
}

async function loadConfig() {
  isLoading.value = true
  try {
    const response = await systemApi.getBridgeHijackConfig({}, { showLoader: false, suppressErrorMessage: true })
    applyConfig(response.config)
    descriptions.value = response.description || {}
    configPath.value = response.path || 'Plugin/VCPBridgeServer/bridge-config.json'
    statusMessage.value = response.message || '前端劫持配置已加载。'
    markConfigSaved()
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
    markConfigSaved()
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
    if (!selectedProfile.value && profiles.value.length > 0) {
      selectProfile(profiles.value.find(p => p.name === activeDefault.value) || profiles.value[0])
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
  --bridge-surface-border: color-mix(in srgb, var(--border-color) 96%, transparent);
  --bridge-control-border: color-mix(in srgb, var(--border-color) 100%, transparent);
  --bridge-card-surface: color-mix(in srgb, var(--primary-text) 1.5%, transparent);
  --bridge-muted-surface: color-mix(in srgb, var(--primary-text) 3.5%, transparent);
  --surface-overlay-soft: color-mix(in srgb, var(--primary-text) 1.5%, transparent);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  align-items: start;
  gap: var(--space-4);
}

.notice-card,
.profiles-section {
  border: 1px solid var(--bridge-surface-border);
  border-radius: var(--radius-lg);
  background: var(--bridge-card-surface);
}

.bridge-header {
  display: flex;
  grid-column: 1;
  grid-row: 1;
  align-items: center;
  padding: 0 0 var(--space-1);
}

.bridge-title {
  display: flex;
  align-items: center;
}

.bridge-title h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.bridge-title p,
.notice-card p,
.config-toggle-row small {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.notice-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 22%, var(--bridge-surface-border));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--highlight-text) 3.5%, transparent);
}

.notice-card > .material-symbols-outlined {
  color: var(--highlight-text);
}

.notice-card strong,
.notice-card p {
  overflow-wrap: anywhere;
}

.notice-card strong {
  display: block;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
  line-height: 1.45;
}

.notice-card .warning {
  color: var(--warning-text);
}

.bridge-workspace {
  grid-column: 1;
  grid-row: 2;
  min-width: 0;
}

.bridge-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-4);
}

.bridge-preview-aside {
  position: sticky;
  grid-column: 2;
  grid-row: 1 / span 2;
  top: 0;
  min-width: 0;
}

.settings-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

:deep(.ui-card.bridge-settings-surface) {
  border-color: var(--bridge-surface-border);
  background: var(--bridge-card-surface);
}

:deep(.ui-card.bridge-settings-surface.ui-card--divided .ui-card__header) {
  border-bottom-color: var(--bridge-surface-border);
}

.bridge-settings-surface :deep(.ui-card__content) {
  gap: var(--space-5);
}

.bridge-settings-surface :deep(.ui-textarea--md) {
  min-height: 72px;
  padding: 8px 10px;
}

.code-textarea {
  min-height: 120px;
  font-family: Consolas, Monaco, "Courier New", monospace;
}

.mapping-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-2);
}

.mapping-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.mapping-mode {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--bridge-surface-border);
  border-radius: var(--radius-md);
  background: var(--bridge-card-surface);
}

.mapping-mode button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.mapping-mode button:hover,
.mapping-mode button.active {
  background: var(--accent-bg);
  color: var(--primary-text);
}

.mapping-mode .material-symbols-outlined {
  font-size: 16px !important;
}

.mapping-table {
  overflow: hidden;
  border: 1px solid var(--bridge-control-border);
  border-radius: var(--radius-md);
  background: var(--bridge-card-surface);
}

.mapping-head,
.mapping-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 48px;
  align-items: center;
  gap: var(--space-2);
  padding: 8px;
}

.mapping-head {
  min-height: 36px;
  border-bottom: 1px solid var(--bridge-surface-border);
  background: var(--bridge-muted-surface);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
}

.mapping-row + .mapping-row {
  border-top: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
}

.mapping-empty {
  display: flex;
  min-height: 96px;
  align-items: center;
  justify-content: center;
  padding: 18px 12px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  text-align: center;
}

/* ─── Profiles Section ──────────────────────────────────────────────── */

.profiles-section {
  overflow: hidden;
  border: 1px solid var(--bridge-surface-border);
  border-radius: var(--radius-lg);
  background: var(--bridge-card-surface);
}

.profiles-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  padding: 14px 16px;
  border-bottom: 1px solid var(--bridge-surface-border);
}

.profiles-title {
  display: flex;
  align-items: center;
  min-width: 0;
}

.profiles-title h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.profiles-title p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.profiles-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.profiles-body {
  display: grid;
  grid-template-columns: minmax(170px, 220px) minmax(0, 1fr);
  min-width: 0;
  gap: var(--space-4);
  padding: 12px 14px 14px;
}

.profiles-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: transparent;
  scrollbar-width: thin;
}

.profiles-list li {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
  min-height: 34px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  border: 0;
  color: var(--secondary-text);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.profiles-list li:hover {
  background: var(--bridge-muted-surface);
  color: var(--primary-text);
}

.profiles-list li.active {
  background: var(--accent-bg);
  color: var(--primary-text);
}

.profile-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--secondary-text) 55%, transparent);
  flex-shrink: 0;
}

.profile-indicator.default {
  background: var(--success-color);
}

.profile-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
}

.profile-meta strong {
  font-size: var(--font-size-helper);
  font-weight: 700;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.profile-meta small {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.35;
}

.profile-default-badge {
  flex-shrink: 0;
  min-height: 20px;
  margin-left: auto;
  padding: 2px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--success-color) 13%, transparent);
  color: var(--success-color);
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1.35;
}

.profile-editor {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4) var(--space-5);
  min-width: 0;
  padding: 0;
}

.profile-editor .config-field {
  min-width: 0;
}

.profile-editor [data-settings-span="full"] {
  grid-column: 1 / -1;
}

.profile-editor :deep(.ui-textarea--md) {
  min-height: 68px;
}

.profile-editor-summary {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 0 0 var(--space-4);
  border-bottom: 1px solid var(--bridge-surface-border);
}

.profile-summary-main {
  min-width: 0;
}

.profile-summary-side {
  display: flex;
  flex-shrink: 0;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 6px;
  max-width: 240px;
}

.profile-editor-summary strong {
  display: block;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
  line-height: 1.4;
}

.profile-editor-summary p {
  margin: 3px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.5;
}

.profile-summary-tags {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  width: 100%;
  margin-bottom: 2px;
}

.profile-summary-tags span {
  min-height: 20px;
  padding: 2px 7px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1.35;
}

.profile-usage-hint {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  gap: 6px;
  min-width: 0;
  margin-top: var(--space-3);
  padding: 5px 8px;
  border-radius: var(--radius-md);
  border: 0;
  background: color-mix(in srgb, var(--primary-text) 2.4%, transparent);
  font-size: var(--font-size-caption);
}

.profile-usage-hint .material-symbols-outlined {
  font-size: 16px !important;
}

.profile-usage-hint code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: Consolas, Monaco, "Courier New", monospace;
  color: var(--highlight-text);
  white-space: nowrap;
}

.profile-danger-zone {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) 0 0;
  border-top: 1px solid color-mix(in srgb, var(--danger-color) 18%, var(--bridge-surface-border));
}

.profile-danger-zone strong {
  display: block;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
  line-height: 1.4;
}

.profile-danger-zone p {
  margin: 2px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.45;
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
  background: var(--overlay-backdrop);
  z-index: 1000;
}

.modal-card {
  background: var(--secondary-bg);
  border: 1px solid var(--bridge-surface-border);
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

/* ─── Preview Card ──────────────────────────────────────────────────── */

.preview-card {
  display: flex;
  height: calc(100vh - 128px);
  min-height: 560px;
  flex-direction: column;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.preview-card header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 0 var(--space-2);
  border-bottom: 0;
  background: transparent;
}

.preview-copy-button {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  width: 28px;
  min-width: 28px;
  height: 28px;
  padding: 0;
  border-radius: var(--radius-sm);
}

.preview-copy-button .material-symbols-outlined {
  font-size: 16px !important;
}

.preview-card header strong {
  display: block;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
  line-height: 1.4;
}

.preview-card header p {
  margin: 2px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.4;
}

.preview-code-shell {
  position: relative;
  flex: 1;
  min-height: 0;
}

.preview-card pre {
  height: 100%;
  margin: 0;
  padding: 12px 44px 12px 12px;
  min-height: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--primary-text);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2.4%, transparent);
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

@media (max-width: 1180px) {
  .bridge-config {
    grid-template-columns: 1fr;
  }

  .bridge-preview-aside {
    position: static;
    grid-column: 1;
    grid-row: auto;
  }

  .preview-card {
    height: auto;
    min-height: 0;
  }

  .preview-card pre {
    max-height: 420px;
  }
}

@media (max-width: 900px) {
  .bridge-header,
  .profiles-header {
    flex-direction: column;
    align-items: stretch;
  }

  .profiles-body {
    grid-template-columns: 1fr;
    padding: 12px;
  }

  .profiles-list {
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: 2px;
  }

  .profiles-list li {
    width: auto;
    min-width: 150px;
  }

  .mapping-head,
  .mapping-row {
    grid-template-columns: 1fr;
  }

  .mapping-head {
    display: none;
  }
}

@media (max-width: 720px) {
  .profile-editor {
    grid-template-columns: 1fr;
  }

  .profile-editor-summary {
    flex-direction: column;
  }

  .profile-summary-side {
    align-items: flex-start;
    max-width: none;
  }

  .profile-summary-tags {
    justify-content: flex-start;
    width: auto;
  }

  .profile-danger-zone {
    flex-direction: column;
    align-items: stretch;
  }
}

@media (max-width: 1280px) {
  .profile-editor {
    grid-template-columns: 1fr;
  }
}
</style>
