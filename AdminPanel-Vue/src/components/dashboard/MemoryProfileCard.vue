<template>
  <div class="dashboard-card-shell dashboard-card-shell--teal memory-profile-card">
    <h3 class="dashboard-card-title">记忆库内存剖面</h3>

    <div v-if="!profile" class="dashboard-card-empty empty-state">
      <p>正在加载记忆库内存剖面...</p>
    </div>

    <div v-else class="memory-profile-layout">
      <div class="summary-grid">
        <div class="dashboard-card-panel summary-item">
          <span class="summary-label">总估算</span>
          <strong>{{ formatBytes(profile.estimatedBytes) }}</strong>
          <small>进程 RSS {{ formatBytes(profile.processMemory.rss) }}</small>
        </div>
        <div class="dashboard-card-panel summary-item">
          <span class="summary-label">热记忆</span>
          <strong>{{ formatBytes(knowledgeBaseProfile.estimatedBytes) }}</strong>
          <small>{{ knowledgeBaseProfile.diaryIndices.loadedCount }} 个日记索引已加载</small>
        </div>
        <div class="dashboard-card-panel summary-item">
          <span class="summary-label">TagMemo</span>
          <strong>{{ formatBytes(knowledgeBaseProfile.tagMemo.estimatedBytes) }}</strong>
          <small>{{ formatNumber(knowledgeBaseProfile.tagMemo.cooccurrenceEdges ?? 0) }} 条矩阵边</small>
        </div>
        <div class="dashboard-card-panel summary-item">
          <span class="summary-label">冷知识库</span>
          <strong>{{ formatBytes(tdbKnowledgeProfile.estimatedBytes) }}</strong>
          <small>{{ tdbKnowledgeProfile.libraries.openedCount }} 个 TDB 库已打开</small>
        </div>
      </div>

      <div class="detail-grid">
        <section class="dashboard-card-panel detail-section">
          <div class="section-title">
            <span>日记本索引</span>
            <small>{{ formatBytes(knowledgeBaseProfile.diaryIndices.estimatedBytes) }}</small>
          </div>
          <div v-if="topDiaryIndices.length === 0" class="empty-line">暂无已加载日记索引</div>
          <div v-else class="item-list">
            <div v-for="item in topDiaryIndices" :key="item.name" class="profile-row">
              <span class="row-name" :title="item.name">{{ item.name }}</span>
              <span class="row-meta">
                {{ formatBytes(item.estimatedBytes) }} · {{ formatNumber(item.stats.totalVectors) }} 向量
              </span>
            </div>
          </div>
        </section>

        <section class="dashboard-card-panel detail-section">
          <div class="section-title">
            <span>TagMemo 矩阵</span>
            <small :class="{ active: knowledgeBaseProfile.tagMemo.matrixRebuilding }">
              {{ knowledgeBaseProfile.tagMemo.matrixRebuilding ? "重建中" : "就绪" }}
            </small>
          </div>
          <div class="metric-list">
            <div class="metric-row">
              <span>Pairwise</span>
              <strong>{{ formatNumber(knowledgeBaseProfile.tagMemo.pairwiseSimilarities ?? 0) }}</strong>
              <small>{{ formatBytes(knowledgeBaseProfile.tagMemo.pairwiseEstimatedBytes ?? 0) }}</small>
            </div>
            <div class="metric-row">
              <span>共现源</span>
              <strong>{{ formatNumber(knowledgeBaseProfile.tagMemo.cooccurrenceSources ?? 0) }}</strong>
              <small>{{ formatBytes(knowledgeBaseProfile.tagMemo.cooccurrenceEstimatedBytes ?? 0) }}</small>
            </div>
            <div class="metric-row">
              <span>内生残差</span>
              <strong>{{ formatNumber(knowledgeBaseProfile.tagMemo.intrinsicResiduals ?? 0) }}</strong>
              <small>{{ formatBytes(knowledgeBaseProfile.tagMemo.intrinsicEstimatedBytes ?? 0) }}</small>
            </div>
          </div>
        </section>

        <section class="dashboard-card-panel detail-section">
          <div class="section-title">
            <span>冷知识库索引</span>
            <small>{{ formatBytes(tdbKnowledgeProfile.libraries.estimatedBytes) }}</small>
          </div>
          <div v-if="topTdbLibraries.length === 0" class="empty-line">
            {{ tdbKnowledgeProfile.enabled ? "暂无打开的 TDB 库" : "TDB 冷知识库未启用" }}
          </div>
          <div v-else class="item-list">
            <div v-for="item in topTdbLibraries" :key="item.name" class="profile-row">
              <span class="row-name" :title="item.path">{{ item.name }}</span>
              <span class="row-meta">
                {{ formatBytes(item.estimatedBytes) }} · 磁盘 {{ formatBytes(item.diskSize) }}
              </span>
            </div>
          </div>
        </section>

        <section class="dashboard-card-panel detail-section">
          <div class="section-title">
            <span>队列与缓存</span>
            <small>{{ knowledgeBaseProfile.dbHealthState }}</small>
          </div>
          <div class="metric-list compact">
            <div class="metric-row">
              <span>KB 队列</span>
              <strong>{{ knowledgeBaseProfile.queues.pendingFiles }}</strong>
              <small>删除 {{ knowledgeBaseProfile.queues.pendingDeletes }}</small>
            </div>
            <div class="metric-row">
              <span>TDB 队列</span>
              <strong>{{ tdbKnowledgeProfile.queues.pending }}</strong>
              <small>失败 {{ tdbKnowledgeProfile.queues.failed }}</small>
            </div>
            <div class="metric-row">
              <span>名称缓存</span>
              <strong>{{ knowledgeBaseProfile.caches.diaryNameVectorCount }}</strong>
              <small>{{ formatBytes(knowledgeBaseProfile.caches.diaryNameVectorEstimatedBytes) }}</small>
            </div>
          </div>
        </section>
      </div>

      <p class="profile-note">{{ profile.note }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  KnowledgeBaseDiaryIndexMemoryItem,
  MemoryProfile,
  TdbKnowledgeLibraryMemoryItem,
} from "@/types/api.system";

const props = defineProps<{
  profile: MemoryProfile | null;
}>();

const emptyKnowledgeBaseProfile = {
  estimatedBytes: 0,
  dbHealthState: "unknown",
  queues: {
    pendingFiles: 0,
    pendingDeletes: 0,
    saveTimers: 0,
    isProcessing: false,
    isProcessingDeletes: false,
  },
  diaryIndices: {
    loadedCount: 0,
    trackedCount: 0,
    idleTtlMs: 0,
    estimatedBytes: 0,
    items: [] as KnowledgeBaseDiaryIndexMemoryItem[],
  },
  caches: {
    diaryNameVectorCount: 0,
    diaryNameVectorEstimatedBytes: 0,
    diaryDateIndexCount: 0,
    diaryDateIndexEstimatedBytes: 0,
  },
  tagMemo: {
    available: false,
    estimatedBytes: 0,
    pairwiseSimilarities: 0,
    pairwiseEstimatedBytes: 0,
    cooccurrenceSources: 0,
    cooccurrenceEdges: 0,
    cooccurrenceEstimatedBytes: 0,
    intrinsicResiduals: 0,
    intrinsicEstimatedBytes: 0,
    matrixRebuilding: false,
  },
};

const emptyTdbKnowledgeProfile = {
  enabled: false,
  estimatedBytes: 0,
  queues: {
    pending: 0,
    retry: 0,
    processing: 0,
    failed: 0,
    isProcessing: false,
    isQueueWorkerRunning: false,
    libraryQueues: 0,
    fileEventVersions: 0,
    pendingFileVersions: 0,
  },
  libraries: {
    openedCount: 0,
    estimatedBytes: 0,
    items: [] as TdbKnowledgeLibraryMemoryItem[],
  },
};

const knowledgeBaseProfile = computed(() => ({
  ...emptyKnowledgeBaseProfile,
  ...(props.profile?.knowledgeBase ?? {}),
  queues: {
    ...emptyKnowledgeBaseProfile.queues,
    ...(props.profile?.knowledgeBase?.queues ?? {}),
  },
  diaryIndices: {
    ...emptyKnowledgeBaseProfile.diaryIndices,
    ...(props.profile?.knowledgeBase?.diaryIndices ?? {}),
    items: props.profile?.knowledgeBase?.diaryIndices?.items ?? [],
  },
  caches: {
    ...emptyKnowledgeBaseProfile.caches,
    ...(props.profile?.knowledgeBase?.caches ?? {}),
  },
  tagMemo: {
    ...emptyKnowledgeBaseProfile.tagMemo,
    ...(props.profile?.knowledgeBase?.tagMemo ?? {}),
  },
}));

const tdbKnowledgeProfile = computed(() => ({
  ...emptyTdbKnowledgeProfile,
  ...(props.profile?.tdbKnowledge ?? {}),
  queues: {
    ...emptyTdbKnowledgeProfile.queues,
    ...(props.profile?.tdbKnowledge?.queues ?? {}),
  },
  libraries: {
    ...emptyTdbKnowledgeProfile.libraries,
    ...(props.profile?.tdbKnowledge?.libraries ?? {}),
    items: props.profile?.tdbKnowledge?.libraries?.items ?? [],
  },
}));

const topDiaryIndices = computed<KnowledgeBaseDiaryIndexMemoryItem[]>(() =>
  knowledgeBaseProfile.value.diaryIndices.items.slice(0, 5)
);

const topTdbLibraries = computed<TdbKnowledgeLibraryMemoryItem[]>(() =>
  tdbKnowledgeProfile.value.libraries.items.slice(0, 5)
);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const digits = unitIndex >= 3 ? 2 : unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("zh-CN");
}
</script>

<style scoped>
@import "./dashboard-card.css";

.memory-profile-card {
  --dashboard-accent: var(--info-text);
  --dashboard-accent-soft: color-mix(in srgb, var(--dashboard-accent) 18%, transparent);
  --dashboard-accent-border: color-mix(in srgb, var(--dashboard-accent) 34%, transparent);
}

.memory-profile-layout {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 12px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.summary-item {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 4px;
  padding: 10px 12px;
}

.summary-label {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
}

.summary-item strong {
  color: var(--primary-text);
  font-size: var(--font-size-title);
  line-height: 1.15;
}

.summary-item small,
.section-title small,
.metric-row small,
.row-meta {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  flex: 1;
  min-height: 0;
  gap: 10px;
}

.detail-section {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: 8px;
  padding: 10px 12px;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
}

.section-title small.active {
  color: var(--warning-color);
}

.item-list,
.metric-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 6px;
  overflow-y: auto;
}

.profile-row,
.metric-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}

.metric-row {
  grid-template-columns: minmax(0, 1fr) auto auto;
}

.row-name {
  min-width: 0;
  overflow: hidden;
  color: var(--primary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-row span {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.metric-row strong {
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-variant-numeric: tabular-nums;
}

.empty-line {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.profile-note {
  margin: 0;
  color: var(--tertiary-text, var(--secondary-text));
  font-size: var(--font-size-caption);
  line-height: 1.4;
}

.empty-state {
  min-height: 180px;
}

@container dashboard-card (max-width: 520px) {
  .summary-grid,
  .detail-grid {
    grid-template-columns: 1fr;
  }

  .summary-grid {
    gap: 8px;
  }
}

@container dashboard-card (max-width: 320px) {
  .profile-row,
  .metric-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .row-meta {
    text-align: left;
  }
}
</style>