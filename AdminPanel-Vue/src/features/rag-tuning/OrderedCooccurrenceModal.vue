<template>
  <BaseModal
    :model-value="modelValue"
    aria-labelledby="ordered-cooccurrence-title"
    @update:modelValue="handleModalVisibility"
  >
    <template #default="{ overlayAttrs, panelAttrs, panelRef }">
      <div v-bind="overlayAttrs" class="ordered-modal">
        <div :ref="panelRef" v-bind="panelAttrs" class="ordered-modal__shell">
          <header class="ordered-modal__header">
            <div class="ordered-modal__hero">
              <span class="ordered-modal__eyebrow">Ordered Bidirectional Potential Manifold</span>
              <div class="ordered-modal__title-row">
                <div>
                  <h3 id="ordered-cooccurrence-title">有序双向势能流形 (V8.2)</h3>
                  <p>
                    按 TagMemo V8.2 的三轴解耦视角调参：形（拓扑）× 色（方向）× 质（语义），并保留叙事方向守卫。
                  </p>
                </div>

                <div class="ordered-modal__badges">
                  <span class="ordered-badge ordered-badge--critical">高风险</span>
                  <span class="ordered-badge ordered-badge--neutral">
                    已改 {{ changedLeaves }}/{{ totalLeaves }}
                  </span>
                </div>
              </div>
            </div>

            <div class="ordered-modal__header-actions">
              <button
                type="button"
                class="btn-secondary"
                :disabled="changedLeaves === 0"
                @click="emit('restore')"
              >
                恢复 V8.2 参数
              </button>
              <button type="button" class="btn-secondary" @click="emit('close')">
                收起流形舱
              </button>
              <button
                type="submit"
                class="btn-primary"
                :form="formId"
                :disabled="isSaving || !isDirty"
              >
                {{ isSaving ? "保存中…" : "保存全部参数" }}
              </button>
            </div>
          </header>

          <div class="ordered-modal__body">
            <aside class="ordered-modal__nav">
              <div class="ordered-sidebar-card">
                <span class="ordered-sidebar-card__label">三轴导航</span>
                <div class="ordered-sidebar-card__nav-list">
                  <button
                    v-for="panel in ORDERED_COOCCURRENCE_PANELS"
                    :key="panel.id"
                    type="button"
                    :class="[
                      'ordered-nav-btn',
                      { 'ordered-nav-btn--active': panel.id === activePanel.id },
                    ]"
                    @click="activePanelId = panel.id"
                  >
                    <span class="material-symbols-outlined">{{ panel.icon }}</span>
                    <span class="ordered-nav-btn__copy">
                      <strong>{{ panel.title }}</strong>
                      <small>{{ panel.axis }} · {{ panelChangeCounts[panel.id] }} 项改动</small>
                    </span>
                  </button>
                </div>
              </div>

              <div class="ordered-sidebar-card">
                <span class="ordered-sidebar-card__label">流形画像（估算）</span>
                <div :class="['ordered-profile', `ordered-profile--${profile.tone}`]">
                  <strong>{{ profile.label }}</strong>
                  <p>{{ profile.summary }}</p>
                  <div class="ordered-profile__meter">
                    <span :style="{ width: `${profile.score * 100}%` }"></span>
                  </div>
                </div>
              </div>

              <div class="ordered-sidebar-card ordered-sidebar-card--compact">
                <span class="ordered-sidebar-card__label">灰度顺序</span>
                <ol class="ordered-phase-list">
                  <li>先校准逆流基础增益 α</li>
                  <li>再观察概念锚 boost β</li>
                  <li>最后启用语义钟形增益 γ</li>
                </ol>
              </div>
            </aside>

            <section class="ordered-modal__workspace">
              <div class="ordered-map">
                <article
                  v-for="item in overviewStats"
                  :key="item.key"
                  :class="['ordered-map__node', `ordered-map__node--${item.tone}`]"
                >
                  <span>{{ item.label }}</span>
                  <strong>{{ item.value }}</strong>
                  <small>{{ item.hint }}</small>
                </article>
              </div>

              <div class="ordered-axis-diagram" aria-label="V8.2 三轴结构图">
                <div class="ordered-axis-diagram__rail">
                  <span>形</span>
                  <strong>拓扑邻接</strong>
                  <small>是否共现</small>
                </div>
                <div class="ordered-axis-diagram__rail">
                  <span>色</span>
                  <strong>顺逆阻尼</strong>
                  <small>叙事方向</small>
                </div>
                <div class="ordered-axis-diagram__rail">
                  <span>质</span>
                  <strong>语义距离</strong>
                  <small>黄金联想区</small>
                </div>
              </div>

              <header class="ordered-panel-header">
                <div>
                  <span class="ordered-panel-header__label">当前轴面</span>
                  <h4>{{ activePanel.title }}</h4>
                  <small>{{ activePanel.axis }}</small>
                </div>
                <p>{{ activePanel.summary }}</p>
              </header>

              <div class="ordered-field-list">
                <article
                  v-for="subKey in activePanel.keys"
                  :key="subKey"
                  :class="[
                    'ordered-field',
                    { 'ordered-field--changed': isFieldChanged(subKey) },
                  ]"
                >
                  <div class="ordered-field__copy">
                    <div class="ordered-field__heading">
                      <div>
                        <h5>{{ getFieldMeta(subKey).label }}</h5>
                        <p class="ordered-field__key">{{ subKey }}</p>
                      </div>

                      <div class="ordered-field__pills">
                        <span
                          v-if="getFieldMeta(subKey).tone"
                          :class="[
                            'ordered-badge',
                            `ordered-badge--${getFieldMeta(subKey).tone}`,
                          ]"
                        >
                          {{ getToneLabel(getFieldMeta(subKey).tone) }}
                        </span>
                        <span
                          v-if="formatDelta(subKey)"
                          class="ordered-badge ordered-badge--changed"
                        >
                          {{ formatDelta(subKey) }}
                        </span>
                      </div>
                    </div>

                    <p class="ordered-field__summary">
                      {{ getFieldMeta(subKey).summary }}
                    </p>

                    <p v-if="getFieldMeta(subKey).range" class="ordered-field__range">
                      {{ getFieldMeta(subKey).range }}
                    </p>

                    <details v-if="getFieldMeta(subKey).logic" class="ordered-field__details">
                      <summary>展开调优逻辑</summary>
                      <p>{{ getFieldMeta(subKey).logic }}</p>
                    </details>
                  </div>

                  <div class="ordered-field__control">
                    <template v-if="isToggleField(subKey)">
                      <div class="ordered-toggle">
                        <button
                          type="button"
                          :class="[
                            'ordered-toggle__option',
                            { 'ordered-toggle__option--active': Number(values[subKey]) === 0 },
                          ]"
                          @click="emit('updateField', subKey, 0)"
                        >
                          关闭
                        </button>
                        <button
                          type="button"
                          :class="[
                            'ordered-toggle__option',
                            { 'ordered-toggle__option--active': Number(values[subKey]) === 1 },
                          ]"
                          @click="emit('updateField', subKey, 1)"
                        >
                          开启
                        </button>
                      </div>
                    </template>

                    <template v-else>
                      <input
                        class="ordered-field__slider"
                        type="range"
                        :aria-label="`${getFieldMeta(subKey).label} 滑杆`"
                        :value="values[subKey]"
                        :min="getSubParamRange(subKey).min"
                        :max="getSubParamRange(subKey).max"
                        :step="getSubParamRange(subKey).step"
                        @input="handleFieldInput(subKey, $event)"
                      />
                    </template>

                    <div class="ordered-field__number-row">
                      <input
                        class="ordered-field__number"
                        type="number"
                        :aria-label="`${getFieldMeta(subKey).label} 数值输入`"
                        :value="values[subKey]"
                        :min="getSubParamRange(subKey).min"
                        :max="getSubParamRange(subKey).max"
                        :step="getSubParamRange(subKey).step"
                        @input="handleFieldInput(subKey, $event)"
                      />
                      <span class="ordered-field__current">{{ formatNumber(values[subKey]) }}</span>
                    </div>
                  </div>
                </article>
              </div>
            </section>

            <aside class="ordered-modal__insights">
              <div class="ordered-sidebar-card">
                <span class="ordered-sidebar-card__label">联动提示</span>
                <ul class="ordered-insight-list">
                  <li v-for="hint in activeHints" :key="hint.title">
                    <strong>{{ hint.title }}</strong>
                    <p>{{ hint.body }}</p>
                  </li>
                </ul>
              </div>

              <div class="ordered-sidebar-card">
                <span class="ordered-sidebar-card__label">未保存修改</span>
                <ul v-if="changedKeys.length > 0" class="ordered-change-list">
                  <li v-for="subKey in changedKeys" :key="subKey">
                    <span>{{ getFieldMeta(subKey).label }}</span>
                    <strong>{{ formatDelta(subKey) }}</strong>
                  </li>
                </ul>
                <p v-else class="ordered-empty-state">
                  当前没有未保存修改。V8.2 参数会重建语义传播地形，建议一次只改一个轴面。
                </p>
              </div>

              <div class="ordered-sidebar-card">
                <span class="ordered-sidebar-card__label">来自 TagMemo V8.2</span>
                <ul class="ordered-insight-list">
                  <li>
                    <strong>形 / 色 / 质正交</strong>
                    <p>拓扑层只管是否邻接，方向层只管顺逆阻尼，语义层只管向量距离调制。</p>
                  </li>
                  <li>
                    <strong>逆流可以存在，但不能篡位</strong>
                    <p>反转守卫让 backwardWeight 永远不超过 forwardWeight 的指定占比。</p>
                  </li>
                </ul>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import BaseModal from "@/components/ui/BaseModal.vue";
import {
  ORDERED_COOCCURRENCE_PANELS,
  ORDERED_COOCCURRENCE_PRIMARY_KEYS,
  getParamMeta,
  getSubParamRange,
  getToneLabel,
  type OrderedCooccurrencePanelId,
  type OrderedCooccurrencePrimaryKey,
  type ParamTone,
} from "@/features/rag-tuning/metadata";

type NumericRecord = Record<string, number>;

interface CouplingHint {
  title: string;
  body: string;
}

const props = defineProps<{
  modelValue: boolean;
  groupName: string;
  paramKey: string;
  values: NumericRecord;
  originalValues: NumericRecord;
  changedLeaves: number;
  totalLeaves: number;
  isSaving: boolean;
  isDirty: boolean;
  formId: string;
}>();

const emit = defineEmits<{
  close: [];
  restore: [];
  updateField: [subKey: string, value: number];
}>();

const activePanelId = ref<OrderedCooccurrencePanelId>(ORDERED_COOCCURRENCE_PANELS[0].id);

const activePanel = computed(
  () =>
    ORDERED_COOCCURRENCE_PANELS.find((panel) => panel.id === activePanelId.value) ??
    ORDERED_COOCCURRENCE_PANELS[0]
);

const changedKeys = computed(() =>
  Object.keys(props.values).filter(
    (subKey) => props.values[subKey] !== props.originalValues[subKey]
  )
);

const panelChangeCounts = computed<Record<OrderedCooccurrencePanelId, number>>(() => {
  const next: Record<OrderedCooccurrencePanelId, number> = {
    topology: 0,
    direction: 0,
    semantic: 0,
    guard: 0,
  };

  for (const panel of ORDERED_COOCCURRENCE_PANELS) {
    next[panel.id] = panel.keys.filter(
      (subKey) => props.values[subKey] !== props.originalValues[subKey]
    ).length;
  }

  return next;
});

const overviewStats = computed(() =>
  ORDERED_COOCCURRENCE_PRIMARY_KEYS.map((subKey) => ({
    key: subKey,
    label: getFieldMeta(subKey).label,
    value: formatNumber(props.values[subKey]),
    hint: getOverviewHint(subKey),
    tone: getFieldTone(subKey),
  }))
);

const profile = computed(() => {
  const reverseGain = normalize(props.values.reverseGain ?? 0.42, 0.3, 0.7);
  const anchorBoost = normalize(props.values.reverseAnchorBoost ?? 1, 0, 1);
  const semanticEnabled = normalize(props.values.semanticGainEnabled ?? 1, 0, 1);
  const guardRisk = 1 - normalize(props.values.reverseInversionGuard ?? 0.95, 0.85, 0.99);
  const peakRisk = Math.abs((props.values.semanticGainPeak ?? 0.65) - 0.65) / 0.25;

  const score = Math.min(
    1,
    reverseGain * 0.35 +
      anchorBoost * 0.18 +
      semanticEnabled * 0.2 +
      guardRisk * 0.17 +
      Math.min(1, peakRisk) * 0.1
  );

  if (score >= 0.7) {
    return {
      tone: "critical" as ParamTone,
      label: "强逆流语义流形",
      summary: "当前配置更愿意回溯概念锚并放大语义黄金区，跨域联想更强，但需要密切观察噪声边与同义词回卷。",
      score,
    };
  }

  if (score <= 0.42) {
    return {
      tone: "stable" as ParamTone,
      label: "保守顺流流形",
      summary: "当前配置更偏向叙事顺流，逆流和语义钟形影响较温和，召回稳定性更高但远距回溯可能偏弱。",
      score,
    };
  }

  return {
    tone: "sensitive" as ParamTone,
    label: "平衡双向流形",
    summary: "当前配置在顺流、逆流和语义钟形之间保持折中，适合常规灰度观察。",
    score,
  };
});

const activeHints = computed<CouplingHint[]>(() => {
  const sourceKeys = changedKeys.value.length > 0 ? changedKeys.value : activePanel.value.keys;
  const hints = sourceKeys
    .map((subKey) => COUPLING_HINTS[subKey])
    .filter((hint): hint is CouplingHint => Boolean(hint));

  return Array.from(new Map(hints.map((hint) => [hint.title, hint])).values());
});

function getFieldMeta(subKey: string) {
  return getParamMeta(props.groupName, `${props.paramKey}.${subKey}`);
}

function getFieldTone(subKey: OrderedCooccurrencePrimaryKey): ParamTone {
  return getFieldMeta(subKey).tone ?? "stable";
}

function getOverviewHint(subKey: OrderedCooccurrencePrimaryKey): string {
  switch (subKey) {
    case "reverseGain":
      return "越高越容易回溯";
    case "reverseAnchorBoost":
      return "概念锚回流开关";
    case "semanticGainEnabled":
      return "钟形语义增益开关";
    case "reverseInversionGuard":
      return "逆流不得篡位";
    default:
      return "关键指标";
  }
}

function isToggleField(subKey: string): boolean {
  return subKey === "reverseAnchorBoost" || subKey === "semanticGainEnabled";
}

function normalize(value: number, min: number, max: number): number {
  if (max <= min) {
    return 0;
  }

  const normalized = (value - min) / (max - min);
  return Math.min(1, Math.max(0, normalized));
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) {
    return "--";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  const precision = Math.abs(value) >= 1 ? 2 : 3;
  return value.toFixed(precision).replace(/\.?0+$/, "");
}

function formatDelta(subKey: string): string | null {
  const originalValue = props.originalValues[subKey];
  const currentValue = props.values[subKey];

  if (originalValue === undefined || currentValue === originalValue) {
    return null;
  }

  const delta = currentValue - originalValue;
  const prefix = delta > 0 ? "+" : "";
  return `${prefix}${formatNumber(delta)}`;
}

function isFieldChanged(subKey: string): boolean {
  return props.values[subKey] !== props.originalValues[subKey];
}

function handleFieldInput(subKey: string, event: Event): void {
  const target = event.target as HTMLInputElement | null;

  if (!target || target.value === "") {
    return;
  }

  const nextValue = Number(target.value);

  if (Number.isNaN(nextValue)) {
    return;
  }

  emit("updateField", subKey, nextValue);
}

function getPreferredPanelId(): OrderedCooccurrencePanelId {
  const changedKeySet = new Set(changedKeys.value);
  const firstChangedPanel = ORDERED_COOCCURRENCE_PANELS.find((panel) =>
    panel.keys.some((subKey) => changedKeySet.has(subKey))
  );

  return firstChangedPanel?.id ?? ORDERED_COOCCURRENCE_PANELS[0].id;
}

function handleModalVisibility(visible: boolean): void {
  if (!visible) {
    emit("close");
  }
}

watch(
  () => props.modelValue,
  (isOpen) => {
    if (!isOpen) {
      return;
    }

    activePanelId.value = getPreferredPanelId();
  }
);

const COUPLING_HINTS: Record<string, CouplingHint> = {
  forwardGain: {
    title: "顺流增益是所有守卫的参照物",
    body: "反转守卫使用 forwardWeight 作为上限基准。除非主路径明显偏弱，否则不建议优先调高 forwardGain。",
  },
  distanceDecay: {
    title: "序位距离衰减会压低长日记首尾共现",
    body: "开启后相邻标签更强、远距离标签更弱。适合标签序列非常长且首尾共现噪声明显的场景。",
  },
  reverseGain: {
    title: "逆流基础增益牵动回溯联想强度",
    body: "调高会让 B→A 更通畅，但应同时观察 maxReverseGain 与 reverseInversionGuard，避免概念回卷。",
  },
  minReverseGain: {
    title: "逆流下限避免回溯被彻底切断",
    body: "下限过高会削弱方向阻尼，下限过低则可能退回 V7 的近似单向行为。",
  },
  maxReverseGain: {
    title: "逆流上限决定概念锚 boost 的天花板",
    body: "如果开启 reverseAnchorBoost 后召回过猛，先收紧 maxReverseGain，再考虑关闭 boost。",
  },
  reverseAnchorBoost: {
    title: "概念锚 boost 适合第二阶段灰度",
    body: "它会让高内生残差标签更容易被回溯召回。建议先验证基础逆流稳定，再打开或调强锚增强。",
  },
  reverseAnchorMax: {
    title: "概念锚最大倍率与逆流上限双重夹逼",
    body: "调高它只会在残差锚足够强时生效，最终仍会被 maxReverseGain 和反转守卫截断。",
  },
  semanticGainEnabled: {
    title: "语义钟形增益是第三阶段灰度",
    body: "开启后会放大概念邻接黄金区，并压制低相似噪声边与高相似同义词回音。",
  },
  semanticGainPeak: {
    title: "峰值位置依赖 embedding 模型分布",
    body: "OpenAI 系通常可从 0.55~0.65 起步；Gemini 分布可能右移，最好先看真实 sim 直方图。",
  },
  semanticGainSigma: {
    title: "钟形宽度决定黄金区容忍度",
    body: "σ 越大平台越宽，更多邻接边获得增益；σ 越小峰值越尖，调参更敏感。",
  },
  semanticGainLowSimFallback: {
    title: "未命中 sim 兜底不等于噪声阈值",
    body: "默认 0.1 用来区别‘未缓存’和‘低于阈值被丢弃’，不建议设为 0。",
  },
  reverseInversionGuard: {
    title: "反转守卫保护叙事方向公理",
    body: "它保证逆流权重不超过顺流指定比例。除非确认顺流被过度压制，否则不要轻易放宽到接近 1。",
  },
};
</script>

<style scoped>
.ordered-modal {
  z-index: var(--z-index-modal);
  padding: var(--space-4);
  background: var(--overlay-backdrop-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.ordered-modal__shell {
  width: min(1520px, calc(100vw - (var(--space-4) * 2)));
  max-height: min(calc(var(--app-viewport-height) - (var(--space-4) * 2)), 980px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--highlight-text) 12%, transparent), transparent 32%),
    linear-gradient(0deg, var(--secondary-bg), var(--secondary-bg)),
    var(--primary-bg);
  box-shadow: var(--overlay-panel-shadow);
}

.ordered-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 28px 22px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--surface-overlay-soft), transparent);
}

.ordered-modal__hero {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.ordered-modal__eyebrow {
  display: inline-flex;
  width: fit-content;
  padding: 6px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--highlight-text) 12%, transparent);
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ordered-modal__title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.ordered-modal__title-row h3 {
  margin: 0;
  font-size: var(--font-size-section-title-strong);
  line-height: 1.1;
}

.ordered-modal__title-row p {
  max-width: 78ch;
  margin: 10px 0 0;
  color: var(--secondary-text);
  line-height: 1.7;
}

.ordered-modal__badges,
.ordered-field__pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ordered-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.ordered-badge--neutral {
  background: var(--tertiary-bg);
  color: var(--secondary-text);
}

.ordered-badge--critical {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.ordered-badge--sensitive {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.ordered-badge--stable {
  background: var(--success-bg);
  color: var(--success-text);
}

.ordered-badge--changed {
  background: var(--info-bg);
  color: var(--info-text);
}

.ordered-modal__header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.ordered-modal__body {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr) 320px;
  gap: 0;
  min-height: 0;
  flex: 1;
}

.ordered-modal__nav,
.ordered-modal__insights {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 22px;
  overflow-y: auto;
  background: var(--surface-overlay-soft);
}

.ordered-modal__nav {
  border-right: 1px solid var(--border-color);
}

.ordered-modal__insights {
  border-left: 1px solid var(--border-color);
}

.ordered-modal__workspace {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  min-height: 0;
  padding: 22px 24px 26px;
  overflow-y: auto;
}

.ordered-sidebar-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 20px;
  background: var(--surface-overlay);
}

.ordered-sidebar-card--compact {
  gap: 10px;
}

.ordered-sidebar-card__label,
.ordered-panel-header__label {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ordered-sidebar-card__nav-list {
  display: grid;
  gap: 10px;
}

.ordered-nav-btn {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--surface-overlay);
  color: var(--primary-text);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    background 0.2s ease;
  text-align: left;
}

.ordered-nav-btn:hover,
.ordered-nav-btn--active {
  border-color: var(--info-border);
  background: var(--info-bg);
  transform: translateY(-1px);
}

.ordered-nav-btn:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.ordered-nav-btn .material-symbols-outlined {
  font-size: var(--font-size-title);
  color: var(--highlight-text);
}

.ordered-nav-btn__copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ordered-nav-btn__copy strong {
  font-size: var(--font-size-body);
}

.ordered-nav-btn__copy small {
  color: var(--secondary-text);
}

.ordered-profile {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ordered-profile--stable,
.ordered-profile--sensitive,
.ordered-profile--critical {
  padding: 12px;
  border-radius: 14px;
  border: 1px solid transparent;
}

.ordered-profile--stable {
  border-color: var(--success-border);
  background: color-mix(in srgb, var(--success-bg) 82%, transparent);
}

.ordered-profile--sensitive {
  border-color: var(--warning-border);
  background: color-mix(in srgb, var(--warning-bg) 82%, transparent);
}

.ordered-profile--critical {
  border-color: var(--danger-border);
  background: color-mix(in srgb, var(--danger-bg) 82%, transparent);
}

.ordered-profile strong {
  font-size: var(--font-size-emphasis);
}

.ordered-profile p {
  color: var(--secondary-text);
  line-height: 1.6;
}

.ordered-profile__meter {
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--surface-overlay-strong);
}

.ordered-profile__meter span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    var(--highlight-text),
    var(--warning-color),
    var(--danger-color)
  );
}

.ordered-phase-list,
.ordered-insight-list,
.ordered-change-list {
  display: grid;
  gap: 12px;
  padding-left: 18px;
}

.ordered-phase-list {
  color: var(--secondary-text);
}

.ordered-map {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.ordered-map__node {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--border-color);
  border-radius: 18px;
  background: var(--surface-overlay);
}

.ordered-map__node--critical {
  border-color: var(--danger-border);
}

.ordered-map__node--sensitive {
  border-color: var(--warning-border);
}

.ordered-map__node--stable {
  border-color: var(--success-border);
}

.ordered-map__node span,
.ordered-map__node small {
  color: var(--secondary-text);
}

.ordered-map__node strong {
  font-size: var(--font-size-display);
  line-height: 1;
}

.ordered-axis-diagram {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-color);
  border-radius: 22px;
  background:
    linear-gradient(90deg, var(--surface-overlay-soft), transparent),
    var(--surface-overlay);
}

.ordered-axis-diagram__rail {
  display: grid;
  gap: 6px;
  padding: 16px;
  border-radius: 18px;
  background: var(--surface-overlay-strong);
  text-align: center;
}

.ordered-axis-diagram__rail span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  justify-self: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--highlight-text) 14%, transparent);
  color: var(--highlight-text);
  font-size: var(--font-size-title);
  font-weight: 800;
}

.ordered-axis-diagram__rail small {
  color: var(--secondary-text);
}

.ordered-panel-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 18px;
  padding: 8px 2px 0;
}

.ordered-panel-header h4 {
  margin: 6px 0 2px;
  font-size: var(--font-size-display);
}

.ordered-panel-header small,
.ordered-panel-header p {
  color: var(--secondary-text);
}

.ordered-panel-header p {
  max-width: 46ch;
  text-align: right;
  line-height: 1.7;
}

.ordered-field-list {
  display: grid;
  gap: 14px;
}

.ordered-field {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(240px, 0.72fr);
  gap: 18px;
  padding: 18px;
  border: 1px solid var(--border-color);
  border-radius: 22px;
  background: var(--surface-overlay);
}

.ordered-field--changed {
  border-color: var(--info-border);
  background: var(--info-bg);
}

.ordered-field__copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ordered-field__heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
}

.ordered-field__heading h5 {
  margin: 0;
  font-size: var(--font-size-body);
}

.ordered-field__key {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.ordered-field__summary {
  color: var(--primary-text);
  line-height: 1.65;
}

.ordered-field__range {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.ordered-field__details {
  color: var(--primary-text);
}

.ordered-field__details summary {
  cursor: pointer;
  color: var(--highlight-text);
}

.ordered-field__details p {
  margin: 8px 0 0;
  color: var(--secondary-text);
  line-height: 1.6;
}

.ordered-field__control {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 18px;
  background: var(--surface-overlay-strong);
}

.ordered-field__slider {
  width: 100%;
  margin: 0;
  accent-color: var(--highlight-text);
}

.ordered-toggle {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 6px;
  border-radius: 16px;
  background: var(--surface-overlay-soft);
}

.ordered-toggle__option {
  min-height: 40px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--secondary-text);
  cursor: pointer;
}

.ordered-toggle__option--active {
  border-color: var(--info-border);
  background: var(--info-bg);
  color: var(--primary-text);
  font-weight: 700;
}

.ordered-field__number-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.ordered-field__number {
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--surface-overlay-soft);
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", monospace;
}

.ordered-field__current {
  min-width: 66px;
  text-align: right;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-body);
  color: var(--highlight-text);
}

.ordered-insight-list li,
.ordered-change-list li {
  color: var(--secondary-text);
}

.ordered-insight-list strong,
.ordered-change-list strong {
  display: block;
  color: var(--primary-text);
  margin-bottom: 4px;
}

.ordered-insight-list p {
  margin: 0;
  line-height: 1.6;
}

.ordered-change-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-left: 4px;
}

.ordered-empty-state {
  color: var(--secondary-text);
  line-height: 1.7;
}

@media (max-width: 1360px) {
  .ordered-modal__body {
    grid-template-columns: 250px minmax(0, 1fr);
  }

  .ordered-modal__insights {
    grid-column: 1 / -1;
    border-left: none;
    border-top: 1px solid var(--border-color);
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 1040px) {
  .ordered-modal__header {
    flex-direction: column;
  }

  .ordered-modal__header-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .ordered-modal__body {
    grid-template-columns: 1fr;
  }

  .ordered-modal__nav {
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }

  .ordered-modal__insights {
    border-left: none;
    border-top: 1px solid var(--border-color);
    grid-template-columns: 1fr;
  }

  .ordered-map,
  .ordered-axis-diagram {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ordered-panel-header,
  .ordered-field {
    grid-template-columns: 1fr;
  }

  .ordered-panel-header p {
    text-align: left;
  }
}

@media (max-width: 720px) {
  .ordered-modal__header,
  .ordered-modal__workspace,
  .ordered-modal__nav,
  .ordered-modal__insights {
    padding-left: 16px;
    padding-right: 16px;
  }

  .ordered-modal__title-row,
  .ordered-field__heading,
  .ordered-field__number-row {
    grid-template-columns: 1fr;
  }

  .ordered-map,
  .ordered-axis-diagram {
    grid-template-columns: 1fr;
  }

  .ordered-field__current {
    text-align: left;
  }
}
</style>