<template>
  <section class="config-section active-section timeline-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton variant="outline" :disabled="loading" @click="loadAll">
          <template #leading><span class="material-symbols-outlined" :class="{ spinning: loading }">sync</span></template>
          刷新
        </UiButton>
        <UiButton variant="primary" :disabled="savingConfig" @click="saveConfig">
          <template #leading><span class="material-symbols-outlined">save</span></template>
          保存配置
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="page-card hero">
      <span class="material-symbols-outlined hero-icon">timeline</span>
      <div>
        <h2>Agent TimeLine 管理</h2>
        <p>生成并管理按月长期时间线。<code>[[VCPTimeLine::小克]]</code> 永久注入全部月摘要，带参数时可展开语义相关的完整月份。</p>
      </div>
    </header>

    <section class="page-card">
      <header class="section-header">
        <div>
          <h3>模型与检索设置</h3>
          <p>Embedding 完全复用 RAGDiaryPlugin 的净化、加权与缓存管线。</p>
        </div>
      </header>
      <div class="config-grid">
        <label class="toggle-row">
          <AppCheckbox v-model="config.enabled" />
          <span><strong>启用 VCPTimeLine</strong><small>关闭后占位符保持原样，不执行注入。</small></span>
        </label>
        <UiField label="时间线与摘要模型">
          <UiInput v-model="config.model" placeholder="例如 gpt-4.1-mini" />
        </UiField>
        <UiField label="默认最大展开 K">
          <UiInput v-model.number="config.defaultExpandK" type="number" min="1" max="100" />
        </UiField>
        <UiField label="默认最低阈值（0.01-0.99）">
          <UiInput v-model.number="config.defaultThreshold" type="number" min="0.01" max="0.99" step="0.01" />
        </UiField>
        <UiField label="最大上下文 Tokens">
          <UiInput v-model.number="config.maxContextTokens" type="number" min="1024" />
        </UiField>
        <UiField label="最大输出 Tokens">
          <UiInput v-model.number="config.maxOutputTokens" type="number" min="128" />
        </UiField>
        <UiField label="最大并发任务">
          <UiInput v-model.number="config.maxConcurrentTasks" type="number" min="1" max="20" />
        </UiField>
        <UiField label="公共目录前缀（逗号分隔）">
          <UiInput v-model="publicPrefixes" placeholder="公共" />
        </UiField>
        <UiField label="忽略目录（逗号分隔）">
          <UiInput v-model="ignoreFolders" placeholder="node_modules,.git" />
        </UiField>
        <UiField class="wide" label="一句话摘要自定义提示词（留空使用内置提示词）">
          <UiTextarea v-model="config.summaryPrompt" rows="3" />
        </UiField>
      </div>
      <div class="syntax-help">
        <code>[[VCPTimeLine::小克]]</code>
        <code>[[VCPTimeLine::小克:3]]</code>
        <code>[[VCPTimeLine::小克:0.5]]</code>
        <code>[[VCPTimeLine::小克:3:0.5]]</code>
      </div>
    </section>

    <section class="page-card">
      <header class="section-header">
        <div>
          <h3>生成管理器</h3>
          <p>源数据来自角色名前缀目录和公共目录，时间线写入 <code>dailynote/{{ '<Agent>' }}timeline/YYYY-MM.md</code>。</p>
        </div>
        <div class="actions">
          <UiInput v-model.trim="newAgentName" placeholder="输入已有或新 Agent 名" @keyup.enter="selectNewAgent" />
          <UiButton variant="outline" :loading="loadingAgent" :disabled="!newAgentName || loadingAgent" @click="selectNewAgent">
            加载 Agent
          </UiButton>
        </div>
      </header>

      <div class="generator-grid">
        <UiField label="Agent">
          <UiSelect v-model="selectedAgent" :disabled="running">
            <option value="" disabled>选择 Agent</option>
            <option v-for="agent in agents" :key="agent" :value="agent">{{ agent }}</option>
          </UiSelect>
        </UiField>
        <UiField label="起始月份（可选）">
          <UiInput v-model="startMonth" type="month" />
        </UiField>
        <UiField label="结束月份（可选）">
          <UiInput v-model="endMonth" type="month" />
        </UiField>
        <label class="toggle-row compact">
          <AppCheckbox v-model="overwrite" />
          <span><strong>覆盖已有数据</strong><small>生成时间线或摘要时重新处理已存在月份。</small></span>
        </label>
      </div>

      <div v-if="selectedAgent && detail" class="agent-load-result">
        <span class="material-symbols-outlined">folder_open</span>
        <span>
          已加载 <strong>{{ selectedAgent }}</strong>：
          找到 {{ detail.files.length }} 个 Timeline 月份，
          {{ Object.keys(detail.summaries).length }} 条月度摘要。
        </span>
      </div>

            <!-- 关联昵称 -->
      <div v-if="selectedAgent" class="aliases-section">
        <div class="aliases-header">
          <h4>关联昵称（Aliases）</h4>
          <UiButton variant="outline" :disabled="discoveringAliases || running" @click="discoverAliases">
            <template #leading><span class="material-symbols-outlined" :class="{ spinning: discoveringAliases }">search</span></template>
            自动发现
          </UiButton>
        </div>
        <p class="aliases-desc">配置该 Agent 的历史名字，让 TimeLine 生成时也能匹配旧日记签名。</p>
        <div class="aliases-tags">
          <span v-for="(alias, idx) in currentAliases" :key="idx" class="alias-tag">
            {{ alias }}
            <button class="alias-remove" @click="removeAlias(idx)">&times;</button>
          </span>
          <span v-if="!currentAliases.length" class="alias-empty">暂无关联昵称</span>
        </div>
        <div v-if="aliasSuggestions.length" class="aliases-suggestions">
          <small>发现的历史签名：</small>
          <span v-for="s in aliasSuggestions" :key="s" class="alias-suggestion" @click="addAliasSuggestion(s)">+ {{ s }}</span>
        </div>
        <div class="aliases-input-row">
          <UiInput v-model.trim="newAliasInput" placeholder="手动输入别名" @keyup.enter="addManualAlias" />
          <UiButton variant="outline" :disabled="!newAliasInput" @click="addManualAlias">添加</UiButton>
        </div>
      </div>

      <!-- 自定义文件夹 -->
      <div v-if="selectedAgent" class="folders-section">
        <div class="folders-header">
          <h4>自定义文件夹</h4>
          <UiButton variant="outline" :disabled="loadingFolders || running" @click="loadFolders">
            <template #leading><span class="material-symbols-outlined" :class="{ spinning: loadingFolders }">refresh</span></template>
            刷新列表
          </UiButton>
          <UiButton v-if="foldersCustomized" variant="outline" @click="resetFolders">
            恢复默认（前缀模式）
          </UiButton>
        </div>
        <p class="folders-desc">勾选参与 TimeLine 统计的日记文件夹。未手动配置时自动按前缀规则推导。</p>
        <div v-if="foldersList.length" class="folders-list">
          <label v-for="folder in foldersList" :key="folder.name" class="folder-item">
            <AppCheckbox :model-value="folder.included" @update:model-value="toggleFolder(folder.name, $event)" />
            <span>{{ folder.name }}</span>
          </label>
        </div>
        <div v-else class="alias-empty">{{ loadingFolders ? '加载中...' : '暂无文件夹数据，请点击刷新列表' }}</div>
      </div>

      <div class="actions task-actions">
        <UiButton variant="primary" :disabled="!selectedAgent || running" @click="startTimelineGeneration">
          <template #leading><span class="material-symbols-outlined">auto_awesome</span></template>
          主动生成 Timeline
        </UiButton>
        <UiButton variant="secondary" :disabled="!selectedAgent || running" @click="startSummaryGeneration">
          <template #leading><span class="material-symbols-outlined">short_text</span></template>
          主动生成 Timeline 摘要
        </UiButton>
      </div>

      <div v-if="status?.running" class="progress-box">
        <div><span class="material-symbols-outlined spinning">progress_activity</span><strong>{{ status.phaseLabel }}</strong></div>
        <div class="progress-track"><span :style="{ width: `${progressPercent}%` }"></span></div>
        <small>{{ status.completed }} / {{ status.total || '?' }}，任务完成前同一 Agent 保持锁定。</small>
      </div>
      <div v-else-if="status?.phase === 'failed'" class="progress-box failed">
        <strong>上次任务失败</strong><small>{{ status.error }}</small>
      </div>
    </section>

    <section class="page-card editor-card">
      <header class="section-header">
        <div>
          <h3>月度文件与摘要编辑</h3>
          <p>Timeline 文件会被知识库自动建立向量索引；一句话摘要保存在插件 JSON 中。</p>
        </div>
        <UiSelect v-model="selectedMonth" :disabled="running || !selectedAgent">
          <option value="" disabled>选择月份</option>
          <option v-for="month in availableMonths" :key="month" :value="month">{{ month }}</option>
        </UiSelect>
      </header>

      <div v-if="selectedAgent && selectedMonth" class="editors">
        <UiField label="月度一句话摘要">
          <div class="summary-editor">
            <UiTextarea
              v-model="summaryDraft"
              rows="4"
              :disabled="running"
              placeholder="输入该月份的一句话摘要；内容较长时会自动换行。"
            />
            <div class="actions end">
              <UiButton variant="outline" :disabled="running || savingSummary" @click="saveSummary">
                保存摘要
              </UiButton>
            </div>
          </div>
        </UiField>
        <UiField label="完整 Timeline Markdown">
          <UiTextarea v-model="fileDraft" rows="20" :disabled="running" />
        </UiField>
        <div class="actions end">
          <UiButton variant="primary" :disabled="running || savingFile" @click="saveFile">保存 Timeline 文件</UiButton>
        </div>
      </div>
      <div v-else class="empty-state">选择 Agent 和月份后可编辑数据。首次生成前，可输入 Agent 名并启动生成任务。</div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { vcpTimelineApi, type VcpTimelineAgentDetail, type VcpTimelineConfig, type VcpTimelineFolderInfo, type VcpTimelineStatus } from '@/api/vcpTimeline'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiField from '@/components/ui/UiField.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
import { showMessage } from '@/utils'

const defaults: VcpTimelineConfig = {
  enabled: true,
  defaultExpandK: 3,
  defaultThreshold: 0.5,
  model: '',
  maxContextTokens: 60000,
  maxOutputTokens: 4000,
  maxConcurrentTasks: 3,
  publicFolderPrefixes: ['公共'],
  ignoreFolders: ['node_modules', '.git'],
  summaryPrompt: '',
  aliases: {},
  agentFolders: {},
}

const config = ref<VcpTimelineConfig>(structuredClone(defaults))
const publicPrefixes = ref('公共')
const ignoreFolders = ref('node_modules,.git')
const agents = ref<string[]>([])
const selectedAgent = ref('')
const newAgentName = ref('')
const detail = ref<VcpTimelineAgentDetail | null>(null)
const selectedMonth = ref('')
const summaryDraft = ref('')
const fileDraft = ref('')
const startMonth = ref('')
const endMonth = ref('')
const overwrite = ref(false)
const loading = ref(false)
const loadingAgent = ref(false)
const savingConfig = ref(false)
const savingFile = ref(false)
const savingSummary = ref(false)
const status = ref<VcpTimelineStatus | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | null = null

// Aliases state
const currentAliases = ref<string[]>([])
const aliasSuggestions = ref<string[]>([])
const newAliasInput = ref('')
const discoveringAliases = ref(false)

// Folders state
const foldersList = ref<VcpTimelineFolderInfo[]>([])
const loadingFolders = ref(false)
const foldersCustomized = ref(false)


const running = computed(() => Boolean(status.value?.running))
const availableMonths = computed(() => {
  const months = new Set<string>(Object.keys(detail.value?.summaries || {}))
  detail.value?.files.forEach(file => months.add(file.month))
  return [...months].sort()
})
const progressPercent = computed(() => {
  if (!status.value?.running || !status.value.total) return 8
  return Math.max(8, Math.min(100, Math.round(status.value.completed / status.value.total * 100)))
})

watch(selectedAgent, async agentName => {
  stopPolling()
  detail.value = null
  selectedMonth.value = ''
  status.value = null
  currentAliases.value = []
  aliasSuggestions.value = []
  foldersList.value = []
  foldersCustomized.value = false
  if (!agentName) return
  try {
    await loadAgent(agentName)
    currentAliases.value = [...(config.value.aliases?.[agentName] || [])]
    foldersCustomized.value = Array.isArray(config.value.agentFolders?.[agentName]) && config.value.agentFolders[agentName].length > 0
    await loadFolders()
  } catch (error) {
    showMessage(`加载 Agent「${agentName}」失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
})


watch(selectedMonth, month => {
  summaryDraft.value = detail.value?.summaries[month] || ''
  fileDraft.value = detail.value?.files.find(file => file.month === month)?.content || ''
})

function commaList(value: string) {
  return value.split(/[,，]/).map(item => item.trim()).filter(Boolean)
}

function normalizedConfig(): VcpTimelineConfig {
  const aliasesMap: Record<string, string[]> = { ...config.value.aliases }
  if (selectedAgent.value) {
    if (currentAliases.value.length > 0) {
      aliasesMap[selectedAgent.value] = [...currentAliases.value]
    } else {
      delete aliasesMap[selectedAgent.value]
    }
  }

  const agentFoldersMap: Record<string, string[]> = { ...config.value.agentFolders }
  if (selectedAgent.value && foldersCustomized.value) {
    const included = foldersList.value.filter(f => f.included).map(f => f.name)
    if (included.length > 0) {
      agentFoldersMap[selectedAgent.value] = included
    } else {
      delete agentFoldersMap[selectedAgent.value]
    }
  } else if (selectedAgent.value && !foldersCustomized.value) {
    delete agentFoldersMap[selectedAgent.value]
  }

  return {
    ...config.value,
    enabled: Boolean(config.value.enabled),
    defaultExpandK: Math.max(1, Math.floor(Number(config.value.defaultExpandK) || 3)),
    defaultThreshold: Math.min(0.99, Math.max(0.01, Number(config.value.defaultThreshold) || 0.5)),
    maxContextTokens: Math.max(1024, Math.floor(Number(config.value.maxContextTokens) || 60000)),
    maxOutputTokens: Math.max(128, Math.floor(Number(config.value.maxOutputTokens) || 4000)),
    maxConcurrentTasks: Math.min(20, Math.max(1, Math.floor(Number(config.value.maxConcurrentTasks) || 3))),
    publicFolderPrefixes: commaList(publicPrefixes.value),
    ignoreFolders: commaList(ignoreFolders.value),
    model: String(config.value.model || '').trim(),
    summaryPrompt: String(config.value.summaryPrompt || '').trim(),
    aliases: aliasesMap,
    agentFolders: agentFoldersMap,
  }
}

// === Aliases methods ===
async function discoverAliases() {
  if (!selectedAgent.value) return
  discoveringAliases.value = true
  try {
    const response = await vcpTimelineApi.discoverAliases(selectedAgent.value)
    aliasSuggestions.value = response.suggestions.filter(s => !currentAliases.value.includes(s))
    if (!aliasSuggestions.value.length) {
      showMessage('未发现新的历史签名', 'info')
    }
  } catch (error) {
    showMessage(`自动发现失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    discoveringAliases.value = false
  }
}

function addAliasSuggestion(alias: string) {
  if (!currentAliases.value.includes(alias)) {
    currentAliases.value.push(alias)
  }
  aliasSuggestions.value = aliasSuggestions.value.filter(s => s !== alias)
}

function addManualAlias() {
  const val = newAliasInput.value.trim()
  if (val && !currentAliases.value.includes(val)) {
    currentAliases.value.push(val)
  }
  newAliasInput.value = ''
}

function removeAlias(idx: number) {
  currentAliases.value.splice(idx, 1)
}

// === Folders methods ===
async function loadFolders() {
  if (!selectedAgent.value) return
  loadingFolders.value = true
  try {
    const response = await vcpTimelineApi.getAgentFolders(selectedAgent.value)
    foldersList.value = response.folders
  } catch (error) {
    showMessage(`加载文件夹列表失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    loadingFolders.value = false
  }
}

function toggleFolder(name: string, included: boolean) {
  const folder = foldersList.value.find(f => f.name === name)
  if (folder) {
    folder.included = included
    foldersCustomized.value = true
  }
}

function resetFolders() {
  foldersCustomized.value = false
  loadFolders()
}

async function loadAll() {
  loading.value = true
  try {
    const [configResponse, agentResponse] = await Promise.all([
      vcpTimelineApi.getConfig(),
      vcpTimelineApi.listAgents(),
    ])
    config.value = structuredClone(configResponse.config)
    publicPrefixes.value = config.value.publicFolderPrefixes.join(',')
    ignoreFolders.value = config.value.ignoreFolders.join(',')
    agents.value = agentResponse.agents || []
    if (selectedAgent.value) await loadAgent(selectedAgent.value)
    else if (agents.value.length) selectedAgent.value = agents.value[0]
  } catch (error) {
    showMessage(`加载 Agent TimeLine 失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    loading.value = false
  }
}

async function saveConfig() {
  savingConfig.value = true
  try {
    const response = await vcpTimelineApi.saveConfig(normalizedConfig())
    config.value = structuredClone(response.config)
      if (selectedAgent.value) {
        currentAliases.value = [...(config.value.aliases?.[selectedAgent.value] || [])]
        foldersCustomized.value = Array.isArray(config.value.agentFolders?.[selectedAgent.value]) && config.value.agentFolders[selectedAgent.value].length > 0
      }
    showMessage(response.message || '配置已保存', 'success')
  } catch (error) {
    showMessage(`保存配置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    savingConfig.value = false
  }
}

async function loadAgent(agentName: string) {
  loadingAgent.value = true
  try {
    const response = await vcpTimelineApi.getAgent(agentName)
    if (selectedAgent.value !== agentName) return
    detail.value = response.detail
    status.value = response.detail.status
    selectedMonth.value = availableMonths.value[availableMonths.value.length - 1] || ''
    if (status.value.running) schedulePoll(agentName)
  } finally {
    loadingAgent.value = false
  }
}

async function selectNewAgent() {
  const name = newAgentName.value.trim()
  if (!name) return
  if (!agents.value.includes(name)) agents.value.push(name)

  try {
    if (selectedAgent.value === name) {
      // 相同值不会触发 Vue watch，必须显式重新加载。
      await loadAgent(name)
    } else {
      selectedAgent.value = name
    }
    newAgentName.value = ''
  } catch (error) {
    showMessage(`加载 Agent「${name}」失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function schedulePoll(agentName: string) {
  stopPolling()
  pollTimer = setTimeout(() => void pollStatus(agentName), 1000)
}

async function pollStatus(agentName: string) {
  try {
    const response = await vcpTimelineApi.getStatus(agentName, {}, { showLoader: false, suppressErrorMessage: true })
    if (selectedAgent.value !== agentName) return
    const wasRunning = status.value?.running
    status.value = response.status
    if (response.status.running) return schedulePoll(agentName)
    stopPolling()
    if (wasRunning) {
      await loadAgent(agentName)
      showMessage(response.status.phase === 'completed' ? '生成任务已完成' : `生成失败：${response.status.error || '未知错误'}`, response.status.phase === 'completed' ? 'success' : 'error')
    }
  } catch {
    if (selectedAgent.value === agentName) schedulePoll(agentName)
  }
}

async function startTimelineGeneration() {
  if (!selectedAgent.value) return
  try {
    await saveConfig()
    const response = await vcpTimelineApi.generateTimelines(selectedAgent.value, {
      startMonth: startMonth.value || undefined,
      endMonth: endMonth.value || undefined,
      overwrite: overwrite.value,
    })
    status.value = response.status
    schedulePoll(selectedAgent.value)
    showMessage('Timeline 生成任务已启动', 'success')
  } catch (error) {
    showMessage(`启动失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function startSummaryGeneration() {
  if (!selectedAgent.value) return
  try {
    await saveConfig()
    const response = await vcpTimelineApi.generateSummaries(selectedAgent.value, { overwrite: overwrite.value })
    status.value = response.status
    schedulePoll(selectedAgent.value)
    showMessage('Timeline 摘要生成任务已启动', 'success')
  } catch (error) {
    showMessage(`启动失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function saveFile() {
  if (!selectedAgent.value || !selectedMonth.value) return
  savingFile.value = true
  try {
    await vcpTimelineApi.saveFile(selectedAgent.value, selectedMonth.value, fileDraft.value)
    await loadAgent(selectedAgent.value)
    selectedMonth.value = selectedMonth.value
    showMessage('Timeline 文件已保存', 'success')
  } catch (error) {
    showMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    savingFile.value = false
  }
}

async function saveSummary() {
  if (!selectedAgent.value || !selectedMonth.value) return
  savingSummary.value = true
  try {
    const response = await vcpTimelineApi.saveSummary(selectedAgent.value, selectedMonth.value, summaryDraft.value)
    if (detail.value) detail.value.summaries = response.summaries
    showMessage('月度摘要已保存', 'success')
  } catch (error) {
    showMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    savingSummary.value = false
  }
}

onMounted(loadAll)
onUnmounted(stopPolling)
</script>

<style scoped>
.timeline-page { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.page-card { padding: var(--space-4); border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: transparent; }
.hero { display: flex; align-items: center; gap: var(--space-3); }
.hero h2, .page-card h3 { margin: 0; }
.hero p, .section-header p { margin: 5px 0 0; color: var(--secondary-text); }
.hero-icon { font-size: 38px !important; color: var(--highlight-text); }
.section-header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); }
.config-grid, .generator-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin-top: var(--space-4); }
.wide { grid-column: 1 / -1; }
.toggle-row { display: flex; align-items: flex-start; gap: var(--space-2); padding: 10px; border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.toggle-row span { display: flex; flex-direction: column; gap: 4px; }
.toggle-row small, .progress-box small { color: var(--secondary-text); }
.compact { align-self: end; }
.syntax-help, .actions, .save-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.syntax-help { margin-top: var(--space-3); }
.syntax-help code { padding: 5px 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--highlight-text); }
.agent-load-result { display: flex; align-items: center; gap: 8px; margin-top: var(--space-4); padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); color: var(--secondary-text); }
.agent-load-result .material-symbols-outlined, .agent-load-result strong { color: var(--highlight-text); }
.task-actions { margin-top: var(--space-4); }
.progress-box { display: flex; flex-direction: column; gap: 9px; margin-top: var(--space-4); padding: 14px; border: 1px solid color-mix(in srgb, var(--highlight-text) 45%, var(--border-color)); border-radius: var(--radius-md); }
.progress-box > div:first-child { display: flex; align-items: center; gap: 8px; color: var(--highlight-text); }
.progress-box.failed { border-color: var(--danger-border); color: var(--danger-color); }
.progress-track { height: 8px; overflow: hidden; border-radius: var(--radius-full); background: color-mix(in srgb, var(--secondary-text) 18%, transparent); }
.progress-track span { display: block; height: 100%; background: var(--highlight-text); }
.editors { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.summary-editor { display: flex; flex-direction: column; gap: var(--space-2); }
.summary-editor :deep(textarea) { min-height: 96px; white-space: pre-wrap; overflow-wrap: anywhere; resize: vertical; }
.end { justify-content: flex-end; }
.empty-state { padding: 48px; text-align: center; color: var(--secondary-text); }
code { color: var(--highlight-text); }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.aliases-section, .folders-section { margin-top: var(--space-4); padding: var(--space-3); border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.aliases-header, .folders-header { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.aliases-header h4, .folders-header h4 { margin: 0; flex: 1; }
.aliases-desc, .folders-desc { margin: 6px 0 10px; color: var(--secondary-text); font-size: 13px; }
.aliases-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.alias-tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: 1px solid var(--highlight-text); border-radius: var(--radius-full); font-size: 13px; color: var(--highlight-text); }
.alias-remove { background: none; border: none; color: var(--secondary-text); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; }
.alias-remove:hover { color: var(--danger-color); }
.alias-empty { color: var(--secondary-text); font-size: 13px; font-style: italic; }
.aliases-suggestions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 10px; }
.alias-suggestion { padding: 3px 8px; border: 1px dashed var(--highlight-text); border-radius: var(--radius-sm); font-size: 12px; color: var(--highlight-text); cursor: pointer; transition: background 0.15s; }
.alias-suggestion:hover { background: color-mix(in srgb, var(--highlight-text) 15%, transparent); }
.aliases-input-row { display: flex; gap: var(--space-2); align-items: center; }
.aliases-input-row :deep(input) { max-width: 200px; }
.folders-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; max-height: 300px; overflow-y: auto; }
.folder-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); font-size: 13px; }
@media (max-width: 1000px) {
  .config-grid, .generator-grid { grid-template-columns: 1fr; }
  .section-header { flex-direction: column; }
}
</style>