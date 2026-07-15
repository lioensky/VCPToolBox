<template>
  <section class="v9-console">
    <header class="v9-console__header">
      <div class="v9-console__identity">
        <span class="material-symbols-outlined">deployed_code</span>
        <div>
          <div class="v9-console__eyebrow">TagMemo V9.1 Production Console</div>
          <h3>V9.1 单轨生产控制台</h3>
          <p>
            V9.1 是唯一生产路线：使用有界传播、入流枢纽校正、软非回溯与
            归一化有限时域场。LightMemo 对照测试固定比较 KNN、V9.1 与独立 Rerank。
          </p>
        </div>
      </div>
      <div class="v9-console__status">
        <UiBadge variant="success">生产：V9.1</UiBadge>
        <UiBadge variant="info">单资产</UiBadge>
        <UiBadge variant="outline">旧版本严格拒绝</UiBadge>
      </div>
    </header>

    <div class="v9-console__warning">
      <span class="material-symbols-outlined">verified_user</span>
      <p>
        资产发布仍采用原子引用替换。显式请求旧版本会返回版本已退役错误；
        全量自学习成功后会清理 V8.3 预计算状态与兼容增益，不会发生静默回退。
      </p>
    </div>

    <div class="v9-console__grid">
      <article class="v9-card v9-card--version">
        <header class="v9-card__header">
          <div>
            <span class="v9-card__kicker">Production Contract</span>
            <h4>单轨资产与重建语义</h4>
          </div>
          <UiBadge variant="success">固定 V9.1</UiBadge>
        </header>

        <div class="v9-toggle-list">
          <div class="v9-toggle">
            <span class="material-symbols-outlined">filter_1</span>
            <span>
              <strong>唯一活动资产包</strong>
              <small>查询始终固定到 V9.1 ArtifactBundle，不再构建 V8.3 查询核。</small>
            </span>
          </div>

          <div class="v9-toggle">
            <span class="material-symbols-outlined">block</span>
            <span>
              <strong>旧版本确定性拒绝</strong>
              <small>显式请求 V8.3 会返回 TAGMEMO_VERSION_RETIRED，不允许回退冒充成功。</small>
            </span>
          </div>

          <div class="v9-toggle">
            <span class="material-symbols-outlined">cleaning_services</span>
            <span>
              <strong>全量训练清理退休资产</strong>
              <small>新 V9.1 pairwise、残差与传播核发布成功后，再清理旧状态和兼容增益。</small>
            </span>
          </div>
        </div>
      </article>

      <article class="v9-card v9-card--kernel">
        <header class="v9-card__header">
          <div>
            <span class="v9-card__kicker">Hub-aware Bounded Kernel</span>
            <h4>V9.1 有界传播、枢纽校正与虫洞预算</h4>
          </div>
          <UiBadge variant="danger">高敏感</UiBadge>
        </header>

        <div class="v9-budget">
          <div>
            <span>单节点最大出流质量</span>
            <strong>{{ formatNumber(v9.outboundMass) }}</strong>
          </div>
          <div class="v9-budget__track">
            <span :style="{ width: `${clamp(v9.outboundMass, 0, 1) * 100}%` }"></span>
          </div>
          <small>归一化后每个节点所有出边传导率之和不超过该预算。</small>
        </div>

        <div class="v9-kernel-grid">
        <NumericField
          label="出流总质量"
          description="控制每跳最多保留多少传播质量；必须不大于 1。"
          :model-value="v9.outboundMass"
          :min="0.1"
          :max="1"
          :step="0.01"
          @update:model-value="setV9Number('outboundMass', $event)"
        />
        <NumericField
          label="共现证据压缩"
          description="进入 log1p 前对累计共现证据缩放，降低高频边对竞争的垄断。"
          :model-value="v9.evidenceCompression"
          :min="0.01"
          :max="5"
          :step="0.01"
          @update:model-value="setV9Number('evidenceCompression', $event)"
        />
        <NumericField
          label="虫洞竞争增益"
          description="只在归一化前提高虫洞边竞争力，不会在归一化后额外创造能量。"
          :model-value="v9.wormholeGain"
          :min="1"
          :max="3"
          :step="0.01"
          @update:model-value="setV9Number('wormholeGain', $event)"
        />
        <NumericField
          label="虫洞张力门槛"
          description="压缩后的边证据乘目标锚增益达到此值才标记为虫洞。"
          :model-value="v9.tensionThreshold"
          :min="0"
          :max="3"
          :step="0.01"
          @update:model-value="setV9Number('tensionThreshold', $event)"
        />
        <NumericField
          label="虫洞预留质量"
          description="从节点既有出流预算内预留给虫洞条件分布，不会增加总能量。"
          :model-value="v9.associationReserveMass"
          :min="0"
          :max="0.25"
          :step="0.01"
          @update:model-value="setV9Number('associationReserveMass', $event)"
        />
        <NumericField
          label="枢纽惩罚指数 η"
          description="按目标节点相对入流执行幂律抑制；0 表示关闭枢纽校正。"
          :model-value="v9.hubPenaltyExponent"
          :min="0"
          :max="1"
          :step="0.01"
          @update:model-value="setV9Number('hubPenaltyExponent', $event)"
        />
        <NumericField
          label="枢纽倍率下限"
          description="保护真实高入流核心概念，避免被枢纽校正无限压低。"
          :model-value="v9.hubPenaltyFloor"
          :min="0.05"
          :max="1"
          :step="0.01"
          @update:model-value="setV9Number('hubPenaltyFloor', $event)"
        />
        <NumericField
          label="长尾倍率上限"
          description="限制稀有目标获得的最大相对奖励，防止长尾噪声被过度放大。"
          :model-value="v9.hubPenaltyCeiling"
          :min="1"
          :max="4"
          :step="0.01"
          @update:model-value="setV9Number('hubPenaltyCeiling', $event)"
        />
        <NumericField
          label="入流平滑比例"
          description="以全图正入流中位数为尺度加入平滑项，降低小样本波动。"
          :model-value="v9.hubSmoothingRatio"
          :min="0.01"
          :max="2"
          :step="0.01"
          @update:model-value="setV9Number('hubSmoothingRatio', $event)"
        />
        </div>
      </article>

      <article class="v9-card v9-card--dynamics">
        <header class="v9-card__header">
          <div>
            <span class="v9-card__kicker">Path Dynamics</span>
            <h4>V9.1 软非回溯与有限时域场</h4>
          </div>
          <UiBadge variant="warning">V9.1 查询动力学</UiBadge>
        </header>

        <div class="v9-budget">
          <div>
            <span>立即回流保留比例</span>
            <strong>{{ formatNumber(spikeRouting.v91ReturnFlowFactor) }}</strong>
          </div>
          <div class="v9-budget__track">
            <span :style="{ width: `${clamp(spikeRouting.v91ReturnFlowFactor, 0, 1) * 100}%` }"></span>
          </div>
          <small>0 为严格非回溯，1 为保留旧传播行为；默认 0.15 强抑制双向回声。</small>
        </div>

        <NumericField
          label="立即回流保留比例"
          description="对 u→i→u 的立即返回电流乘此系数；普通汇聚路径不受影响。"
          :model-value="spikeRouting.v91ReturnFlowFactor"
          :min="0"
          :max="1"
          :step="0.01"
          @update:model-value="setSpikeNumber('v91ReturnFlowFactor', $event)"
        />
        <NumericField
          label="有限场衰减 γ"
          description="控制归一化几何跳权重；越小越偏向种子和近跳，越大越保留远跳。"
          :model-value="spikeRouting.v91FirGamma"
          :min="0.05"
          :max="0.95"
          :step="0.01"
          @update:model-value="setSpikeNumber('v91FirGamma', $event)"
        />
        <NumericField
          label="最大传播状态数"
          description="带前驱边状态的查询级硬上限，超出时保留能量最高的状态。"
          :model-value="spikeRouting.v91MaxPropagationStates"
          :min="100"
          :max="20000"
          :step="100"
          @update:model-value="setSpikeNumber('v91MaxPropagationStates', $event)"
        />
      </article>

      <article class="v9-card v9-card--residual">
        <header class="v9-card__header">
          <div>
            <span class="v9-card__kicker">Residual Instrument</span>
            <h4>内生残差与锚增益</h4>
          </div>
          <UiBadge variant="info">JS / Rust 单一真相源</UiBadge>
        </header>

        <label class="v9-field">
          <span class="v9-field__label">残差算法</span>
          <UiSelect :model-value="residual.method" @update:model-value="setResidualField('method', $event)">
            <option value="anchored_gs">Anchored Gram-Schmidt</option>
            <option value="centroid">Centroid Residual</option>
            <option value="svd">SVD Residual</option>
          </UiSelect>
          <small>实际生效配置由 JS 完整传入 Rust，并纳入 artifact signature。</small>
        </label>

        <label class="v9-toggle v9-toggle--standalone">
          <input
            type="checkbox"
            :checked="residual.semanticEnabled"
            @change="setResidualBoolean('semanticEnabled', $event)"
          />
          <span>
            <strong>启用 Pairwise 语义门控</strong>
            <small>使用当前模型签名下的成对余弦缓存调制残差邻域。</small>
          </span>
        </label>

        <div class="v9-residual-grid">
          <NumericField label="最大邻居数" :model-value="residual.maxNeighbors" :min="4" :max="256" :step="1" @update:model-value="setResidualNumber('maxNeighbors', $event)" />
          <NumericField label="最大基底数" :model-value="residual.maxBasis" :min="1" :max="32" :step="1" @update:model-value="setResidualNumber('maxBasis', $event)" />
          <NumericField label="最少邻居数" :model-value="residual.minNeighbors" :min="1" :max="64" :step="1" @update:model-value="setResidualNumber('minNeighbors', $event)" />
          <NumericField label="序位距离衰减" :model-value="residual.positionDecay" :min="0" :max="4" :step="0.01" @update:model-value="setResidualNumber('positionDecay', $event)" />
          <NumericField label="语义钟形峰值" :model-value="residual.semanticPeak" :min="-1" :max="1" :step="0.01" @update:model-value="setResidualNumber('semanticPeak', $event)" />
          <NumericField label="语义钟形宽度" :model-value="residual.semanticSigma" :min="0.02" :max="2" :step="0.01" @update:model-value="setResidualNumber('semanticSigma', $event)" />
          <NumericField label="语义软底" :model-value="residual.semanticFloor" :min="0" :max="1" :step="0.01" @update:model-value="setResidualNumber('semanticFloor', $event)" />
          <NumericField label="语义硬门槛" :model-value="residual.semanticHardFloor" :min="-1" :max="1" :step="0.01" @update:model-value="setResidualNumber('semanticHardFloor', $event)" />
          <NumericField label="最小解释增益" :model-value="residual.minGain" :min="0" :max="1" :step="0.001" @update:model-value="setResidualNumber('minGain', $event)" />
        </div>

        <div class="v9-anchor">
          <header>
            <div>
              <strong>V9.1 固定锚增益映射</strong>
              <small>原始 residual ratio 保持 [0,1]，工程增益使用固定函数映射。</small>
            </div>
            <code>clip(base + scale × r^γ)</code>
          </header>
          <div class="v9-residual-grid">
            <NumericField label="基础增益" :model-value="residual.v9AnchorBase" :min="0" :max="4" :step="0.01" @update:model-value="setResidualNumber('v9AnchorBase', $event)" />
            <NumericField label="残差倍率" :model-value="residual.v9AnchorScale" :min="0" :max="4" :step="0.01" @update:model-value="setResidualNumber('v9AnchorScale', $event)" />
            <NumericField label="曲线指数 γ" :model-value="residual.v9AnchorGamma" :min="0.1" :max="8" :step="0.01" @update:model-value="setResidualNumber('v9AnchorGamma', $event)" />
            <NumericField label="增益下限" :model-value="residual.v9AnchorMin" :min="0" :max="4" :step="0.01" @update:model-value="setResidualNumber('v9AnchorMin', $event)" />
            <NumericField label="增益上限" :model-value="residual.v9AnchorMax" :min="0" :max="8" :step="0.01" @update:model-value="setResidualNumber('v9AnchorMax', $event)" />
          </div>
        </div>
      </article>

      <article class="v9-card v9-card--geometry">
        <header class="v9-card__header">
          <div>
            <span class="v9-card__kicker">Geometry Auxiliary Readout</span>
            <h4>四层几何辅助奖励地板</h4>
          </div>
          <UiBadge variant="danger">V9.2 高敏感</UiBadge>
        </header>

        <p class="v9-card__description">
          辅助轨不会叠加创造新奖励，只在节点场、分类证据与闭合门控同时可信时，
          补足旧测地奖励尚未达到的有界地板。
        </p>

        <label class="v9-toggle v9-toggle--standalone">
          <input
            type="checkbox"
            :checked="geometryAuxiliary.enabled"
            @change="setGeometryBoolean('enabled', $event)"
          />
          <span>
            <strong>启用几何辅助轨</strong>
            <small>关闭后所有几何地板与精确身份锚点均只保留诊断，不参与排序。</small>
          </span>
        </label>

        <div class="v9-geometry-grid">
          <NumericField label="辅助奖励总上限" description="几何辅助轨单候选最多补足的绝对分数。" :model-value="geometryAuxiliary.maxAuxBonus" :min="0" :max="0.05" :step="0.001" @update:model-value="setGeometryNumber('maxAuxBonus', $event)" />
          <NumericField label="直接证据地板上限" description="direct 证据可获得的辅助目标地板上限。" :model-value="geometryAuxiliary.directFloorCap" :min="0" :max="0.05" :step="0.001" @update:model-value="setGeometryNumber('directFloorCap', $event)" />
          <NumericField label="结构证据地板上限" description="structural 连续走廊的辅助目标地板上限。" :model-value="geometryAuxiliary.structuralFloorCap" :min="0" :max="0.05" :step="0.001" @update:model-value="setGeometryNumber('structuralFloorCap', $event)" />
          <NumericField label="主题证据地板上限" description="thematic 主题接触的辅助目标地板上限。" :model-value="geometryAuxiliary.thematicFloorCap" :min="0" :max="0.05" :step="0.001" @update:model-value="setGeometryNumber('thematicFloorCap', $event)" />
          <NumericField label="最小融合几何分" description="四层融合分达到该值才允许辅助补差。" :model-value="geometryAuxiliary.minFusedScore" :min="0" :max="1" :step="0.01" @update:model-value="setGeometryNumber('minFusedScore', $event)" />
          <NumericField label="最小闭合分" description="查询、候选与 Tag→Chunk 闭合的综合门槛。" :model-value="geometryAuxiliary.minClosureScore" :min="0" :max="1" :step="0.01" @update:model-value="setGeometryNumber('minClosureScore', $event)" />
          <NumericField label="最小分类证据" description="当前 direct、structural 或 thematic 通道的最低证据。" :model-value="geometryAuxiliary.minClassEvidence" :min="0" :max="1" :step="0.01" @update:model-value="setGeometryNumber('minClassEvidence', $event)" />
          <NumericField label="地板可靠性指数" description="越大越压制低可靠候选，仅让高可靠证据接近地板上限。" :model-value="geometryAuxiliary.floorExponent" :min="0.5" :max="4" :step="0.05" @update:model-value="setGeometryNumber('floorExponent', $event)" />
        </div>

        <div class="v9-anchor">
          <header>
            <div>
              <strong>Exact Identity Anchor</strong>
              <small>只保护来自 query seed/core 的高势能精确 Tag 接触；公共 Tag 与 emergent 节点不能触发。</small>
            </div>
            <UiBadge variant="warning">精确身份保护</UiBadge>
          </header>

          <label class="v9-toggle v9-toggle--standalone">
            <input
              type="checkbox"
              :checked="identityAnchor.enabled"
              :disabled="!geometryAuxiliary.enabled"
              @change="setIdentityBoolean('enabled', $event)"
            />
            <span>
              <strong>启用精确身份锚点</strong>
              <small>同时受几何辅助总开关、精确命中、特异性和闭合门槛约束。</small>
            </span>
          </label>

          <div class="v9-geometry-grid">
            <NumericField label="最低查询势能" :model-value="identityAnchor.minPotential" :min="0" :max="1" :step="0.01" @update:model-value="setIdentityNumber('minPotential', $event)" />
            <NumericField label="最低 Tag 特异性" :model-value="identityAnchor.minSpecificity" :min="0" :max="1" :step="0.01" @update:model-value="setIdentityNumber('minSpecificity', $event)" />
            <NumericField label="最低 Tag→Chunk 闭合" :model-value="identityAnchor.minTagChunkClosure" :min="0" :max="1" :step="0.01" @update:model-value="setIdentityNumber('minTagChunkClosure', $event)" />
            <NumericField label="最低身份锚强度" :model-value="identityAnchor.minStrength" :min="0" :max="1" :step="0.01" @update:model-value="setIdentityNumber('minStrength', $event)" />
            <NumericField label="身份地板上限" :model-value="identityAnchor.floorCap" :min="0" :max="0.05" :step="0.001" @update:model-value="setIdentityNumber('floorCap', $event)" />
            <NumericField label="身份可靠性指数" :model-value="identityAnchor.floorExponent" :min="0.5" :max="4" :step="0.05" @update:model-value="setIdentityNumber('floorExponent', $event)" />
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ParamGroup, ParamValue } from "@/api";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import NumericField from "./TagMemoV9NumericField.vue";

type LooseRecord = Record<string, ParamValue>;

const props = defineProps<{
  modelValue: ParamGroup;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: ParamGroup];
}>();

const v9 = computed(() => {
  const raw = asRecord(props.modelValue.v9);
  return {
    outboundMass: numberValue(raw.outboundMass, 0.95),
    evidenceCompression: numberValue(raw.evidenceCompression, 1),
    wormholeGain: numberValue(raw.wormholeGain, 1.35),
    tensionThreshold: numberValue(raw.tensionThreshold, 1),
    associationReserveMass: numberValue(raw.associationReserveMass, 0.05),
    hubPenaltyExponent: numberValue(raw.hubPenaltyExponent, 0.3),
    hubPenaltyFloor: numberValue(raw.hubPenaltyFloor, 0.55),
    hubPenaltyCeiling: numberValue(raw.hubPenaltyCeiling, 1.8),
    hubSmoothingRatio: numberValue(raw.hubSmoothingRatio, 0.1),
  };
});
const spikeRouting = computed(() => {
  const raw = asRecord(props.modelValue.spikeRouting);
  return {
    v91ReturnFlowFactor: numberValue(raw.v91ReturnFlowFactor, 0.15),
    v91FirGamma: numberValue(raw.v91FirGamma, 0.6),
    v91MaxPropagationStates: numberValue(raw.v91MaxPropagationStates, 2000),
  };
});
const residual = computed(() => {
  const raw = asRecord(props.modelValue.intrinsicResidual);
  return {
    method: stringValue(raw.method, "anchored_gs"),
    maxNeighbors: numberValue(raw.maxNeighbors, 48),
    maxBasis: numberValue(raw.maxBasis, 4),
    minNeighbors: numberValue(raw.minNeighbors, 3),
    semanticEnabled: booleanValue(raw.semanticEnabled, true),
    semanticPeak: numberValue(raw.semanticPeak, 0.65),
    semanticSigma: numberValue(raw.semanticSigma, 0.25),
    semanticFloor: numberValue(raw.semanticFloor, 0.35),
    semanticHardFloor: numberValue(raw.semanticHardFloor, -1),
    minGain: numberValue(raw.minGain, 0.015),
    positionDecay: numberValue(raw.positionDecay, 0.15),
    v9AnchorBase: numberValue(raw.v9AnchorBase, 0.75),
    v9AnchorScale: numberValue(raw.v9AnchorScale, 1.25),
    v9AnchorGamma: numberValue(raw.v9AnchorGamma, 1),
    v9AnchorMin: numberValue(raw.v9AnchorMin, 0.5),
    v9AnchorMax: numberValue(raw.v9AnchorMax, 2),
  };
});
const geometryAuxiliary = computed(() => {
  const geodesic = asRecord(props.modelValue.geodesicRerank);
  const raw = asRecord(geodesic.geometryAuxiliary);
  return {
    enabled: booleanValue(raw.enabled, false),
    maxAuxBonus: numberValue(raw.maxAuxBonus, 0.018),
    directFloorCap: numberValue(raw.directFloorCap, 0.018),
    structuralFloorCap: numberValue(raw.structuralFloorCap, 0.012),
    thematicFloorCap: numberValue(raw.thematicFloorCap, 0.006),
    minFusedScore: numberValue(raw.minFusedScore, 0.12),
    minClosureScore: numberValue(raw.minClosureScore, 0.55),
    minClassEvidence: numberValue(raw.minClassEvidence, 0.1),
    floorExponent: numberValue(raw.floorExponent, 1.5),
  };
});
const identityAnchor = computed(() => {
  const geodesic = asRecord(props.modelValue.geodesicRerank);
  const geometry = asRecord(geodesic.geometryAuxiliary);
  const raw = asRecord(geometry.identityAnchor);
  return {
    enabled: booleanValue(raw.enabled, false),
    minPotential: numberValue(raw.minPotential, 0.8),
    minSpecificity: numberValue(raw.minSpecificity, 0.55),
    minTagChunkClosure: numberValue(raw.minTagChunkClosure, 0.35),
    minStrength: numberValue(raw.minStrength, 0.55),
    floorCap: numberValue(raw.floorCap, 0.018),
    floorExponent: numberValue(raw.floorExponent, 1.25),
  };
});

function asRecord(value: ParamValue | undefined): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : {};
}

function numberValue(value: ParamValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: ParamValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: ParamValue | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function updateSection(section: string, key: string, value: ParamValue): void {
  emit("update:modelValue", {
    ...props.modelValue,
    [section]: {
      ...asRecord(props.modelValue[section]),
      [key]: value,
    },
  });
}

function setV9Number(key: string, value: number): void {
  updateSection("v9", key, value);
}

function setSpikeNumber(key: string, value: number): void {
  updateSection("spikeRouting", key, value);
}

function setResidualField(key: string, value: string | number): void {
  updateSection("intrinsicResidual", key, String(value));
}

function setResidualNumber(key: string, value: number): void {
  updateSection("intrinsicResidual", key, value);
}

function setResidualBoolean(key: string, event: Event): void {
  updateSection("intrinsicResidual", key, (event.target as HTMLInputElement).checked);
}

function updateGeometrySection(key: string, value: ParamValue): void {
  const geodesic = asRecord(props.modelValue.geodesicRerank);
  emit("update:modelValue", {
    ...props.modelValue,
    geodesicRerank: {
      ...geodesic,
      geometryAuxiliary: {
        ...asRecord(geodesic.geometryAuxiliary),
        [key]: value,
      },
    },
  });
}

function updateIdentitySection(key: string, value: ParamValue): void {
  const geodesic = asRecord(props.modelValue.geodesicRerank);
  const geometry = asRecord(geodesic.geometryAuxiliary);
  emit("update:modelValue", {
    ...props.modelValue,
    geodesicRerank: {
      ...geodesic,
      geometryAuxiliary: {
        ...geometry,
        identityAnchor: {
          ...asRecord(geometry.identityAnchor),
          [key]: value,
        },
      },
    },
  });
}

function setGeometryNumber(key: string, value: number): void {
  updateGeometrySection(key, value);
}

function setGeometryBoolean(key: string, event: Event): void {
  updateGeometrySection(key, (event.target as HTMLInputElement).checked);
}

function setIdentityNumber(key: string, value: number): void {
  updateIdentitySection(key, value);
}

function setIdentityBoolean(key: string, event: Event): void {
  updateIdentitySection(key, (event.target as HTMLInputElement).checked);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
</script>

<style scoped>
.v9-console {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 30%, var(--border-color));
  border-radius: var(--radius-xl);
  background:
    radial-gradient(circle at 8% 0%, color-mix(in srgb, var(--highlight-text) 10%, transparent), transparent 34%),
    color-mix(in srgb, var(--primary-text) 1.5%, transparent);
}

.v9-console__header,
.v9-card__header,
.v9-anchor header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: flex-start;
}

.v9-console__identity {
  display: flex;
  gap: var(--space-3);
}

.v9-console__identity > .material-symbols-outlined {
  display: grid;
  place-items: center;
  flex: 0 0 44px;
  height: 44px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--highlight-text) 14%, transparent);
  color: var(--highlight-text);
  font-size: 26px;
}

.v9-console h3,
.v9-console h4,
.v9-console p {
  margin: 0;
}

.v9-console h3 {
  margin-top: 4px;
  font-size: var(--font-size-section-title-strong);
}

.v9-console__identity p {
  max-width: 76ch;
  margin-top: 8px;
  color: var(--secondary-text);
  line-height: 1.6;
}

.v9-console__eyebrow,
.v9-card__kicker {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.v9-console__status {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.v9-console__warning {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--warning-border) 62%, var(--border-color));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning-bg) 56%, transparent);
}

.v9-console__warning p {
  color: var(--secondary-text);
  line-height: 1.55;
}

.v9-console__warning .material-symbols-outlined {
  color: var(--warning-color);
}

.v9-console__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.v9-card {
  display: grid;
  align-content: start;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-bg) 44%, transparent);
}

/* 短卡片先并排，参数较多的 Kernel 与 Residual 各自横跨整行。 */
.v9-card--version {
  order: 1;
}

.v9-card--dynamics {
  order: 2;
  border-color: color-mix(in srgb, var(--warning-border) 48%, var(--border-color));
}

.v9-card--kernel {
  order: 3;
  grid-column: 1 / -1;
}

.v9-card--residual {
  order: 4;
  grid-column: 1 / -1;
}

.v9-card--geometry {
  order: 5;
  grid-column: 1 / -1;
  border-color: color-mix(in srgb, var(--warning-border) 52%, var(--border-color));
}

.v9-card__description {
  color: var(--secondary-text);
  line-height: 1.6;
}

.v9-kernel-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.v9-card__header h4 {
  margin-top: 4px;
  font-size: var(--font-size-title);
}

.v9-field {
  display: grid;
  gap: 6px;
}

.v9-field__label {
  font-weight: 600;
}

.v9-field small,
.v9-toggle small,
.v9-budget small,
.v9-anchor small {
  color: var(--secondary-text);
  line-height: 1.45;
}

.v9-toggle-list {
  display: grid;
  gap: var(--space-2);
}

.v9-toggle {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 68%, transparent);
  border-radius: var(--radius-md);
}

.v9-toggle > .material-symbols-outlined {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--highlight-text);
  font-size: 20px;
}

.v9-toggle span {
  display: grid;
  gap: 4px;
}

.v9-toggle--standalone {
  background: color-mix(in srgb, var(--highlight-text) 3%, transparent);
}

.v9-budget {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--highlight-text) 5%, transparent);
}

.v9-budget > div:first-child {
  display: flex;
  justify-content: space-between;
}

.v9-budget__track {
  height: 8px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--secondary-text) 20%, transparent);
}

.v9-budget__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--highlight-text), var(--warning-color));
}

.v9-residual-grid,
.v9-geometry-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.v9-anchor {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-color);
}

.v9-anchor header > div {
  display: grid;
  gap: 4px;
}

.v9-anchor code {
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--primary-text) 6%, transparent);
  color: var(--highlight-text);
}

@media (max-width: 1100px) {
  .v9-console__grid,
  .v9-residual-grid,
  .v9-geometry-grid,
  .v9-kernel-grid {
    grid-template-columns: 1fr 1fr;
  }

  .v9-card--kernel,
  .v9-card--residual,
  .v9-card--geometry {
    grid-column: 1 / -1;
  }
}

@media (max-width: 760px) {
  .v9-console {
    padding: var(--space-4);
  }

  .v9-console__header,
  .v9-card__header,
  .v9-anchor header {
    flex-direction: column;
  }

  .v9-console__status {
    justify-content: flex-start;
  }

  .v9-console__grid,
  .v9-residual-grid,
  .v9-geometry-grid,
  .v9-kernel-grid {
    grid-template-columns: 1fr;
  }

  .v9-card--kernel,
  .v9-card--residual,
  .v9-card--geometry {
    grid-column: auto;
  }
}
</style>