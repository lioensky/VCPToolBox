<template>
  <section class="config-section active-section rag-lab">
    <header class="rag-lab__hero card">
      <div class="rag-lab__hero-copy">
        <span class="rag-lab__eyebrow">Wave RAG Parameter Lab</span>
        <h2>浪潮 RAG 参数调优工作台</h2>
        <p class="description">
          集中查看和调整浪潮 RAG 的核心参数，支持按模块浏览、快速定位高影响项，并对虫洞脉冲路由等复杂参数进入独立控制舱进行细化编辑。
        </p>
      </div>

      <div class="rag-lab__hero-stats">
        <div class="hero-stat">
          <span class="hero-stat__value">{{ groupSections.length }}</span>
          <span class="hero-stat__label">参数组</span>
        </div>
        <div class="hero-stat">
          <span class="hero-stat__value">{{ totalLeafCount }}</span>
          <span class="hero-stat__label">可调节点</span>
        </div>
        <div class="hero-stat" :class="{ 'hero-stat--warning': isDirty }">
          <span class="hero-stat__value">{{ changedLeafCount }}</span>
          <span class="hero-stat__label">未保存修改</span>
        </div>
      </div>
    </header>

    <div v-if="isLoading" class="rag-lab__state card">
      <span class="material-symbols-outlined">hourglass_top</span>
      <div>
        <strong>正在加载 RAG 参数</strong>
        <p>读取完成后会按分组展开到参数工作台中。</p>
      </div>
    </div>

    <div v-else-if="loadError" class="rag-lab__state rag-lab__state--error card">
      <span class="material-symbols-outlined">error</span>
      <div>
        <strong>参数加载失败</strong>
        <p>{{ loadError }}</p>
      </div>
      <button type="button" class="btn-secondary" @click="loadParams">重新加载</button>
    </div>

    <form v-else :id="formId" class="rag-lab__workspace" @submit.prevent="saveParams">
      <div class="rag-lab__main">
        <article
          v-for="section in groupSections"
          :id="section.anchor"
          :key="section.name"
          class="group-panel card"
          :style="{ '--group-accent': section.meta.accent }"
        >
          <header class="group-panel__header">
            <div class="group-panel__header-main">
              <span class="group-panel__badge">{{ section.meta.badge }}</span>
              <div class="group-panel__title-row">
                <span class="material-symbols-outlined">{{ section.meta.icon }}</span>
                <div>
                  <h3>{{ section.meta.title }}</h3>
                  <p class="group-panel__name">{{ section.name }}</p>
                </div>
              </div>
              <p class="group-panel__description">{{ section.meta.description }}</p>
            </div>

            <div class="group-panel__metrics">
              <div class="group-panel__metric">
                <span>{{ section.entries.length }}</span>
                <small>模块</small>
              </div>
              <div class="group-panel__metric">
                <span>{{ section.changedLeaves }}/{{ section.totalLeaves }}</span>
                <small>已改动</small>
              </div>
            </div>
          </header>

          <div class="group-panel__list">
            <section
              v-for="entry in section.entries"
              :key="entry.key"
              :class="[
                'param-row',
                `param-row--${entry.kind}`,
                {
                  'param-row--changed': entry.changedLeaves > 0,
                  'param-row--wormhole': isWormholeEntry(section.name, entry),
                },
              ]"
            >
              <template v-if="isWormholeEntry(section.name, entry)">
                <div class="wormhole-launchpad">
                  <div class="wormhole-launchpad__copy">
                    <div class="param-row__heading">
                      <div class="param-row__title-block">
                        <h4>{{ entry.meta.label }}</h4>
                        <p class="param-row__key">{{ entry.key }}</p>
                      </div>

                      <div class="param-row__pills">
                        <span class="mini-pill mini-pill--critical">
                          {{ getToneLabel(entry.meta.tone) }}
                        </span>
                        <span
                          v-if="entry.changedLeaves > 0"
                          class="mini-pill mini-pill--changed"
                        >
                          已修改 {{ entry.changedLeaves }}
                        </span>
                      </div>
                    </div>

                    <p class="param-row__summary">{{ entry.meta.summary }}</p>

                    <p v-if="entry.meta.range" class="param-row__range">
                      <span class="material-symbols-outlined">straighten</span>
                      {{ entry.meta.range }}
                    </p>

                    <details v-if="entry.meta.logic" class="param-row__details">
                      <summary>展开调优逻辑</summary>
                      <div class="param-row__details-body">
                        <p>{{ entry.meta.logic }}</p>
                      </div>
                    </details>
                  </div>

                  <div class="wormhole-launchpad__control">
                    <div class="wormhole-launchpad__stats">
                      <article
                        v-for="subKey in WORMHOLE_PRIMARY_KEYS"
                        :key="subKey"
                        class="wormhole-launchpad__stat"
                      >
                        <span>{{ getWormholeQuickLabel(subKey) }}</span>
                        <strong>{{ getWormholeQuickValue(entry, subKey) }}</strong>
                      </article>
                    </div>

                    <div class="wormhole-launchpad__footer">
                      <button type="button" class="btn-primary" @click="openWormholeModal">
                        打开虫洞控制舱
                      </button>
                    </div>
                  </div>
                </div>
              </template>

              <template v-else>
                <div class="param-row__copy">
                  <div class="param-row__heading">
                    <div class="param-row__title-block">
                      <h4>{{ entry.meta.label }}</h4>
                      <p class="param-row__key">{{ entry.key }}</p>
                    </div>

                    <div class="param-row__pills">
                      <span class="mini-pill mini-pill--neutral">
                        {{ getKindLabel(entry.kind) }}
                      </span>
                      <span
                        v-if="entry.meta.tone"
                        :class="['mini-pill', `mini-pill--${entry.meta.tone}`]"
                      >
                        {{ getToneLabel(entry.meta.tone) }}
                      </span>
                      <span
                        v-if="entry.changedLeaves > 0"
                        class="mini-pill mini-pill--changed"
                      >
                        已修改 {{ entry.changedLeaves }}
                      </span>
                    </div>
                  </div>

                  <p class="param-row__summary">{{ entry.meta.summary }}</p>

                  <p v-if="entry.meta.range" class="param-row__range">
                    <span class="material-symbols-outlined">straighten</span>
                    {{ entry.meta.range }}
                  </p>

                  <details v-if="entry.meta.logic" class="param-row__details">
                    <summary>展开调优逻辑</summary>
                    <div class="param-row__details-body">
                      <p>{{ entry.meta.logic }}</p>
                    </div>
                  </details>
                </div>

                <div class="param-row__control">
                  <div v-if="entry.kind === 'number'" class="control-shell">
                    <label class="control-shell__label" :for="entry.fieldId">当前数值</label>
                    <input
                      :id="entry.fieldId"
                      v-model.number="section.raw[entry.key]"
                      type="number"
                      :step="getNumberStep(entry.value)"
                    />
                  </div>

                  <div
                    v-else-if="entry.kind === 'tuple'"
                    class="control-shell control-shell--tuple"
                  >
                    <div class="tuple-grid">
                      <label
                        v-for="(itemValue, index) in entry.value"
                        :key="`${entry.key}-${index}`"
                        class="tuple-field"
                      >
                        <span>{{ getTupleFieldLabel(entry, index) }}</span>
                        <input
                          v-model.number="(section.raw[entry.key] as number[])[index]"
                          type="number"
                          :step="getNumberStep(itemValue)"
                        />
                      </label>
                    </div>
                  </div>

                  <div v-else class="control-shell control-shell--nested">
                    <div class="nested-header">
                      <span>子参数模块</span>
                      <span>{{ Object.keys(entry.value).length }} 项</span>
                    </div>

                    <div class="nested-list">
                      <div
                        v-for="subKey in Object.keys(entry.value)"
                        :key="`${entry.key}-${subKey}`"
                        class="nested-item"
                      >
                        <div class="nested-item__copy">
                          <div class="nested-item__title">
                            <h5>{{ getNestedMeta(section.name, entry.key, subKey).label }}</h5>
                            <span class="nested-item__key">{{ subKey }}</span>
                          </div>

                          <p class="nested-item__summary">
                            {{ getNestedMeta(section.name, entry.key, subKey).summary }}
                          </p>

                          <div class="nested-item__meta">
                            <span
                              v-if="getNestedMeta(section.name, entry.key, subKey).tone"
                              :class="[
                                'mini-pill',
                                `mini-pill--${getNestedMeta(section.name, entry.key, subKey).tone}`,
                              ]"
                            >
                              {{
                                getToneLabel(
                                  getNestedMeta(section.name, entry.key, subKey).tone
                                )
                              }}
                            </span>
                            <span
                              v-if="getNestedMeta(section.name, entry.key, subKey).range"
                              class="nested-item__range"
                            >
                              {{ getNestedMeta(section.name, entry.key, subKey).range }}
                            </span>
                          </div>
                        </div>

                        <div class="nested-item__control">
                          <input
                            v-model.number="
                              (section.raw[entry.key] as Record<string, number>)[subKey]
                            "
                            class="nested-item__slider"
                            type="range"
                            :aria-label="`${getNestedMeta(section.name, entry.key, subKey).label} 滑杆`"
                            :min="getSubParamRange(subKey).min"
                            :max="getSubParamRange(subKey).max"
                            :step="getSubParamRange(subKey).step"
                          />
                          <input
                            v-model.number="
                              (section.raw[entry.key] as Record<string, number>)[subKey]
                            "
                            class="nested-item__number"
                            type="number"
                            :aria-label="`${getNestedMeta(section.name, entry.key, subKey).label} 数值输入`"
                            :min="getSubParamRange(subKey).min"
                            :max="getSubParamRange(subKey).max"
                            :step="getSubParamRange(subKey).step"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
            </section>
          </div>
        </article>
      </div>

      <aside class="rag-lab__aside">
        <div class="rag-console card">
          <div class="rag-console__section">
            <span class="rag-console__label">操作台</span>
            <h3>保存与回退</h3>
            <p>建议一次只改一组高敏参数，并在每次保存后观察实际召回结果。</p>
          </div>

          <div class="rag-console__actions">
            <button
              type="submit"
              class="btn-primary"
              :disabled="isSaving || !hasParams || !isDirty"
            >
              {{ isSaving ? "保存中…" : "保存参数配置" }}
            </button>
            <button
              type="button"
              class="btn-secondary"
              :disabled="!isDirty"
              @click="resetParams"
            >
              重置未保存修改
            </button>
          </div>

          <p
            v-if="statusMessage"
            :class="['rag-console__status', `rag-console__status--${statusType}`]"
            role="status"
            aria-live="polite"
          >
            {{ statusMessage }}
          </p>

          <div class="rag-console__section">
            <span class="rag-console__label">快速跳转</span>
            <div class="rag-console__jump-list">
              <button
                v-for="section in groupSections"
                :key="`${section.name}-jump`"
                type="button"
                class="rag-console__jump-btn"
                @click="scrollToGroup(section.anchor)"
              >
                <span>{{ section.meta.title }}</span>
                <small>{{ section.changedLeaves }}/{{ section.totalLeaves }}</small>
              </button>
            </div>
          </div>

          <div class="rag-console__section">
            <span class="rag-console__label">风险提示</span>
            <ul class="rag-console__tips">
              <li>标记为“高风险”的参数建议单独修改并观察效果。</li>
              <li>虫洞路由参数之间耦合较强，不建议一次联动改太多项。</li>
              <li>
                如果召回突然漂移，优先回看 <code>tensionThreshold</code>、
                <code>baseMomentum</code> 和 <code>dynamicBoostRange</code>。
              </li>
            </ul>
          </div>
        </div>
      </aside>
    </form>

    <WormholeRoutingModal
      v-if="wormholeEntry"
      :model-value="wormholeModalOpen"
      :group-name="WORMHOLE_GROUP_NAME"
      :param-key="WORMHOLE_PARAM_KEY"
      :values="wormholeCurrentValues"
      :original-values="wormholeOriginalValues"
      :changed-leaves="wormholeEntry.changedLeaves"
      :total-leaves="wormholeEntry.totalLeaves"
      :is-saving="isSaving"
      :is-dirty="isDirty"
      :form-id="formId"
      @close="closeWormholeModal"
      @restore="resetWormholeParams"
      @update-field="updateWormholeField"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ragApi, type ParamGroup, type ParamValue, type RagParams } from "@/api";
import WormholeRoutingModal from "@/features/rag-tuning/WormholeRoutingModal.vue";
import {
  GROUP_ORDER,
  WORMHOLE_PRIMARY_KEYS,
  getGroupMeta,
  getParamMeta,
  getSubParamRange,
  getToneLabel,
  getTupleLabel,
  type GroupMeta,
  type ParamMeta,
  type WormholePrimaryKey,
} from "@/features/rag-tuning/metadata";
import { showMessage } from "@/utils";

type NumericRecord = Record<string, number>;
type ParamEntryKind = "number" | "tuple" | "nested";
type StatusType = "info" | "success" | "error";

interface ParamEntryBase {
  key: string;
  fieldId: string;
  meta: ParamMeta;
  kind: ParamEntryKind;
  changedLeaves: number;
  totalLeaves: number;
}

interface NumberParamEntry extends ParamEntryBase {
  kind: "number";
  value: number;
}

interface TupleParamEntry extends ParamEntryBase {
  kind: "tuple";
  value: number[];
}

interface NestedParamEntry extends ParamEntryBase {
  kind: "nested";
  value: NumericRecord;
}

type ParamEntry = NumberParamEntry | TupleParamEntry | NestedParamEntry;

interface GroupSection {
  name: string;
  anchor: string;
  meta: GroupMeta;
  raw: ParamGroup;
  entries: ParamEntry[];
  changedLeaves: number;
  totalLeaves: number;
}

const WORMHOLE_GROUP_NAME = "KnowledgeBaseManager";
const WORMHOLE_PARAM_KEY = "spikeRouting";
const formId = "rag-tuning-form";

const params = ref<RagParams>({});
const originalParams = ref<RagParams>({});
const isLoading = ref(true);
const isSaving = ref(false);
const loadError = ref("");
const statusMessage = ref("");
const statusType = ref<StatusType>("info");
const wormholeModalOpen = ref(false);

function cloneParams(source: RagParams): RagParams {
  return JSON.parse(JSON.stringify(source));
}

function isNumericRecord(value: ParamValue | undefined): value is NumericRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countLeafValues(value: ParamValue): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (isNumericRecord(value)) {
    return Object.keys(value).length;
  }

  return 1;
}

function countChangedLeaves(current: ParamValue, original?: ParamValue): number {
  if (original === undefined) {
    return countLeafValues(current);
  }

  if (Array.isArray(current) && Array.isArray(original)) {
    const maxLength = Math.max(current.length, original.length);
    let changedCount = 0;

    for (let index = 0; index < maxLength; index += 1) {
      if (current[index] !== original[index]) {
        changedCount += 1;
      }
    }

    return changedCount;
  }

  if (isNumericRecord(current) && isNumericRecord(original)) {
    const keys = new Set([...Object.keys(current), ...Object.keys(original)]);
    let changedCount = 0;

    keys.forEach((key) => {
      if (current[key] !== original[key]) {
        changedCount += 1;
      }
    });

    return changedCount;
  }

  return current === original ? 0 : 1;
}

function createAnchor(groupName: string): string {
  const normalized = groupName
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return `rag-group-${normalized || "default"}`;
}

function createFieldId(groupName: string, paramKey: string): string {
  return `rag-field-${groupName}-${paramKey}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function compareGroupOrder(left: string, right: string): number {
  const leftIndex = GROUP_ORDER.indexOf(left as (typeof GROUP_ORDER)[number]);
  const rightIndex = GROUP_ORDER.indexOf(right as (typeof GROUP_ORDER)[number]);

  if (leftIndex === -1 && rightIndex === -1) {
    return left.localeCompare(right);
  }

  if (leftIndex === -1) {
    return 1;
  }

  if (rightIndex === -1) {
    return -1;
  }

  return leftIndex - rightIndex;
}

function buildEntry(
  groupName: string,
  paramKey: string,
  value: ParamValue,
  original: ParamValue | undefined
): ParamEntry {
  const base = {
    key: paramKey,
    fieldId: createFieldId(groupName, paramKey),
    meta: getParamMeta(groupName, paramKey),
    changedLeaves: countChangedLeaves(value, original),
    totalLeaves: countLeafValues(value),
  };

  if (Array.isArray(value)) {
    return { ...base, kind: "tuple", value };
  }

  if (isNumericRecord(value)) {
    return { ...base, kind: "nested", value };
  }

  return { ...base, kind: "number", value };
}

const groupSections = computed<GroupSection[]>(() =>
  Object.entries(params.value)
    .sort(([left], [right]) => compareGroupOrder(left, right))
    .map(([groupName, groupParams]) => {
      const entries = Object.entries(groupParams).map(([paramKey, value]) =>
        buildEntry(groupName, paramKey, value, originalParams.value[groupName]?.[paramKey])
      );

      return {
        name: groupName,
        anchor: createAnchor(groupName),
        meta: getGroupMeta(groupName),
        raw: groupParams,
        entries,
        changedLeaves: entries.reduce((total, entry) => total + entry.changedLeaves, 0),
        totalLeaves: entries.reduce((total, entry) => total + entry.totalLeaves, 0),
      };
    })
);

const totalLeafCount = computed(() =>
  groupSections.value.reduce((total, section) => total + section.totalLeaves, 0)
);

const changedLeafCount = computed(() =>
  groupSections.value.reduce((total, section) => total + section.changedLeaves, 0)
);

const isDirty = computed(() => changedLeafCount.value > 0);
const hasParams = computed(() => groupSections.value.length > 0);

const wormholeEntry = computed<NestedParamEntry | null>(() => {
  const section = groupSections.value.find((item) => item.name === WORMHOLE_GROUP_NAME);
  const entry = section?.entries.find((item) => item.key === WORMHOLE_PARAM_KEY);
  return entry && entry.kind === "nested" ? entry : null;
});

const wormholeCurrentValues = computed<NumericRecord>(() => {
  const raw = params.value[WORMHOLE_GROUP_NAME]?.[WORMHOLE_PARAM_KEY];
  return isNumericRecord(raw) ? raw : {};
});

const wormholeOriginalValues = computed<NumericRecord>(() => {
  const raw = originalParams.value[WORMHOLE_GROUP_NAME]?.[WORMHOLE_PARAM_KEY];
  return isNumericRecord(raw) ? raw : {};
});

function isWormholeNestedEntry(entry: ParamEntry): entry is NestedParamEntry {
  return entry.kind === "nested" && entry.key === WORMHOLE_PARAM_KEY;
}

function isWormholeEntry(sectionName: string, entry: ParamEntry): boolean {
  return sectionName === WORMHOLE_GROUP_NAME && isWormholeNestedEntry(entry);
}

function getKindLabel(kind: ParamEntryKind): string {
  switch (kind) {
    case "number":
      return "单值";
    case "tuple":
      return "区间/配比";
    case "nested":
      return "子模块";
    default:
      return "参数";
  }
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

function getNumberStep(value: number): number {
  if (Number.isInteger(value) && Math.abs(value) >= 1) {
    return 1;
  }

  if (Math.abs(value) < 0.1) {
    return 0.001;
  }

  if (Math.abs(value) < 1) {
    return 0.01;
  }

  return 0.05;
}

function getTupleFieldLabel(entry: TupleParamEntry, index: number): string {
  return getTupleLabel(entry.meta, index);
}

function getNestedMeta(groupName: string, paramKey: string, subKey: string): ParamMeta {
  return getParamMeta(groupName, `${paramKey}.${subKey}`);
}

function getWormholeQuickLabel(subKey: WormholePrimaryKey): string {
  return getNestedMeta(WORMHOLE_GROUP_NAME, WORMHOLE_PARAM_KEY, subKey).label;
}

function getWormholeQuickValue(entry: ParamEntry, subKey: WormholePrimaryKey): string {
  if (!isWormholeNestedEntry(entry)) {
    return "--";
  }

  return formatNumber(entry.value[subKey]);
}

function scrollToGroup(anchor: string): void {
  document.getElementById(anchor)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function openWormholeModal(): void {
  if (wormholeEntry.value) {
    wormholeModalOpen.value = true;
  }
}

function closeWormholeModal(): void {
  wormholeModalOpen.value = false;
}

function updateWormholeField(subKey: string, value: number): void {
  const raw = params.value[WORMHOLE_GROUP_NAME]?.[WORMHOLE_PARAM_KEY];

  if (isNumericRecord(raw)) {
    raw[subKey] = value;
  }
}

function resetWormholeParams(): void {
  const original = originalParams.value[WORMHOLE_GROUP_NAME]?.[WORMHOLE_PARAM_KEY];

  if (!params.value[WORMHOLE_GROUP_NAME] || !isNumericRecord(original)) {
    return;
  }

  params.value[WORMHOLE_GROUP_NAME][WORMHOLE_PARAM_KEY] = { ...original };
  statusMessage.value = "已恢复虫洞脉冲路由的未保存修改。";
  statusType.value = "info";
}

async function loadParams(): Promise<void> {
  isLoading.value = true;
  loadError.value = "";

  try {
    const data = await ragApi.getRagParams({
      showLoader: false,
      loadingKey: "rag-tuning.params.load",
    });

    params.value = cloneParams(data);
    originalParams.value = cloneParams(data);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    loadError.value = `加载失败：${errorMessage}`;
    statusMessage.value = loadError.value;
    statusType.value = "error";
    console.error("Failed to load RAG params:", error);
    showMessage(loadError.value, "error");
  } finally {
    isLoading.value = false;
  }
}

async function saveParams(): Promise<void> {
  if (!hasParams.value || !isDirty.value || isSaving.value) {
    return;
  }

  isSaving.value = true;

  try {
    await ragApi.saveRagParams(params.value, {
      loadingKey: "rag-tuning.params.save",
    });

    originalParams.value = cloneParams(params.value);
    statusMessage.value = "RAG 参数已保存。";
    statusType.value = "success";
    showMessage("RAG 参数已保存。", "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `保存失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  } finally {
    isSaving.value = false;
  }
}

function resetParams(): void {
  params.value = cloneParams(originalParams.value);
  statusMessage.value = "已恢复到最近一次保存的参数状态。";
  statusType.value = "info";
}

onMounted(() => {
  void loadParams();
});
</script>

<style scoped>
.rag-lab {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.rag-lab__hero {
  position: relative;
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) auto;
  gap: var(--space-5);
  padding: var(--space-6);
  border-radius: var(--radius-xl);
}

.rag-lab__hero::before {
  content: "";
  position: absolute;
  inset: auto -10% -30% 55%;
  height: 260px;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--highlight-text) 24%, transparent),
    transparent 68%
  );
  pointer-events: none;
}

.rag-lab__eyebrow {
  display: inline-flex;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-full);
  background: var(--info-bg);
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.rag-lab__hero-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.rag-lab__hero-copy h2 {
  margin: 0;
  font-size: var(--font-size-section-title-fluid);
  line-height: 1.2;
}

.rag-lab__hero-copy .description {
  max-width: 68ch;
  margin: 0;
}

.rag-lab__hero-stats {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(96px, 120px));
  gap: var(--space-3);
  align-content: start;
}

.hero-stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
}

.hero-stat--warning {
  border-color: var(--warning-border);
  background: var(--warning-bg);
}

.hero-stat__value {
  font-size: var(--font-size-display);
  font-weight: 700;
  line-height: 1;
}

.hero-stat__label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.rag-lab__state {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 20px var(--space-5);
}

.rag-lab__state p {
  margin: 0;
  color: var(--secondary-text);
}

.rag-lab__state .material-symbols-outlined {
  font-size: var(--font-size-section-icon);
  color: var(--highlight-text);
}

.rag-lab__state--error {
  justify-content: space-between;
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

.rag-lab__workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--space-5);
  align-items: start;
}

.rag-lab__main {
  display: grid;
  gap: var(--space-5);
}

.group-panel {
  overflow: hidden;
  border-radius: var(--radius-xl);
  scroll-margin-top: calc(var(--app-top-bar-height, 60px) + 16px);
}

.group-panel__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-5) 20px var(--space-6);
  position: relative;
  background: linear-gradient(90deg, var(--surface-overlay-soft), transparent);
}

.group-panel__header::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 70%;
  background: var(--group-accent);
  border-radius: 2px;
}

.group-panel__header-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.group-panel__badge {
  display: inline-flex;
  width: fit-content;
  padding: 5px var(--space-3);
  border-radius: var(--radius-full);
  background: var(--surface-overlay-strong);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.group-panel__title-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.group-panel__title-row .material-symbols-outlined {
  font-size: var(--font-size-section-icon);
  color: var(--highlight-text);
}

.group-panel__title-row h3 {
  margin: 0;
  font-size: var(--font-size-title);
}

.group-panel__name {
  margin: var(--space-1) 0 0;
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.group-panel__description {
  max-width: 70ch;
  margin: 0;
  color: var(--secondary-text);
  line-height: 1.7;
}

.group-panel__metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(96px, 110px));
  gap: 10px;
}

.group-panel__metric {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  justify-content: center;
  padding: 14px var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
}

.group-panel__metric span {
  font-size: var(--font-size-title);
  font-weight: 700;
}

.group-panel__metric small {
  color: var(--secondary-text);
}

.group-panel__list {
  display: grid;
}

.param-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.72fr);
  gap: var(--space-5);
  padding: var(--space-5) var(--space-5) var(--space-5) var(--space-6);
  border-top: 1px solid var(--border-color);
}

.param-row--changed {
  background: var(--info-bg);
}

.param-row__copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.param-row__heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-4);
}

.param-row__title-block h4 {
  margin: 0;
  font-size: var(--font-size-body);
}

.param-row__key {
  margin: var(--space-1) 0 0;
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.param-row__pills {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.mini-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.mini-pill--neutral {
  background: var(--surface-overlay);
  color: var(--secondary-text);
}

.mini-pill--stable {
  background: var(--success-bg);
  color: var(--success-text);
}

.mini-pill--sensitive {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.mini-pill--critical {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.mini-pill--changed {
  background: var(--info-bg);
  color: var(--info-text);
}

.param-row__summary {
  margin: 0;
  color: color-mix(in srgb, var(--primary-text) 84%, transparent);
  line-height: 1.7;
}

.param-row__range {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  width: fit-content;
  padding: 7px var(--space-3);
  border-radius: var(--radius-full);
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.param-row__range .material-symbols-outlined {
  font-size: var(--font-size-body);
}

.param-row__details summary {
  cursor: pointer;
  color: var(--highlight-text);
}

.param-row__details-body {
  max-width: 68ch;
  margin-top: var(--space-2);
  color: var(--secondary-text);
  line-height: 1.7;
}

.param-row__control {
  display: flex;
  align-items: stretch;
}

.control-shell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-4);
  border-radius: var(--radius-xl);
  background: var(--surface-overlay-soft);
}

.control-shell__label,
.tuple-field span,
.nested-header {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.control-shell input,
.tuple-field input,
.nested-item__number {
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--input-bg);
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", monospace;
}

.tuple-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-3);
}

.tuple-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.control-shell--nested {
  gap: var(--space-4);
  container: nested-shell / inline-size;
}

.nested-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
}

.nested-list {
  display: grid;
  gap: var(--space-3);
}

.nested-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 160px;
  gap: 14px;
  padding: 14px;
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-strong);
}

.nested-item__copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.nested-item__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.nested-item__title h5 {
  margin: 0;
  font-size: var(--font-size-body);
}

.nested-item__key {
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.nested-item__summary {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.nested-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.nested-item__range {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-overlay);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.nested-item__control {
  display: flex;
  flex-direction: column;
  gap: 10px;
  justify-content: center;
}

.nested-item__slider {
  width: 100%;
  margin: 0;
  accent-color: var(--highlight-text);
}

.nested-item__number {
  text-align: right;
}

@container nested-shell (max-width: 480px) {
  .nested-item {
    grid-template-columns: 1fr;
  }

  .nested-item__control {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 112px;
    align-items: center;
  }
}

@container nested-shell (max-width: 340px) {
  .nested-item__control {
    grid-template-columns: 1fr;
  }
}

.wormhole-launchpad {
  display: contents;
}

.wormhole-launchpad__copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.wormhole-launchpad__control {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  justify-content: space-between;
  width: 100%;
  padding: var(--space-4);
  border-radius: var(--radius-xl);
  background: var(--surface-overlay-soft);
  border: 1px solid var(--surface-overlay-soft);
}

.wormhole-launchpad__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.wormhole-launchpad__stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
}

.wormhole-launchpad__stat span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.wormhole-launchpad__stat strong {
  font-size: var(--font-size-display);
  line-height: 1;
}

.wormhole-launchpad__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0;
}

.wormhole-launchpad__footer .btn-primary,
.wormhole-launchpad__control .btn-primary {
  width: 100%;
  justify-content: center;
}

.rag-lab__aside {
  position: sticky;
  top: var(--space-4);
}

.rag-console {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  border-radius: var(--radius-xl);
}

.rag-console__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.rag-console__section h3,
.rag-console__section p {
  margin: 0;
}

.rag-console__section p {
  color: var(--secondary-text);
  font-size: var(--font-size-body);
}

.rag-console__label {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.rag-console__actions,
.rag-console__jump-list {
  display: grid;
  gap: 10px;
}

.rag-console__actions button {
  justify-content: center;
}

.rag-console__actions button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.rag-console__status {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid transparent;
  font-size: var(--font-size-body);
}

.rag-console__status--info {
  background: var(--info-bg);
  border-color: var(--info-border);
}

.rag-console__status--success {
  background: var(--success-bg);
  border-color: var(--success-border);
  color: var(--success-text);
}

.rag-console__status--error {
  background: var(--danger-bg);
  border-color: var(--danger-border);
  color: var(--danger-text);
}

.rag-console__jump-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
  color: var(--primary-text);
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
  text-align: left;
}

.rag-console__jump-btn:hover {
  border-color: var(--highlight-text);
  background: var(--info-bg);
  transform: translateY(-1px);
}

.rag-console__jump-btn:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.rag-console__jump-btn small,
.rag-console__tips {
  color: var(--secondary-text);
}

.rag-console__jump-btn small,
.rag-console__tips code {
  font-family: "Consolas", "Monaco", monospace;
}

.rag-console__tips {
  display: grid;
  gap: 10px;
  padding-left: var(--space-4);
}

@media (max-width: 1180px) {
  .rag-lab__hero {
    grid-template-columns: 1fr;
  }

  .rag-lab__hero-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .rag-lab__workspace {
    grid-template-columns: 1fr;
  }

  .rag-lab__aside {
    position: static;
  }
}

@media (max-width: 960px) {
  .group-panel__header,
  .param-row,
  .wormhole-launchpad,
  .nested-item {
    grid-template-columns: 1fr;
  }

  .group-panel__header,
  .param-row {
    padding-right: var(--space-4);
  }

  .group-panel__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wormhole-launchpad__footer {
    flex-direction: column;
    align-items: stretch;
  }
}

@media (max-width: 640px) {
  .rag-lab__hero,
  .rag-console {
    padding: var(--space-4);
  }

  .rag-lab__hero-stats {
    grid-template-columns: 1fr;
  }

  .group-panel__header {
    padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
  }

  .param-row {
    padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
  }

  .param-row__heading {
    flex-direction: column;
  }

  .param-row__pills {
    justify-content: flex-start;
  }

  .tuple-grid,
  .wormhole-launchpad__stats {
    grid-template-columns: 1fr;
  }
}
</style>
