<template>
  <section class="config-section active-section onering-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton variant="outline" :disabled="loading" @click="loadAll">
          <template #leading><span class="material-symbols-outlined" :class="{ spinning: loading }">sync</span></template>
          刷新
        </UiButton>
        <UiButton variant="primary" :disabled="saving" @click="saveConfig">
          <template #leading><span class="material-symbols-outlined">save</span></template>
          保存配置
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="page-card hero">
      <span class="material-symbols-outlined hero-icon">all_inclusive</span>
      <div>
        <h2>OneRing 管理</h2>
        <p>统一管理跨端连续上下文与 OneRingMemo 短期时间线摘要。摘要通过 <code>[[OneRingMemo::Nova]]</code> 在最终阶段独立注入。</p>
      </div>
    </header>

    <div class="settings-grid">
      <section class="page-card">
        <h3>OneRing 上下文</h3>
        <div class="form-stack">
          <label class="toggle-row">
            <AppCheckbox v-model="draft.enabled" />
            <span><strong>启用 OneRing</strong><small>关闭后不执行 OneRing 主上下文流程；Memo 最终注入仍保持独立。</small></span>
          </label>
          <UiField label="来源标记输出位置">
            <UiSelect v-model="draft.tailTagPlacement">
              <option value="inline">追加到原消息块</option>
              <option value="system_user_block">独立 user 伪系统块</option>
            </UiSelect>
          </UiField>
          <UiField label="最大补充上下文块数">
            <UiInput v-model.number="draft.maxContextBlocks" type="number" min="1" />
          </UiField>
          <label class="toggle-row">
            <AppCheckbox v-model="draft.timeInsert" />
            <span><strong>启用时间线插入</strong><small>按照可信 OneRing 时间戳合并跨端消息。</small></span>
          </label>
          <label class="toggle-row">
            <AppCheckbox v-model="draft.timeInsertPrepend" />
            <span><strong>允许前置补充</strong><small>允许在首个可信 Post 锚点之前补入历史。</small></span>
          </label>
          <label class="toggle-row">
            <AppCheckbox v-model="draft.timeInsertMiddle" />
            <span><strong>允许中段插入</strong><small>允许在两个可信时间锚点之间补入历史。</small></span>
          </label>
          <label class="toggle-row">
            <AppCheckbox v-model="draft.asyncOnlyMode" />
            <span><strong>Only 模式异步持久化</strong><small>Only 请求快速返回，数据库同步在后台完成。</small></span>
          </label>
        </div>
      </section>

      <section class="page-card">
        <h3>OneRingMemo 自动摘要</h3>
        <div class="form-stack">
          <label class="toggle-row">
            <AppCheckbox v-model="draft.memo.enabled" />
            <span><strong>启用 Memo</strong><small>控制摘要生成；无摘要时占位符替换为空文本。</small></span>
          </label>
          <label class="toggle-row">
            <AppCheckbox v-model="draft.memo.autoGenerate" />
            <span><strong>自动生成摘要</strong><small>AI 回复成功写库后，按更新周期异步检查。</small></span>
          </label>
          <UiField label="摘要模型">
            <UiInput v-model="draft.memo.model" placeholder="例如 gpt-4.1-mini" />
          </UiField>
          <div class="field-grid">
            <UiField label="更新周期（分钟）">
              <UiInput v-model.number="draft.memo.updateIntervalMinutes" type="number" min="1" />
            </UiField>
            <UiField label="时间线宽度（1-7 天）">
              <UiInput v-model.number="draft.memo.timelineDays" type="number" min="1" max="7" />
            </UiField>
            <UiField label="不足时补足消息数">
              <UiInput v-model.number="draft.memo.fallbackMessageCount" type="number" min="1" />
            </UiField>
            <UiField label="最大上下文 Tokens">
              <UiInput v-model.number="draft.memo.maxContextTokens" type="number" min="1024" />
            </UiField>
            <UiField label="最大输出 Tokens">
              <UiInput v-model.number="draft.memo.maxOutputTokens" type="number" min="128" />
            </UiField>
          </div>
          <p class="helper">超过最大上下文时会先分段摘要，再递归合并摘要；群聊和跨端消息保留发送者、来源及时间信息。</p>
        </div>
      </section>
    </div>

    <section class="page-card memo-editor">
      <header class="section-header">
        <div>
          <h3>Agent 摘要</h3>
          <p>摘要按 Agent 独立存储。可人工编辑，也可立即调用配置模型重新生成。</p>
        </div>
        <div class="agent-actions">
          <UiSelect v-model="selectedAgent" :disabled="generationStatus?.running">
            <option value="" disabled>选择 Agent</option>
            <option v-for="item in agents" :key="item.agentName" :value="item.agentName">{{ item.agentName }}</option>
          </UiSelect>
          <UiButton variant="outline" :disabled="!selectedAgent || generating" @click="generateMemo">
            <template #leading><span class="material-symbols-outlined" :class="{ spinning: generating }">auto_awesome</span></template>
            {{ generating ? '摘要生成中' : '生成摘要' }}
          </UiButton>
          <UiButton variant="primary" :disabled="!selectedAgent || memoSaving || generating" @click="saveMemo">保存摘要</UiButton>
        </div>
      </header>

      <div v-if="selectedAgent" class="memo-body">
        <div v-if="generationStatus?.running" class="generation-progress" role="status" aria-live="polite">
          <div class="generation-progress-title">
            <span class="material-symbols-outlined spinning">progress_activity</span>
            <strong>{{ generationStatus.phaseLabel }}</strong>
          </div>
          <div class="generation-progress-track">
            <span :style="{ width: `${generationProgressPercent}%` }"></span>
          </div>
          <small>
            整个递归任务完成并成功写入前，生成、切换 Agent 和保存摘要均保持锁定。
            <template v-if="generationStatus.total > 0">
              当前阶段 {{ generationStatus.completed }} / {{ generationStatus.total }}
            </template>
          </small>
        </div>
        <div v-else-if="generationStatus?.phase === 'failed'" class="generation-progress failed" role="alert">
          <strong>上次摘要生成失败</strong>
          <small>{{ generationStatus.error || generationStatus.phaseLabel }}</small>
        </div>
        <div class="memo-meta">
          <span>占位符：<code>[[OneRingMemo::{{ selectedAgent }}]]</code></span>
          <span>生成时间：{{ currentMemo?.generatedAt || '-' }}</span>
          <span>来源消息：{{ currentMemo?.sourceMessageCount ?? '-' }} 条</span>
          <span>范围：{{ currentMemo?.sourceFirstTimestamp || '-' }} → {{ currentMemo?.sourceLastTimestamp || '-' }}</span>
        </div>
        <UiTextarea v-model="memoDraft" rows="18" :disabled="generating" placeholder="当前 Agent 尚无摘要。可人工填写或点击生成摘要。" />
      </div>
      <div v-else class="empty-state">尚无 OneRing Agent 数据，或请选择一个 Agent。</div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { systemApi } from '@/api'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiField from '@/components/ui/UiField.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
import type { OneRingConfig, OneRingMemoAgent, OneRingMemoGenerationStatus } from '@/types/api.system'
import { showMessage } from '@/utils'

const defaultConfig: OneRingConfig = {
  enabled: true,
  tailTagPlacement: 'inline',
  maxContextBlocks: 10,
  timeInsert: true,
  timeInsertPrepend: true,
  timeInsertMiddle: true,
  asyncOnlyMode: true,
  memo: {
    enabled: true,
    autoGenerate: false,
    updateIntervalMinutes: 360,
    timelineDays: 3,
    fallbackMessageCount: 30,
    model: '',
    maxContextTokens: 32000,
    maxOutputTokens: 2000,
  },
}

const draft = ref<OneRingConfig>(structuredClone(defaultConfig))
const agents = ref<OneRingMemoAgent[]>([])
const selectedAgent = ref('')
const memoDraft = ref('')
const loading = ref(false)
const saving = ref(false)
const generationStatus = ref<OneRingMemoGenerationStatus | null>(null)
const memoSaving = ref(false)
let generationPollTimer: ReturnType<typeof setTimeout> | null = null
const currentMemo = computed(() => agents.value.find(item => item.agentName === selectedAgent.value)?.memo || null)
const generating = computed(() => Boolean(generationStatus.value?.running))
const generationProgressPercent = computed(() => {
  const status = generationStatus.value
  if (!status?.running || status.total <= 0) return 8
  return Math.min(100, Math.max(8, Math.round((status.completed / status.total) * 100)))
})

watch(selectedAgent, () => {
  memoDraft.value = currentMemo.value?.summary || ''
  generationStatus.value = null
  stopGenerationPolling()
  if (selectedAgent.value) void refreshGenerationStatus(selectedAgent.value, true)
})

function normalizeDraft(): OneRingConfig {
  return {
    ...draft.value,
    enabled: Boolean(draft.value.enabled),
    maxContextBlocks: Math.max(1, Math.floor(Number(draft.value.maxContextBlocks) || 10)),
    timeInsert: Boolean(draft.value.timeInsert),
    timeInsertPrepend: Boolean(draft.value.timeInsertPrepend),
    timeInsertMiddle: Boolean(draft.value.timeInsertMiddle),
    asyncOnlyMode: Boolean(draft.value.asyncOnlyMode),
    memo: {
      ...draft.value.memo,
      enabled: Boolean(draft.value.memo.enabled),
      autoGenerate: Boolean(draft.value.memo.autoGenerate),
      updateIntervalMinutes: Math.max(1, Math.floor(Number(draft.value.memo.updateIntervalMinutes) || 360)),
      timelineDays: Math.min(7, Math.max(1, Math.floor(Number(draft.value.memo.timelineDays) || 3))),
      fallbackMessageCount: Math.max(1, Math.floor(Number(draft.value.memo.fallbackMessageCount) || 30)),
      model: String(draft.value.memo.model || '').trim(),
      maxContextTokens: Math.max(1024, Math.floor(Number(draft.value.memo.maxContextTokens) || 32000)),
      maxOutputTokens: Math.max(128, Math.floor(Number(draft.value.memo.maxOutputTokens) || 2000)),
    },
  }
}

async function loadAll() {
  loading.value = true
  try {
    const [configResponse, memoResponse] = await Promise.all([
      systemApi.getOneRingConfig({}, { showLoader: false }),
      systemApi.listOneRingMemos({}, { showLoader: false }),
    ])
    draft.value = structuredClone(configResponse.config)
    agents.value = memoResponse.agents || []
    if (!selectedAgent.value || !agents.value.some(item => item.agentName === selectedAgent.value)) {
      selectedAgent.value = agents.value[0]?.agentName || ''
    } else {
      memoDraft.value = currentMemo.value?.summary || ''
    }
  } catch (error) {
    showMessage(`加载 OneRing 管理数据失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    loading.value = false
  }
}

async function saveConfig() {
  saving.value = true
  try {
    const response = await systemApi.saveOneRingConfig(normalizeDraft(), {}, { showLoader: false })
    draft.value = structuredClone(response.config)
    showMessage(response.message || 'OneRing 配置已保存', 'success')
  } catch (error) {
    showMessage(`保存配置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    saving.value = false
  }
}

async function saveMemo() {
  if (!selectedAgent.value) return
  memoSaving.value = true
  try {
    const response = await systemApi.saveOneRingMemo(selectedAgent.value, memoDraft.value, {}, { showLoader: false })
    const item = agents.value.find(agent => agent.agentName === selectedAgent.value)
    if (item) item.memo = response.memo
    showMessage(response.message || '摘要已保存', 'success')
  } catch (error) {
    showMessage(`保存摘要失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    memoSaving.value = false
  }
}

function stopGenerationPolling() {
  if (generationPollTimer) {
    clearTimeout(generationPollTimer)
    generationPollTimer = null
  }
}

function scheduleGenerationPoll(agentName: string) {
  stopGenerationPolling()
  generationPollTimer = setTimeout(() => {
    void refreshGenerationStatus(agentName)
  }, 1000)
}

async function refreshGenerationStatus(agentName: string, silent = false) {
  try {
    const response = await systemApi.getOneRingMemoStatus(agentName, {}, {
      showLoader: false,
      suppressErrorMessage: true,
    })
    if (selectedAgent.value !== agentName) return
    const wasRunning = generationStatus.value?.running === true
    generationStatus.value = response.status

    if (response.status.running) {
      scheduleGenerationPoll(agentName)
      return
    }

    stopGenerationPolling()
    if (response.memo) {
      const item = agents.value.find(agent => agent.agentName === agentName)
      if (item) item.memo = response.memo
      memoDraft.value = response.memo.summary || ''
    }
    if (wasRunning && response.status.phase === 'completed') {
      showMessage('OneRingMemo 全部分段摘要、递归合并与写入均已完成', 'success')
    } else if (wasRunning && response.status.phase === 'failed') {
      showMessage(`摘要生成失败：${response.status.error || '未知错误'}`, 'error')
    }
  } catch (error) {
    if (!silent && selectedAgent.value === agentName) {
      // 短暂网络故障不能解除 UI 锁；服务器任务可能仍在执行，继续轮询。
      scheduleGenerationPoll(agentName)
    }
  }
}

async function generateMemo() {
  const agentName = selectedAgent.value
  if (!agentName || generating.value) return
  try {
    await saveConfig()
    const response = await systemApi.generateOneRingMemo(agentName, {}, { showLoader: false })
    generationStatus.value = response.status || null
    showMessage(response.message || '摘要任务已启动', 'success')
    scheduleGenerationPoll(agentName)
  } catch (error) {
    // 409 也可能意味着页面刷新前已有任务在运行，立即读取服务器真相状态。
    await refreshGenerationStatus(agentName, true)
    if (!generationStatus.value?.running) {
      showMessage(`启动摘要失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }
}

onMounted(loadAll)
onUnmounted(stopGenerationPolling)
</script>

<style scoped>
.onering-page { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.page-card { padding: var(--space-4); border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: transparent; }
.hero { display: flex; align-items: center; gap: var(--space-3); }
.hero h2, .page-card h3 { margin: 0; }
.hero p, .section-header p { margin: 5px 0 0; color: var(--secondary-text); }
.hero-icon { font-size: 38px !important; color: var(--highlight-text); }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.form-stack { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
.toggle-row { display: flex; align-items: flex-start; gap: var(--space-2); padding: 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.toggle-row span { display: flex; flex-direction: column; gap: 4px; }
.toggle-row small, .helper, .memo-meta { color: var(--secondary-text); font-size: var(--font-size-helper); }
.section-header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); }
.agent-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.memo-body { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.memo-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.generation-progress { display: flex; flex-direction: column; gap: 9px; padding: 14px; border: 1px solid color-mix(in srgb, var(--highlight-text) 48%, var(--border-color)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--highlight-text) 8%, transparent); }
.generation-progress-title { display: flex; align-items: center; gap: 8px; color: var(--highlight-text); }
.generation-progress-track { height: 8px; overflow: hidden; border-radius: var(--radius-full); background: color-mix(in srgb, var(--secondary-text) 18%, transparent); }
.generation-progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--highlight-text); transition: width 240ms ease; }
.generation-progress small { color: var(--secondary-text); }
.generation-progress.failed { border-color: color-mix(in srgb, var(--danger-text) 55%, var(--border-color)); background: color-mix(in srgb, var(--danger-text) 8%, transparent); }
.generation-progress.failed strong { color: var(--danger-text); }
.empty-state { padding: 48px; text-align: center; color: var(--secondary-text); }
code { color: var(--highlight-text); }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 900px) {
  .settings-grid, .field-grid { grid-template-columns: 1fr; }
  .section-header { flex-direction: column; }
}
</style>