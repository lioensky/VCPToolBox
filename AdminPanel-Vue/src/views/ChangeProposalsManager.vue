<template>
  <section class="config-section active-section change-proposals-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiBadge :variant="config.requireUserApproval ? 'warning' : 'success'">
          {{ config.requireUserApproval ? "用户审批模式" : "自动批准模式" }}
        </UiBadge>
        <UiButton variant="outline" :disabled="loading" @click="refresh">
          刷新
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="change-proposals-intro">
      <h2>文件变更审批</h2>
      <p>查看 DailyNote 产生的文件变更提案、预期内容和执行状态。</p>
    </header>

    <UiSettingsCard
      title="审批策略"
      description="关闭用户审批后，新提案会自动批准并执行，但快照、Diff 和恢复所需记录仍会保存。"
      variant="subtle"
    >
      <UiSettingsSwitchRow
        v-model="config.requireUserApproval"
        :disabled="savingConfig"
        label="需要用户审批"
        description="开启后新文件变更会先保存为待审批提案；关闭后新提案自动批准。"
        @change="saveApprovalConfig"
      />
    </UiSettingsCard>

    <div class="change-proposals-toolbar">
      <UiField label="状态" size="sm">
        <UiSelect v-model="filters.status">
          <option value="all">全部状态</option>
          <option value="pending_approval">待审批</option>
          <option value="applied">已执行</option>
          <option value="rejected">已拒绝</option>
          <option value="failed">执行失败</option>
          <option value="stale">版本已变化</option>
        </UiSelect>
      </UiField>
      <UiField label="来源" size="sm">
        <UiSelect v-model="filters.sourcePlugin">
          <option value="all">全部来源</option>
          <option v-for="plugin in sourcePlugins" :key="plugin" :value="plugin">
            {{ plugin }}
          </option>
        </UiSelect>
      </UiField>
      <UiField label="搜索" size="sm" class="change-proposals-search">
        <UiInput
          v-model.trim="filters.search"
          type="search"
          placeholder="路径、Agent、命令"
        />
      </UiField>
    </div>

    <UiEmptyState
      v-if="!loading && proposals.length === 0"
      title="暂无文件变更提案"
      description="DailyNote 创建或更新日记后，提案会显示在这里。"
    >
      <template #icon>
        <span class="material-symbols-outlined">difference</span>
      </template>
    </UiEmptyState>

    <div v-else class="change-proposals-list">
      <article
        v-for="proposal in proposals"
        :key="proposal.proposalId"
        class="change-proposal-item"
        :class="{ selected: selected?.proposalId === proposal.proposalId }"
      >
        <button
          class="change-proposal-summary"
          type="button"
          @click="selectProposal(proposal)"
        >
          <span class="material-symbols-outlined proposal-icon">
            {{ proposal.operationType === "create" ? "note_add" : "edit_note" }}
          </span>
          <span class="proposal-summary-main">
            <strong>{{ proposal.path }}</strong>
            <small>
              {{ proposal.sourcePlugin }} · {{ proposal.command }} ·
              {{ formatTime(proposal.createdAt) }}
            </small>
          </span>
          <UiBadge :variant="statusVariant(proposal.status)">
            {{ statusLabel(proposal.status) }}
          </UiBadge>
        </button>
      </article>
    </div>

    <UiSettingsCard
      v-if="selected"
      class="proposal-detail"
      :title="selected.path || selected.proposalId"
      :description="detailDescription"
      variant="subtle"
    >
      <div class="proposal-detail-meta">
        <span>状态：{{ statusLabel(selected.status) }}</span>
        <span>新增 {{ selected.diff?.additions || 0 }} 行</span>
        <span>删除 {{ selected.diff?.deletions || 0 }} 行</span>
        <span>编码：{{ selected.encoding || "utf8" }}</span>
        <span>审批来源：{{ approvalSourceLabel }}</span>
      </div>

      <div v-if="selected.snapshotReadError" class="proposal-error">
        快照读取失败：{{ selected.snapshotReadError }}
      </div>

      <div v-else class="proposal-content-grid">
        <section class="proposal-content-pane">
          <h3>原始内容</h3>
          <pre>{{ selected.beforeExists ? selected.beforeContent : "文件不存在" }}</pre>
        </section>
        <section class="proposal-content-pane">
          <h3>预期内容</h3>
          <pre>{{ selected.afterContent || "" }}</pre>
        </section>
      </div>

      <section class="proposal-diff-pane">
        <h3>文本 Diff</h3>
        <pre class="proposal-diff">{{ selected.diff?.unified || "没有可显示的文本差异。" }}</pre>
      </section>

      <div v-if="selected.errorMessage" class="proposal-error">
        {{ selected.errorMessage }}
      </div>
      <div v-if="selected.rejectionReason" class="proposal-error">
        拒绝理由：{{ selected.rejectionReason }}
      </div>

      <div v-if="selected.status === 'pending_approval'" class="proposal-actions">
        <UiButton variant="primary" :disabled="processing" @click="approveSelected">
          批准并执行
        </UiButton>
        <UiButton variant="danger" :disabled="processing" @click="rejectSelected">
          拒绝
        </UiButton>
      </div>
      <div v-else-if="canDeleteSelected" class="proposal-actions">
        <UiButton variant="danger" :disabled="processing" @click="deleteSelected">
          <template #leading>
            <span class="material-symbols-outlined">delete_forever</span>
          </template>
          删除审批记录
        </UiButton>
      </div>
    </UiSettingsCard>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  changeProposalsApi,
  type ChangeProposal,
  type ChangeProposalStatus,
} from "@/api";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiSettingsCard from "@/components/ui/UiSettingsCard.vue";
import UiSettingsSwitchRow from "@/components/ui/UiSettingsSwitchRow.vue";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";

const proposals = ref<ChangeProposal[]>([]);
const selected = ref<ChangeProposal | null>(null);
const loading = ref(false);
const processing = ref(false);
const savingConfig = ref(false);
const config = reactive({ requireUserApproval: true });
const filters = reactive({ status: "all", sourcePlugin: "all", search: "" });

const sourcePlugins = computed(() =>
  [
    ...new Set(
      proposals.value
        .map((proposal) => proposal.sourcePlugin)
        .filter(Boolean) as string[]
    ),
  ].sort()
);

const detailDescription = computed(() => {
  if (!selected.value) return "";
  const source = selected.value.sourcePlugin || "未知来源";
  const operation = selected.value.operationType || "变更";
  const mode =
    selected.value.approvalMode === "auto" ? "系统自动批准" : "用户审批";
  return `${source} · ${operation} · ${mode}`;
});

const approvalSourceLabel = computed(() => {
  if (selected.value?.approvalSource === "system") return "系统自动批准";
  if (selected.value?.approvalSource?.startsWith("user:")) return "用户审批";
  return selected.value?.approvalSource || "未审批";
});

const canDeleteSelected = computed(() =>
  ["applied", "rejected", "failed", "stale"].includes(
    selected.value?.status || ""
  )
);

function statusLabel(status: ChangeProposalStatus): string {
  return (
    {
      pending_approval: "待审批",
      approved: "已批准",
      rejected: "已拒绝",
      applying: "执行中",
      applied: "已执行",
      failed: "执行失败",
      stale: "版本已变化",
    }[status] || status
  );
}

function statusVariant(
  status: ChangeProposalStatus
): "success" | "warning" | "danger" | "info" | "outline" {
  if (status === "applied") return "success";
  if (status === "pending_approval") return "warning";
  if (status === "rejected" || status === "failed" || status === "stale") {
    return "danger";
  }
  if (status === "applying" || status === "approved") return "info";
  return "outline";
}

function formatTime(value?: string): string {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadConfig(): Promise<void> {
  const next = await changeProposalsApi.getConfig();
  config.requireUserApproval = next.requireUserApproval !== false;
}

async function loadProposals(): Promise<void> {
  loading.value = true;
  try {
    proposals.value = await changeProposalsApi.list(filters);
    if (selected.value) {
      const refreshed = proposals.value.find(
        (proposal) => proposal.proposalId === selected.value?.proposalId
      );
      if (refreshed) {
        await selectProposal(refreshed, false, false);
      } else {
        selected.value = null;
      }
    }
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  try {
    await Promise.all([loadConfig(), loadProposals()]);
  } catch (error) {
    showMessage(`加载文件变更审批数据失败：${errorMessage(error)}`, "error");
  }
}

async function selectProposal(
  proposal: ChangeProposal,
  showLoader = true,
  toggle = true
): Promise<void> {
  if (toggle && selected.value?.proposalId === proposal.proposalId) {
    selected.value = null;
    return;
  }
  selected.value = await changeProposalsApi.get(
    proposal.proposalId,
    showLoader ? {} : { showLoader: false }
  );
}

async function saveApprovalConfig(): Promise<void> {
  const nextValue = config.requireUserApproval;
  savingConfig.value = true;
  try {
    const next = await changeProposalsApi.saveConfig(
      { requireUserApproval: nextValue },
      { loadingKey: "change-proposals.config" }
    );
    config.requireUserApproval = next.requireUserApproval !== false;
    showMessage("文件变更审批配置已保存", "success");
  } catch (error) {
    config.requireUserApproval = !nextValue;
    showMessage(`保存审批配置失败：${errorMessage(error)}`, "error");
  } finally {
    savingConfig.value = false;
  }
}

async function approveSelected(): Promise<void> {
  if (
    !selected.value ||
    !(await askConfirm({
      message: "确定批准并执行此文件变更吗？",
      confirmText: "批准并执行",
      danger: true,
    }))
  ) {
    return;
  }

  processing.value = true;
  try {
    await changeProposalsApi.approve(selected.value.proposalId, {
      loadingKey: "change-proposals.approve",
    });
    showMessage("文件变更已批准并执行", "success");
    await refresh();
  } catch (error) {
    showMessage(`批准失败：${errorMessage(error)}`, "error");
  } finally {
    processing.value = false;
  }
}

async function rejectSelected(): Promise<void> {
  if (!selected.value) return;
  const reason = window.prompt("请输入拒绝理由（可选）：") || "";
  processing.value = true;
  try {
    await changeProposalsApi.reject(selected.value.proposalId, reason, {
      loadingKey: "change-proposals.reject",
    });
    showMessage("文件变更提案已拒绝", "success");
    await refresh();
  } catch (error) {
    showMessage(`拒绝失败：${errorMessage(error)}`, "error");
  } finally {
    processing.value = false;
  }
}

async function deleteSelected(): Promise<void> {
  if (
    !selected.value ||
    !canDeleteSelected.value ||
    !(await askConfirm({
      title: "删除审批记录",
      message:
        "确定删除这条审批记录及其快照吗？删除后无法恢复，但不会影响已经落盘的文件。",
      confirmText: "删除记录",
      danger: true,
    }))
  ) {
    return;
  }

  const proposalId = selected.value.proposalId;
  processing.value = true;
  try {
    await changeProposalsApi.delete(proposalId, {
      loadingKey: "change-proposals.delete",
    });
    selected.value = null;
    showMessage("审批记录及其快照已删除", "success");
    await refresh();
  } catch (error) {
    showMessage(`删除审批记录失败：${errorMessage(error)}`, "error");
  } finally {
    processing.value = false;
  }
}

watch(
  () => [filters.status, filters.sourcePlugin, filters.search],
  () => void loadProposals()
);

onMounted(() => void refresh());
</script>

<style scoped>
.change-proposals-page {
  display: grid;
  gap: var(--space-4);
}

.change-proposals-intro h2 {
  margin: 0;
}

.change-proposals-intro p {
  margin: var(--space-1) 0 0;
  color: var(--secondary-text);
}

.change-proposals-toolbar {
  display: grid;
  grid-template-columns: minmax(150px, 0.7fr) minmax(150px, 0.7fr) minmax(240px, 1.6fr);
  gap: var(--space-3);
}

.change-proposals-list {
  display: grid;
  gap: 6px;
}

.change-proposal-item {
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.change-proposal-item.selected {
  border-color: var(--accent-color);
}

.change-proposal-summary {
  display: grid;
  width: 100%;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3);
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.proposal-icon {
  color: var(--accent-color);
}

.proposal-summary-main {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.proposal-summary-main strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.proposal-summary-main small {
  color: var(--secondary-text);
}

.proposal-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.proposal-diff {
  max-height: 520px;
  overflow: auto;
  margin: var(--space-3) 0 0;
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  background: #101318;
  color: #e6edf3;
  font: 12px/1.55 "Consolas", "Cascadia Mono", monospace;
  white-space: pre;
}

.proposal-content-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.proposal-content-pane,
.proposal-diff-pane {
  min-width: 0;
}

.proposal-content-pane h3,
.proposal-diff-pane h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-body);
}

.proposal-content-pane pre {
  max-height: 360px;
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.55 "Consolas", "Cascadia Mono", monospace;
}

.proposal-diff-pane {
  margin-top: var(--space-3);
}

.proposal-error {
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--danger-color);
  background: color-mix(in srgb, var(--danger-color) 10%, transparent);
}

.proposal-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

@media (max-width: 720px) {
  .change-proposals-toolbar {
    grid-template-columns: 1fr;
  }

  .change-proposal-summary {
    grid-template-columns: 28px minmax(0, 1fr);
  }

  .change-proposal-summary :deep(.ui-badge) {
    grid-column: 2;
    justify-self: start;
  }

  .proposal-actions {
    flex-direction: column;
  }

  .proposal-content-grid {
    grid-template-columns: 1fr;
  }
}
</style>
