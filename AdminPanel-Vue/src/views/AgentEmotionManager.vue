<template>
  <section class="config-section active-section emotion-page">
    <div class="emotion-hero card">
      <div class="hero-copy">
        <span class="hero-kicker">
          <span class="material-symbols-outlined">favorite</span>
          OpenHerPersona 轴体观测器
        </span>
        <h2>Agent 心理轴体观测</h2>
        <p class="description">
          可视化每个 Agent 的心理性别、知性轴、感性轴、驱力轴与二级向量残差。当前版本为纯异步观察器，不注入提示词。
        </p>
      </div>
      <div class="hero-actions">
        <button class="btn-secondary" :disabled="isConfigLoading" @click="openConfigModal">
          <span class="material-symbols-outlined">tune</span>
          观测配置
        </button>
        <button class="btn-secondary" :disabled="isLoading" @click="refresh">
          <span class="material-symbols-outlined">refresh</span>
          {{ isLoading ? "刷新中…" : "刷新" }}
        </button>
        <span v-if="statusMessage" :class="['status-message', statusType]">{{ statusMessage }}</span>
      </div>
    </div>

    <div class="overview-grid">
      <div class="overview-card card">
        <span class="overview-label">插件状态</span>
        <strong>{{ overview?.enabled ? "已启用" : "未启用" }}</strong>
        <small>提示注入：{{ overview?.boundaries?.noPromptInjection ? "已移除" : "未知" }} · 模式：纯异步观察</small>
      </div>
      <div class="overview-card card">
        <span class="overview-label">记录 Agent</span>
        <strong>{{ validAgents.length }}</strong>
        <small>最近：{{ validAgents[0]?.summary.agentLabel || "无" }}</small>
      </div>
      <div class="overview-card card">
        <span class="overview-label">算法边界</span>
        <strong>{{ overview?.boundaries?.noKeywordHeuristic ? "已重构" : "未知" }}</strong>
        <small>无时间衰减 · 无关键词启发</small>
      </div>
      <div class="overview-card card">
        <span class="overview-label">存储形态</span>
        <strong>SQLite 轴状态</strong>
        <small>每 Agent 独立二级锚点</small>
      </div>
    </div>

    <div v-if="isLoading && validAgents.length === 0" class="empty-state card">
      <span class="loading-spinner loading-spinner--sm"></span>
      <p>正在读取 Agent 轴体状态…</p>
    </div>

    <div v-else-if="validAgents.length === 0" class="empty-state card">
      <span class="material-symbols-outlined">sentiment_neutral</span>
      <p>暂未记录任何 Agent 轴体状态。</p>
      <small>当 OpenHerPersona 识别到 Agent 身份并处理对话后，这里会出现对应条目。</small>
    </div>

    <div v-else class="emotion-layout">
      <aside class="agent-list card">
        <div class="panel-title">
          <span class="material-symbols-outlined">groups</span>
          Agent 列表
        </div>
        <button
          v-for="agent in validAgents"
          :key="agent.summary.agentKey"
          type="button"
          :class="['agent-tab', { active: selectedAgentKey === agent.summary.agentKey }]"
          @click="selectedAgentKey = agent.summary.agentKey"
        >
          <span class="agent-avatar">{{ initials(agent.summary.agentLabel) }}</span>
          <span class="agent-tab-main">
            <strong>{{ agent.summary.agentLabel }}</strong>
            <small>{{ agent.summary.observationCount ?? agent.summary.turnCount ?? 0 }} 次观测 · {{ relativeTime(agent.summary.lastObservedAt || agent.summary.lastActiveAt || agent.summary.updatedAt) }}</small>
          </span>
          <span class="mood-dot" :style="{ background: moodColor(agent.status?.state?.mood) }"></span>
        </button>
      </aside>

      <main v-if="selectedAgent?.status?.state" class="agent-detail">
        <div class="agent-header card" :style="agentHeaderStyle">
          <div>
            <span class="hero-kicker">
              <span class="material-symbols-outlined">psychology_alt</span>
              纯异步观察 · {{ state.mood.label }}
            </span>
            <h2>{{ state.agentLabel }}</h2>
            <p>{{ moodDescription }}</p>
          </div>
          <div class="mood-orb" :style="{ '--mood-color': moodColor(state.mood) }">
            <strong>{{ state.mood.label }}</strong>
            <span>正性 {{ formatPercent(state.mood.positive) }}</span>
            <span>负性 {{ formatPercent(state.mood.negative) }}</span>
            <span>唤醒 {{ formatPercent(state.mood.arousal) }}</span>
          </div>
        </div>

        <div class="metric-grid">
          <div class="metric-card card">
            <span class="metric-label">观测次数</span>
            <strong>{{ state.observationCount }}</strong>
            <small>最近观测：{{ formatDate(state.lastObservedAt) }}</small>
          </div>
          <div class="metric-card card">
            <span class="metric-label">心理性别轴</span>
            <strong>{{ formatPercent(state.psyGender) }}</strong>
            <small>雌性倾向 ⇄ 雄性/中性/流动态</small>
          </div>
          <div class="metric-card card">
            <span class="metric-label">情绪张力</span>
            <strong>{{ formatPercent(state.mood.tension) }}</strong>
            <small>正负情绪并存，不做对冲抵消</small>
          </div>
          <div class="metric-card card">
            <span class="metric-label">队列状态</span>
            <strong>{{ selectedAgent?.status?.queue.running ? "运行中" : "空闲" }}</strong>
            <small>待处理：{{ selectedAgent?.status?.queue.pending ?? 0 }}</small>
          </div>
        </div>

        <div class="visual-grid">
          <section class="card emotion-panel">
            <div class="panel-title">
              <span class="material-symbols-outlined">local_fire_department</span>
              驱力轴
            </div>
            <div class="bar-list">
              <div v-for="item in driveItems" :key="item.key" class="bar-row">
                <div class="bar-meta">
                  <span>{{ item.label }}</span>
                  <strong>{{ formatPercent(item.value) }}</strong>
                </div>
                <div class="bar-track">
                  <div class="bar-fill drive" :style="{ width: `${item.value * 100}%` }"></div>
                </div>
                <small>激活 {{ formatPercent(item.activation) }} · 锐度 {{ formatPercent(item.sharpness) }}</small>
              </div>
            </div>
          </section>

          <section class="card emotion-panel">
            <div class="panel-title">
              <span class="material-symbols-outlined">graphic_eq</span>
              知性轴
            </div>
            <div class="signal-cloud">
              <div
                v-for="item in signalItems"
                :key="item.key"
                class="signal-chip"
                :style="{ '--strength': item.value }"
              >
                <span>{{ item.label }}</span>
                <strong>{{ formatPercent(item.value) }}</strong>
                <small>激活 {{ formatPercent(item.activation) }} · 锐度 {{ formatPercent(item.sharpness) }}</small>
              </div>
            </div>
          </section>

          <section class="card emotion-panel">
            <div class="panel-title">
              <span class="material-symbols-outlined">radar</span>
              感性轴
            </div>
            <div class="context-grid">
              <div v-for="item in contextItems" :key="item.key" class="context-cell">
                <span>{{ item.label }}</span>
                <div class="mini-gauge">
                  <i :style="{ width: `${item.value * 100}%` }"></i>
                </div>
                <strong>{{ formatPercent(item.value) }}</strong>
              </div>
            </div>
          </section>

          <section class="card emotion-panel">
            <div class="panel-title">
              <span class="material-symbols-outlined">auto_awesome</span>
              最近二级残差
            </div>
            <div class="expression-card">
              <div v-for="item in subAxisItems" :key="`${item.axis}-${item.subAxis}`" class="sub-axis-row">
                <span>{{ item.axisLabel }} / {{ item.subAxis }}</span>
                <strong>{{ formatPercent(item.weight) }}</strong>
                <small>相似度 {{ item.similarity.toFixed(4) }}</small>
              </div>
              <p v-if="subAxisItems.length === 0" class="description">暂无二级残差记录，等待下一次向量观测。</p>
            </div>
          </section>
        </div>

        <section class="card delta-panel">
          <div class="panel-title">
            <span class="material-symbols-outlined">history</span>
            最近观测快照
          </div>
          <div v-if="state.lastObservation" class="delta-grid">
            <div>
              <span>输入指纹</span>
              <strong>{{ state.lastObservation.inputHash || "unknown" }}</strong>
            </div>
            <div>
              <span>观测时间</span>
              <strong>{{ formatDate(state.lastObservation.at) }}</strong>
            </div>
            <div class="delta-reason">
              <span>心境</span>
              <strong>{{ state.lastObservation.mood?.label || state.mood.label }}</strong>
            </div>
          </div>
          <p v-else class="description">暂无观测快照。</p>
        </section>

        <div class="action-row card">
          <button class="btn-secondary" :disabled="isActionRunning" @click="tickSelected">
            <span class="material-symbols-outlined">update</span>
            手动刷新快照
          </button>
          <button class="btn-danger" :disabled="isActionRunning" @click="resetSelected">
            <span class="material-symbols-outlined">restart_alt</span>
            重置该 Agent 轴状态
          </button>
        </div>
      </main>

      <main v-else class="agent-detail">
        <div class="empty-state card">
          <span class="material-symbols-outlined">error</span>
          <p>该 Agent 状态读取失败。</p>
          <small>{{ selectedAgent?.error || "未知错误" }}</small>
        </div>
      </main>
    </div>

    <div v-if="showConfigModal" class="config-modal-backdrop" @click.self="closeConfigModal">
      <div class="config-modal card" role="dialog" aria-modal="true" aria-label="OpenHerPersona 配置">
        <div class="config-modal-header">
          <div>
            <span class="hero-kicker">
              <span class="material-symbols-outlined">settings_heart</span>
              JSON 配置 · {{ configSourceLabel }}
            </span>
            <h2>OpenHerPersona 观测配置</h2>
            <p class="description">配置已从 env 迁移到插件 state 目录 JSON。当前算法为异步观测，不再注入提示词或 persona_delta。</p>
          </div>
          <button class="icon-btn" type="button" aria-label="关闭配置" @click="closeConfigModal">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>

        <div v-if="isConfigLoading" class="empty-state config-loading">
          <span class="loading-spinner loading-spinner--sm"></span>
          <p>正在读取 JSON 配置…</p>
        </div>

        <form v-else class="config-form" @submit.prevent="saveConfig">
          <div class="config-path">
            <span class="material-symbols-outlined">folder</span>
            <code>{{ configPath || "Plugin/OpenHerPersona/state/openher-persona-config.json" }}</code>
          </div>

          <div class="config-grid">
            <label v-for="item in configItems" :key="item.key" class="config-item">
              <span class="config-item-copy">
                <strong>{{ item.schema.label || item.key }}</strong>
                <small>{{ item.schema.description || item.key }}</small>
              </span>

              <span v-if="item.schema.type === 'boolean'" class="switch">
                <input v-model="configDraft[item.key]" type="checkbox" />
                <span class="slider"></span>
              </span>

              <select
                v-else-if="item.schema.type === 'select'"
                v-model="configDraft[item.key]"
                class="config-control"
              >
                <option v-for="option in item.schema.options || []" :key="option" :value="option">
                  {{ option }}
                </option>
              </select>

              <input
                v-else
                v-model.number="configDraft[item.key]"
                class="config-control"
                type="number"
                :min="item.schema.min"
                :max="item.schema.max"
                :step="item.schema.step || (item.schema.type === 'integer' ? 1 : 0.01)"
              />
            </label>
          </div>

          <div class="config-modal-actions">
            <button class="btn-secondary" type="button" @click="resetConfigDraft">
              <span class="material-symbols-outlined">undo</span>
              还原
            </button>
            <button class="btn-primary" type="submit" :disabled="isConfigSaving">
              <span class="material-symbols-outlined">save</span>
              {{ isConfigSaving ? "保存中…" : "保存配置" }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  openHerPersonaApi,
  type OpenHerPersonaAdminAgent,
  type OpenHerPersonaAdminStatus,
  type OpenHerPersonaConfigResponse,
  type OpenHerPersonaConfigSchemaEntry,
  type OpenHerPersonaMood,
  type OpenHerPersonaState,
} from "@/api";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";

const DRIVE_LABELS: Record<string, string> = {
  curiosity: "好奇",
  fear: "恐惧",
  libido: "性欲",
  hedonia: "享乐",
};

const SIGNAL_LABELS: Record<string, string> = {
  inquiry: "求知",
  discernment: "分辨",
  refusal: "拒绝",
};

const CONTEXT_LABELS: Record<string, string> = {
  positive: "正性情绪",
  negative: "负性情绪",
  arousal: "唤醒",
};

const status = ref<OpenHerPersonaAdminStatus | null>(null);
const selectedAgentKey = ref("");
const isLoading = ref(false);
const isActionRunning = ref(false);
const statusMessage = ref("");
const statusType = ref<"info" | "success" | "error">("info");
const showConfigModal = ref(false);
const isConfigLoading = ref(false);
const isConfigSaving = ref(false);
const configResponse = ref<OpenHerPersonaConfigResponse | null>(null);
const configDraft = ref<Record<string, boolean | number | string>>({});

const overview = computed(() => status.value?.overview || null);
const validAgents = computed(() => status.value?.agents || []);
const selectedAgent = computed<OpenHerPersonaAdminAgent | undefined>(() => {
  return validAgents.value.find((agent) => agent.summary.agentKey === selectedAgentKey.value) || validAgents.value[0];
});
const state = computed<OpenHerPersonaState>(() => selectedAgent.value!.status!.state!);

function axisItems(layer: OpenHerPersonaState["drive"], labels: Record<string, string>) {
  return Object.entries(layer || {}).map(([key, axis]) => ({
    key,
    label: labels[key] || key,
    value: Number(axis.value) || 0,
    activation: Number(axis.activation) || 0,
    sharpness: Number(axis.sharpness) || 0,
    subAxes: axis.subAxes || {},
  }));
}

const driveItems = computed(() => axisItems(state.value.drive, DRIVE_LABELS));

const signalItems = computed(() => axisItems(state.value.cognitive, SIGNAL_LABELS));

const contextItems = computed(() => axisItems(state.value.affective, CONTEXT_LABELS));

const subAxisItems = computed(() =>
  [...driveItems.value, ...signalItems.value, ...contextItems.value]
    .flatMap((axis) =>
      Object.entries(axis.subAxes).map(([subAxis, score]) => ({
        axis: axis.key,
        axisLabel: axis.label,
        subAxis,
        similarity: Number(score.similarity) || 0,
        weight: Number(score.weight) || 0,
      }))
    )
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
);

const moodDescription = computed(() => {
  const topCognitive = signalItems.value
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
    .map((item) => item.label)
    .join("、") || "平稳";
  const topDrive = driveItems.value
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
    .map((item) => item.label)
    .join("、") || "无明显驱力";
  return `当前心境为「${state.value.mood.label}」，知性主轴：${topCognitive}；驱力热点：${topDrive}。`;
});

const agentHeaderStyle = computed(() => ({
  "--agent-mood-color": moodColor(state.value.mood),
}));

const configItems = computed(() =>
  Object.entries(configResponse.value?.schema || {}).map(([key, schema]) => ({
    key,
    schema: schema as OpenHerPersonaConfigSchemaEntry,
  }))
);

const configPath = computed(() => configResponse.value?.path || "");
const configSourceLabel = computed(() => configResponse.value?.sourceOfTruth === "json" ? "JSON 为真相" : "运行时配置");

watch(validAgents, (agents) => {
  if (!agents.length) {
    selectedAgentKey.value = "";
    return;
  }
  if (!selectedAgentKey.value || !agents.some((agent) => agent.summary.agentKey === selectedAgentKey.value)) {
    selectedAgentKey.value = agents[0].summary.agentKey;
  }
});

async function loadStatus(silent = false): Promise<void> {
  isLoading.value = true;
  if (!silent) {
    statusMessage.value = "正在加载情绪状态…";
    statusType.value = "info";
  }

  try {
    status.value = await openHerPersonaApi.getStatus();
    statusMessage.value = `已加载 ${validAgents.value.length} 个 Agent`;
    statusType.value = "success";
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `加载失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  } finally {
    isLoading.value = false;
  }
}

async function refresh(): Promise<void> {
  await loadStatus();
}

async function tickSelected(): Promise<void> {
  if (!selectedAgent.value) return;
  isActionRunning.value = true;
  try {
    await openHerPersonaApi.tickAgent(selectedAgent.value.summary.agentKey, selectedAgent.value.summary.agentLabel, {
      loadingKey: "openher-persona.tick",
    });
    showMessage("手动 Tick 已完成", "success");
    await loadStatus(true);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`Tick 失败：${errorMessage}`, "error");
  } finally {
    isActionRunning.value = false;
  }
}

async function resetSelected(): Promise<void> {
  if (!selectedAgent.value) return;
  const confirmed = await askConfirm({
    message: `确定要重置「${selectedAgent.value.summary.agentLabel}」的 OpenHerPersona 情绪状态吗？`,
    danger: true,
    confirmText: "重置",
  });
  if (!confirmed) return;

  isActionRunning.value = true;
  try {
    await openHerPersonaApi.resetAgent(selectedAgent.value.summary.agentKey, selectedAgent.value.summary.agentLabel, {
      loadingKey: "openher-persona.reset",
    });
    showMessage("Agent 情绪已重置", "success");
    await loadStatus(true);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`重置失败：${errorMessage}`, "error");
  } finally {
    isActionRunning.value = false;
  }
}

async function openConfigModal(): Promise<void> {
  showConfigModal.value = true;
  await loadConfig();
}

function closeConfigModal(): void {
  showConfigModal.value = false;
}

async function loadConfig(): Promise<void> {
  isConfigLoading.value = true;
  try {
    configResponse.value = await openHerPersonaApi.getConfig();
    resetConfigDraft();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`加载 OpenHerPersona 配置失败：${errorMessage}`, "error");
  } finally {
    isConfigLoading.value = false;
  }
}

function resetConfigDraft(): void {
  configDraft.value = { ...(configResponse.value?.config || {}) };
}

async function saveConfig(): Promise<void> {
  isConfigSaving.value = true;
  try {
    configResponse.value = await openHerPersonaApi.saveConfig(configDraft.value, {
      loadingKey: "openher-persona.config.save",
    });
    resetConfigDraft();
    showMessage("OpenHerPersona 配置已保存，插件将热加载 JSON 配置", "success");
    await loadStatus(true);
    closeConfigModal();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`保存 OpenHerPersona 配置失败：${errorMessage}`, "error");
  } finally {
    isConfigSaving.value = false;
  }
}

function formatPercent(value: number): string {
  const normalized = Number.isFinite(value) ? value : 0;
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}%`;
}

function formatDate(value?: string | null): string {
  if (!value) return "无记录";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString("zh-CN");
}

function relativeTime(value?: string | null): string {
  if (!value) return "无活跃记录";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const diff = Date.now() - time;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function initials(name: string): string {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

function moodColor(mood?: OpenHerPersonaMood): string {
  const positive = mood?.positive ?? 0.5;
  const negative = mood?.negative ?? 0.25;
  const arousal = mood?.arousal ?? 0.5;
  const hue = 205 - positive * 85 + negative * 45 + arousal * 18;
  const saturation = 52 + arousal * 36;
  const lightness = 42 + positive * 16 - negative * 8;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

onMounted(() => {
  void loadStatus();
});
</script>

<style scoped>
.emotion-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.emotion-hero {
  display: flex;
  justify-content: space-between;
  gap: var(--space-5);
  overflow: hidden;
  position: relative;
  background:
    radial-gradient(circle at top left, color-mix(in srgb, var(--highlight-text) 22%, transparent), transparent 34%),
    linear-gradient(135deg, var(--secondary-bg), color-mix(in srgb, var(--tertiary-bg) 70%, transparent));
}

.emotion-hero::after {
  content: "";
  position: absolute;
  inset: auto -8% -60% auto;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--highlight-text) 18%, transparent), transparent 70%);
  pointer-events: none;
}

.hero-copy,
.hero-actions {
  position: relative;
  z-index: 1;
}

.hero-copy h2,
.agent-header h2 {
  margin: var(--space-2) 0;
  font-size: var(--font-size-headline);
}

.hero-kicker {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--highlight-text);
  font-weight: 700;
  font-size: var(--font-size-helper);
}

.hero-actions {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.overview-grid,
.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
}

.overview-card,
.metric-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.overview-card strong,
.metric-card strong {
  font-size: var(--font-size-display);
}

.overview-label,
.metric-label {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.overview-card small,
.metric-card small,
.agent-tab small {
  color: var(--secondary-text);
}

.empty-state {
  display: flex;
  min-height: 220px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  text-align: center;
  color: var(--secondary-text);
}

.empty-state .material-symbols-outlined {
  font-size: var(--font-size-icon-empty-lg);
  color: var(--highlight-text);
  opacity: 0.72;
}

.emotion-layout {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.agent-list {
  position: sticky;
  top: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.panel-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  font-size: var(--font-size-title);
  font-weight: 700;
}

.agent-tab {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 10px;
  gap: var(--space-3);
  align-items: center;
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
  color: var(--primary-text);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast),
    transform var(--transition-fast);
}

.agent-tab:hover,
.agent-tab.active {
  border-color: color-mix(in srgb, var(--highlight-text) 60%, transparent);
  background: color-mix(in srgb, var(--highlight-text) 12%, transparent);
  transform: translateY(-1px);
}

.agent-avatar {
  display: inline-flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--highlight-text) 18%, transparent);
  color: var(--highlight-text);
  font-weight: 800;
}

.agent-tab-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.agent-tab-main strong,
.agent-tab-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mood-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: 0 0 16px currentColor;
}

.agent-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}

.agent-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-5);
  align-items: center;
  background:
    radial-gradient(circle at 92% 16%, color-mix(in srgb, var(--agent-mood-color) 34%, transparent), transparent 34%),
    var(--secondary-bg);
}

.mood-orb {
  --mood-color: var(--highlight-text);
  flex: 0 0 170px;
  height: 170px;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  background:
    radial-gradient(circle at 35% 25%, color-mix(in srgb, white 36%, transparent), transparent 28%),
    radial-gradient(circle, color-mix(in srgb, var(--mood-color) 64%, transparent), color-mix(in srgb, var(--mood-color) 16%, transparent));
  box-shadow:
    inset 0 0 24px color-mix(in srgb, white 16%, transparent),
    0 0 40px color-mix(in srgb, var(--mood-color) 42%, transparent);
}

.mood-orb strong {
  font-size: var(--font-size-title);
}

.mood-orb span {
  font-size: var(--font-size-caption);
}

.visual-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-5);
}

.emotion-panel {
  min-height: 320px;
}

.bar-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.bar-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}

.bar-track,
.mini-gauge {
  height: 10px;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: var(--surface-overlay-strong);
}

.bar-fill,
.mini-gauge i {
  display: block;
  height: 100%;
  border-radius: inherit;
}

.bar-fill.drive {
  background: linear-gradient(90deg, var(--highlight-text), var(--warning-color), var(--danger-color));
}

.trend {
  display: inline-block;
  margin-top: 5px;
  font-size: var(--font-size-caption);
}

.trend.stable {
  color: var(--secondary-text);
}

.trend.up {
  color: var(--warning-text);
}

.trend.down {
  color: var(--success-text);
}

.signal-cloud {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.signal-chip {
  --strength: 0.5;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--highlight-text) calc(var(--strength) * 56%), var(--border-color));
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--highlight-text) calc(var(--strength) * 22%), transparent), transparent),
    var(--surface-overlay-soft);
}

.signal-chip strong {
  font-size: var(--font-size-emphasis);
}

.context-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.context-cell {
  display: grid;
  grid-template-columns: 64px 1fr 48px;
  gap: var(--space-2);
  align-items: center;
  font-size: var(--font-size-helper);
}

.mini-gauge i {
  background: linear-gradient(90deg, var(--success-color), var(--highlight-text));
}

.expression-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.expression-mode {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.expression-mode .material-symbols-outlined {
  display: inline-flex;
  width: 58px;
  height: 58px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--highlight-text) 16%, transparent);
  color: var(--highlight-text);
}

.expression-mode div {
  display: flex;
  flex-direction: column;
}

.expression-tags {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.expression-tags span {
  padding: 6px 10px;
  border-radius: var(--radius-full);
  color: var(--secondary-text);
  background: var(--surface-overlay);
  font-size: var(--font-size-caption);
}

.expression-tags span.active {
  color: var(--success-text);
  background: var(--success-bg);
}

.model-choice {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.delta-grid {
  display: grid;
  grid-template-columns: 160px 220px minmax(0, 1fr);
  gap: var(--space-4);
}

.delta-grid div {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.delta-grid span {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.delta-reason strong {
  overflow-wrap: anywhere;
}

.action-row {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
  flex-wrap: wrap;
}

.config-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-index-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  background: var(--overlay-backdrop);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.config-modal {
  width: min(980px, 100%);
  max-height: min(820px, calc(100vh - 48px));
  overflow: auto;
  background:
    radial-gradient(circle at top right, color-mix(in srgb, var(--highlight-text) 20%, transparent), transparent 32%),
    var(--secondary-bg);
  box-shadow: var(--overlay-panel-shadow);
}

.config-modal-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: flex-start;
  margin-bottom: var(--space-4);
}

.config-modal-header h2 {
  margin: var(--space-2) 0;
  font-size: var(--font-size-display);
}

.icon-btn {
  display: inline-flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  color: var(--primary-text);
  background: var(--surface-overlay);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--surface-overlay-strong);
}

.config-loading {
  min-height: 180px;
}

.config-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.config-path {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  overflow-wrap: anywhere;
}

.config-path code {
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.config-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
}

.config-item-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.config-item-copy small {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.config-control {
  min-width: 140px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--primary-text);
  background: var(--input-bg);
  font: inherit;
}

.config-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-color);
}

@media (max-width: 1180px) {
  .overview-grid,
  .metric-grid,
  .visual-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .emotion-layout {
    grid-template-columns: 1fr;
  }

  .agent-list {
    position: static;
  }
}

@media (max-width: 720px) {
  .emotion-hero,
  .agent-header {
    flex-direction: column;
    align-items: stretch;
  }

  .overview-grid,
  .metric-grid,
  .visual-grid,
  .signal-cloud,
  .config-grid,
  .context-grid,
  .delta-grid {
    grid-template-columns: 1fr;
  }

  .mood-orb {
    align-self: center;
  }

  .context-cell {
    grid-template-columns: 64px 1fr 44px;
  }

  .action-row,
  .config-modal-actions {
    flex-direction: column;
  }

  .config-item {
    grid-template-columns: 1fr;
  }

  .config-control {
    width: 100%;
  }
}
</style>