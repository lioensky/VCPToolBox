<template>
  <Teleport to="body">
    <Transition name="diary-syntax-modal">
      <div
        v-if="modelValue"
        class="diary-syntax-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diary-syntax-title"
        @click.self="close"
      >
        <section
          class="diary-syntax-panel"
          @click.stop
          @mousedown.stop
          @keydown.stop
        >
          <header class="diary-syntax-header">
            <div>
              <span class="eyebrow">DailyNote DSL</span>
              <h2 id="diary-syntax-title">日记本语法编辑器</h2>
              <p>
                生成 <code>《《小吉日记本》》</code>、<code>[[公共知识日记本]]</code>
                这类可直接放入 Agent 系统提示词的记忆占位符。
              </p>
            </div>
            <button class="diary-close-btn" type="button" aria-label="关闭" @click="close">
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>

          <div class="diary-syntax-body">
            <label class="syntax-field syntax-field--full">
              <span>日记本名称</span>
              <input
                v-model="notebookName"
                type="text"
                placeholder="例如：小吉日记本 / 物理|政治日记本"
                @keydown.stop
              />
              <small>
                支持聚合检索，用 <code>|</code> 分隔多个日记本名。
                示例：<code>物理|政治|python日记本</code>，最终可生成
                <code>[[物理|政治|python日记本:1.2]]</code> 或
                <code>《《物理|政治|python日记本::TagMemo+::Rerank+》》</code>。
              </small>
            </label>

            <div class="syntax-card syntax-card--mode">
              <div class="syntax-card-title">
                <span class="material-symbols-outlined">route</span>
                注入模式
              </div>
              <div class="mode-toggle">
                <button
                  type="button"
                  :class="{ active: syntaxMode === 'dynamic' }"
                  @click="syntaxMode = 'dynamic'"
                >
                  《《》》 动态注入
                </button>
                <button
                  type="button"
                  :class="{ active: syntaxMode === 'fixed' }"
                  @click="syntaxMode = 'fixed'"
                >
                  [[]] 固定注入
                </button>
              </div>
              <p>
                <strong>动态注入</strong>会先判断当前上下文与日记本是否相关，达标后才检索片段；
                <strong>固定注入</strong>会无条件执行 RAG 片段检索。
              </p>
            </div>

            <div class="syntax-grid">
              <div class="syntax-card syntax-option-card syntax-option-card--wide syntax-classic-card">
                <div class="syntax-card-title">
                  <span class="material-symbols-outlined">auto_awesome</span>
                  经典 RAG 后缀
                </div>
                <p>
                  这些是最常用的单语法开关，可自由组合。<code>::Time</code> 负责时间感知，
                  <code>::Group</code> 负责语义组增强，<code>::Rerank</code> 负责普通精排，
                  <code>::Expand</code> 负责父文档展开。注意：普通 <code>::Rerank</code>
                  与 <code>::Rerank+</code> 只能二选一。
                </p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Time 时间感知检索</strong>
                    <code>::Time</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.time" />
                </div>
                <p>解析“上周、最近、三个月前”等自然语言时间线索，并融合时间范围召回。该语法还支持新建聊天时自动传递上一个聊天的记忆，无视任意前端。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Group 语义组增强</strong>
                    <code>::Group</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.group" />
                </div>
                <p>命中语义组后融合组向量，适合逻辑串、黑话、玩梗和专精主题捕网。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Rerank 普通精排</strong>
                    <code>::Rerank</code>
                  </div>
                  <AppSwitch
                    :model-value="enabledSuffixes.rerank"
                    @update:model-value="setExclusiveSuffix('rerank', $event)"
                  />
                </div>
                <p>先超量召回，再用 Reranker 模型重新排序。普通 Rerank 与 Rerank+ 只能二选一。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Expand 父文档展开</strong>
                    <code>::Expand</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.expand" />
                </div>
                <p>命中任意 chunk 后展开所属完整日记，适合长文档、API 手册和设定集。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Associate 联想共现</strong>
                    <code>::Associate</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.associate" />
                </div>
                <p>以已召回 chunk 作为种子，寻找多路径共同指向的潜在关联记忆。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Base64Memo 多模态附件召回</strong>
                    <code>::Base64Memo</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.base64Memo" />
                </div>
                <p>从召回日记中提取图片、音频、视频、PDF 等附件并注入当前对话。</p>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>TagMemo</strong>
                    <code>::TagMemo</code>
                  </div>
                  <AppSwitch
                    :model-value="enabledSuffixes.tagMemo"
                    @update:model-value="setExclusiveSuffix('tagMemo', $event)"
                  />
                </div>
                <p>
                  启用浪潮 TagMemo 拓扑记忆增强。留空权重时系统会动态估算，通常建议不要手写数字。
                  TagMemo 与 TagMemo+ 只能二选一。
                </p>
                <label class="inline-number">
                  <span>可选权重</span>
                  <input
                    v-model="tagMemoWeight"
                    :disabled="!enabledSuffixes.tagMemo"
                    type="number"
                    min="0"
                    max="2"
                    step="0.05"
                    placeholder="留空自动"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>TagMemo+</strong>
                    <code>::TagMemo+</code>
                  </div>
                  <AppSwitch
                    :model-value="enabledSuffixes.tagMemoPlus"
                    @update:model-value="setExclusiveSuffix('tagMemoPlus', $event)"
                  />
                </div>
                <p>
                  在 TagMemo 基础上加入测地线重排，适合标签体系完善的大型知识库。留空权重时自动动态计算。
                  TagMemo+ 与 TagMemo 只能二选一。
                </p>
                <label class="inline-number">
                  <span>可选权重</span>
                  <input
                    v-model="tagMemoPlusWeight"
                    :disabled="!enabledSuffixes.tagMemoPlus"
                    type="number"
                    min="0"
                    max="2"
                    step="0.05"
                    placeholder="留空自动"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>Rerank+</strong>
                    <code>::Rerank+</code>
                  </div>
                  <AppSwitch
                    :model-value="enabledSuffixes.rerankPlus"
                    @update:model-value="setExclusiveSuffix('rerankPlus', $event)"
                  />
                </div>
                <p>
                  双路融合精排。α 越高越信任 Reranker，留空则使用默认 0.5。
                  Rerank+ 与标准 Rerank 只能二选一。
                </p>
                <label class="inline-number">
                  <span>α 权重</span>
                  <input
                    v-model="rerankPlusAlpha"
                    :disabled="!enabledSuffixes.rerankPlus"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    placeholder="默认 0.5"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card syntax-option-card--wide">
                <div class="syntax-option-head">
                  <div>
                    <strong>时间衰减进阶</strong>
                    <code>::TimeDecay30/0.5/box_archive</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.timeDecay" />
                </div>
                <p>
                  对旧记忆做时间衰减，支持 <code>::TimeDecay半衰期天数/最低分/白名单标签</code>。
                  第三段是固定衰减内容的标签白名单，多个标签用英文逗号分隔；不写第三段则衰减所有可解析日期的非时间路召回结果。
                  标签会按原文保留，支持中文、英文、数字和下划线，例如 <code>box归档,临时记忆,box_archive</code>。
                </p>
                <div class="time-decay-grid" :class="{ disabled: !enabledSuffixes.timeDecay }">
                  <label class="inline-number">
                    <span>半衰期天数</span>
                    <input
                      v-model="timeDecayHalfLifeDays"
                      :disabled="!enabledSuffixes.timeDecay"
                      type="text"
                      inputmode="numeric"
                      pattern="[0-9]*"
                      placeholder="30"
                    />
                  </label>
                  <label class="inline-number">
                    <span>最低分</span>
                    <input
                      v-model="timeDecayMinScore"
                      :disabled="!enabledSuffixes.timeDecay"
                      type="text"
                      inputmode="decimal"
                      placeholder="0.5"
                    />
                  </label>
                  <label class="syntax-field">
                    <span>只衰减这些标签</span>
                    <input
                      v-model="timeDecayTargetTags"
                      :disabled="!enabledSuffixes.timeDecay"
                      type="text"
                      placeholder="box归档,临时记忆,box_archive"
                    />
                    <small>
                      推荐在日记里写稳定标签：<code>Tag: 2026-05-19, box归档, 临时记忆</code>，
                      再用第三段选择固定衰减内容。
                    </small>
                  </label>
                </div>
              </div>

              <div class="syntax-card syntax-option-card">
                <div class="syntax-option-head">
                  <div>
                    <strong>最小阈值截断</strong>
                    <code>::Truncate</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.truncate" />
                </div>
                <p>
                  丢弃最终分低于阈值的记忆片段，适合过滤噪音。常用范围 0.25 - 0.6。
                </p>
                <label class="inline-number">
                  <span>阈值</span>
                  <input
                    v-model="truncateThreshold"
                    :disabled="!enabledSuffixes.truncate"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    placeholder="0.4"
                    @keydown.stop
                  />
                </label>
              </div>

              <div class="syntax-card syntax-option-card syntax-option-card--wide">
                <div class="syntax-option-head">
                  <div>
                    <strong>RoleValve 角色楼层门控</strong>
                    <code>::RoleValve@User>3</code>
                  </div>
                  <AppSwitch v-model="enabledSuffixes.roleValve" />
                </div>
                <p>
                  根据上下文中 User / Assistant / System 的发言楼层数决定是否加载日记本，
                  适合“聊到一定深度才启用”的知识库。
                </p>

                <div class="role-valve-builder" :class="{ disabled: !enabledSuffixes.roleValve }">
                  <div class="role-valve-row">
                    <select v-model="roleValveDraft.role" :disabled="!enabledSuffixes.roleValve">
                      <option value="@User">@User 用户发言</option>
                      <option value="@Assistant">@Assistant 助手发言</option>
                      <option value="@System">@System 系统消息</option>
                    </select>
                    <select v-model="roleValveDraft.operator" :disabled="!enabledSuffixes.roleValve">
                      <option value=">">></option>
                      <option value="<"><</option>
                      <option value=">=">>=</option>
                      <option value="<="><=</option>
                    </select>
                    <input
                      v-model.number="roleValveDraft.count"
                      :disabled="!enabledSuffixes.roleValve"
                      type="number"
                      min="0"
                      step="1"
                      @keydown.stop
                    />
                    <button
                      type="button"
                      class="btn-secondary btn-sm"
                      :disabled="!enabledSuffixes.roleValve"
                      @click="addRoleValveCondition"
                    >
                      添加条件
                    </button>
                  </div>

                  <div class="logic-row">
                    <span>条件连接符</span>
                    <button
                      type="button"
                      :class="{ active: roleValveJoiner === '&' }"
                      :disabled="!enabledSuffixes.roleValve"
                      @click="roleValveJoiner = '&'"
                    >
                      且 &
                    </button>
                    <button
                      type="button"
                      :class="{ active: roleValveJoiner === '|' }"
                      :disabled="!enabledSuffixes.roleValve"
                      @click="roleValveJoiner = '|'"
                    >
                      或 |
                    </button>
                  </div>

                  <div class="condition-list">
                    <span
                      v-for="(condition, index) in roleValveConditions"
                      :key="`${condition}-${index}`"
                      class="condition-chip"
                    >
                      {{ condition }}
                      <button type="button" @click="removeRoleValveCondition(index)">×</button>
                    </span>
                    <span v-if="roleValveConditions.length === 0" class="condition-empty">
                      暂无条件，将使用当前编辑行自动生成。
                    </span>
                  </div>
                </div>
              </div>

              <div class="syntax-card syntax-option-card syntax-option-card--wide">
                <div class="syntax-option-head">
                  <div>
                    <strong>AIMemo / AIMemo+</strong>
                    <code>::AIMemo</code>
                  </div>
                </div>
                <p>
                  两个 AI 语法都需要在前端系统提示词中加入 <code>[[AIMemo=True]]</code> 特殊占位符才会触发。
                  <strong>AIMemo</strong> 是独立 AI 召回管线，触发时其它 RAG 后缀不会工作，但可写在一起；
                  <strong>AIMemo+</strong> 会先复用完整后缀管线构建5倍K候选池，再交给 AI 总结，支持与任意语法兼容。
                </p>
                <div class="ai-mode-row">
                  <button
                    type="button"
                    :class="{ active: aiMode === 'none' }"
                    @click="aiMode = 'none'"
                  >
                    不使用
                  </button>
                  <button
                    type="button"
                    :class="{ active: aiMode === 'aimemo' }"
                    @click="aiMode = 'aimemo'"
                  >
                    AIMemo
                  </button>
                  <button
                    type="button"
                    :class="{ active: aiMode === 'aimemoPlus' }"
                    @click="aiMode = 'aimemoPlus'"
                  >
                    AIMemo+
                  </button>
                </div>
                <label class="syntax-field">
                  <span>可选预设名</span>
                  <input
                    v-model="aiPreset"
                    :disabled="aiMode === 'none'"
                    type="text"
                    placeholder="例如 custom_preset，可留空"
                    @keydown.stop
                  />
                </label>
              </div>
            </div>

            <div class="syntax-card k-card">
              <div class="syntax-option-head">
                <div>
                  <strong>K 倍率（必须放最后）</strong>
                  <code>:1.5</code>
                </div>
                <AppSwitch v-model="useKMultiplier" />
              </div>
              <p>
                调整 RAG 召回数量。注意 K 倍率语法使用单引号风格的冒号位置：
                它必须追加在日记本名称与所有后缀之后，并放在最终闭合符号之前。
              </p>
              <label class="inline-number">
                <span>K 倍率</span>
                <input
                  v-model="kMultiplier"
                  :disabled="!useKMultiplier"
                  type="number"
                  min="0.1"
                  max="10"
                  step="0.1"
                  placeholder="1.5"
                  @keydown.stop
                />
              </label>
            </div>
          </div>

          <footer class="syntax-preview-bar">
            <div>
              <span>最终语法预览</span>
              <code>{{ generatedSyntax }}</code>
            </div>
            <div class="preview-actions">
              <button type="button" class="btn-secondary" @click="copySyntax">
                <span class="material-symbols-outlined">content_copy</span>
                复制文本
              </button>
              <button type="button" class="btn-primary" @click="insertSyntax">
                <span class="material-symbols-outlined">keyboard_return</span>
                插入到编辑器
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import AppSwitch from "@/components/ui/AppSwitch.vue";
import { showMessage } from "@/utils";

type SyntaxMode = "dynamic" | "fixed";
type AiMode = "none" | "aimemo" | "aimemoPlus";
type SuffixKey =
  | "time"
  | "group"
  | "rerank"
  | "timeDecay"
  | "expand"
  | "associate"
  | "base64Memo"
  | "tagMemo"
  | "tagMemoPlus"
  | "rerankPlus"
  | "truncate"
  | "roleValve";

interface RoleValveDraft {
  role: "@User" | "@Assistant" | "@System";
  operator: ">" | "<" | ">=" | "<=";
  count: number;
}

defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "insert", value: string): void;
}>();

const notebookName = ref("小吉日记本");
const syntaxMode = ref<SyntaxMode>("dynamic");
const useKMultiplier = ref(false);
const kMultiplier = ref("1.5");
const tagMemoWeight = ref("");
const tagMemoPlusWeight = ref("");
const rerankPlusAlpha = ref("");
const timeDecayHalfLifeDays = ref("");
const timeDecayMinScore = ref("");
const timeDecayTargetTags = ref("");
const truncateThreshold = ref("0.4");
const aiMode = ref<AiMode>("none");
const aiPreset = ref("");
const roleValveJoiner = ref<"&" | "|">("&");
const roleValveConditions = ref<string[]>([]);
const roleValveDraft = reactive<RoleValveDraft>({
  role: "@User",
  operator: ">",
  count: 3,
});

const enabledSuffixes = reactive<Record<SuffixKey, boolean>>({
  time: false,
  group: false,
  rerank: false,
  timeDecay: false,
  expand: false,
  associate: false,
  base64Memo: false,
  tagMemo: false,
  tagMemoPlus: false,
  rerankPlus: false,
  truncate: false,
  roleValve: false,
});

const generatedSyntax = computed(() => {
  const rawName = notebookName.value.trim() || "日记本";
  const suffixes: string[] = [];

  if (enabledSuffixes.time) suffixes.push("::Time");
  if (enabledSuffixes.group) suffixes.push("::Group");
  if (enabledSuffixes.tagMemo) suffixes.push(`::TagMemo${sanitizeNumber(tagMemoWeight.value)}`);
  if (enabledSuffixes.tagMemoPlus) suffixes.push(`::TagMemo+${sanitizeNumber(tagMemoPlusWeight.value)}`);
  if (enabledSuffixes.rerank) suffixes.push("::Rerank");
  if (enabledSuffixes.rerankPlus) suffixes.push(`::Rerank+${sanitizeNumber(rerankPlusAlpha.value)}`);
  if (enabledSuffixes.timeDecay) suffixes.push(buildTimeDecaySuffix());
  if (enabledSuffixes.truncate) suffixes.push(`::Truncate${sanitizeNumber(truncateThreshold.value) || "0.4"}`);
  if (enabledSuffixes.associate) suffixes.push("::Associate");
  if (enabledSuffixes.expand) suffixes.push("::Expand");
  if (enabledSuffixes.base64Memo) suffixes.push("::Base64Memo");
  if (aiMode.value === "aimemo") suffixes.push(`::AIMemo${formatAiPreset()}`);
  if (aiMode.value === "aimemoPlus") suffixes.push(`::AIMemo+${formatAiPreset()}`);
  if (enabledSuffixes.roleValve) suffixes.push(`::RoleValve${buildRoleValveExpression()}`);

  const kSuffix = useKMultiplier.value ? `:${sanitizeNumber(kMultiplier.value) || "1.5"}` : "";
  const inner = `${rawName}${suffixes.join("")}${kSuffix}`;

  return syntaxMode.value === "dynamic" ? `《《${inner}》》` : `[[${inner}]]`;
});

function setExclusiveSuffix(key: SuffixKey, value: boolean): void {
  enabledSuffixes[key] = value;

  if (!value) {
    return;
  }

  if (key === "tagMemo") {
    enabledSuffixes.tagMemoPlus = false;
    return;
  }

  if (key === "tagMemoPlus") {
    enabledSuffixes.tagMemo = false;
    return;
  }

  if (key === "rerank") {
    enabledSuffixes.rerankPlus = false;
    return;
  }

  if (key === "rerankPlus") {
    enabledSuffixes.rerank = false;
  }
}

function sanitizeNumber(value: unknown): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    return "";
  }

  return String(numeric);
}

function formatAiPreset(): string {
  const preset = aiPreset.value.trim();
  return preset ? `:${preset}` : "";
}

function sanitizeTimeDecayTags(value: string): string {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .join(",");
}

function buildTimeDecaySuffix(): string {
  const halfLife = sanitizeNumber(timeDecayHalfLifeDays.value);
  const minScore = sanitizeNumber(timeDecayMinScore.value);
  const targetTags = sanitizeTimeDecayTags(timeDecayTargetTags.value);

  if (!halfLife && !minScore && !targetTags) {
    return "::TimeDecay";
  }

  const head = halfLife || "30";
  if (!minScore && !targetTags) {
    return `::TimeDecay${head}`;
  }

  const middle = minScore || "0.5";
  return targetTags ? `::TimeDecay${head}/${middle}/${targetTags}` : `::TimeDecay${head}/${middle}`;
}

function buildRoleValveExpression(): string {
  const conditions =
    roleValveConditions.value.length > 0
      ? roleValveConditions.value
      : [formatRoleValveCondition()];

  return conditions.join(roleValveJoiner.value);
}

function formatRoleValveCondition(): string {
  const count = Number.isFinite(roleValveDraft.count) ? Math.max(0, Math.floor(roleValveDraft.count)) : 0;
  return `${roleValveDraft.role}${roleValveDraft.operator}${count}`;
}

function addRoleValveCondition(): void {
  const condition = formatRoleValveCondition();
  roleValveConditions.value.push(condition);
}

function removeRoleValveCondition(index: number): void {
  roleValveConditions.value.splice(index, 1);
}

async function copySyntax(): Promise<void> {
  try {
    await navigator.clipboard.writeText(generatedSyntax.value);
    showMessage("日记本语法已复制。", "success");
  } catch {
    showMessage("复制失败，请手动选中预览文本复制。", "error");
  }
}

function insertSyntax(): void {
  emit("insert", generatedSyntax.value);
  showMessage("日记本语法已插入到 Agent 文件编辑器。", "success");
}

function close(): void {
  emit("update:modelValue", false);
}
</script>

<style scoped>
.diary-syntax-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-index-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--overlay-backdrop);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.diary-syntax-panel {
  display: flex;
  flex-direction: column;
  width: min(1120px, 100%);
  max-height: min(92vh, 920px);
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background: var(--secondary-bg);
  box-shadow: var(--overlay-panel-shadow);
}

.diary-syntax-header,
.syntax-preview-bar {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5);
  border-bottom: 1px solid var(--border-color);
}

.diary-syntax-header h2 {
  margin: var(--space-2) 0;
  font-size: var(--font-size-display);
}

.diary-syntax-header p,
.syntax-card p,
.k-card p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.6;
}

.diary-close-btn {
  display: inline-grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: var(--tertiary-bg);
  color: var(--primary-text);
  cursor: pointer;
}

.diary-syntax-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  overflow-y: auto;
}

.syntax-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.syntax-field--full input {
  width: 100%;
}

.syntax-field span,
.inline-number span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
}

.syntax-field small {
  color: var(--secondary-text);
}

.syntax-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.syntax-card {
  padding: var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--tertiary-bg);
}

.syntax-classic-card {
  background: color-mix(in srgb, var(--highlight-text) 8%, var(--tertiary-bg));
  border-color: color-mix(in srgb, var(--highlight-text) 26%, var(--border-color));
}

.syntax-card--mode {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.syntax-card-title,
.syntax-option-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.syntax-card-title {
  justify-content: flex-start;
  color: var(--primary-text);
  font-weight: 700;
}

.syntax-card-title .material-symbols-outlined {
  color: var(--highlight-text);
}

.syntax-option-head strong {
  display: block;
  margin-bottom: 4px;
}

.syntax-option-head code,
.diary-syntax-header code,
.syntax-preview-bar code,
.syntax-field code,
.syntax-card p code,
.k-card p code {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--highlight-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.syntax-option-card--wide {
  grid-column: 1 / -1;
}

.mode-toggle,
.ai-mode-row,
.logic-row,
.preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.mode-toggle button,
.ai-mode-row button,
.logic-row button {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  cursor: pointer;
}

.mode-toggle button.active,
.ai-mode-row button.active,
.logic-row button.active {
  border-color: var(--highlight-text);
  background: var(--info-bg);
  color: var(--highlight-text);
}

.inline-number {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-3);
}

.inline-number input {
  width: 100%;
}

.time-decay-grid,
.role-valve-builder {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.time-decay-grid.disabled,
.role-valve-builder.disabled {
  opacity: 0.62;
}

.role-valve-row {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) 96px 96px auto;
  gap: var(--space-2);
}

.condition-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.condition-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--info-border);
  border-radius: var(--radius-full);
  background: var(--info-bg);
  color: var(--info-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.condition-chip button {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.condition-empty {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.k-card {
  border-color: var(--warning-border);
  background: var(--warning-bg);
}

.syntax-preview-bar {
  align-items: center;
  border-top: 1px solid var(--border-color);
  border-bottom: none;
  background: color-mix(in srgb, var(--primary-bg) 34%, var(--secondary-bg));
}

.syntax-preview-bar > div:first-child {
  min-width: 0;
}

.syntax-preview-bar span {
  display: block;
  margin-bottom: 6px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.syntax-preview-bar code {
  display: block;
  max-width: 62vw;
  overflow-x: auto;
  white-space: nowrap;
  font-size: var(--font-size-body);
}

.diary-syntax-modal-enter-active,
.diary-syntax-modal-leave-active {
  transition: opacity var(--transition-fast);
}

.diary-syntax-modal-enter-from,
.diary-syntax-modal-leave-to {
  opacity: 0;
}

@media (max-width: 860px) {
  .syntax-grid {
    grid-template-columns: 1fr;
  }

  .role-valve-row {
    grid-template-columns: 1fr;
  }

  .syntax-preview-bar,
  .diary-syntax-header {
    flex-direction: column;
  }

  .syntax-preview-bar code {
    max-width: 100%;
  }

  .preview-actions .btn-primary,
  .preview-actions .btn-secondary {
    flex: 1 1 180px;
    justify-content: center;
  }
}
</style>