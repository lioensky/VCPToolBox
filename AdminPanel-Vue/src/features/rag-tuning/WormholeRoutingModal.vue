<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="wormhole-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wormhole-routing-title"
    >
      <div class="wormhole-modal__backdrop" aria-hidden="true" @click="emit('close')"></div>

      <div
        ref="dialogRef"
        class="wormhole-modal__shell"
        tabindex="-1"
        @keydown="handleDialogKeydown"
      >
        <header class="wormhole-modal__header">
          <div class="wormhole-modal__hero">
            <span class="wormhole-modal__eyebrow">Wormhole Routing Cockpit</span>
            <div class="wormhole-modal__title-row">
              <div>
                <h3 id="wormhole-routing-title">虫洞脉冲路由</h3>
              </div>

              <div class="wormhole-modal__badges">
                <span class="wormhole-badge wormhole-badge--critical">高风险</span>
                <span class="wormhole-badge wormhole-badge--neutral">
                  已改 {{ changedLeaves }}/{{ totalLeaves }}
                </span>
              </div>
            </div>
          </div>

          <div class="wormhole-modal__header-actions">
            <button
              type="button"
              class="btn-secondary"
              :disabled="changedLeaves === 0"
              @click="emit('restore')"
            >
              恢复虫洞参数
            </button>
            <button type="button" class="btn-secondary" @click="emit('close')">
              收起舱门
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

        <div class="wormhole-modal__body">
          <aside class="wormhole-modal__nav">
            <div class="wormhole-sidebar-card">
              <span class="wormhole-sidebar-card__label">导航</span>
              <div class="wormhole-sidebar-card__nav-list">
                <button
                  v-for="panel in WORMHOLE_ROUTING_PANELS"
                  :key="panel.id"
                  type="button"
                  :class="[
                    'wormhole-nav-btn',
                    { 'wormhole-nav-btn--active': panel.id === activePanel.id },
                  ]"
                  @click="activePanelId = panel.id"
                >
                  <span class="material-symbols-outlined">{{ panel.icon }}</span>
                  <span class="wormhole-nav-btn__copy">
                    <strong>{{ panel.title }}</strong>
                    <small>{{ panelChangeCounts[panel.id] }} 项改动</small>
                  </span>
                </button>
              </div>
            </div>

            <div class="wormhole-sidebar-card">
              <span class="wormhole-sidebar-card__label">当前画像（估算）</span>
              <div :class="['wormhole-profile', `wormhole-profile--${profile.tone}`]">
                <strong>{{ profile.label }}</strong>
                <p>{{ profile.summary }}</p>
                <div class="wormhole-profile__meter">
                  <span :style="{ width: `${profile.score * 100}%` }"></span>
                </div>
              </div>
            </div>
          </aside>

          <section class="wormhole-modal__workspace">
            <div class="wormhole-overview">
              <article
                v-for="item in overviewStats"
                :key="item.key"
                class="wormhole-overview__item"
              >
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
                <small>{{ item.hint }}</small>
              </article>
            </div>

            <header class="wormhole-panel-header">
              <div>
                <span class="wormhole-panel-header__label">当前分组</span>
                <h4>{{ activePanel.title }}</h4>
              </div>
              <p>{{ activePanel.summary }}</p>
            </header>

            <div class="wormhole-field-list">
              <article
                v-for="subKey in activePanel.keys"
                :key="subKey"
                :class="[
                  'wormhole-field',
                  { 'wormhole-field--changed': isFieldChanged(subKey) },
                ]"
              >
                <div class="wormhole-field__copy">
                  <div class="wormhole-field__heading">
                    <div>
                      <h5>{{ getFieldMeta(subKey).label }}</h5>
                      <p class="wormhole-field__key">{{ subKey }}</p>
                    </div>

                    <div class="wormhole-field__pills">
                      <span
                        v-if="getFieldMeta(subKey).tone"
                        :class="[
                          'wormhole-badge',
                          `wormhole-badge--${getFieldMeta(subKey).tone}`,
                        ]"
                      >
                        {{ getToneLabel(getFieldMeta(subKey).tone) }}
                      </span>
                      <span
                        v-if="formatDelta(subKey)"
                        class="wormhole-badge wormhole-badge--changed"
                      >
                        {{ formatDelta(subKey) }}
                      </span>
                    </div>
                  </div>

                  <p class="wormhole-field__summary">
                    {{ getFieldMeta(subKey).summary }}
                  </p>

                  <p v-if="getFieldMeta(subKey).range" class="wormhole-field__range">
                    {{ getFieldMeta(subKey).range }}
                  </p>

                  <details v-if="getFieldMeta(subKey).logic" class="wormhole-field__details">
                    <summary>展开调优逻辑</summary>
                    <p>{{ getFieldMeta(subKey).logic }}</p>
                  </details>
                </div>

                <div class="wormhole-field__control">
                  <input
                    class="wormhole-field__slider"
                    type="range"
                    :aria-label="`${getFieldMeta(subKey).label} 滑杆`"
                    :value="values[subKey]"
                    :min="getSubParamRange(subKey).min"
                    :max="getSubParamRange(subKey).max"
                    :step="getSubParamRange(subKey).step"
                    @input="handleFieldInput(subKey, $event)"
                  />

                  <div class="wormhole-field__number-row">
                    <input
                      class="wormhole-field__number"
                      type="number"
                      :aria-label="`${getFieldMeta(subKey).label} 数值输入`"
                      :value="values[subKey]"
                      :min="getSubParamRange(subKey).min"
                      :max="getSubParamRange(subKey).max"
                      :step="getSubParamRange(subKey).step"
                      @input="handleFieldInput(subKey, $event)"
                    />
                    <span class="wormhole-field__current">{{ formatNumber(values[subKey]) }}</span>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <aside class="wormhole-modal__insights">
            <div class="wormhole-sidebar-card">
              <span class="wormhole-sidebar-card__label">联动提示</span>
              <ul class="wormhole-insight-list">
                <li v-for="hint in activeHints" :key="hint.title">
                  <strong>{{ hint.title }}</strong>
                  <p>{{ hint.body }}</p>
                </li>
              </ul>
            </div>

            <div class="wormhole-sidebar-card">
              <span class="wormhole-sidebar-card__label">未保存修改</span>
              <ul v-if="changedKeys.length > 0" class="wormhole-change-list">
                <li v-for="subKey in changedKeys" :key="subKey">
                  <span>{{ getFieldMeta(subKey).label }}</span>
                  <strong>{{ formatDelta(subKey) }}</strong>
                </li>
              </ul>
              <p v-else class="wormhole-empty-state">
                目前还没有未保存修改，建议一次只微调 1 到 2 个关键参数。
              </p>
            </div>

            <div class="wormhole-sidebar-card">
              <span class="wormhole-sidebar-card__label">操作建议</span>
              <ul class="wormhole-insight-list">
                <li>
                  <strong>先看点火，再看衰减</strong>
                  <p>如果召回开始漂移，优先回看 tensionThreshold、baseMomentum 与 wormholeDecay。</p>
                </li>
                <li>
                  <strong>大改之前先保存快照</strong>
                  <p>虫洞参数耦合较强，连续调很多项时很容易把问题来源混在一起。</p>
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import {
  WORMHOLE_PRIMARY_KEYS,
  WORMHOLE_ROUTING_PANELS,
  getParamMeta,
  getSubParamRange,
  getToneLabel,
  type ParamTone,
  type WormholePrimaryKey,
  type WormholeRoutingPanelId,
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

const dialogRef = ref<HTMLElement | null>(null);
const activePanelId = ref<WormholeRoutingPanelId>(WORMHOLE_ROUTING_PANELS[0].id);
const previousBodyOverflow = ref("");

const activePanel = computed(
  () =>
    WORMHOLE_ROUTING_PANELS.find((panel) => panel.id === activePanelId.value) ??
    WORMHOLE_ROUTING_PANELS[0]
);

const changedKeys = computed(() =>
  Object.keys(props.values).filter(
    (subKey) => props.values[subKey] !== props.originalValues[subKey]
  )
);

const panelChangeCounts = computed<Record<WormholeRoutingPanelId, number>>(() => {
  const next: Record<WormholeRoutingPanelId, number> = {
    trigger: 0,
    spread: 0,
    decay: 0,
  };

  for (const panel of WORMHOLE_ROUTING_PANELS) {
    next[panel.id] = panel.keys.filter(
      (subKey) => props.values[subKey] !== props.originalValues[subKey]
    ).length;
  }

  return next;
});

const overviewStats = computed(() =>
  WORMHOLE_PRIMARY_KEYS.map((subKey) => ({
    key: subKey,
    label: getFieldMeta(subKey).label,
    value: formatNumber(props.values[subKey]),
    hint: getOverviewHint(subKey),
  }))
);

const profile = computed(() => {
  const score =
    normalize(props.values.baseMomentum ?? 1, 1, 5) * 0.35 +
    (1 - normalize(props.values.tensionThreshold ?? 1, 0.5, 3)) * 0.35 +
    normalize(props.values.wormholeDecay ?? 0.7, 0.6, 0.9) * 0.2 +
    (1 - normalize(props.values.baseDecay ?? 0.2, 0.1, 0.4)) * 0.1;

  if (score >= 0.68) {
    return {
      tone: "critical" as ParamTone,
      label: "激进扩散",
      summary: "基于当前 4 项核心参数的前端估算，这组配置更愿意跨域跳转，探索更强，但也更容易放大噪声与语义漂移。",
      score,
    };
  }

  if (score <= 0.4) {
    return {
      tone: "stable" as ParamTone,
      label: "保守探索",
      summary: "基于当前 4 项核心参数的前端估算，这组配置更偏向留在本域与近邻传播，结果更稳，但可能错过远距离联想。",
      score,
    };
  }

  return {
    tone: "sensitive" as ParamTone,
    label: "平衡默认",
    summary: "基于当前 4 项核心参数的前端估算，这组配置在稳定和探索之间折中，适合大多数常规对话与召回场景。",
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

function getOverviewHint(subKey: WormholePrimaryKey): string {
  switch (subKey) {
    case "tensionThreshold":
      return "越低越容易跨域";
    case "baseMomentum":
      return "越高越能继续传播";
    case "baseDecay":
      return "越低越快衰减";
    case "wormholeDecay":
      return "越高越保留跨域收益";
    default:
      return "关键指标";
  }
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

function getDialogFocusableElements(): HTMLElement[] {
  if (!dialogRef.value) {
    return [];
  }

  const selector = [
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  return Array.from(dialogRef.value.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hasAttribute("disabled")
  );
}

function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }

  if (event.key !== "Tab") {
    return;
  }

  const focusableElements = getDialogFocusableElements();
  if (focusableElements.length === 0) {
    event.preventDefault();
    dialogRef.value?.focus();
    return;
  }

  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];
  const activeElement = document.activeElement as HTMLElement | null;
  const isInsideDialog = Boolean(activeElement && dialogRef.value?.contains(activeElement));

  if (event.shiftKey) {
    if (!isInsideDialog || activeElement === firstFocusable) {
      event.preventDefault();
      lastFocusable.focus();
    }
    return;
  }

  if (!isInsideDialog || activeElement === lastFocusable) {
    event.preventDefault();
    firstFocusable.focus();
  }
}

function getPreferredPanelId(): WormholeRoutingPanelId {
  const changedKeySet = new Set(changedKeys.value);
  const firstChangedPanel = WORMHOLE_ROUTING_PANELS.find((panel) =>
    panel.keys.some((subKey) => changedKeySet.has(subKey))
  );

  return firstChangedPanel?.id ?? WORMHOLE_ROUTING_PANELS[0].id;
}

function syncBodyScrollLock(isOpen: boolean): void {
  if (typeof document === "undefined") {
    return;
  }

  if (isOpen) {
    previousBodyOverflow.value = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return;
  }

  document.body.style.overflow = previousBodyOverflow.value;
}

watch(
  () => props.modelValue,
  async (isOpen) => {
    syncBodyScrollLock(isOpen);

    if (!isOpen) {
      return;
    }

    activePanelId.value = getPreferredPanelId();
    await nextTick();
    dialogRef.value?.focus();
  }
);

onUnmounted(() => {
  syncBodyScrollLock(false);
});

const COUPLING_HINTS: Record<string, CouplingHint> = {
  tensionThreshold: {
    title: "张力阈值会牵动整体跨域意愿",
    body: "如果它降得太低，最好同步关注 baseMomentum 和 wormholeDecay，否则很容易出现跳得出去却收不回来的情况。",
  },
  baseMomentum: {
    title: "初始动量决定第一跳后还能不能继续扩散",
    body: "调高它时，建议同时盯住 maxSafeHops 和 baseDecay，避免高动量带来层层外溢。",
  },
  baseDecay: {
    title: "常规衰减是控制本域回声的刹车",
    body: "如果常规衰减太低，哪怕虫洞参数不激进，也可能在本域里积累过多回音。",
  },
  wormholeDecay: {
    title: "虫洞衰减决定跨域收益会不会保留下来",
    body: "它通常应明显高于 baseDecay，才能体现跨域探索的价值，但过高也会把偏题结果带回主链路。",
  },
  maxSafeHops: {
    title: "安全跳数是扩散上限",
    body: "当 baseMomentum 较高时，再放大 hop 上限会显著提升探索跨度，也会提高响应不稳定性。",
  },
  maxEmergentNodes: {
    title: "涌现节点上限影响结果回流密度",
    body: "这个值与 maxNeighborsPerNode 共同决定扩散后会有多少新节点重新进入召回排序。",
  },
  maxNeighborsPerNode: {
    title: "单节点邻居数决定扩散宽度",
    body: "如果你已经提高了 maxEmergentNodes，再继续放大邻居数，结果会更发散，也更容易出现噪声堆积。",
  },
  firingThreshold: {
    title: "放电阈值是弱信号清理器",
    body: "适度提高它可以压掉尾流噪声，但如果张力阈值也偏高，整体路由会迅速变得保守。",
  },
};
</script>

<style scoped>
.wormhole-modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-index-modal);
  display: flex;
  align-items: center;
  justify-content: center;
}

.wormhole-modal__backdrop {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(
      circle at top,
      color-mix(in srgb, var(--highlight-text) 18%, transparent),
      transparent 40%
    ),
    var(--overlay-backdrop-strong);
  backdrop-filter: blur(12px);
}

.wormhole-modal__shell {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(1480px, 88vw);
  height: min(920px, 90vh);
  border: 1px solid var(--border-color);
  border-radius: 28px;
  overflow: hidden;
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--primary-bg) 86%, var(--surface-overlay-strong)),
      color-mix(in srgb, var(--secondary-bg) 90%, var(--primary-bg))
    ),
    var(--secondary-bg);
  box-shadow: var(--overlay-panel-shadow);
  outline: none;
  overscroll-behavior: contain;
}

.wormhole-modal__shell:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.wormhole-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 28px 22px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--surface-overlay-soft), transparent);
}

.wormhole-modal__hero {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.wormhole-modal__eyebrow {
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

.wormhole-modal__title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.wormhole-modal__title-row h3 {
  margin: 0;
  font-size: var(--font-size-section-title-strong);
  line-height: 1.1;
}

.wormhole-modal__badges,
.wormhole-field__pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.wormhole-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.wormhole-badge--neutral {
  background: var(--tertiary-bg);
  color: var(--secondary-text);
}

.wormhole-badge--critical {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.wormhole-badge--sensitive {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.wormhole-badge--stable {
  background: var(--success-bg);
  color: var(--success-text);
}

.wormhole-badge--changed {
  background: var(--info-bg);
  color: var(--info-text);
}

.wormhole-modal__header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.wormhole-modal__body {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 300px;
  gap: 0;
  min-height: 0;
  flex: 1;
}

.wormhole-modal__nav,
.wormhole-modal__insights {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 22px;
  overflow-y: auto;
  background: var(--surface-overlay-soft);
}

.wormhole-modal__nav {
  border-right: 1px solid var(--border-color);
}

.wormhole-modal__insights {
  border-left: 1px solid var(--border-color);
}

.wormhole-modal__workspace {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  min-height: 0;
  padding: 22px 24px 26px;
  overflow-y: auto;
}

.wormhole-sidebar-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 20px;
  background: var(--surface-overlay);
}

.wormhole-sidebar-card__label,
.wormhole-panel-header__label {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.wormhole-sidebar-card__nav-list {
  display: grid;
  gap: 10px;
}

.wormhole-nav-btn {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
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

.wormhole-nav-btn:hover,
.wormhole-nav-btn--active {
  border-color: var(--info-border);
  background: var(--info-bg);
  transform: translateY(-1px);
}

.wormhole-nav-btn:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.wormhole-nav-btn .material-symbols-outlined {
  font-size: var(--font-size-title);
  color: var(--highlight-text);
}

.wormhole-nav-btn__copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.wormhole-nav-btn__copy strong {
  font-size: var(--font-size-body);
}

.wormhole-nav-btn__copy small {
  color: var(--secondary-text);
}

.wormhole-profile {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wormhole-profile--stable,
.wormhole-profile--sensitive,
.wormhole-profile--critical {
  padding: 12px;
  border-radius: 14px;
  border: 1px solid transparent;
}

.wormhole-profile--stable {
  border-color: var(--success-border);
  background: color-mix(in srgb, var(--success-bg) 82%, transparent);
}

.wormhole-profile--sensitive {
  border-color: var(--warning-border);
  background: color-mix(in srgb, var(--warning-bg) 82%, transparent);
}

.wormhole-profile--critical {
  border-color: var(--danger-border);
  background: color-mix(in srgb, var(--danger-bg) 82%, transparent);
}

.wormhole-profile strong {
  font-size: var(--font-size-emphasis);
}

.wormhole-profile p {
  color: var(--secondary-text);
  line-height: 1.6;
}

.wormhole-profile__meter {
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--surface-overlay-strong);
}

.wormhole-profile__meter span {
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

.wormhole-profile--stable .wormhole-profile__meter span {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--success-color) 70%, var(--highlight-text)),
    var(--success-color)
  );
}

.wormhole-profile--sensitive .wormhole-profile__meter span {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--warning-color) 68%, var(--highlight-text)),
    var(--warning-color)
  );
}

.wormhole-profile--critical .wormhole-profile__meter span {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--danger-color) 64%, var(--highlight-text)),
    var(--danger-color)
  );
}

.wormhole-overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.wormhole-overview__item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--border-color);
  border-radius: 18px;
  background: var(--surface-overlay);
}

.wormhole-overview__item span,
.wormhole-overview__item small {
  color: var(--secondary-text);
}

.wormhole-overview__item strong {
  font-size: var(--font-size-display);
  line-height: 1;
}

.wormhole-panel-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 18px;
  padding: 8px 2px 0;
}

.wormhole-panel-header h4 {
  margin: 6px 0 0;
  font-size: var(--font-size-display);
}

.wormhole-panel-header p {
  max-width: 42ch;
  color: var(--secondary-text);
  text-align: right;
}

.wormhole-field-list {
  display: grid;
  gap: 14px;
}

.wormhole-field {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(240px, 0.72fr);
  gap: 18px;
  padding: 18px;
  border: 1px solid var(--border-color);
  border-radius: 22px;
  background: var(--surface-overlay);
}

.wormhole-field--changed {
  border-color: var(--info-border);
  background: var(--info-bg);
}

.wormhole-field__copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wormhole-field__heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
}

.wormhole-field__heading h5 {
  margin: 0;
  font-size: var(--font-size-body);
}

.wormhole-field__key {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.wormhole-field__summary {
  color: var(--primary-text);
  line-height: 1.65;
}

.wormhole-field__range {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.wormhole-field__details {
  color: var(--primary-text);
}

.wormhole-field__details summary {
  cursor: pointer;
  color: var(--highlight-text);
}

.wormhole-field__details p {
  margin: 8px 0 0;
  color: var(--secondary-text);
  line-height: 1.6;
}

.wormhole-field__control {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 18px;
  background: var(--surface-overlay-strong);
}

.wormhole-field__slider {
  width: 100%;
  margin: 0;
  accent-color: var(--highlight-text);
}

.wormhole-field__number-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.wormhole-field__number {
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--surface-overlay-soft);
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", monospace;
}

.wormhole-field__current {
  min-width: 66px;
  text-align: right;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-body);
  color: var(--highlight-text);
}

.wormhole-insight-list,
.wormhole-change-list {
  display: grid;
  gap: 12px;
  padding-left: 18px;
}

.wormhole-insight-list li,
.wormhole-change-list li {
  color: var(--secondary-text);
}

.wormhole-insight-list strong,
.wormhole-change-list strong {
  display: block;
  color: var(--primary-text);
  margin-bottom: 4px;
}

.wormhole-insight-list p {
  margin: 0;
  line-height: 1.6;
}

.wormhole-change-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-left: 4px;
}

.wormhole-empty-state {
  color: var(--secondary-text);
  line-height: 1.7;
}

@media (max-width: 1320px) {
  .wormhole-modal__shell {
    width: min(1500px, calc(100vw - 20px));
    height: min(920px, calc(var(--app-viewport-height, 100vh) - 20px));
  }

  .wormhole-modal__body {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .wormhole-modal__insights {
    grid-column: 1 / -1;
    border-left: none;
    border-top: 1px solid var(--border-color);
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 1024px) {
  .wormhole-modal__header {
    flex-direction: column;
  }

  .wormhole-modal__header-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .wormhole-modal__body {
    grid-template-columns: 1fr;
  }

  .wormhole-modal__nav {
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }

  .wormhole-modal__insights {
    border-left: none;
    border-top: 1px solid var(--border-color);
    grid-template-columns: 1fr;
  }

  .wormhole-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wormhole-panel-header,
  .wormhole-field {
    grid-template-columns: 1fr;
  }

  .wormhole-panel-header p {
    text-align: left;
  }
}

@media (max-width: 720px) {
  .wormhole-modal__shell {
    width: 100vw;
    height: var(--app-viewport-height, 100vh);
    border-radius: 0;
  }

  .wormhole-modal__header,
  .wormhole-modal__workspace,
  .wormhole-modal__nav,
  .wormhole-modal__insights {
    padding-left: 16px;
    padding-right: 16px;
  }

  .wormhole-modal__title-row {
    flex-direction: column;
  }

  .wormhole-overview {
    grid-template-columns: 1fr;
  }

  .wormhole-field__heading,
  .wormhole-field__number-row {
    grid-template-columns: 1fr;
  }

  .wormhole-field__current {
    text-align: left;
  }
}
</style>
