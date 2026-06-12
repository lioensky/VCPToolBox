<template>
  <section class="config-section active-section emotion-page">
    <div class="emotion-hero card">
      <div class="hero-copy">
        <span class="hero-kicker">
          <span class="material-symbols-outlined">favorite</span>
          OpenHerPersona 情绪数据库
        </span>
        <h2>Agent 情绪管理</h2>
        <p class="description">
          可视化每个 Agent 的心境、驱力热度、人格信号、表达倾向与相变状态。数据来自 OpenHerPersona 的本地状态库。
        </p>
      </div>
      <div class="hero-actions">
        <button class="btn-secondary" :disabled="isConfigLoading" @click="openConfigModal">
          <span class="material-symbols-outlined">tune</span>
          情绪配置
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
        <small>提示注入：{{ overview?.hintEnabled ? "开启" : "关闭" }} · 观察模式：{{ overview?.observeOnly ? "是" : "否" }}</small>
      </div>
      <div class="overview-card card">
        <span class="overview-label">记录 Agent</span>
        <strong>{{ validAgents.length }}</strong>
        <small>活跃：{{ overview?.activeAgent?.agentLabel || "无" }}</small>
      </div>
      <div class="overview-card card">
        <span class="overview-label">语义上下文</span>
        <strong>{{ overview?.semanticContext?.enabled ? "开启" : "关闭" }}</strong>
        <small>权重 {{ formatPercent(overview?.semanticContext?.weight ?? 0) }} · {{ overview?.semanticContext?.provider || "unknown" }}</small>
      </div>
      <div class="overview-card card">
        <span class="overview-label">ContextBridge</span>
        <strong>{{ overview?.contextBridgeAvailable ? "可用" : "不可用" }}</strong>
        <small>锚点：{{ overview?.semanticContext?.anchorsReady ? "Ready" : "Pending" }}</small>
      </div>
    </div>

    <div v-if="isLoading && validAgents.length === 0" class="empty-state card">
      <span class="loading-spinner loading-spinner--sm"></span>
      <p>正在读取 Agent 情绪状态…</p>
    </div>

    <div v-else-if="validAgents.length === 0" class="empty-state card">
      <span class="material-symbols-outlined">sentiment_neutral</span>
      <p>暂未记录任何 Agent 情绪状态。</p>
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
            <small>{{ agent.summary.turnCount }} 轮 · {{ relativeTime(agent.summary.lastActiveAt || agent.summary.updatedAt) }}</small>
          </span>
          <span class="mood-dot" :style="{ background: moodColor(agent.status?.state.mood) }"></span>
        </button>
      </aside>

      <main v-if="selectedAgent?.status?.state" class="agent-detail">
        <div class="agent-header card" :style="agentHeaderStyle">
          <div>
            <span class="hero-kicker">
              <span class="material-symbols-outlined">psychology_alt</span>
              {{ state.phase.name }} · {{ state.expression.label }}
            </span>
            <h2>{{ state.agentLabel }}</h2>
            <p>{{ moodDescription }}</p>
          </div>
          <div class="mood-orb" :style="{ '--mood-color': moodColor(state.mood) }">
            <strong>{{ state.mood.label }}</strong>
            <span>愉悦 {{ formatPercent(state.mood.valence) }}</span>
            <span>激活 {{ formatPercent(state.mood.arousal) }}</span>
          </div>
        </div>

        <div class="metric-grid">
          <div class="metric-card card">
            <span class="metric-label">对话轮次</span>
            <strong>{{ state.turnCount }}</strong>
            <small>最近活跃：{{ formatDate(state.lastActiveAt) }}</small>
          </div>
          <div class="metric-card card">
            <span class="metric-label">相变压力</span>
            <strong>{{ formatPercent(state.phase.charge / 1.2) }}</strong>
            <small>{{ phaseText }}</small>
          </div>
          <div class="metric-card card">
            <span class="metric-label">表达强度</span>
            <strong>{{ formatPercent(state.expression.intensity) }}</strong>
            <small>{{ state.expression.reason || "无记录" }}</small>
          </div>
          <div class="metric-card card">
            <span class="metric-label">冷却周期</span>
            <strong>{{ state.cooldown.minutes || 0 }}m</strong>
            <small>上次冲动：{{ formatDate(state.cooldown.lastImpulseAt) }}</small>
          </div>
        </div>

        <div class="visual-grid">
          <section class="card emotion-panel">
            <div class="panel-title">
              <span class="material-symbols-outlined">local_fire_department</span>
              五维驱力热度
            </div>
            <div class="bar-list">
              <div v-for="item in driveItems" :key="item.key" class="bar-row">
                <div class="bar-meta">
                  <span>{{ item.label }}</span>
                  <strong>{{ item.value.toFixed(2) }}/5</strong>
                </div>
                <div class="bar-track">
                  <div class="bar-fill drive" :style="{ width: `${(item.value / 5) * 100}%` }"></div>
                </div>
                <small :class="trendClass(item.trend)">{{ trendText(item.trend, "升温", "回落") }}</small>
              </div>
            </div>
          </section>

          <section class="card emotion-panel">
            <div class="panel-title">
              <span class="material-symbols-outlined">graphic_eq</span>
              八维人格信号
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
                <small :class="trendClass(item.trend)">{{ trendText(item.trend, "增强", "收束") }}</small>
              </div>
            </div>
          </section>

          <section class="card emotion-panel">
            <div class="panel-title">
              <span class="material-symbols-outlined">radar</span>
              当前语境雷达
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
              表达倾向
            </div>
            <div class="expression-card">
              <div class="expression-mode">
                <span class="material-symbols-outlined">{{ expressionIcon }}</span>
                <div>
                  <strong>{{ state.expression.label }}</strong>
                  <small>{{ paceLabel(state.expression.pace) }} · {{ state.expression.burst ? "分条倾向" : "连续表达" }}</small>
                </div>
              </div>
              <div class="expression-tags">
                <span :class="{ active: state.expression.emoji }">表情感</span>
                <span :class="{ active: state.expression.burst }">即时分条</span>
                <span :class="{ active: state.expression.silence }">静默</span>
              </div>
              <p>{{ state.expression.reason || "表达原因尚未记录" }}</p>
              <p v-if="state.expression.modelChoice" class="model-choice">
                模型回填：{{ state.expression.modelChoice.mode || "unknown" }} /
                {{ paceLabel(state.expression.modelChoice.pace || "balanced") }} /
                {{ formatPercent(state.expression.modelChoice.intensity || 0) }}
              </p>
            </div>
          </section>
        </div>

        <section class="card delta-panel">
          <div class="panel-title">
            <span class="material-symbols-outlined">history</span>
            最近情绪回填
          </div>
          <div v-if="state.lastAppliedPersonaDelta" class="delta-grid">
            <div>
              <span>影响等级</span>
              <strong>{{ state.lastAppliedPersonaDelta.impact || "unknown" }}</strong>
            </div>
            <div>
              <span>记录时间</span>
              <strong>{{ formatDate(state.lastAppliedPersonaDelta.at) }}</strong>
            </div>
            <div class="delta-reason">
              <span>原因</span>
              <strong>{{ state.lastAppliedPersonaDelta.reason || "未提供" }}</strong>
            </div>
          </div>
          <p v-else class="description">暂无 persona_delta 回填记录。</p>
        </section>

        <div class="action-row card">
          <button class="btn-secondary" :disabled="isActionRunning" @click="tickSelected">
            <span class="material-symbols-outlined">update</span>
            手动 Tick
          </button>
          <button class="btn-danger" :disabled="isActionRunning" @click="resetSelected">
            <span class="material-symbols-outlined">restart_alt</span>
            重置该 Agent 情绪
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
            <h2>OpenHerPersona 配置</h2>
            <p class="description">配置已从 env 迁移到插件 state 目录 JSON，保存后立即写入并由插件热加载生效。</p>
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
  connection: "联结",
  novelty: "新鲜",
  expression: "表达",
  safety: "安全",
  play: "玩闹",
};

const SIGNAL_LABELS: Record<string, string> = {
  directness: "直接度",
  vulnerability: "坦露度",
  playfulness: "玩闹度",
  initiative: "主动度",
  depth: "深度",
  warmth: "温暖度",
  defiance: "倔强度",
  curiosity: "好奇度",
};

const CONTEXT_LABELS: Record<string, string> = {
  engagement: "投入",
  constraint: "约束",
  technicality: "技术性",
  playfulness: "玩笑",
  affection: "亲昵",
  urgency: "紧迫",
  novelty: "新鲜",
  depth: "深度",
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
const state = computed<OpenHerPersonaState>(() => selectedAgent.value!.status!.state);

const driveItems = computed(() =>
  Object.entries(state.value.frustration || {}).map(([key, value]) => ({
    key,
    label: DRIVE_LABELS[key] || key,
    value: Number(value) || 0,
    trend: Number(state.value.trends?.frustration?.[key]) || 0,
  }))
);

const signalItems = computed(() =>
  Object.entries(state.value.signals || {}).map(([key, value]) => ({
    key,
    label: SIGNAL_LABELS[key] || key,
    value: Number(value) || 0,
    trend: Number(state.value.trends?.signals?.[key]) || 0,
  }))
);

const contextItems = computed(() =>
  Object.entries(state.value.genome?.lastContext || {}).map(([key, value]) => ({
    key,
    label: CONTEXT_LABELS[key] || key,
    value: Number(value) || 0,
  }))
);

const moodDescription = computed(() => {
  const topSignals = state.value.topSignals?.map((item) => item.label).join("、") || "平稳";
  const topDrives = state.value.topFrustration?.map((item) => item.label).join("、") || "无明显热度";
  return `当前心境为「${state.value.mood.label}」，主要信号：${topSignals}；驱力热点：${topDrives}。`;
});

const phaseText = computed(() => {
  const phase = state.value.phase.name;
  if (phase === "eruption") return "爆发态：短时强烈表达";
  if (phase === "cooling") return "冷却态：防御与回落";
  if (phase === "strained") return "紧绷态：压力积累";
  return "稳定态：压力平稳";
});

const expressionIcon = computed(() => {
  const mode = state.value.expression.mode;
  if (mode === "emoji_like") return "mood";
  if (mode === "voice_like") return "record_voice_over";
  if (mode === "long_text") return "subject";
  if (mode === "reserved") return "more_horiz";
  return "chat";
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
  const valence = mood?.valence ?? 0.5;
  const arousal = mood?.arousal ?? 0.5;
  const hue = 210 - valence * 110 + arousal * 25;
  const saturation = 55 + arousal * 35;
  const lightness = 48 + valence * 18;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function trendText(value: number, upWord: string, downWord: string): string {
  if (Math.abs(value) < 0.015) return "稳定";
  return `${value > 0 ? upWord : downWord} ${Math.abs(value).toFixed(3)}`;
}

function trendClass(value: number): string {
  if (Math.abs(value) < 0.015) return "trend stable";
  return value > 0 ? "trend up" : "trend down";
}

function paceLabel(pace: string): string {
  const labels: Record<string, string> = {
    short: "短句",
    balanced: "平稳",
    flowing: "流动",
    long: "展开",
  };
  return labels[pace] || pace;
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