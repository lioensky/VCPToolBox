<template>
  <section class="config-section active-section tool-approval-page">
    <p class="description">在此管理工具调用的审核机制。开启后，特定的工具调用将需要通过管理面板进行人工确认。</p>

    <UiToolbar class="tool-approval-toolbar" :class="{ 'is-dirty': isDirty }">
      <template #default>
        <UiDirtyIndicator :dirty="isDirty" label="配置已修改" />
        <UiBadge v-if="!isDirty" variant="outline">暂无改动</UiBadge>
        <UiBadge v-if="statusMessage" :variant="statusBadgeVariant">{{ statusMessage }}</UiBadge>
      </template>
      <template #actions>
        <UiButton type="button" :disabled="saving || !isDirty" :loading="saving" @click="saveConfig">
          {{ saving ? '保存中…' : '保存审核配置' }}
        </UiButton>
      </template>
    </UiToolbar>

    <UiSettingsCard
      title="审核规则"
      description="控制工具调用进入人工审核的范围、等待时间与隐私保护策略。"
      variant="subtle"
    >
      <form @submit.prevent="saveConfig">
        <UiSettingsGroup inset>
          <div class="config-item">
            <AppSwitch v-model="config.enabled" :disabled="saving" label="是否开启工具调用审核" />
          </div>
          <div class="config-item">
            <AppSwitch v-model="config.approveAll" :disabled="saving" label="是否开启所有工具调用审核" />
          <p class="aa-hint">如果开启，所有工具调用都将进入审核流程，无论是否在名单中。</p>
          </div>
          <div class="config-item">
            <AppSwitch v-model="config.fuzzyToolMatching" :disabled="saving" label="是否开启模糊工具匹配" />
          <p class="aa-hint">开启后，工具参数值边界除标准「始」「末」外，还会兼容「始}、{始」、以及「始`」「始text」「始``」「始%20」等异常标记。</p>
          </div>
          <div class="config-item privacy-protection-item">
            <AppSwitch v-model="config.privacyProtectionEnabled" :disabled="saving" label="是否开启工具调用隐私保护" />
          <p class="aa-hint">默认关闭。开启后，会在工具结果返回给 AI 前保守打码疑似 .env 单行密钥、password、api key、token，以及 sk- 等高置信长令牌；不会影响工具实际执行与人工审核参数。</p>
          </div>
        </UiSettingsGroup>
        <UiSettingsForm as="div" :columns="2" gap="md">
          <UiField label="审核最大等待时间" description="超时后，该审核请求将自动拒绝。" for-id="tool-approval-timeout">
            <UiInput
              id="tool-approval-timeout"
              v-model.number="config.timeoutMinutes"
              class="timeout-input"
              type="number"
              min="1"
              max="60"
              :disabled="saving"
            />
          </UiField>
          <UiField
            label="被审核规则名单"
            description="支持 ToolName、ToolName:Command、ToolName::SilentReject、ToolName:Command::SilentReject。带 ::SilentReject 的规则在用户拒绝时不会向 AI 返回拒绝提示。"
            for-id="tool-approval-list"
            data-settings-span="full"
          >
            <UiTextarea
              id="tool-approval-list"
              v-model="config.approvalListText"
              class="approval-list-textarea"
              rows="8"
              :disabled="saving"
              placeholder="例如：&#10;SciCalculator&#10;PowerShellExecutor:Get-ChildItem&#10;PowerShellExecutor::SilentReject&#10;PowerShellExecutor:Remove-Item::SilentReject"
            />
          </UiField>
        </UiSettingsForm>
      </form>
    </UiSettingsCard>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { adminConfigApi } from '@/api'
import type { ToolApprovalConfig } from '@/api/admin-config'
import AppSwitch from '@/components/ui/AppSwitch.vue'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiDirtyIndicator from '@/components/ui/UiDirtyIndicator.vue'
import UiField from '@/components/ui/UiField.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiSettingsCard from '@/components/ui/UiSettingsCard.vue'
import UiSettingsForm from '@/components/ui/UiSettingsForm.vue'
import UiSettingsGroup from '@/components/ui/UiSettingsGroup.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
import UiToolbar from '@/components/ui/UiToolbar.vue'
import { askConfirm } from '@/platform/feedback/feedbackBus'
import { showMessage } from '@/utils'

interface ToolApprovalFormState {
  enabled: boolean
  approveAll: boolean
  timeoutMinutes: number
  fuzzyToolMatching: boolean
  privacyProtectionEnabled: boolean
  approvalListText: string
}

function createDefaultConfig(): ToolApprovalFormState {
  return {
    enabled: false,
    approveAll: false,
    timeoutMinutes: 5,
    fuzzyToolMatching: false,
    privacyProtectionEnabled: false,
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
    fuzzyToolMatching: Boolean(data.fuzzyToolMatching),
    privacyProtectionEnabled: data.privacyProtection?.enabled === true,
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
    fuzzyToolMatching: state.fuzzyToolMatching,
    privacyProtection: {
      enabled: state.privacyProtectionEnabled
    },
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

const statusBadgeVariant = computed(() => {
  if (statusType.value === 'success') return 'success'
  if (statusType.value === 'error') return 'danger'
  return 'info'
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
  padding: var(--space-3) 0;
  backdrop-filter: blur(8px);
}

.tool-approval-toolbar.is-dirty {
  color: var(--warning-color);
}

.config-item {
  min-width: 0;
}

.config-item + .config-item {
  margin-top: var(--space-3);
}

.timeout-input {
  max-width: 120px;
}

.approval-list-textarea {
  font-family: 'Consolas', 'Monaco', monospace;
}

.aa-hint {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  margin: var(--space-2) 0 0;
}

</style>
