<template>
  <section class="config-section active-section">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiBadge v-if="statusMessage" :variant="statusBadgeVariant()">{{ statusMessage }}</UiBadge>
        <UiButton size="lg" variant="secondary" @click="saveConfig">
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          保存 AgentAssistant 配置
        </UiButton>
      </UiPageActions>
    </Teleport>

    <p class="description">
      这里用于配置 <strong>AgentAssistant</strong> 插件。你可以：
      <br />1）从已注册的 Agent 一键创建助手； <br />2）添加完全自定义的助手；
      <br />3）为每个助手设置模型、性格说明和系统提示词；
      <br />4）调整异步委托模式的最大轮数、总超时和心跳提示词。
      <br />所有修改会自动写入
      <code>Plugin/AgentAssistant/config.json</code> 中，无需手动编辑文本。
    </p>

    <div class="aa-config-container">
      <UiSettingsCard
        class="aa-settings-surface"
        title="全局会话设置"
        description="控制 AgentAssistant 的会话记忆与共享补充提示词。"
        variant="subtle"
      >
        <UiSettingsForm as="div" :columns="2">
          <UiField
            label="每个 Agent 记住的历史轮数"
            description="数值越大，Agent 能记住的上下文越多，但每次调用消耗的 Token 也会增加。"
            for-id="aa-max-history"
          >
            <UiInput
              type="number"
              id="aa-max-history"
              v-model.number="globalConfig.maxHistory"
              min="1"
              max="50"
              step="1"
              placeholder="例如：7"
            />
          </UiField>
          <UiField
            label="上下文保留时间（小时）"
            description="超过这个时间没有对话时，系统会自动清理旧会话，防止记忆无限增长。"
            for-id="aa-context-ttl"
          >
            <UiInput
              type="number"
              id="aa-context-ttl"
              v-model.number="globalConfig.contextTtl"
              min="1"
              max="168"
              step="1"
              placeholder="例如：24"
            />
          </UiField>
          <UiField
            label="所有助手共享的补充系统提示词（可选）"
            description="这里的内容会自动追加到每个助手的系统提示词后面，可用于统一规定整体风格和安全边界。"
            for-id="aa-global-system-prompt"
            data-settings-span="full"
          >
          <UiTextarea
            id="aa-global-system-prompt"
            v-model="globalConfig.globalSystemPrompt"
            rows="3"
            placeholder="例如：统一要求所有助手说话更温柔、避免输出敏感内容、统一使用某种语言等。"
          />
          </UiField>
        </UiSettingsForm>
      </UiSettingsCard>

      <UiSettingsCard
        class="aa-delegation-settings aa-settings-surface"
        title="异步委托设置"
        description="当工具调用中传入 task_delegation: true 时，AgentAssistant 会立即返回委托 ID，并在后台按限制循环唤醒目标 Agent 执行任务。"
        variant="subtle"
      >
        <UiSettingsForm as="div" :columns="2">
          <UiField
            label="委托最大对话轮数"
            description="达到上限但没有输出 [[TaskComplete]] 或 [[TaskFailed]] 时，会判定为失败。"
            for-id="aa-delegation-max-rounds"
          >
            <UiInput
              type="number"
              id="aa-delegation-max-rounds"
              v-model.number="globalConfig.delegationMaxRounds"
              min="1"
              max="200"
              step="1"
              placeholder="例如：15"
            />
          </UiField>

          <UiField
            label="委托总超时（毫秒）"
            description="从委托创建开始计算的总运行时间。300000 = 5 分钟，1800000 = 30 分钟。"
            for-id="aa-delegation-timeout"
          >
            <UiInput
              type="number"
              id="aa-delegation-timeout"
              v-model.number="globalConfig.delegationTimeout"
              min="10000"
              step="1000"
              placeholder="例如：300000"
            />
          </UiField>

          <UiField
            label="委托模式系统提示词（可选）"
            description="会拼接到目标 Agent 的系统提示词后面，用于说明异步委托任务规则。请保留 {{TaskPrompt}}。"
            for-id="aa-delegation-system-prompt"
            data-settings-span="full"
          >
          <UiTextarea
            id="aa-delegation-system-prompt"
            v-model="globalConfig.delegationSystemPrompt"
            rows="8"
            placeholder="留空时使用插件内置默认委托提示词。可使用 {{SenderName}} 和 {{TaskPrompt}} 占位符。"
          />
          </UiField>

          <UiField
            label="委托心跳提示词（可选）"
            description="当上一轮没有完成任务时，系统会把这段文字作为下一轮 user 消息发给目标 Agent。"
            for-id="aa-delegation-heartbeat-prompt"
            data-settings-span="full"
          >
          <UiTextarea
            id="aa-delegation-heartbeat-prompt"
            v-model="globalConfig.delegationHeartbeatPrompt"
            rows="4"
            placeholder="留空时使用插件内置默认心跳提示词。"
          />
          </UiField>
        </UiSettingsForm>
      </UiSettingsCard>

      <UiSettingsCard
        class="aa-delegation-tracker aa-settings-surface"
        title="异步委托任务追踪"
        description="这里显示当前运行中的异步委托和最近完成记录。面板每 5 秒自动刷新一次。"
        variant="subtle"
      >
        <template #action>
          <UiButton variant="outline" :loading="delegationLoading" @click="loadDelegations">
            {{ delegationLoading ? "刷新中…" : "刷新任务" }}
          </UiButton>
        </template>

        <UiBadge v-if="delegationStatusMessage" class="aa-delegation-status" variant="info">
          {{ delegationStatusMessage }}
        </UiBadge>

        <div class="aa-delegation-list">
          <h4>运行中任务</h4>
          <UiEmptyState v-if="activeDelegations.length === 0" title="当前没有运行中的异步委托" />
          <div
            v-for="task in activeDelegations"
            :key="task.id"
            class="aa-delegation-card active"
          >
            <div class="aa-delegation-card-header">
              <div>
                <strong>{{ task.agentName || task.agentBaseName || "未知 Agent" }}</strong>
                <span class="aa-delegation-id">{{ task.id }}</span>
              </div>
              <UiBadge :variant="delegationBadgeVariant(task.status)">
                {{ formatDelegationStatus(task.status) }}
              </UiBadge>
            </div>

            <div class="aa-delegation-meta">
              <span>轮数：{{ task.currentRound || 0 }}/{{ task.maxRounds || "-" }}</span>
              <span>运行：{{ formatElapsed(task.elapsedMs) }}</span>
              <span v-if="task.lastHeartbeatDelaySeconds">
                心跳延迟：{{ task.lastHeartbeatDelaySeconds }}s
              </span>
            </div>

            <div class="aa-preview-block">
              <label>初始任务</label>
              <p>{{ task.taskPromptPreview || "无任务预览" }}</p>
            </div>

            <div class="aa-preview-block">
              <label>最近回复预览</label>
              <p>{{ task.lastResponsePreview || "尚未产生回复" }}</p>
            </div>

            <div class="aa-delegation-actions">
              <UiButton
                variant="danger"
                size="sm"
                :disabled="task.cancelRequested || task.status === 'cancelling'"
                @click="cancelDelegation(task.id)"
              >
                {{ task.cancelRequested || task.status === "cancelling" ? "取消中…" : "取消任务" }}
              </UiButton>
            </div>
          </div>
        </div>

        <div class="aa-delegation-list">
          <h4>最近完成 / 失败 / 取消</h4>
          <UiEmptyState v-if="recentDelegations.length === 0" title="暂无最近委托记录" description="服务重启后只会保留新的运行期记录。" />
          <div
            v-for="task in recentDelegations"
            :key="task.id"
            class="aa-delegation-card recent"
          >
            <div class="aa-delegation-card-header">
              <div>
                <strong>{{ task.agentName || task.agentBaseName || "未知 Agent" }}</strong>
                <span class="aa-delegation-id">{{ task.id }}</span>
              </div>
              <UiBadge :variant="delegationBadgeVariant(task.status)">
                {{ formatDelegationStatus(task.status) }}
              </UiBadge>
            </div>

            <div class="aa-delegation-meta">
              <span>轮数：{{ task.currentRound || 0 }}/{{ task.maxRounds || "-" }}</span>
              <span>耗时：{{ formatElapsed(task.elapsedMs) }}</span>
              <span v-if="task.archivePath">归档：{{ task.archivePath }}</span>
            </div>

            <div class="aa-preview-block">
              <label>最终报告预览</label>
              <p>{{ task.finalReportPreview || task.lastResponsePreview || "无预览内容" }}</p>
            </div>
          </div>
        </div>
      </UiSettingsCard>

      <UiSettingsCard
        class="aa-settings-surface"
        title="已配置的 Agent 助手"
        description="从已注册 Agent 创建助手，或添加完全自定义的助手配置。"
        variant="subtle"
      >
        <template #action>
          <div class="aa-agents-actions">
            <UiField label="从已注册 Agent 创建" for-id="aa-existing-agent-select" orientation="horizontal" size="sm">
            <UiSelect
              id="aa-existing-agent-select"
              v-model="selectedExistingAgent"
              size="sm"
            >
              <option value="">选择一个已注册 Agent…</option>
              <option
                v-for="agent in availableAgents"
                :key="agent"
                :value="agent"
              >
                {{ agent }}
              </option>
            </UiSelect>
            </UiField>
            <UiButton
              size="sm"
              @click="addFromExisting"
              :disabled="!selectedExistingAgent"
            >
              添加
            </UiButton>
          <UiButton variant="outline" size="sm" @click="addCustomAgent">
            添加自定义 Agent
          </UiButton>
          </div>
        </template>

      <div id="aa-agent-cards-container" class="aa-agent-cards-container">
        <UiCard
          v-for="(agent, index) in agents"
          :key="agent.localId"
          class="aa-agent-card"
          size="sm"
          variant="flat"
        >
          <div class="aa-agent-card-header">
            <div class="aa-agent-name-row">
              <UiInput
                type="text"
                v-model="agent.name"
                :name="`agent-name-${index}`"
                autocomplete="off"
                size="lg"
                placeholder="助手名称（例如：小娜、ResearchBot）"
              />
              <span class="aa-agent-subtitle">
                在工具调用中使用：agent_name="{{ agent.name }}"
              </span>
              <UiButton variant="danger" size="sm" @click="removeAgent(index)">
                删除
              </UiButton>
            </div>
          </div>

          <div class="aa-agent-card-body">
            <UiSettingsForm as="div" :columns="2" gap="sm">
              <UiField label="模型 ID" description="必须填写一个后端已配置的模型 ID。">
                <UiInput
                  type="text"
                  v-model="agent.model"
                  :name="`agent-model-${index}`"
                  autocomplete="off"
                  placeholder="例如：gemini-2.5-flash-preview-05-20"
                />
              </UiField>

              <UiField label="角色说明">
                <UiTextarea
                  v-model="agent.personality"
                  :name="`agent-personality-${index}`"
                  autocomplete="off"
                  rows="2"
                  size="sm"
                  placeholder="例如：擅长检索与汇总多来源信息的研究助手…"
                />
              </UiField>

            <UiField
              label="系统提示词"
              description="决定这个助手的性格和能力。"
              data-settings-span="full"
            >
              <UiTextarea
                v-model="agent.systemPrompt"
                :name="`agent-system-prompt-${index}`"
                autocomplete="off"
                rows="4"
                placeholder="可以简单写，也可以详细写。可使用 {{MaidName}}、{{Date}}、{{Time}} 等占位符。如果只想引用某个 Agent.txt 的内容，可以直接写 {{Nova}} 这样的占位符。"
              />
            </UiField>

            <div class="aa-advanced-params" data-settings-span="full">
              <UiField
                label="最大输出 Token 数"
                description="控制单次回答的最长长度，一般保持默认即可。"
              >
                <UiInput
                  type="number"
                  v-model.number="agent.maxOutputTokens"
                  :name="`agent-max-output-tokens-${index}`"
                  autocomplete="off"
                  min="1"
                  step="1"
                  placeholder="例如：8000"
                />
              </UiField>

              <UiField label="温度（Temperature）" description="数值越低越稳健严谨，越高则越有创意。">
                <UiInput
                  type="number"
                  v-model.number="agent.temperature"
                  :name="`agent-temperature-${index}`"
                  autocomplete="off"
                  step="0.1"
                  min="0"
                  max="2"
                  placeholder="例如：0.7"
                />
              </UiField>
            </div>
            </UiSettingsForm>
          </div>
        </UiCard>
      </div>
      </UiSettingsCard>

    </div>
  </section>
</template>

<script setup lang="ts">
import { useAgentAssistantConfig } from "@/features/agent-assistant-config/useAgentAssistantConfig";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiSettingsCard from "@/components/ui/UiSettingsCard.vue";
import UiSettingsForm from "@/components/ui/UiSettingsForm.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";

const {
  globalConfig,
  agents,
  availableAgents,
  selectedExistingAgent,
  statusMessage,
  statusType,
  activeDelegations,
  recentDelegations,
  delegationStatusMessage,
  delegationLoading,
  loadDelegations,
  cancelDelegation,
  addFromExisting,
  addCustomAgent,
  removeAgent,
  saveConfig,
} = useAgentAssistantConfig();

function statusBadgeVariant(): "success" | "danger" | "info" {
  if (statusType.value === "success") return "success";
  if (statusType.value === "error") return "danger";
  return "info";
}

function delegationBadgeVariant(status?: string): "success" | "warning" | "danger" | "info" | "outline" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled" || status === "cancelling") return "danger";
  if (status === "waiting") return "warning";
  if (status === "running") return "info";
  return "outline";
}

function formatElapsed(ms?: number): string {
  if (!ms || ms < 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatDelegationStatus(status?: string): string {
  const map: Record<string, string> = {
    running: "运行中",
    waiting: "等待心跳",
    cancelling: "取消中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[status || ""] || status || "未知";
}
</script>

<style scoped>
.aa-config-container {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.aa-settings-surface {
  --aa-surface-border: color-mix(in srgb, var(--border-color) 96%, transparent);
  --aa-card-surface: color-mix(in srgb, var(--primary-text) 1.5%, transparent);
}

.aa-settings-surface,
:deep(.ui-card.aa-settings-surface) {
  border-color: var(--aa-surface-border);
  background: var(--aa-card-surface);
}

.aa-settings-surface :deep(.ui-card__header),
:deep(.ui-card.aa-settings-surface.ui-card--divided .ui-card__header) {
  border-bottom-color: var(--aa-surface-border);
}

.aa-settings-surface :deep(.ui-input),
.aa-settings-surface :deep(.ui-select),
.aa-settings-surface :deep(.ui-textarea) {
  border-color: var(--aa-surface-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 42%, transparent);
}

.aa-delegation-settings {
  border-left: 1px solid color-mix(in srgb, var(--highlight-text) 36%, var(--border-color));
}

.aa-delegation-tracker {
  border-left: 1px solid color-mix(in srgb, var(--warning-color) 42%, var(--border-color));
}

.aa-delegation-status {
  margin-bottom: var(--space-3);
}

.aa-delegation-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.aa-delegation-list h4 {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
}

.aa-delegation-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 84%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.aa-delegation-card.active {
  border-left-color: color-mix(in srgb, var(--highlight-text) 48%, var(--border-color));
}

.aa-delegation-card.recent {
  background: transparent;
}

.aa-delegation-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.aa-delegation-id {
  display: block;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  word-break: break-all;
  margin-top: var(--space-1);
}

.aa-delegation-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.aa-preview-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
}

.aa-preview-block label {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.aa-preview-block p {
  margin: 0;
  color: var(--secondary-text);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.aa-delegation-actions {
  display: flex;
  justify-content: flex-end;
}

.aa-agents-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.aa-agent-cards-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--space-3);
  max-width: 100%;
  overflow: visible;
}

.aa-agent-card {
  box-sizing: border-box;
  max-width: 100%;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--border-color) 84%, transparent);
}

.aa-agent-card-header {
  margin-bottom: var(--space-3);
}

.aa-agent-name-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.aa-agent-subtitle {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  word-break: break-word;
}

.aa-agent-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.aa-advanced-params {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  width: 100%;
}

@media (max-width: 768px) {
  .aa-advanced-params {
    grid-template-columns: 1fr;
  }

  .aa-agent-cards-container {
    grid-template-columns: 1fr;
  }
}

</style>
