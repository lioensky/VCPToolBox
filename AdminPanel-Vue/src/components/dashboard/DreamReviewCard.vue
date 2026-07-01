<template>
  <div class="dashboard-card-shell dashboard-card-shell--rose dream-review-card">
    <div class="dashboard-card-header dream-review-header">
      <div>
        <h3 class="dashboard-card-title">梦境监督</h3>
        <p class="dashboard-card-subtitle">待审核梦操作</p>
      </div>
      <RouterLink class="dashboard-card-badge dream-review-link" to="/dream-manager">
        查看
      </RouterLink>
    </div>

    <div v-if="loading" class="dashboard-card-empty dream-review-empty">
      <span class="loading-spinner loading-spinner--sm loading-spinner--mb-3"></span>
      <p>正在检查梦操作…</p>
    </div>

    <div v-else-if="errorMessage" class="dashboard-card-empty dream-review-empty">
      <span class="material-symbols-outlined dream-review-icon danger">error</span>
      <p>{{ errorMessage }}</p>
    </div>

    <div v-else-if="pendingDreams.length === 0" class="dashboard-card-empty dream-review-empty">
      <span class="material-symbols-outlined dream-review-icon">verified</span>
      <p>当前没有待审核梦操作。</p>
    </div>

    <div v-else class="dream-review-content">
      <div class="dream-review-summary">
        <div class="dream-review-metric">
          <strong>{{ totalPendingCount }}</strong>
          <span>待审操作</span>
        </div>
        <div class="dream-review-metric">
          <strong>{{ pendingDreams.length }}</strong>
          <span>梦日志</span>
        </div>
      </div>

      <div class="dream-review-list">
        <RouterLink
          v-for="dream in displayedDreams"
          :key="dream.filename"
          class="dashboard-card-panel dream-review-item"
          to="/dream-manager"
        >
          <div class="dream-review-item-main">
            <span class="dream-review-agent">{{ dream.agentName || "未知 Agent" }}</span>
            <span class="dream-review-time">{{ formatTime(dream.timestamp) }}</span>
          </div>
          <div class="dream-review-item-meta">
            <span class="dream-review-count">{{ dream.pendingCount ?? 0 }} 待审</span>
            <span class="dream-review-types">{{ summarizeOperationTypes(dream.operationSummary) }}</span>
          </div>
        </RouterLink>

        <RouterLink
          v-if="pendingDreams.length > displayedDreams.length"
          class="dream-review-more"
          to="/dream-manager"
        >
          还有 {{ pendingDreams.length - displayedDreams.length }} 条梦日志待查看
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { dreamApi, type DreamLogSummary, type DreamOperationSummary } from "@/api";
import { createLogger } from "@/utils";

const REFRESH_INTERVAL_MS = 30_000;
const MAX_DISPLAYED_DREAMS = 5;

const logger = createLogger("DreamReviewCard");
const loading = ref(true);
const errorMessage = ref("");
const dreams = ref<DreamLogSummary[]>([]);
let refreshTimer: number | undefined;

const pendingDreams = computed(() =>
  dreams.value
    .filter((dream) => (dream.pendingCount ?? 0) > 0)
    .sort((left, right) => toTime(right.timestamp) - toTime(left.timestamp))
);

const displayedDreams = computed(() => pendingDreams.value.slice(0, MAX_DISPLAYED_DREAMS));

const totalPendingCount = computed(() =>
  pendingDreams.value.reduce((sum, dream) => sum + (dream.pendingCount ?? 0), 0)
);

async function loadDreams() {
  try {
    errorMessage.value = "";
    dreams.value = await dreamApi.getDreamLogSummaries({
      showLoader: false,
      suppressErrorMessage: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load dream review summaries:", error);
    errorMessage.value = `加载失败：${message}`;
  } finally {
    loading.value = false;
  }
}

function toTime(value?: string): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatTime(value?: string): string {
  const timestamp = toTime(value);
  if (!timestamp) {
    return "未知时间";
  }

  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summarizeOperationTypes(operations?: DreamOperationSummary[]): string {
  const pendingOperations = (operations ?? []).filter(
    (operation) => operation.status === "pending_review"
  );

  if (pendingOperations.length === 0) {
    return "待处理";
  }

  const labels = pendingOperations.map((operation) => getOperationTypeLabel(operation.type));
  return [...new Set(labels)].slice(0, 3).join(" / ");
}

function getOperationTypeLabel(type?: string): string {
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

onMounted(() => {
  void loadDreams();
  refreshTimer = window.setInterval(() => {
    void loadDreams();
  }, REFRESH_INTERVAL_MS);
});

onUnmounted(() => {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }
});
</script>

<style scoped>
@import "./dashboard-card.css";

.dream-review-card {
  --dashboard-accent: var(--warning-color);
  --dashboard-accent-soft: color-mix(in srgb, var(--dashboard-accent) 16%, transparent);
  --dashboard-accent-border: color-mix(in srgb, var(--dashboard-accent) 34%, transparent);
}

.dream-review-header {
  margin-bottom: 14px;
}

.dream-review-link {
  text-decoration: none;
}

.dream-review-empty {
  min-height: 0;
  flex: 1;
  gap: 8px;
}

.dream-review-icon {
  color: var(--dashboard-accent);
  font-size: 34px;
  opacity: 0.85;
}

.dream-review-icon.danger {
  color: var(--danger-color);
}

.dream-review-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 12px;
}

.dream-review-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.dream-review-metric {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  min-height: 66px;
  padding: 10px 12px;
  border: 1px solid var(--dashboard-accent-border);
  border-radius: var(--radius-lg, 14px);
  background: var(--dashboard-accent-soft);
}

.dream-review-metric strong {
  color: var(--primary-text);
  font-size: var(--font-size-metric-secondary);
  line-height: 1;
}

.dream-review-metric span {
  margin-top: 6px;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.dream-review-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 8px;
  overflow-y: auto;
  padding-right: 3px;
  scrollbar-width: thin;
  scrollbar-color: var(--dashboard-accent-border) transparent;
}

.dream-review-list::-webkit-scrollbar {
  width: 4px;
}

.dream-review-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--dashboard-accent-border);
}

.dream-review-item {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 11px;
  color: inherit;
  text-decoration: none;
}

.dream-review-item-main,
.dream-review-item-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  gap: 10px;
}

.dream-review-agent {
  min-width: 0;
  overflow: hidden;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dream-review-time,
.dream-review-types {
  min-width: 0;
  overflow: hidden;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dream-review-count {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: var(--radius-full, 999px);
  background: var(--warning-bg);
  color: var(--warning-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.dream-review-more {
  display: block;
  padding: 6px 4px;
  color: var(--dashboard-accent);
  font-size: var(--font-size-caption);
  font-weight: 700;
  text-align: center;
  text-decoration: none;
}

@container dashboard-card (max-width: 360px) {
  .dream-review-summary {
    gap: 8px;
  }

  .dream-review-metric {
    min-height: 56px;
    padding: 8px 10px;
  }

  .dream-review-metric strong {
    font-size: var(--font-size-title);
  }

  .dream-review-item-main,
  .dream-review-item-meta {
    align-items: flex-start;
    flex-direction: column;
    gap: 5px;
  }
}

@container dashboard-card (max-width: 280px) {
  .dream-review-summary {
    grid-template-columns: 1fr;
  }

  .dream-review-item {
    padding: 8px 9px;
  }
}
</style>