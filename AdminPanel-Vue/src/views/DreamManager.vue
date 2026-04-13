<template>
  <section class="config-section active-section">
    <p class="description">在梦境操作触及日记文件前进行审核。</p>
    <div id="dream-manager-content">
      <p v-if="listState.status === 'loading'" class="dream-placeholder">
        加载中…
      </p>
      <p v-else-if="listState.status === 'error'" class="dream-error-message">
        加载失败: {{ listState.message }}
      </p>
      <div
        v-else-if="listState.dreams.length === 0"
        class="dream-empty-state"
      >
        <span class="material-symbols-outlined dream-empty-icon"
          >nights_stay</span
        >
        <p>暂无梦操作日志</p>
        <p class="dream-empty-subtitle">
          当 Agent 发起梦操作后，日志将出现在这里
        </p>
      </div>
      <div
        v-else
        v-for="dream in listState.dreams"
        :key="dream.id"
        class="dream-log-card"
        :class="{ 'has-pending': dream.pendingCount > 0 }"
      >
        <div class="dream-log-header" @click="toggleDreamDetail(dream.id)">
          <div class="dream-log-title">
            <span class="material-symbols-outlined">nights_stay</span>
            <strong>{{ dream.agentName }}</strong>
            <span
              class="dream-badge"
              :class="dream.pendingCount > 0 ? 'pending' : 'done'"
            >
              {{
                dream.pendingCount > 0
                  ? `${dream.pendingCount} 待审批`
                  : "已处理"
              }}
            </span>
          </div>
          <div class="dream-log-meta">
            <span>{{ formatDreamTimestamp(dream.timestamp) }}</span>
            <span>{{ dream.operationCount }} 个操作</span>
          </div>
        </div>

        <div
          v-if="dream.operationSummary.length > 0"
          class="dream-log-ops-summary"
        >
          <span
            v-for="(operation, index) in dream.operationSummary"
            :key="`${dream.id}:${index}`"
            class="dream-op-chip"
            :class="operation.status"
          >
            {{ getOpTypeLabel(operation.type) }} ·
            {{ getStatusLabel(operation.status) }}
          </span>
        </div>

        <div v-if="dream.expanded" class="dream-log-detail">
          <p
            v-if="dream.detailState.status === 'loading'"
            class="dream-placeholder detail"
          >
            加载详情…
          </p>
          <p
            v-else-if="dream.detailState.status === 'error'"
            class="dream-error-message"
          >
            加载失败: {{ dream.detailState.message }}
          </p>
          <template v-else-if="dream.detailState.status === 'loaded'">
            <div
              v-if="dream.detailState.detail.narrativeHtml"
              class="dream-narrative-block"
            >
              <h4>🌙 梦境叙事</h4>
              <div
                class="dream-narrative-text"
                v-html="dream.detailState.detail.narrativeHtml"
              ></div>
            </div>

            <div class="dream-ops-list">
              <div
                v-for="operation in dream.detailState.detail.operations"
                :key="operation.id"
                class="dream-op-card"
                :class="operation.status"
              >
                <div class="dream-op-header">
                  <span class="dream-op-type">
                    {{ operation.typeIcon }} {{ operation.typeLabel }}
                  </span>
                  <span class="dream-op-status" :class="operation.status">
                    {{ operation.statusLabel }}
                  </span>
                </div>

                <div class="dream-op-body">
                  <template v-if="operation.kind === 'merge'">
                    <div class="dream-op-field">
                      <label>源日记 ({{ operation.sourceFiles.length }} 篇)</label>
                      <div class="dream-file-list">
                        <code
                          v-for="file in operation.sourceFiles"
                          :key="`${operation.id}:${file}`"
                          class="dream-file-path"
                        >
                          {{ file }}
                        </code>
                      </div>
                    </div>
                    <div class="dream-op-field">
                      <label>合并后内容</label>
                      <div
                        class="dream-content-preview"
                        v-html="operation.contentHtml"
                      ></div>
                    </div>
                    <details
                      v-if="operation.sourceDetails.length > 0"
                      class="dream-source-details"
                    >
                      <summary>📄 查看源日记原文</summary>
                      <div
                        v-for="source in operation.sourceDetails"
                        :key="`${operation.id}:${source.name}`"
                        class="dream-source-item"
                      >
                        <strong>{{ source.name }}</strong>
                        <div
                          class="dream-content-preview"
                          v-html="source.contentHtml"
                        ></div>
                      </div>
                    </details>
                  </template>

                  <template v-else-if="operation.kind === 'delete'">
                    <div class="dream-op-field">
                      <label>目标日记</label>
                      <code class="dream-file-path">
                        {{ operation.targetFile }}
                      </code>
                    </div>
                    <div class="dream-op-field">
                      <label>删除理由</label>
                      <p>{{ operation.reason }}</p>
                    </div>
                    <details
                      v-if="operation.targetContentHtml"
                      class="dream-source-details"
                    >
                      <summary>📄 查看待删除内容</summary>
                      <div
                        class="dream-content-preview"
                        v-html="operation.targetContentHtml"
                      ></div>
                    </details>
                  </template>

                  <template v-else-if="operation.kind === 'insight'">
                    <div class="dream-op-field">
                      <label>
                        参考日记 ({{ operation.referenceFiles.length }} 篇)
                      </label>
                      <div class="dream-file-list">
                        <code
                          v-for="file in operation.referenceFiles"
                          :key="`${operation.id}:${file}`"
                          class="dream-file-path"
                        >
                          {{ file }}
                        </code>
                      </div>
                    </div>
                    <div class="dream-op-field">
                      <label>梦感悟内容</label>
                      <div
                        class="dream-content-preview"
                        v-html="operation.contentHtml"
                      ></div>
                    </div>
                  </template>

                  <pre v-else class="dream-op-raw">{{ operation.rawJson }}</pre>
                </div>

                <div v-if="operation.isPending" class="dream-op-actions">
                  <button
                    type="button"
                    class="btn-success"
                    @click.stop="approveOperation(dream.filename, operation.id)"
                  >
                    ✅ 批准执行
                  </button>
                  <button
                    type="button"
                    class="btn-danger"
                    @click.stop="rejectOperation(dream.filename, operation.id)"
                  >
                    ❌ 拒绝
                  </button>
                </div>
                <p v-else-if="operation.reviewedAt" class="dream-reviewed-info">
                  审批时间: {{ formatDreamTimestamp(operation.reviewedAt) }}
                </p>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useMarkdownRenderer } from "@/composables/useMarkdownRenderer";
import {
  dreamApi,
  type DreamLogSummary,
  type DreamOperationAction,
  type DreamOperationSummary,
  type RawDreamDetail,
  type RawDreamOperation,
} from "@/api";
import { showMessage } from "@/utils";

interface DreamSummaryView {
  id: string;
  filename: string;
  agentName: string;
  timestamp?: string;
  operationCount: number;
  pendingCount: number;
  operationSummary: DreamOperationSummaryView[];
  expanded: boolean;
  detailState: DreamDetailState;
}

interface DreamOperationSummaryView {
  type: string;
  status: string;
}

interface DreamSourceDetailView {
  name: string;
  contentHtml: string;
}

interface DreamOperationBaseView {
  id: string;
  type: string;
  typeLabel: string;
  typeIcon: string;
  status: string;
  statusLabel: string;
  isPending: boolean;
  reviewedAt?: string;
}

interface DreamMergeOperationView extends DreamOperationBaseView {
  kind: "merge";
  sourceFiles: string[];
  contentHtml: string;
  sourceDetails: DreamSourceDetailView[];
}

interface DreamDeleteOperationView extends DreamOperationBaseView {
  kind: "delete";
  targetFile: string;
  reason: string;
  targetContentHtml: string;
}

interface DreamInsightOperationView extends DreamOperationBaseView {
  kind: "insight";
  referenceFiles: string[];
  contentHtml: string;
}

interface DreamUnknownOperationView extends DreamOperationBaseView {
  kind: "unknown";
  rawJson: string;
}

type DreamOperationView =
  | DreamMergeOperationView
  | DreamDeleteOperationView
  | DreamInsightOperationView
  | DreamUnknownOperationView;

interface DreamDetailView {
  narrativeHtml: string;
  operations: DreamOperationView[];
}

type DreamDetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; detail: DreamDetailView };

type DreamListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; dreams: DreamSummaryView[] };

const { renderMarkdownSync, initializeRenderer } = useMarkdownRenderer();

const listState = ref<DreamListState>({ status: "loading" });

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractFileName(fileUrl?: string): string {
  if (!fileUrl) {
    return "(未知)";
  }

  const parts = fileUrl.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || fileUrl;
}

function formatDreamTimestamp(timestamp?: string): string {
  if (!timestamp) {
    return "未知时间";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }

  return date.toLocaleString("zh-CN");
}

function getOpTypeLabel(type?: string): string {
  switch (type) {
    case "merge":
      return "合并";
    case "delete":
      return "删除";
    case "insight":
      return "感悟";
    default:
      return type || "未知";
  }
}

function getOpTypeIcon(type?: string): string {
  switch (type) {
    case "merge":
      return "🔀";
    case "delete":
      return "🗑️";
    case "insight":
      return "💡";
    default:
      return "❓";
  }
}

function getStatusLabel(status?: string): string {
  switch (status) {
    case "pending_review":
      return "待审批";
    case "approved":
      return "已批准";
    case "rejected":
      return "已拒绝";
    case "error":
      return "执行出错";
    default:
      return status || "未知";
  }
}

function toOperationSummaryView(
  operation: DreamOperationSummary
): DreamOperationSummaryView {
  return {
    type: operation.type || "unknown",
    status: operation.status || "unknown",
  };
}

function toDreamSummaryView(summary: DreamLogSummary): DreamSummaryView {
  return {
    id: summary.filename,
    filename: summary.filename,
    agentName: summary.agentName || "未知",
    timestamp: summary.timestamp,
    operationCount: summary.operationCount ?? 0,
    pendingCount: summary.pendingCount ?? 0,
    operationSummary: Array.isArray(summary.operationSummary)
      ? summary.operationSummary.map(toOperationSummaryView)
      : [],
    expanded: false,
    detailState: { status: "idle" },
  };
}

function createOperationBaseView(
  operation: RawDreamOperation,
  index: number
): DreamOperationBaseView {
  const type = operation.type || "unknown";
  const status = operation.status || "unknown";

  return {
    id: String(operation.operationId ?? operation.id ?? index),
    type,
    typeLabel: getOpTypeLabel(type),
    typeIcon: getOpTypeIcon(type),
    status,
    statusLabel: getStatusLabel(status),
    isPending: status === "pending_review",
    reviewedAt: operation.reviewedAt,
  };
}

function toDreamOperationView(
  operation: RawDreamOperation,
  index: number
): DreamOperationView {
  const base = createOperationBaseView(operation, index);

  switch (base.type) {
    case "merge":
      return {
        ...base,
        kind: "merge",
        sourceFiles: (operation.sourceDiaries || []).map(extractFileName),
        contentHtml: renderMarkdownSync(operation.newContent || "(空)"),
        sourceDetails: Object.entries(operation.sourceContents || {}).map(
          ([url, content]) => ({
            name: extractFileName(url),
            contentHtml: renderMarkdownSync(content || ""),
          })
        ),
      };
    case "delete":
      return {
        ...base,
        kind: "delete",
        targetFile: extractFileName(operation.targetDiary),
        reason: operation.reason || "(无)",
        targetContentHtml: operation.targetContent
          ? renderMarkdownSync(operation.targetContent)
          : "",
      };
    case "insight":
      return {
        ...base,
        kind: "insight",
        referenceFiles: (operation.referenceDiaries || []).map(extractFileName),
        contentHtml: renderMarkdownSync(operation.insightContent || "(空)"),
      };
    default:
      return {
        ...base,
        kind: "unknown",
        rawJson: JSON.stringify(operation, null, 2),
      };
  }
}

function toDreamDetailView(detail: RawDreamDetail): DreamDetailView {
  return {
    narrativeHtml: detail.dreamNarrative
      ? renderMarkdownSync(detail.dreamNarrative)
      : "",
    operations: Array.isArray(detail.operations)
      ? detail.operations.map(toDreamOperationView)
      : [],
  };
}

function getLoadedDreams(): DreamSummaryView[] | null {
  if (listState.value.status !== "loaded") {
    return null;
  }

  return listState.value.dreams;
}

async function loadDreams(): Promise<void> {
  listState.value = { status: "loading" };

  try {
    const summaries = await dreamApi.getDreamLogSummaries();
    const dreams = summaries
      .map(toDreamSummaryView)
      .sort((left, right) => {
        const leftTime = left.timestamp ? new Date(left.timestamp).getTime() : 0;
        const rightTime = right.timestamp
          ? new Date(right.timestamp).getTime()
          : 0;
        return rightTime - leftTime;
      });

    listState.value = {
      status: "loaded",
      dreams,
    };
  } catch (error) {
    listState.value = {
      status: "error",
      message: getErrorMessage(error),
    };
  }
}

async function loadDreamDetail(dream: DreamSummaryView): Promise<void> {
  dream.detailState = { status: "loading" };

  try {
    const [detail] = await Promise.all([
      dreamApi.getDreamLogDetail(dream.filename),
      initializeRenderer(),
    ]);

    dream.detailState = {
      status: "loaded",
      detail: toDreamDetailView(detail),
    };
  } catch (error) {
    dream.detailState = {
      status: "error",
      message: getErrorMessage(error),
    };
  }
}

function toggleDreamDetail(dreamId: string): void {
  const dreams = getLoadedDreams();
  if (!dreams) {
    return;
  }

  const dream = dreams.find((item) => item.id === dreamId);
  if (!dream) {
    return;
  }

  dream.expanded = !dream.expanded;
  if (!dream.expanded) {
    return;
  }

  void loadDreamDetail(dream);
}

async function reviewOperation(
  filename: string,
  operationId: string,
  action: DreamOperationAction
): Promise<void> {
  const actionLabel = action === "approve" ? "批准" : "拒绝";
  const warning =
    action === "approve" ? "批准后将执行实际的文件操作。" : "";

  if (!confirm(`确定${actionLabel}此操作吗？${warning}`)) {
    return;
  }

  try {
    const result = await dreamApi.reviewDreamOperation(
      filename,
      operationId,
      action,
      {
        loadingKey: `dream-manager.operation.${action}`,
      }
    );

    showMessage(result.message || `操作已${actionLabel}`, "success");
    await loadDreams();
  } catch (error) {
    showMessage(`${actionLabel}失败: ${getErrorMessage(error)}`, "error");
  }
}

async function approveOperation(
  filename: string,
  operationId: string
): Promise<void> {
  await reviewOperation(filename, operationId, "approve");
}

async function rejectOperation(
  filename: string,
  operationId: string
): Promise<void> {
  await reviewOperation(filename, operationId, "reject");
}

onMounted(async () => {
  // 初始化 Markdown 渲染引擎
  await initializeRenderer();
  void loadDreams();
});
</script>

<style scoped>
.dream-placeholder,
.dream-error-message {
  padding: var(--space-4) 0;
}

.dream-placeholder {
  opacity: 0.6;
}

.dream-placeholder.detail {
  padding: var(--space-2) 0;
}

.dream-error-message {
  color: var(--danger-color);
}

.dream-empty-state {
  text-align: center;
  padding: var(--space-8) var(--space-5);
  opacity: 0.7;
}

.dream-empty-icon {
  display: block;
  font-size: var(--font-size-icon-empty-lg);
  opacity: 0.3;
  margin-bottom: var(--space-3);
}

.dream-empty-subtitle {
  font-size: var(--font-size-helper);
  opacity: 0.7;
}

.dream-log-card {
  border: 1px solid var(--border-color);
  border-top: 2px solid transparent;
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-3);
  overflow: hidden;
  transition: border-color 0.2s ease;
  position: relative;
}

.dream-log-card.has-pending {
  border-top-color: var(--warning-border);
}

.dream-log-card:hover {
  box-shadow: var(--shadow-overlay-soft);
}

.dream-log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  gap: var(--space-3);
  background: var(--tertiary-bg);
}

.dream-log-header:hover {
  background: var(--accent-bg);
}

.dream-log-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-body);
}

.dream-log-meta {
  display: flex;
  gap: var(--space-4);
  font-size: var(--font-size-helper);
  opacity: 0.6;
  flex-shrink: 0;
}

.dream-badge {
  font-size: var(--font-size-helper);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  font-weight: 600;
}

.dream-badge.pending {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.dream-badge.done {
  background: var(--success-bg);
  color: var(--success-text);
}

.dream-log-ops-summary {
  padding: 0 var(--space-4) var(--space-2);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.dream-op-chip {
  font-size: var(--font-size-helper);
  padding: 2px var(--space-2);
  border-radius: 4px;
  background: var(--tertiary-bg);
}

.dream-op-chip.pending_review {
  color: var(--warning-text);
}

.dream-op-chip.approved {
  color: var(--success-text);
}

.dream-op-chip.rejected {
  color: var(--danger-text);
}

.dream-op-chip.error {
  color: var(--danger-text);
}

.dream-log-detail {
  padding: 0 var(--space-4) var(--space-4);
  border-top: 1px solid var(--border-color);
}

.dream-narrative-block {
  background: var(--secondary-bg);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-4);
}

.dream-narrative-block h4 {
  margin: 0 0 var(--space-2);
}

.dream-narrative-text {
  white-space: normal;
  font-size: var(--font-size-body);
  line-height: 1.6;
  max-height: 300px;
  overflow-y: auto;
}

.dream-op-card {
  border: 1px solid var(--border-color);
  border-top: 2px solid transparent;
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-2);
  overflow: hidden;
  position: relative;
}

.dream-op-card.approved {
  border-top-color: var(--success-border);
}

.dream-op-card.rejected {
  opacity: 0.7;
  border-top-color: var(--danger-border);
}

.dream-op-card.error {
  border-top-color: var(--danger-border);
}

.dream-op-card.pending_review {
  border-top-color: var(--warning-border);
}

.dream-op-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  background: var(--tertiary-bg);
}

.dream-op-type {
  font-weight: 600;
  font-size: var(--font-size-body);
}

.dream-op-status {
  font-size: var(--font-size-caption);
  padding: 2px var(--space-2);
  border-radius: 4px;
}

.dream-op-status.pending_review {
  color: var(--warning-text);
}

.dream-op-status.approved {
  color: var(--success-text);
}

.dream-op-status.rejected {
  color: var(--danger-text);
}

.dream-op-status.error {
  color: var(--danger-text);
}

.dream-op-body {
  padding: var(--space-2) var(--space-3);
}

.dream-op-field {
  margin-bottom: var(--space-2);
}

.dream-op-field label {
  font-size: var(--font-size-caption);
  opacity: 0.6;
  display: block;
  margin-bottom: var(--space-1);
}

.dream-file-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.dream-file-path {
  font-size: var(--font-size-helper);
  background: var(--tertiary-bg);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: "Consolas", "Monaco", monospace;
}

.dream-content-preview {
  background: var(--surface-overlay-strong);
  padding: var(--space-2);
  border-radius: 4px;
  font-size: var(--font-size-helper);
  word-break: break-word;
  max-height: 250px;
  overflow-y: auto;
  margin: var(--space-1) 0;
}

.dream-source-details {
  margin-top: var(--space-2);
}

.dream-source-details summary {
  cursor: pointer;
  font-size: var(--font-size-helper);
  opacity: 0.7;
}

.dream-source-item {
  margin-top: 6px;
}

.dream-op-raw {
  margin: 0;
  font-size: var(--font-size-helper);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.dream-op-actions {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-color);
}

.dream-reviewed-info {
  font-size: var(--font-size-caption);
  opacity: 0.5;
  padding: var(--space-2) var(--space-3);
}

.dream-content-preview :deep(p),
.dream-narrative-text :deep(p) {
  margin: 0 0 0.75em;
}

.dream-content-preview :deep(p:last-child),
.dream-narrative-text :deep(p:last-child) {
  margin-bottom: 0;
}

.dream-content-preview :deep(pre),
.dream-narrative-text :deep(pre) {
  white-space: pre-wrap;
  word-break: break-word;
}

.dream-content-preview :deep(code),
.dream-narrative-text :deep(code) {
  font-family: "Consolas", "Monaco", monospace;
}

.dream-content-preview :deep(ul),
.dream-content-preview :deep(ol),
.dream-narrative-text :deep(ul),
.dream-narrative-text :deep(ol) {
  margin: 0 0 0.75em;
  padding-left: 1.25rem;
}

@media (max-width: 720px) {
  .dream-log-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .dream-log-meta {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
  }

  .dream-op-header {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-2);
  }

  .dream-op-actions {
    flex-direction: column;
  }
}
</style>
