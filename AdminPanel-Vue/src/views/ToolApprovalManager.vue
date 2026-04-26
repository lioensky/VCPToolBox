<template>
  <section class="config-section active-section tool-approval-page">
    <p class="description">在此管理工具调用的审核机制。开启后，特定的工具调用将需要通过管理面板进行人工确认。</p>

    <div class="card tool-approval-toolbar" :class="{ 'is-dirty': isDirty }">
      <div class="toolbar-meta">
        <span class="dirty-badge" :class="{ 'dirty-badge--active': isDirty }">
          {{ isDirty ? '配置已修改' : '暂无改动' }}
        </span>
        <span v-if="statusMessage" :class="['status-message', statusType]">{{ statusMessage }}</span>
      </div>
      <button type="button" class="btn-primary" :disabled="saving || !isDirty" @click="saveConfig">
        <span class="material-symbols-outlined" :class="{ spinning: saving }">{{ saving ? 'sync' : 'save' }}</span>
        <span>{{ saving ? '保存中…' : '保存审核配置' }}</span>
      </button>
    </div>

    <div class="card">
      <form @submit.prevent="saveConfig">
        <div class="config-item">
          <AppSwitch v-model="config.enabled" :disabled="saving" label="是否开启工具调用审核" />
        </div>
        <div class="config-item">
          <AppSwitch v-model="config.approveAll" :disabled="saving" label="是否开启所有工具调用审核" />
          <p class="aa-hint">如果开启，所有工具调用都将进入审核流程，无论是否在名单中。</p>
        </div>
        <div class="config-item">
          <label for="tool-approval-timeout">设置审核最大等待时间 (分钟)</label>
          <input type="number" id="tool-approval-timeout" v-model.number="config.timeoutMinutes" min="1" max="60" :disabled="saving">
          <p class="aa-hint">超时后，该审核请求将自动拒绝。</p>
        </div>
        <div class="config-item">
          <label for="tool-approval-list">被审核规则名单 (每行一条规则)</label>
          <textarea id="tool-approval-list" v-model="config.approvalListText" rows="8" :disabled="saving" placeholder="例如：&#10;SciCalculator&#10;PowerShellExecutor:Get-ChildItem&#10;PowerShellExecutor::SilentReject&#10;PowerShellExecutor:Remove-Item::SilentReject"></textarea>
          <p class="aa-hint">支持四种格式：ToolName、ToolName:Command、ToolName::SilentReject、ToolName:Command::SilentReject。带“::SilentReject”的规则在用户拒绝时不会向 AI 返回拒绝提示。</p>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { adminConfigApi } from '@/api'
import type { ToolApprovalConfig } from '@/api/admin-config'
import AppSwitch from '@/components/ui/AppSwitch.vue'
import { askConfirm } from '@/platform/feedback/feedbackBus'
import { showMessage } from '@/utils'

interface ToolApprovalFormState {
  enabled: boolean
  approveAll: boolean
  timeoutMinutes: number
  approvalListText: string
}

function createDefaultConfig(): ToolApprovalFormState {
  return {
    enabled: false,
    approveAll: false,
    timeoutMinutes: 5,
    approvalListText: ''
  }
}

function normalizeToolApprovalConfig(data: ToolApprovalConfig): ToolApprovalFormState {
  const approvalList = Array.isArray(data.approvalList)
    ? data.approvalList
    : Array.isArray(data.toolList)
      ? data.toolList
      : []

  return {
    enabled: Boolean(data.enabled),
    approveAll: Boolean(data.approveAll),
    timeoutMinutes: data.timeoutMinutes ?? data.timeout ?? 5,
    approvalListText: approvalList.join('\n')
  }
}

const config = ref<ToolApprovalFormState>(createDefaultConfig())
const statusMessage = ref('')
const statusType = ref<'info' | 'success' | 'error'>('info')
const saving = ref(false)
const initialSignature = ref('')

function buildPayload(state: ToolApprovalFormState) {
  return {
    enabled: state.enabled,
    approveAll: state.approveAll,
    timeoutMinutes: state.timeoutMinutes,
    approvalList: state.approvalListText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  }
}

function buildConfigSignature(state: ToolApprovalFormState): string {
  return JSON.stringify(buildPayload(state))
}

const isDirty = computed(() => {
  return buildConfigSignature(config.value) !== initialSignature.value
})

async function loadConfig() {
  try {
    const data = await adminConfigApi.getToolApprovalConfig({
      showLoader: false,
      loadingKey: 'tool-approval.config.load'
    })
    config.value = normalizeToolApprovalConfig(data)
    initialSignature.value = buildConfigSignature(config.value)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Failed to load config:', error)
    showMessage(`加载审核配置失败：${errorMessage}`, 'error')
  }
}

async function saveConfig() {
  if (saving.value || !isDirty.value) {
    return
  }

  saving.value = true
  try {
    const payload = buildPayload(config.value)
    await adminConfigApi.saveToolApprovalConfig(payload, {
      loadingKey: 'tool-approval.config.save'
    })
    initialSignature.value = buildConfigSignature(config.value)
    statusMessage.value = '审核配置已保存！'
    statusType.value = 'success'
    showMessage('审核配置已保存！', 'success')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    statusMessage.value = `保存失败：${errorMessage}`
    statusType.value = 'error'
    showMessage(`保存失败：${errorMessage}`, 'error')
  } finally {
    saving.value = false
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey) {
    return
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    if (isEditableTarget(event.target)) {
      return
    }
    event.preventDefault()
    void saveConfig()
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (!isDirty.value) {
    return
  }
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => {
  void loadConfig()
  document.addEventListener('keydown', handleKeydown)
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

onBeforeRouteLeave(async () => {
  if (!isDirty.value) {
    return true
  }

  return await askConfirm({
    message: '审核配置有未保存改动，确定要离开吗？',
    danger: true,
    confirmText: '放弃改动',
  })
})
</script>

<style scoped>
.tool-approval-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tool-approval-toolbar {
  position: sticky;
  top: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
}

.tool-approval-toolbar.is-dirty {
  border-color: color-mix(in srgb, var(--warning-text) 30%, var(--border-color));
}

.toolbar-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.dirty-badge {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--tertiary-bg);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.dirty-badge--active {
  background: var(--warning-bg);
  border-color: var(--warning-border);
  color: var(--warning-text);
}

.card {
  padding: var(--space-5);
}

.config-item {
  margin-bottom: var(--space-5);
}

.config-item > label:not(.switch-row) {
  display: block;
  margin-bottom: var(--space-2);
  font-weight: 500;
}

.config-item input[type="number"] {
  width: 100px;
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
}

.config-item textarea {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-family: 'Consolas', 'Monaco', monospace;
  resize: vertical;
}

.aa-hint {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  margin-top: var(--space-2);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
