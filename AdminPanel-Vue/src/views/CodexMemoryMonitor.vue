<template>
  <section class="config-section active-section codex-memory-page">
    <header class="memory-hero card">
      <div class="memory-hero__copy">
        <span class="memory-hero__eyebrow">Codex Memory Operations</span>
        <h2>Codex 记忆总览</h2>
        <p class="description">
          汇总桥接写入、召回命中、自适应调节和最近记忆文件，帮助我们快速判断记忆链路是健康、空转，还是已经开始偏移。
        </p>
      </div>

      <form class="memory-hero__controls" @submit.prevent="refreshOverview">
        <label class="field">
          <span>审计窗口</span>
          <input v-model.number="query.auditWindow" type="number" min="10" max="2000" step="10" />
        </label>
        <label class="field">
          <span>列表数量</span>
          <input v-model.number="query.limit" type="number" min="1" max="50" step="1" />
        </label>
        <button type="submit" class="btn-primary">
          <span class="material-symbols-outlined">refresh</span>
          刷新
        </button>
      </form>
    </header>

    <div class="summary-grid">
      <article class="summary-card card">
        <span>桥接接受</span>
        <strong>{{ summary.accepted }}</strong>
        <small>拒绝 {{ summary.rejected }}</small>
      </article>
      <article class="summary-card card">
        <span>召回命中</span>
        <strong>{{ recallSummary.totalHits }}</strong>
        <small>缓存 {{ recallSummary.cacheHits }}</small>
      </article>
      <article class="summary-card card">
        <span>过程记忆</span>
        <strong>{{ summary.processAccepted }}</strong>
        <small>拒绝 {{ summary.processRejected }}</small>
      </article>
      <article class="summary-card card">
        <span>知识记忆</span>
        <strong>{{ summary.knowledgeAccepted }}</strong>
        <small>拒绝 {{ summary.knowledgeRejected }}</small>
      </article>
      <article class="summary-card card">
        <span>关联条目</span>
        <strong>{{ overview?.memoryLinks.length ?? 0 }}</strong>
        <small>最近链路命中</small>
      </article>
      <article class="summary-card card">
        <span>最近刷新</span>
        <strong>{{ formatMaybeDate(lastLoadedAt) }}</strong>
        <small>{{ recallStatusLabel }}</small>
      </article>
    </div>

    <div v-if="isLoading" class="state-card card">
      <span class="material-symbols-outlined spinning">sync</span>
      <div>
        <strong>正在加载 Codex 记忆总览</strong>
        <p>会读取 bridge audit、recall audit 和最近日记文件。</p>
      </div>
    </div>

    <div v-else-if="loadError" class="state-card state-card--error card">
      <span class="material-symbols-outlined">error</span>
      <div>
        <strong>加载失败</strong>
        <p>{{ loadError }}</p>
      </div>
      <button type="button" class="btn-secondary" @click="refreshOverview">重试</button>
    </div>

    <template v-else-if="overview">
      <div class="panel-grid">
        <article class="card status-panel">
          <header class="panel-header">
            <div>
              <h3>写入桥接状态</h3>
              <p>Bridge audit 最近 {{ summary.sampleSize }} 条写入决策。</p>
            </div>
            <span :class="['status-pill', summary.rejected > 0 ? 'status-pill--warning' : 'status-pill--ok']">
              {{ summary.rejected > 0 ? "存在拒绝" : "运行平稳" }}
            </span>
          </header>

          <div class="metric-list">
            <div class="metric-row">
              <span>敏感拦截</span>
              <strong>{{ summary.sensitiveRejected }}</strong>
            </div>
            <div class="metric-row">
              <span>直写阻断</span>
              <strong>{{ summary.blockedDirectWrites }}</strong>
            </div>
            <div class="metric-row">
              <span>最新接受</span>
              <strong>{{ formatMaybeDate(summary.latestAcceptedAt) }}</strong>
            </div>
            <div class="metric-row">
              <span>最新拒绝</span>
              <strong>{{ formatMaybeDate(summary.latestRejectedAt) }}</strong>
            </div>
          </div>

          <div v-if="overview.rejectionReasons.length > 0" class="chips">
            <span v-for="item in overview.rejectionReasons" :key="item.reason" class="chip chip--warning">
              {{ item.count }}x {{ item.reason }}
            </span>
          </div>
          <p v-else class="empty-text">当前窗口没有拒绝原因聚合。</p>
        </article>

        <article class="card status-panel">
          <header class="panel-header">
            <div>
              <h3>召回审计状态</h3>
              <p>{{ overview.recall.message }}</p>
            </div>
            <span :class="['status-pill', recallStatusClass]">
              {{ recallStatusLabel }}
            </span>
          </header>

          <div class="metric-list">
            <div class="metric-row">
              <span>Snippet</span>
              <strong>{{ recallSummary.snippetHits }}</strong>
            </div>
            <div class="metric-row">
              <span>Full text</span>
              <strong>{{ recallSummary.fullTextHits }}</strong>
            </div>
            <div class="metric-row">
              <span>Direct</span>
              <strong>{{ recallSummary.directHits }}</strong>
            </div>
            <div class="metric-row">
              <span>最新命中</span>
              <strong>{{ formatMaybeDate(recallSummary.latestHitAt) }}</strong>
            </div>
          </div>
        </article>
      </div>

      <div class="panel-grid panel-grid--adaptive">
        <article class="card">
          <header class="panel-header">
            <div>
              <h3>自适应配置</h3>
              <p>当前从 `rag_params.json` 解析出的 Codex recall tuning 配置。</p>
            </div>
            <span :class="['status-pill', adaptiveEnabled ? 'status-pill--ok' : 'status-pill--muted']">
              {{ adaptiveEnabled ? "enabled" : "disabled" }}
            </span>
          </header>

          <div class="config-grid">
            <div class="metric-row">
              <span>目标命中率</span>
              <strong>{{ formatPercent(adaptive.config.targetHitRate) }}</strong>
            </div>
            <div class="metric-row">
              <span>预热写入阈值</span>
              <strong>{{ adaptive.config.minWritesBeforeAdjust }}</strong>
            </div>
            <div class="metric-row">
              <span>低分阈值</span>
              <strong>{{ formatScore(adaptive.config.lowScoreThreshold) }}</strong>
            </div>
            <div class="metric-row">
              <span>窗口条数</span>
              <strong>{{ adaptive.config.profileWindow }}</strong>
            </div>
          </div>
        </article>

        <article class="card">
          <header class="panel-header">
            <div>
              <h3>Top Tags</h3>
              <p>最近召回里最常出现的标签，用来判断 recall 是否正围绕正确语义收敛。</p>
            </div>
          </header>

          <div v-if="adaptive.tagContribution.flat.length > 0" class="tag-contribution-list">
            <div v-for="tag in adaptive.tagContribution.flat" :key="`${tag.dbName}-${tag.tag}`" class="tag-contribution-item">
              <div>
                <strong>{{ tag.tag }}</strong>
                <small>{{ tag.dbName }} · 命中 {{ tag.hitCount }} · 记忆 {{ tag.uniqueMemoryCount }}</small>
              </div>
              <span class="tag-score">{{ formatScore(tag.avgTopScore) }}</span>
            </div>
          </div>
          <p v-else class="empty-text">当前没有标签贡献数据。</p>
        </article>
      </div>

      <div class="profile-grid">
        <article
          v-for="profile in adaptive.profiles"
          :key="profile.dbName"
          class="card profile-card"
          :class="`profile-card--${profile.status}`"
        >
          <header class="panel-header">
            <div>
              <h3>{{ profile.dbName }}</h3>
              <p>{{ profile.target === "process" ? "过程记忆" : "知识记忆" }}</p>
            </div>
            <span :class="['status-pill', getProfileStatusClass(profile.status)]">
              {{ profile.status }}
            </span>
          </header>

          <div class="metric-list">
            <div class="metric-row">
              <span>写入 / 命中</span>
              <strong>{{ profile.writeCount }} / {{ profile.totalHits }}</strong>
            </div>
            <div class="metric-row">
              <span>命中率</span>
              <strong>{{ formatPercent(profile.hitRate) }}</strong>
            </div>
            <div class="metric-row">
              <span>平均分</span>
              <strong>{{ formatScore(profile.avgTopScore) }}</strong>
            </div>
            <div class="metric-row">
              <span>K / 阈值</span>
              <strong>{{ signedNumber(profile.kDelta) }} / {{ signedNumber(profile.thresholdDelta, 3) }}</strong>
            </div>
          </div>

          <div class="delta-strip">
            <span>Tag {{ signedNumber(profile.tagWeightDelta, 3) }}</span>
            <span>Trunc {{ signedNumber(profile.truncationDelta, 3) }}</span>
            <span>Penalty {{ signedNumber(profile.lowScorePenalty, 3) }}</span>
          </div>

          <div class="chips">
            <span v-for="reason in profile.reasons" :key="reason" class="chip">
              {{ reason }}
            </span>
          </div>
        </article>
      </div>

      <div class="panel-grid panel-grid--records">
        <article class="card table-card">
          <header class="panel-header">
            <div>
              <h3>最近 bridge audit</h3>
              <p>按时间倒序展示最近写入决策。</p>
            </div>
          </header>

          <div v-if="overview.recentAudit.length > 0" class="table-wrap">
            <table class="memory-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>目标</th>
                  <th>决策</th>
                  <th>标题</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in overview.recentAudit" :key="`${entry.timestamp}-${entry.memoryId}-${entry.title}`">
                  <td>{{ formatMaybeDate(entry.timestamp) }}</td>
                  <td>{{ entry.target || "-" }}</td>
                  <td>
                    <span :class="['status-pill', entry.decision === 'accepted' ? 'status-pill--ok' : 'status-pill--warning']">
                      {{ entry.decision }}
                    </span>
                  </td>
                  <td>
                    <strong>{{ entry.title || "Untitled memory" }}</strong>
                    <small>{{ trimText(entry.reason, 88) }}</small>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="empty-text">当前没有 bridge audit 记录。</p>
        </article>

        <article class="card table-card">
          <header class="panel-header">
            <div>
              <h3>最近 recall audit</h3>
              <p>用来观察 recall 来源、cache 命中和 top score 走势。</p>
            </div>
          </header>

          <div v-if="overview.recall.recent.length > 0" class="table-wrap">
            <table class="memory-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>目标</th>
                  <th>类型</th>
                  <th>Top</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in overview.recall.recent" :key="`${entry.timestamp}-${entry.topMemoryId}-${entry.topSourceFile}`">
                  <td>{{ formatMaybeDate(entry.timestamp) }}</td>
                  <td>{{ entry.target || "-" }}</td>
                  <td>
                    <span class="status-pill status-pill--info">
                      {{ entry.recallType }}
                    </span>
                  </td>
                  <td>
                    <strong>{{ entry.topMemoryId || entry.topSourceFile || "-" }}</strong>
                    <small>
                      score {{ formatScore(entry.topScore) }} ·
                      {{ entry.fromCache ? "cache" : "live" }} ·
                      {{ entry.resultCount }} results
                    </small>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="empty-text">当前没有 recall audit 记录。</p>
        </article>
      </div>

      <div class="panel-grid panel-grid--records">
        <article class="card table-card">
          <header class="panel-header">
            <div>
              <h3>最近关联记忆</h3>
              <p>把 accepted write 和 recall hit 串起来，帮助定位最常被命中的记忆条目。</p>
            </div>
          </header>

          <div v-if="overview.memoryLinks.length > 0" class="link-list">
            <div v-for="link in overview.memoryLinks" :key="`${link.memoryId}-${link.filePath}`" class="link-item">
              <div>
                <strong>{{ link.title }}</strong>
                <small>{{ link.target || "-" }} · {{ formatMaybeDate(link.lastRecallAt || link.writtenAt) }}</small>
              </div>
              <div class="link-item__metrics">
                <span>{{ link.recallCount }} recall</span>
                <span>{{ link.cacheRecallCount }} cache</span>
                <span>{{ formatScore(link.lastTopScore) }}</span>
              </div>
            </div>
          </div>
          <p v-else class="empty-text">当前没有可关联的写入 / 召回记录。</p>
        </article>

        <article class="card table-card">
          <header class="panel-header">
            <div>
              <h3>最近日记文件</h3>
              <p>直接看 process / knowledge 两个目录最近被改动的文件。</p>
            </div>
          </header>

          <div class="dual-list">
            <section class="file-list">
              <h4>Process</h4>
              <div v-if="overview.recentFiles.process.length > 0" class="file-list__items">
                <div v-for="file in overview.recentFiles.process" :key="file.path" class="file-item">
                  <strong>{{ file.name }}</strong>
                  <small>{{ formatMaybeDate(file.updatedAt) }} · {{ formatFileSize(file.size) }}</small>
                </div>
              </div>
              <p v-else class="empty-text">暂无文件</p>
            </section>

            <section class="file-list">
              <h4>Knowledge</h4>
              <div v-if="overview.recentFiles.knowledge.length > 0" class="file-list__items">
                <div v-for="file in overview.recentFiles.knowledge" :key="file.path" class="file-item">
                  <strong>{{ file.name }}</strong>
                  <small>{{ formatMaybeDate(file.updatedAt) }} · {{ formatFileSize(file.size) }}</small>
                </div>
              </div>
              <p v-else class="empty-text">暂无文件</p>
            </section>
          </div>
        </article>
      </div>

      <details class="card path-card">
        <summary>路径与日志文件</summary>
        <div class="path-grid">
          <div class="path-item">
            <span>auditLogPath</span>
            <code>{{ overview.paths.auditLogPath }}</code>
          </div>
          <div class="path-item">
            <span>recallLogPath</span>
            <code>{{ overview.paths.recallLogPath }}</code>
          </div>
          <div class="path-item">
            <span>processDiaryPath</span>
            <code>{{ overview.paths.processDiaryPath }}</code>
          </div>
          <div class="path-item">
            <span>knowledgeDiaryPath</span>
            <code>{{ overview.paths.knowledgeDiaryPath }}</code>
          </div>
        </div>
      </details>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  codexMemoryApi,
  type CodexAdaptiveDiaryProfile,
  type CodexMemoryOverview,
} from "@/api/codexMemory";
import { showMessage } from "@/platform/feedback/feedbackBus";
import { formatDate, formatFileSize } from "@/utils";

const overview = ref<CodexMemoryOverview | null>(null);
const isLoading = ref(false);
const loadError = ref("");
const lastLoadedAt = ref<string | null>(null);
const query = ref({
  auditWindow: 500,
  limit: 10,
});

const summary = computed(
  () =>
    overview.value?.summary ?? {
      sampleSize: 0,
      accepted: 0,
      rejected: 0,
      processAccepted: 0,
      knowledgeAccepted: 0,
      processRejected: 0,
      knowledgeRejected: 0,
      blockedDirectWrites: 0,
      sensitiveRejected: 0,
      latestAcceptedAt: null,
      latestRejectedAt: null,
    }
);

const recallSummary = computed(
  () =>
    overview.value?.recall.summary ?? {
      sampleSize: 0,
      totalHits: 0,
      processHits: 0,
      knowledgeHits: 0,
      snippetHits: 0,
      fullTextHits: 0,
      directHits: 0,
      cacheHits: 0,
      latestHitAt: null,
      latestProcessHitAt: null,
      latestKnowledgeHitAt: null,
    }
);

const adaptive = computed(
  () =>
    overview.value?.adaptive ?? {
      config: {
        enabled: false,
        targetHitRate: 0,
        minWritesBeforeAdjust: 0,
        lowScoreThreshold: 0,
        maxThresholdDrop: 0,
        maxTagWeightBoost: 0,
        maxKBoost: 0,
        maxTruncationBoost: 0,
        thresholdDropScale: 0,
        tagWeightBoostScale: 0,
        truncationBoostScale: 0,
        scoreThresholdScale: 0,
        scoreTagWeightScale: 0,
        scoreTruncationScale: 0,
        kBoostStep: 0,
        tagContributionLimit: 0,
        profileWindow: 0,
        profileBytes: 0,
      },
      profiles: [],
      tagContribution: {
        flat: [],
        byDiary: [],
      },
      paths: {
        recallLogPath: "",
        writeLogPath: "",
      },
    }
);

const adaptiveEnabled = computed(() => adaptive.value.config.enabled !== false);
const recallStatusLabel = computed(() => overview.value?.recall.status ?? "idle");
const recallStatusClass = computed(() => {
  if (!overview.value?.recall.available) return "status-pill--muted";
  return overview.value.recall.status === "active"
    ? "status-pill--ok"
    : "status-pill--info";
});

async function loadOverview(showSuccess = false): Promise<void> {
  isLoading.value = true;
  loadError.value = "";

  try {
    overview.value = await codexMemoryApi.getOverview(
      {
        auditWindow: query.value.auditWindow,
        limit: query.value.limit,
      },
      {
        showLoader: false,
        loadingKey: "codex-memory.overview",
      }
    );
    lastLoadedAt.value = new Date().toISOString();
    if (showSuccess) {
      showMessage("Codex 记忆总览已刷新。", "success");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    loadError.value = message;
    showMessage(`加载 Codex 记忆总览失败：${message}`, "error");
  } finally {
    isLoading.value = false;
  }
}

function refreshOverview(): void {
  void loadOverview(true);
}

function formatMaybeDate(value: string | null | undefined): string {
  if (!value) return "-";
  return formatDate(value);
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatScore(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return value.toFixed(3);
}

function signedNumber(
  value: number | null | undefined,
  digits = 2
): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  if (value === 0) return (0).toFixed(digits);
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function trimText(value: string, maxLength: number): string {
  if (!value) return "-";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function getProfileStatusClass(status: CodexAdaptiveDiaryProfile["status"]): string {
  switch (status) {
    case "boosted":
      return "status-pill--warning";
    case "steady":
      return "status-pill--ok";
    case "warming":
      return "status-pill--info";
    case "disabled":
      return "status-pill--muted";
    default:
      return "status-pill--info";
  }
}

onMounted(() => {
  void loadOverview();
});
</script>

<style scoped>
.codex-memory-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.memory-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(280px, 0.9fr);
  gap: var(--space-5);
  align-items: start;
  overflow: hidden;
  background:
    radial-gradient(circle at top right, color-mix(in srgb, var(--memory-color) 18%, transparent), transparent 48%),
    linear-gradient(135deg, color-mix(in srgb, var(--secondary-bg) 92%, black), color-mix(in srgb, var(--secondary-bg) 85%, var(--memory-color) 15%));
}

.memory-hero__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  color: var(--memory-color);
  font-size: var(--font-size-helper);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.memory-hero h2 {
  margin: 0;
  font-size: var(--font-size-display);
}

.memory-hero__controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--memory-color) 28%, var(--border-color));
  background: color-mix(in srgb, var(--tertiary-bg) 90%, transparent);
}

.memory-hero__controls .btn-primary {
  grid-column: 1 / -1;
  min-height: 44px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.field input {
  width: 100%;
}

.summary-grid,
.panel-grid,
.profile-grid {
  display: grid;
  gap: var(--space-4);
}

.summary-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

.summary-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 128px;
  justify-content: space-between;
}

.summary-card span,
.summary-card small,
.panel-header p,
.empty-text,
.link-item small,
.file-item small,
.path-item span {
  color: var(--secondary-text);
}

.summary-card strong {
  font-size: clamp(1.55rem, 1.25rem + 1vw, 2.1rem);
  color: var(--memory-color);
}

.state-card {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.state-card .material-symbols-outlined {
  font-size: 2rem;
  color: var(--memory-color);
}

.state-card--error .material-symbols-outlined {
  color: var(--danger-color);
}

.spinning {
  animation: codex-memory-spin 1s linear infinite;
}

.panel-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel-grid--adaptive {
  align-items: start;
}

.panel-grid--records {
  align-items: start;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: start;
  margin-bottom: var(--space-4);
}

.panel-header h3 {
  margin: 0 0 var(--space-1);
}

.status-panel,
.table-card,
.profile-card,
.path-card {
  min-height: 100%;
}

.metric-list,
.config-grid {
  display: grid;
  gap: var(--space-2);
}

.metric-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: center;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface-overlay) 80%, transparent);
}

.metric-row strong,
.tag-score,
.link-item__metrics span:last-child {
  color: var(--memory-color);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--memory-color) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--memory-color) 18%, var(--border-color));
  font-size: var(--font-size-helper);
}

.chip--warning {
  background: var(--warning-bg);
  border-color: var(--warning-border);
}

.tag-contribution-list,
.link-list,
.file-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tag-contribution-item,
.link-item,
.file-item {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: center;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface-overlay) 72%, transparent);
}

.tag-contribution-item strong,
.link-item strong,
.file-item strong {
  display: block;
  margin-bottom: 4px;
}

.profile-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.profile-card {
  border-color: color-mix(in srgb, var(--memory-color) 24%, var(--border-color));
}

.profile-card--boosted {
  box-shadow: 0 16px 40px color-mix(in srgb, var(--warning-color) 22%, transparent);
}

.profile-card--steady {
  box-shadow: 0 16px 40px color-mix(in srgb, var(--success-color) 20%, transparent);
}

.profile-card--warming {
  box-shadow: 0 16px 40px color-mix(in srgb, var(--highlight-text) 14%, transparent);
}

.delta-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.table-wrap {
  overflow-x: auto;
}

.memory-table {
  width: 100%;
  border-collapse: collapse;
}

.memory-table th,
.memory-table td {
  padding: 12px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
  vertical-align: top;
}

.memory-table th {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.memory-table td strong,
.memory-table td small {
  display: block;
}

.link-item__metrics {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-3);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.dual-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.file-list h4 {
  margin: 0 0 var(--space-3);
}

.path-card summary {
  cursor: pointer;
  color: var(--primary-text);
  font-weight: 600;
}

.path-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.path-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.path-item code {
  word-break: break-all;
  padding: 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface-overlay) 72%, transparent);
  border: 1px solid var(--border-color);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: var(--radius-full);
  border: 1px solid transparent;
  font-size: var(--font-size-helper);
  white-space: nowrap;
}

.status-pill--ok {
  color: var(--success-text);
  background: var(--success-bg);
  border-color: var(--success-border);
}

.status-pill--warning {
  color: var(--warning-text);
  background: var(--warning-bg);
  border-color: var(--warning-border);
}

.status-pill--info {
  color: var(--info-text);
  background: var(--info-bg);
  border-color: var(--info-border);
}

.status-pill--muted {
  color: var(--secondary-text);
  background: color-mix(in srgb, var(--surface-overlay) 80%, transparent);
  border-color: var(--border-color);
}

@keyframes codex-memory-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1280px) {
  .summary-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .memory-hero,
  .panel-grid,
  .profile-grid,
  .path-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 820px) {
  .memory-hero__controls,
  .summary-grid,
  .dual-list {
    grid-template-columns: 1fr;
  }

  .panel-header,
  .tag-contribution-item,
  .link-item,
  .file-item {
    flex-direction: column;
    align-items: flex-start;
  }

  .link-item__metrics {
    justify-content: flex-start;
  }

  .memory-table th:nth-child(2),
  .memory-table td:nth-child(2) {
    display: none;
  }
}
</style>
