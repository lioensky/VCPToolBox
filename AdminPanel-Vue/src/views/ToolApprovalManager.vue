<template>
  <section class="config-section active-section tool-approval-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiDirtyIndicator :dirty="isDirty" label="配置已修改" />
        <UiBadge v-if="!isDirty" variant="outline">暂无改动</UiBadge>
        <UiBadge v-if="statusMessage" :variant="statusBadgeVariant">{{ statusMessage }}</UiBadge>
        <UiButton type="button" :disabled="saving || !isDirty" :loading="saving" @click="saveConfig">
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          {{ saving ? '保存中…' : '保存审核配置' }}
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="tool-approval-intro">
      <h2>工具调用审核</h2>
      <p>管理工具调用进入人工确认流程的条件、等待时间和隐私保护策略。</p>
    </header>

    <section class="approval-summary" aria-label="工具调用审核摘要">
      <span class="summary-item">
        <strong>{{ config.enabled ? '已启用' : '未启用' }}</strong>
        <small>审核状态</small>
      </span>
      <span class="summary-item">
        <strong>{{ config.approveAll ? '全部工具' : '规则命中' }}</strong>
        <small>审核范围</small>
      </span>
      <span class="summary-item">
        <strong>{{ config.timeoutMinutes }} 分钟</strong>
        <small>最大等待</small>
      </span>
      <span class="summary-item">
        <strong>{{ approvalRuleCount }}</strong>
        <small>规则数量</small>
      </span>
    </section>

    <form class="approval-layout" @submit.prevent="saveConfig">
      <UiSettingsCard
        class="tool-approval-surface"
        title="审核范围"
        description="控制哪些工具调用需要人工确认，以及审核请求的等待时间。"
        variant="subtle"
      >
        <UiSettingsForm as="div" :columns="2" gap="sm">
          <UiSettingsSwitchRow
            v-model="config.enabled"
            :disabled="saving"
            label="启用工具调用审核"
            description="开启后，命中规则的工具调用会进入人工确认流程。"
            data-settings-span="full"
          />
          <UiSettingsSwitchRow
            v-model="config.approveAll"
            :disabled="saving"
            label="审核所有工具调用"
            description="开启后，所有工具调用都会进入审核流程，无论是否在名单中。"
            data-settings-span="full"
          />
          <UiField label="最大等待时间" description="超时后，该审核请求将自动拒绝。" for-id="tool-approval-timeout">
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
        </UiSettingsForm>
      </UiSettingsCard>

      <UiSettingsCard
        class="tool-approval-surface"
        title="匹配与保护"
        description="配置工具名匹配方式，以及结果返回给 AI 前的敏感信息保护。"
        variant="subtle"
      >
        <UiSettingsForm as="div" :columns="1" gap="sm">
          <UiSettingsSwitchRow
            v-model="config.fuzzyToolMatching"
            :disabled="saving"
            label="启用模糊工具匹配"
            description="工具参数值边界除标准「始」「末」外，还会兼容异常标记。"
          />
          <UiSettingsSwitchRow
            v-model="config.privacyProtectionEnabled"
            :disabled="saving"
            label="启用工具调用隐私保护"
            description="开启后，会在工具结果返回给 AI 前保守打码疑似密钥、password、api key、token 等高置信长令牌；不影响工具实际执行与人工审核参数。"
          />
        </UiSettingsForm>
      </UiSettingsCard>

      <UiSettingsCard
        class="tool-approval-surface approval-rules-card"
        title="被审核规则名单"
        description="支持 ToolName、ToolName:Command、ToolName::SilentReject、ToolName:Command::SilentReject。"
        variant="subtle"
      >
        <UiField
          label="规则列表"
          description="每行一条规则。带 ::SilentReject 的规则在用户拒绝时不会向 AI 返回拒绝提示。"
          for-id="tool-approval-list"
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
      </UiSettingsCard>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { adminConfigApi } from '@/api'
import type { ToolApprovalConfig } from '@/api/admin-config'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiDirtyIndicator from '@/components/ui/UiDirtyIndicator.vue'
import UiField from '@/components/ui/UiField.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiSettingsCard from '@/components/ui/UiSettingsCard.vue'
import UiSettingsForm from '@/components/ui/UiSettingsForm.vue'
import UiSettingsSwitchRow from '@/components/ui/UiSettingsSwitchRow.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
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

const approvalRuleCount = computed(() => {
  return buildPayload(config.value).approvalList.length
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

.tool-approval-intro {
  display: grid;
  gap: var(--space-1);
}

.tool-approval-intro h2 {
  margin: 0;
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.tool-approval-intro p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.approval-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.summary-item {
  display: grid;
  gap: 2px;
  min-height: 52px;
  justify-content: start;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 90%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.summary-item strong {
  color: var(--primary-text);
  font-size: var(--font-size-emphasis);
  line-height: 1.15;
}

.summary-item small {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.approval-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.86fr);
  gap: var(--space-4);
}

.tool-approval-surface {
  --tool-approval-surface-border: color-mix(in srgb, var(--border-color) 94%, transparent);
  --tool-approval-card-surface: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.tool-approval-surface,
:deep(.ui-card.tool-approval-surface) {
  border-color: var(--tool-approval-surface-border);
  background: var(--tool-approval-card-surface);
}

.tool-approval-surface :deep(.ui-card__header),
:deep(.ui-card.tool-approval-surface.ui-card--divided .ui-card__header) {
  border-bottom-color: var(--tool-approval-surface-border);
}

.tool-approval-surface :deep(.ui-input),
.tool-approval-surface :deep(.ui-textarea) {
  border-color: color-mix(in srgb, var(--border-color) 90%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.timeout-input {
  max-width: 120px;
}

.approval-rules-card {
  grid-column: 1 / -1;
}

.approval-list-textarea {
  font-family: 'Consolas', 'Monaco', monospace;
  line-height: 1.55;
}

@media (max-width: 960px) {
  .approval-summary,
  .approval-layout {
    grid-template-columns: 1fr;
  }
}
</style>
