<template>
  <section class="river-console">
    <header class="river-console__header">
      <div class="river-console__identity">
        <span class="material-symbols-outlined">water</span>
        <div>
          <span class="river-console__eyebrow">RiverMemo · Topology V3.1</span>
          <h3>RiverMemo V3 统一信息场控制台</h3>
          <p>
            继承 V9 的全上下文降噪与有界传播，以双尺度场、查询河网相对拓扑、
            Ω 可观测泛函和 hop-0 直接锚完成统一重排。
          </p>
        </div>
      </div>
      <div class="river-console__status">
        <UiBadge :variant="enabled ? 'success' : 'outline'">
          {{ enabled ? "已启用" : "未启用" }}
        </UiBadge>
        <UiBadge variant="info">Topology V3</UiBadge>
        <UiBadge variant="danger">不建议调参</UiBadge>
      </div>
    </header>

    <div class="river-console__warning" role="alert">
      <span class="material-symbols-outlined">warning</span>
      <div>
        <strong>V10 / RiverMemo 参数已经按统一泛函联合校准，不建议用户修改</strong>
        <p>
          除“启用 RiverMemo”外，这些参数存在强耦合。修改双场 α、Ω、条件带宽、
          角色限幅或直接锚阈值，可能同时改变候选边界、统计基线与排序权限。
          只有在固定回归集、完整 trace 和可回退预设下进行算法实验时，才应展开高级参数。
        </p>
      </div>
    </div>

    <article class="river-equation">
      <div>
        <span class="river-console__eyebrow">Production Functional</span>
        <h4>拓扑 V3 总方程</h4>
        <p>
          双场语义基线 + Ω 授权的条件拓扑创新 + 与河网密度正交的直接锚点创新。
        </p>
      </div>
      <code>Sᵢ = Π[ Sᵢ field + Ωᵧ · TopologyInnovation + DirectAnchor ]</code>
    </article>

    <label class="river-master-toggle">
      <input
        type="checkbox"
        :checked="enabled"
        @change="updateBoolean('enabled', $event)"
      />
      <span class="material-symbols-outlined">{{ enabled ? "toggle_on" : "toggle_off" }}</span>
      <span>
        <strong>启用 RiverMemo Topology V3</strong>
        <small>
          启用后使用固定 V3 生产重排；V9 EPA、Residual Pyramid 与 Spike 降噪仍是查询源底座。
        </small>
      </span>
    </label>

    <div class="river-section-list">
      <details
        v-for="section in advancedSections"
        :key="section.id"
        class="river-section"
      >
        <summary>
          <span class="river-section__icon material-symbols-outlined">{{ section.icon }}</span>
          <span class="river-section__copy">
            <strong>{{ section.title }}</strong>
            <small>{{ section.summary }}</small>
          </span>
          <span class="river-section__count">{{ leavesForSection(section).length }} 项</span>
          <span class="material-symbols-outlined river-section__chevron">expand_more</span>
        </summary>

        <div class="river-section__notice">
          <span class="material-symbols-outlined">science</span>
          <span>高级实验参数：建议保持默认值。修改前请先保存当前配置为独立预设。</span>
        </div>

        <div class="river-field-grid">
          <article
            v-for="leaf in leavesForSection(section)"
            :key="leaf.path"
            class="river-field"
            :class="`river-field--${leaf.meta.tone || 'critical'}`"
          >
            <header>
              <div>
                <h5>{{ leaf.meta.label }}</h5>
                <code>{{ leaf.path }}</code>
              </div>
              <UiBadge :variant="toneVariant(leaf.meta.tone)">
                {{ getToneLabel(leaf.meta.tone) }}
              </UiBadge>
            </header>

            <p>{{ leaf.meta.summary }}</p>
            <small v-if="leaf.meta.range" class="river-field__range">
              {{ leaf.meta.range }}
            </small>
            <small v-if="leaf.meta.logic" class="river-field__logic">
              {{ leaf.meta.logic }}
            </small>

            <label v-if="leaf.kind === 'boolean'" class="river-switch">
              <input
                type="checkbox"
                :checked="Boolean(leaf.value)"
                @change="updateBoolean(leaf.path, $event)"
              />
              <span>{{ leaf.value ? "开启" : "关闭" }}</span>
            </label>

            <UiSelect
              v-else-if="leaf.kind === 'select'"
              :model-value="String(leaf.value)"
              @update:model-value="updateString(leaf.path, $event)"
            >
              <option
                v-for="option in selectOptions(leaf.path)"
                :key="option"
                :value="option"
              >
                {{ option }}
              </option>
            </UiSelect>

            <UiInput
              v-else-if="leaf.kind === 'number'"
              :model-value="numericLeafValue(leaf)"
              type="number"
              :step="numberStep(leaf.path, numericLeafValue(leaf))"
              @update:model-value="updateNumber(leaf.path, $event)"
            />

            <UiInput
              v-else
              :model-value="String(leaf.value)"
              type="text"
              @update:model-value="updateString(leaf.path, $event)"
            />
          </article>
        </div>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ParamGroup, ParamValue } from "@/api";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import {
  RIVERMEMO_SECTIONS,
  getRiverMemoParamMeta,
  getToneLabel,
  type ParamMeta,
  type ParamTone,
  type RiverMemoSectionMeta,
} from "./metadata";

type LooseRecord = Record<string, ParamValue>;
type BadgeVariant = "secondary" | "warning" | "danger";
type LeafKind = "number" | "boolean" | "select" | "string";

interface RiverLeaf {
  path: string;
  value: string | number | boolean;
  kind: LeafKind;
  meta: ParamMeta;
}

const props = defineProps<{
  modelValue: ParamGroup;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: ParamGroup];
}>();

const SELECT_OPTIONS: Record<string, readonly string[]> = {
  "sourceObservation.mode": ["v9_epa_pyramid_spike"],
  "localField.solver": ["scaled_resolvent"],
  "transferField.solver": ["scaled_resolvent"],
  "effectiveSupport.method": ["mass_ratio"],
  "pathGeometry.supportMode": ["effective_domain", "positive_tail"],
  "dstc.semanticScoreMode": ["positive", "shifted"],
  "dstc.pureScoreMode": ["topology_limited", "legacy_linear"],
  "dstc.topologyReliabilityMode": ["path_closure", "path_only"],
  "dstc.semanticSimilarityMode": ["positive", "shifted"],
  "dstc.closureMode": ["query_weighted", "tag_only"],
};

const enabled = computed(() => booleanValue(props.modelValue.enabled, false));
const advancedSections = computed(() =>
  RIVERMEMO_SECTIONS.filter((section) => section.id !== "source")
    .concat(RIVERMEMO_SECTIONS.filter((section) => section.id === "source"))
);

function asRecord(value: ParamValue | undefined): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : {};
}

function booleanValue(value: ParamValue | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function flattenValue(value: ParamValue, prefix: string): RiverLeaf[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenValue(child, prefix ? `${prefix}.${key}` : key)
    );
  }
  if (Array.isArray(value) || value === null) return [];
  const kind: LeafKind = typeof value === "boolean"
    ? "boolean"
    : typeof value === "number"
      ? "number"
      : SELECT_OPTIONS[prefix]
        ? "select"
        : "string";
  return [{
    path: prefix,
    value,
    kind,
    meta: getRiverMemoParamMeta(prefix),
  }];
}

function valueAtPath(path: string): ParamValue | undefined {
  let current: ParamValue = props.modelValue;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as LooseRecord)[segment];
  }
  return current;
}

function leavesForSection(section: RiverMemoSectionMeta): RiverLeaf[] {
  return section.paths.flatMap((path) => {
    if (path === "enabled") return [];
    const value = valueAtPath(path);
    return value === undefined ? [] : flattenValue(value, path);
  });
}

function cloneGroup(): ParamGroup {
  return JSON.parse(JSON.stringify(props.modelValue)) as ParamGroup;
}

function setPath(path: string, value: ParamValue): void {
  const next = cloneGroup();
  const segments = path.split(".");
  let cursor: LooseRecord = next;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    cursor[segment] = { ...asRecord(cursor[segment]) };
    cursor = cursor[segment] as LooseRecord;
  }
  cursor[segments[segments.length - 1]] = value;
  emit("update:modelValue", next);
}

function updateBoolean(path: string, event: Event): void {
  setPath(path, (event.target as HTMLInputElement).checked);
}

function updateNumber(path: string, raw: string | number): void {
  const value = Number(raw);
  if (Number.isFinite(value)) setPath(path, value);
}

function updateString(path: string, raw: string | number): void {
  setPath(path, String(raw));
}

function toneVariant(tone?: ParamTone): BadgeVariant {
  if (tone === "critical") return "danger";
  if (tone === "sensitive") return "warning";
  return "secondary";
}

function selectOptions(path: string): readonly string[] {
  return SELECT_OPTIONS[path] || [String(valueAtPath(path) ?? "")];
}

function numericLeafValue(leaf: RiverLeaf): number {
  return typeof leaf.value === "number" ? leaf.value : Number(leaf.value) || 0;
}

function numberStep(path: string, value: number): number | string {
  const lower = path.toLowerCase();
  if (lower.includes("tolerance")) return "any";
  if (
    lower.includes("iterations")
    || lower.endsWith("k")
    || lower.includes("candidates")
    || lower.includes("quota")
    || lower.includes("edges")
    || lower.includes("tracelimit")
    || lower.includes("peers")
    || lower.includes("contacts")
  ) return 1;
  if (Math.abs(value) < 0.01) return 0.001;
  if (Math.abs(value) < 1) return 0.01;
  return 0.05;
}
</script>

<style scoped>
.river-console {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid color-mix(in srgb, oklch(0.72 0.16 210) 42%, var(--border-color));
  border-radius: var(--radius-xl);
  background:
    radial-gradient(circle at 8% 0%, color-mix(in srgb, oklch(0.72 0.16 210) 12%, transparent), transparent 36%),
    color-mix(in srgb, var(--primary-text) 1.5%, transparent);
}

.river-console__header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: flex-start;
}

.river-console__identity {
  display: flex;
  gap: var(--space-3);
}

.river-console__identity > .material-symbols-outlined {
  display: grid;
  place-items: center;
  flex: 0 0 46px;
  height: 46px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, oklch(0.72 0.16 210) 16%, transparent);
  color: var(--highlight-text);
  font-size: 28px;
}

.river-console h3,
.river-console h4,
.river-console h5,
.river-console p {
  margin: 0;
}

.river-console h3 {
  margin-top: 4px;
  font-size: var(--font-size-section-title-strong);
}

.river-console__identity p {
  max-width: 78ch;
  margin-top: 8px;
  color: var(--secondary-text);
  line-height: 1.6;
}

.river-console__eyebrow {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.river-console__status {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.river-console__warning {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--danger-bg) 72%, transparent);
}

.river-console__warning > .material-symbols-outlined {
  flex: 0 0 auto;
  color: var(--danger-color);
  font-size: 26px;
}

.river-console__warning div {
  display: grid;
  gap: 6px;
}

.river-console__warning p {
  color: var(--secondary-text);
  line-height: 1.6;
}

.river-equation {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: center;
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 24%, var(--border-color));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--highlight-text) 4%, transparent);
}

.river-equation h4 {
  margin: 4px 0;
}

.river-equation p {
  color: var(--secondary-text);
}

.river-equation code {
  max-width: 100%;
  padding: 10px 12px;
  overflow-x: auto;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 7%, transparent);
  color: var(--highlight-text);
  font-family: "Consolas", "Monaco", monospace;
  white-space: nowrap;
}

.river-master-toggle {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--success-color) 32%, var(--border-color));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--success-color) 5%, transparent);
  cursor: pointer;
}

.river-master-toggle input {
  width: 18px;
  height: 18px;
}

.river-master-toggle > .material-symbols-outlined {
  color: var(--success-color);
  font-size: 30px;
}

.river-master-toggle > span:last-child {
  display: grid;
  gap: 4px;
}

.river-master-toggle small {
  color: var(--secondary-text);
  line-height: 1.5;
}

.river-section-list {
  display: grid;
  gap: var(--space-3);
}

.river-section {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-bg) 42%, transparent);
}

.river-section > summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-4);
  cursor: pointer;
  list-style: none;
}

.river-section > summary::-webkit-details-marker {
  display: none;
}

.river-section[open] > summary {
  border-bottom: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--highlight-text) 4%, transparent);
}

.river-section__icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--highlight-text) 10%, transparent);
  color: var(--highlight-text);
}

.river-section__copy {
  display: grid;
  gap: 4px;
}

.river-section__copy small {
  color: var(--secondary-text);
  line-height: 1.45;
}

.river-section__count {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.river-section__chevron {
  transition: transform 180ms ease;
}

.river-section[open] .river-section__chevron {
  transform: rotate(180deg);
}

.river-section__notice {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin: var(--space-3) var(--space-4) 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning-bg) 58%, transparent);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.river-section__notice .material-symbols-outlined {
  color: var(--warning-color);
  font-size: 20px;
}

.river-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  padding: var(--space-4);
}

.river-field {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-md);
}

.river-field--critical {
  border-color: color-mix(in srgb, var(--danger-border) 45%, var(--border-color));
}

.river-field--sensitive {
  border-color: color-mix(in srgb, var(--warning-border) 45%, var(--border-color));
}

.river-field header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
}

.river-field header > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.river-field h5 {
  font-size: var(--font-size-body);
}

.river-field code {
  overflow: hidden;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.river-field > p {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.5;
}

.river-field__range {
  color: var(--highlight-text);
}

.river-field__logic {
  color: var(--secondary-text);
  line-height: 1.45;
}

.river-field :deep(.ui-input),
.river-field :deep(.ui-select) {
  width: 100%;
  font-family: "Consolas", "Monaco", monospace;
}

.river-switch {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  width: fit-content;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--primary-text) 5%, transparent);
  cursor: pointer;
}

.river-switch input {
  width: 16px;
  height: 16px;
}

@media (max-width: 900px) {
  .river-console__header,
  .river-equation {
    grid-template-columns: 1fr;
    flex-direction: column;
  }

  .river-console__status {
    justify-content: flex-start;
  }

  .river-field-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .river-console {
    padding: var(--space-4);
  }

  .river-section > summary {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .river-section__count {
    display: none;
  }
}
</style>