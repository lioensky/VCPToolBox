<template>
  <section class="config-section active-section">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton variant="outline" @click="resetFilters">
          重置筛选
        </UiButton>
        <UiButton
          variant="outline"
          :disabled="isRefreshing"
          @click="refreshDreams"
        >
          刷新
        </UiButton>
        <UiButton
          variant="primary"
          :disabled="visiblePendingCount === 0 || batchProcessing"
          @click="batchReviewVisible('approve')"
        >
          批准当前筛选待审
        </UiButton>
        <UiButton
          variant="danger"
          :disabled="visiblePendingCount === 0 || batchProcessing"
          @click="batchReviewVisible('reject')"
        >
          拒绝当前筛选待审
        </UiButton>
      </UiPageActions>
    </Teleport>

    <p class="description">在梦境操作触及日记文件前进行审核。</p>
    <div id="dream-manager-content">
      <p v-if="listState.status === 'loading'" class="dream-placeholder">
        加载中…
      </p>
      <p v-else-if="listState.status === 'error'" class="dream-error-message">
        加载失败: {{ listState.message }}
      </p>
      <template v-else>
        <div class="dream-workbench">
          <div class="dream-stat-strip">
            <span class="dream-stat">
              <strong>{{ filterStats.total }}</strong>
              梦日志
            </span>
            <span class="dream-stat pending">
              <strong>{{ filterStats.pending }}</strong>
              待审批
            </span>
            <span class="dream-stat">
              <strong>{{ filterStats.error }}</strong>
              出错
            </span>
            <span v-if="isRefreshing" class="dream-refreshing">同步中...</span>
          </div>

          <div class="dream-filter-grid">
            <UiField label="状态" size="sm">
              <UiSelect v-model="filters.status">
                <option value="all">全部状态</option>
                <option value="pending">仅待审批</option>
                <option value="handled">已处理完</option>
                <option value="approved">含已批准</option>
                <option value="rejected">含已拒绝</option>
                <option value="error">含出错</option>
              </UiSelect>
            </UiField>

            <UiField label="Agent" size="sm">
              <UiSelect v-model="filters.agent">
                <option value="all">全部 Agent</option>
                <option
                  v-for="agent in agentOptions"
                  :key="agent"
                  :value="agent"
                >
                  {{ agent }}
                </option>
              </UiSelect>
            </UiField>

            <UiField label="类型" size="sm">
              <UiSelect v-model="filters.type">
                <option value="all">全部类型</option>
                <option value="merge">合并</option>
                <option value="delete">删除</option>
                <option value="insight">感悟</option>
                <option value="unknown">未知</option>
              </UiSelect>
            </UiField>

            <UiField label="搜索" size="sm" class="dream-filter-search">
              <UiInput
                v-model.trim="filters.query"
                type="search"
                placeholder="文件名、Agent、状态"
              />
            </UiField>
          </div>

        </div>

        <UiEmptyState
          v-if="loadedDreams.length === 0"
          title="暂无梦操作日志"
          description="当 Agent 发起梦操作后，日志将出现在这里"
        >
          <template #icon>
            <span class="material-symbols-outlined">nights_stay</span>
          </template>
        </UiEmptyState>
        <UiEmptyState
          v-else-if="visibleDreams.length === 0"
          title="当前筛选没有结果"
          description="换个状态、Agent 或搜索词就能继续找"
        >
          <template #icon>
            <span class="material-symbols-outlined">filter_alt</span>
          </template>
        </UiEmptyState>
      <div
        v-else
          v-for="dream in visibleDreams"
        :key="dream.id"
        class="dream-log-card"
        :class="{ 'has-pending': dream.pendingCount > 0 }"
      >
        <div class="dream-log-header" @click="toggleDreamDetail(dream.id)">
          <div class="dream-log-title">
            <span class="material-symbols-outlined">nights_stay</span>
            <strong>{{ dream.agentName }}</strong>
            <UiBadge :variant="dream.pendingCount > 0 ? 'warning' : 'success'">
              {{
                dream.pendingCount > 0
                  ? `${dream.pendingCount} 待审批`
                  : "已处理"
              }}
            </UiBadge>
          </div>
          <div class="dream-log-meta">
            <span>{{ formatDreamTimestamp(dream.timestamp) }}</span>
            <span>{{ dream.operationCount }} 个操作</span>
          </div>
            <div v-if="dream.pendingCount > 0" class="dream-log-actions">
              <UiButton
                variant="primary"
                size="sm"
                :disabled="batchProcessing"
                @click.stop="batchReviewDream(dream, 'approve')"
              >
                批准本条待审
              </UiButton>
              <UiButton
                variant="danger"
                size="sm"
                :disabled="batchProcessing"
                @click.stop="batchReviewDream(dream, 'reject')"
              >
                拒绝本条待审
              </UiButton>
            </div>
        </div>

        <div
          v-if="dream.operationSummary.length > 0"
          class="dream-log-ops-summary"
        >
          <UiBadge
            v-for="(operation, index) in dream.operationSummary"
            :key="`${dream.id}:${index}`"
            :variant="getStatusBadgeVariant(operation.status)"
          >
            {{ getOpTypeLabel(operation.type) }} ·
            {{ getStatusLabel(operation.status) }}
          </UiBadge>
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

            <div
              v-if="getPendingOperations(dream).length > 0"
              class="dream-detail-toolbar"
            >
              <span>
                本日志还有 {{ getPendingOperations(dream).length }} 个待审操作
              </span>
              <div class="dream-detail-actions">
                <UiButton
                  variant="primary"
                  size="sm"
                  :disabled="batchProcessing"
                  @click.stop="batchReviewDream(dream, 'approve')"
                >
                  全部批准
                </UiButton>
                <UiButton
                  variant="danger"
                  size="sm"
                  :disabled="batchProcessing"
                  @click.stop="batchReviewDream(dream, 'reject')"
                >
                  全部拒绝
                </UiButton>
              </div>
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
                  <UiBadge :variant="getStatusBadgeVariant(operation.status)">
                    {{ operation.statusLabel }}
                  </UiBadge>
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
                  <UiButton
                    variant="primary"
                    size="sm"
                    :disabled="isOperationProcessing(dream.filename, operation.id)"
                    @click.stop="approveOperation(dream.filename, operation.id)"
                  >
                    批准执行
                  </UiButton>
                  <UiButton
                    variant="danger"
                    size="sm"
                    :disabled="isOperationProcessing(dream.filename, operation.id)"
                    @click.stop="rejectOperation(dream.filename, operation.id)"
                  >
                    拒绝
                  </UiButton>
                </div>
                <p v-else-if="operation.reviewedAt" class="dream-reviewed-info">
                  审批时间: {{ formatDreamTimestamp(operation.reviewedAt) }}
                </p>
              </div>
            </div>
          </template>
        </div>
      </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useMarkdownRenderer } from "@/composables/useMarkdownRenderer";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import {
  dreamApi,
  type BatchDreamOperationInput,
  type BatchDreamOperationResult,
  type DreamLogSummary,
  type DreamOperationAction,
  type DreamOperationSummary,
  type RawDreamDetail,
  type RawDreamOperation,
} from "@/api";
import { askConfirm } from "@/platform/feedback/feedbackBus";
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

type DreamStatusFilter =
  | "all"
  | "pending"
  | "handled"
  | "approved"
  | "rejected"
  | "error";

type DreamTypeFilter = "all" | "merge" | "delete" | "insight" | "unknown";

const { renderMarkdownSync, initializeRenderer } = useMarkdownRenderer();

const listState = ref<DreamListState>({ status: "loading" });
const isRefreshing = ref(false);
const batchProcessing = ref(false);
const processingOperationKeys = ref(new Set<string>());
const filters = reactive<{
  status: DreamStatusFilter;
  agent: string;
  type: DreamTypeFilter;
  query: string;
}>({
  status: "pending",
  agent: "all",
  type: "all",
  query: "",
});

const loadedDreams = computed(() =>
  listState.value.status === "loaded" ? listState.value.dreams : []
);

const filterStats = computed(() => {
  const dreams = loadedDreams.value;
  return {
    total: dreams.length,
    pending: dreams.reduce((sum, dream) => sum + dream.pendingCount, 0),
    error: dreams.filter((dream) => hasOperationStatus(dream, "error")).length,
  };
});

const agentOptions = computed(() =>
  Array.from(new Set(loadedDreams.value.map((dream) => dream.agentName))).sort(
    (left, right) => left.localeCompare(right, "zh-CN")
  )
);

const visibleDreams = computed(() =>
  loadedDreams.value.filter((dream) => dreamMatchesFilters(dream))
);

const visiblePendingCount = computed(() =>
  visibleDreams.value.reduce((sum, dream) => sum + dream.pendingCount, 0)
);

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

function getStatusBadgeVariant(
  status?: string
): "secondary" | "success" | "warning" | "danger" | "outline" {
  switch (status) {
    case "pending_review":
      return "warning";
    case "approved":
      return "success";
    case "rejected":
    case "error":
      return "danger";
    default:
      return "secondary";
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

function mergeDreamSummaryView(
  summary: DreamLogSummary,
  previous?: DreamSummaryView
): DreamSummaryView {
  const next = toDreamSummaryView(summary);
  if (!previous) {
    return next;
  }

  return {
    ...next,
    expanded: previous.expanded,
    detailState: previous.detailState,
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

function hasOperationStatus(dream: DreamSummaryView, status: string): boolean {
  return dream.operationSummary.some((operation) => operation.status === status);
}

function hasOperationType(dream: DreamSummaryView, type: string): boolean {
  return dream.operationSummary.some((operation) => operation.type === type);
}

function dreamMatchesFilters(dream: DreamSummaryView): boolean {
  if (filters.agent !== "all" && dream.agentName !== filters.agent) {
    return false;
  }

  if (filters.type !== "all" && !hasOperationType(dream, filters.type)) {
    return false;
  }

  switch (filters.status) {
    case "pending":
      if (dream.pendingCount <= 0) return false;
      break;
    case "handled":
      if (dream.pendingCount > 0) return false;
      break;
    case "approved":
    case "rejected":
    case "error":
      if (!hasOperationStatus(dream, filters.status)) return false;
      break;
    case "all":
      break;
  }

  const query = filters.query.trim().toLowerCase();
  if (!query) {
    return true;
  }

  const haystack = [
    dream.filename,
    dream.agentName,
    dream.timestamp || "",
    ...dream.operationSummary.flatMap((operation) => [
      operation.type,
      getOpTypeLabel(operation.type),
      operation.status,
      getStatusLabel(operation.status),
    ]),
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function resetFilters(): void {
  filters.status = "all";
  filters.agent = "all";
  filters.type = "all";
  filters.query = "";
}

async function loadDreams(options: { preserveState?: boolean } = {}): Promise<void> {
  const previousDreams =
    listState.value.status === "loaded"
      ? new Map(listState.value.dreams.map((dream) => [dream.id, dream]))
      : new Map<string, DreamSummaryView>();

  if (!options.preserveState || listState.value.status !== "loaded") {
    listState.value = { status: "loading" };
  } else {
    isRefreshing.value = true;
  }

  try {
    const summaries = await dreamApi.getDreamLogSummaries();
    const dreams = summaries
      .map((summary) =>
        mergeDreamSummaryView(summary, previousDreams.get(summary.filename))
      )
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
  } finally {
    isRefreshing.value = false;
  }
}

async function refreshDreams(): Promise<void> {
  await loadDreams({ preserveState: true });
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

async function ensureDreamDetail(
  dream: DreamSummaryView,
  options: { expand?: boolean } = {}
): Promise<DreamSummaryView> {
  if (dream.detailState.status !== "loaded") {
    if (options.expand && !dream.expanded) {
      dream.expanded = true;
    }
    await loadDreamDetail(dream);
  }

  if (dream.detailState.status !== "loaded") {
    throw new Error(`${dream.agentName} 的梦日志详情加载失败`);
  }

  return dream;
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

function getOperationKey(filename: string, operationId: string): string {
  return `${filename}::${operationId}`;
}

function setOperationProcessing(
  filename: string,
  operationId: string,
  processing: boolean
): void {
  const next = new Set(processingOperationKeys.value);
  const key = getOperationKey(filename, operationId);
  if (processing) {
    next.add(key);
  } else {
    next.delete(key);
  }
  processingOperationKeys.value = next;
}

function isOperationProcessing(filename: string, operationId: string): boolean {
  return processingOperationKeys.value.has(getOperationKey(filename, operationId));
}

function syncDreamSummaryFromDetail(dream: DreamSummaryView): void {
  if (dream.detailState.status !== "loaded") {
    return;
  }

  const operations = dream.detailState.detail.operations;
  dream.operationCount = operations.length;
  dream.pendingCount = operations.filter((operation) => operation.isPending).length;
  dream.operationSummary = operations.map((operation) => ({
    type: operation.type,
    status: operation.status,
  }));
}

function patchReviewedOperation(
  filename: string,
  rawOperation?: RawDreamOperation
): void {
  if (!rawOperation) {
    return;
  }

  const dreams = getLoadedDreams();
  const dream = dreams?.find((item) => item.filename === filename);
  if (!dream || dream.detailState.status !== "loaded") {
    return;
  }

  const operationId = String(rawOperation.operationId ?? rawOperation.id ?? "");
  const operationIndex = dream.detailState.detail.operations.findIndex(
    (operation) => operation.id === operationId
  );
  if (operationIndex < 0) {
    return;
  }

  dream.detailState.detail.operations[operationIndex] = toDreamOperationView(
    rawOperation,
    operationIndex
  );
  syncDreamSummaryFromDetail(dream);
}

function getPendingOperations(dream: DreamSummaryView): DreamOperationView[] {
  if (dream.detailState.status !== "loaded") {
    return [];
  }

  return dream.detailState.detail.operations.filter(
    (operation) => operation.isPending
  );
}

async function reviewOperation(
  filename: string,
  operationId: string,
  action: DreamOperationAction
): Promise<void> {
  const actionLabel = action === "approve" ? "批准" : "拒绝";
  const warning =
    action === "approve" ? "批准后将执行实际的文件操作。" : "";

  if (!(await askConfirm({
    message: `确定${actionLabel}此操作吗？${warning}`,
    danger: action === "approve",
    confirmText: actionLabel,
  }))) {
    return;
  }

  try {
    setOperationProcessing(filename, operationId, true);
    const result = await dreamApi.reviewDreamOperation(
      filename,
      operationId,
      action,
      {
        loadingKey: `dream-manager.operation.${action}`,
      }
    );

    patchReviewedOperation(filename, result.operation);
    showMessage(result.message || `操作已${actionLabel}`, "success");
  } catch (error) {
    showMessage(`${actionLabel}失败: ${getErrorMessage(error)}`, "error");
  } finally {
    setOperationProcessing(filename, operationId, false);
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

function formatBatchMessage(
  action: DreamOperationAction,
  successCount: number,
  failedCount: number
): string {
  const actionLabel = action === "approve" ? "批准" : "拒绝";
  if (failedCount === 0) {
    return `已${actionLabel} ${successCount} 个操作`;
  }

  return `已${actionLabel} ${successCount} 个操作，${failedCount} 个失败`;
}

function applyBatchResults(results: BatchDreamOperationResult[] = []): void {
  for (const result of results) {
    if (result.ok && result.filename && result.operation) {
      patchReviewedOperation(result.filename, result.operation);
    }
  }
}

async function batchReviewOperations(
  operations: BatchDreamOperationInput[],
  action: DreamOperationAction
): Promise<void> {
  if (operations.length === 0) {
    showMessage("没有可处理的待审批操作", "info");
    return;
  }

  const actionLabel = action === "approve" ? "批准" : "拒绝";
  const warning =
    action === "approve" ? "批准后将顺序执行实际的文件操作。" : "";

  if (
    !(await askConfirm({
      message: `确定${actionLabel} ${operations.length} 个待审批操作吗？${warning}`,
      danger: action === "approve",
      confirmText: actionLabel,
    }))
  ) {
    return;
  }

  try {
    batchProcessing.value = true;
    const result = await dreamApi.batchReviewDreamOperations(operations, action, {
      loadingKey: `dream-manager.batch.${action}`,
    });
    const successCount = result.successCount ?? 0;
    const failedCount = result.failedCount ?? 0;
    applyBatchResults(result.results);
    showMessage(
      formatBatchMessage(action, successCount, failedCount),
      failedCount > 0 ? "warning" : "success"
    );
  } catch (error) {
    showMessage(`批量${actionLabel}失败: ${getErrorMessage(error)}`, "error");
  } finally {
    batchProcessing.value = false;
  }
}

async function batchReviewDream(
  dream: DreamSummaryView,
  action: DreamOperationAction
): Promise<void> {
  try {
    await ensureDreamDetail(dream);
    const operations = getPendingOperations(dream).map((operation) => ({
      filename: dream.filename,
      operationId: operation.id,
    }));
    await batchReviewOperations(operations, action);
  } catch (error) {
    showMessage(getErrorMessage(error), "error");
  }
}

async function batchReviewVisible(action: DreamOperationAction): Promise<void> {
  const operations: BatchDreamOperationInput[] = [];

  try {
    for (const dream of visibleDreams.value) {
      if (dream.pendingCount <= 0) {
        continue;
      }

      await ensureDreamDetail(dream);
      operations.push(
        ...getPendingOperations(dream).map((operation) => ({
          filename: dream.filename,
          operationId: operation.id,
        }))
      );
    }

    await batchReviewOperations(operations, action);
  } catch (error) {
    showMessage(getErrorMessage(error), "error");
  }
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

.dream-workbench {
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(135deg, var(--surface-overlay-soft), transparent),
    var(--secondary-bg);
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.dream-stat-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.dream-stat {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  min-height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-full);
  background: transparent;
  font-size: var(--font-size-helper);
}

.dream-stat strong {
  font-size: var(--font-size-body);
}

.dream-stat.pending {
  color: var(--warning-text);
}

.dream-refreshing {
  font-size: var(--font-size-helper);
  opacity: 0.7;
}

.dream-filter-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(140px, 1fr)) minmax(220px, 2fr);
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.dream-filter-grid :deep(.ui-field) {
  min-width: 0;
}

.dream-log-actions,
.dream-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.dream-log-actions {
  margin-left: auto;
  flex-shrink: 0;
}

.dream-detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-md);
  background: var(--warning-bg);
  color: var(--warning-text);
  margin-bottom: var(--space-3);
  font-size: var(--font-size-helper);
}

.dream-log-card {
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-top: 2px solid transparent;
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-3);
  overflow: hidden;
  transition: background-color var(--transition-fast), border-color var(--transition-fast);
  position: relative;
  background: transparent;
}

.dream-log-card.has-pending {
  border-top-color: var(--warning-border);
}

.dream-log-card:hover {
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.dream-log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  gap: var(--space-3);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.dream-log-header:hover {
  background: transparent;
}

.dream-log-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-body);
}

.dream-log-title .material-symbols-outlined {
  font-size: 18px;
  line-height: 1;
}

.dream-log-meta {
  display: flex;
  gap: var(--space-4);
  font-size: var(--font-size-helper);
  opacity: 0.6;
  flex-shrink: 0;
}

.dream-log-ops-summary {
  padding: 0 var(--space-4) var(--space-2);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.dream-log-detail {
  padding: 0 var(--space-4) var(--space-4);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
}

.dream-narrative-block {
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  padding: var(--space-3);
  border-radius: var(--radius-md);
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
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-top: 2px solid transparent;
  border-radius: var(--radius-md);
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
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.dream-op-type {
  font-weight: 600;
  font-size: var(--font-size-body);
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
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 68%, transparent);
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  font-family: "Consolas", "Monaco", monospace;
}

.dream-content-preview {
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 68%, transparent);
  padding: var(--space-2);
  border-radius: var(--radius-md);
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
  border-top: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
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
  .dream-filter-grid {
    grid-template-columns: 1fr;
  }

  .dream-log-actions,
  .dream-detail-toolbar,
  .dream-detail-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .dream-log-actions :deep(.ui-button),
  .dream-detail-actions :deep(.ui-button) {
    width: 100%;
  }

  .dream-log-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .dream-log-actions {
    margin-left: 0;
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
