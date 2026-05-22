<template>
  <section class="config-section active-section">    <p class="description">在此管理工具调用的审核机制。开启后，特定的工具调用将需要通过管理面板进行人工确认。</p>
    <div class="card">
      <form @submit.prevent="saveConfig">
        <div class="config-item">
          <label class="switch-container">
            <span>是否开启工具调用审核</span>
            <label class="switch">
              <input type="checkbox" v-model="config.enabled">
              <span class="slider"></span>
            </label>
          </label>
        </div>
        <div class="config-item">
          <label class="switch-container">
            <span>是否开启所有工具调用审核</span>
            <label class="switch">
              <input type="checkbox" v-model="config.approveAll">
              <span class="slider"></span>
            </label>
          </label>
          <p class="aa-hint">如果开启，所有工具调用都将进入审核流程，无论是否在名单中。</p>
        </div>
        <div class="config-item">
          <label for="tool-approval-timeout">设置审核最大等待时间 (分钟)</label>
          <input type="number" id="tool-approval-timeout" v-model.number="config.timeoutMinutes" min="1" max="60">
          <p class="aa-hint">超时后，该审核请求将自动拒绝。</p>
        </div>
        <div class="config-item">
          <label for="tool-approval-list">被审核规则名单 (每行一条规则)</label>
          <textarea id="tool-approval-list" v-model="config.approvalListText" rows="8" placeholder="例如：&#10;SciCalculator&#10;PowerShellExecutor:Get-ChildItem&#10;PowerShellExecutor::SilentReject&#10;PowerShellExecutor:Remove-Item::SilentReject"></textarea>
          <p class="aa-hint">支持四种格式：ToolName、ToolName:Command、ToolName::SilentReject、ToolName:Command::SilentReject。带“::SilentReject”的规则在用户拒绝时不会向 AI 返回拒绝提示。</p>
        </div>
        <div class="config-footer">
          <button type="submit" class="btn-primary">保存审核配置</button>
          <span v-if="statusMessage" :class="['status-message', statusType]">{{ statusMessage }}</span>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adminConfigApi } from '@/api'
import type { ToolApprovalConfig } from '@/api/admin-config'
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

async function loadConfig() {
  try {
    const data = await adminConfigApi.getToolApprovalConfig({
      showLoader: false,
      loadingKey: 'tool-approval.config.load'
    })
    config.value = normalizeToolApprovalConfig(data)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Failed to load config:', error)
    showMessage(`加载审核配置失败：${errorMessage}`, 'error')
  }
}

async function saveConfig() {
  try {
    await adminConfigApi.saveToolApprovalConfig({
      enabled: config.value.enabled,
      approveAll: config.value.approveAll,
      timeoutMinutes: config.value.timeoutMinutes,
      approvalList: config.value.approvalListText.split('\n').map(line => line.trim()).filter(Boolean)
    }, {
      loadingKey: 'tool-approval.config.save'
    })
    statusMessage.value = '审核配置已保存！'
    statusType.value = 'success'
    showMessage('审核配置已保存！', 'success')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    statusMessage.value = `保存失败：${errorMessage}`
    statusType.value = 'error'
    showMessage(`保存失败：${errorMessage}`, 'error')
  }
}

onMounted(() => {
  loadConfig()
})
</script>

<style scoped>
.card {
  padding: var(--space-5);
}

.config-item {
  margin-bottom: var(--space-5);
}

.config-item label {
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

.config-footer {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding-top: var(--space-5);
  border-top: 1px solid var(--border-color);
}
</style>
