<template>
  <section class="config-section active-section dynamic-tools-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiBadge v-if="statusMessage" :variant="statusBadgeVariant">{{ statusMessage }}</UiBadge>
        <UiButton type="button" variant="outline" size="lg" @click="loadState">
          <template #leading><span class="material-symbols-outlined">refresh</span></template>
          刷新
        </UiButton>
        <UiButton type="button" variant="outline" size="lg" @click="copyPlaceholder">
          <template #leading><span class="material-symbols-outlined">content_copy</span></template>
          复制占位符
        </UiButton>
        <UiBadge v-if="editor.dirty" variant="warning">有未保存草稿</UiBadge>
        <UiButton type="button" size="lg" variant="primary" :disabled="editor.saving || !editor.initialized" @click="saveDynamicConfig">
          <template #leading><span class="material-symbols-outlined">save</span></template>
          保存
        </UiButton>
      </UiPageActions>
    </Teleport>

    <UiToolbar class="dynamic-tools-header" align="start">
      <div>
        <h2>动态工具清单</h2>
        <p class="description">管理 {{ placeholderText }} 的注入配置、分类状态和工具暴露规则。</p>
      </div>
    </UiToolbar>

    <div class="summary-grid">
      <UiCard class="summary-item" size="sm" variant="flat">
        <span class="summary-label">可用工具</span>
        <strong>{{ availableCount }}</strong>
      </UiCard>
      <UiCard class="summary-item" size="sm" variant="flat">
        <span class="summary-label">总记录</span>
        <strong>{{ records.length }}</strong>
      </UiCard>
      <UiCard class="summary-item" size="sm" variant="flat">
        <span class="summary-label">分类队列</span>
        <strong>{{ state?.queueSize ?? 0 }}</strong>
        <small v-if="isClassifying">后台分类中</small>
      </UiCard>
      <UiCard class="summary-item" size="sm" variant="flat">
        <span class="summary-label">快照</span>
        <strong>{{ state?.snapshotId ?? '-' }}</strong>
      </UiCard>
    </div>

    <div v-if="state?.lastError" class="warning-box">
      <span class="material-symbols-outlined">warning</span>
      <span>{{ state.lastError }}</span>
    </div>

    <div v-if="draftError && editor.initialized" class="warning-box" role="alert">{{ draftError }}</div>

    <fieldset class="config-editors" :disabled="editor.saving || !editor.initialized">
    <form class="panel-grid" @submit.prevent="saveDynamicConfig">
      <UiSettingsCard class="config-card dynamic-settings-surface" title="注入配置" variant="subtle">
        <UiSettingsForm as="div" :columns="2" gap="sm">
          <UiSettingsSwitchRow v-model="config.enabled" label="启用动态工具清单" data-settings-span="full" />

          <UiField label="轻量清单数量"><UiInput v-model.number="config.maxBriefListItems" type="number" min="1" max="500" /></UiField>
          <UiField label="语义命中展开数"><UiInput v-model.number="config.maxExpandedPlugins" type="number" min="0" max="50" /></UiField>
          <UiField label="点名分类展开数"><UiInput v-model.number="config.maxForcedCategoryPlugins" type="number" min="1" max="100" /></UiField>
          <UiField label="最大注入字符数"><UiInput v-model.number="config.maxInjectionChars" type="number" min="1000" max="120000" step="1000" /></UiField>
          <UiField label="分类去抖 ms"><UiInput v-model.number="config.classificationDebounceMs" type="number" min="0" max="60000" step="100" /></UiField>
          <UiField label="分类超时 ms"><UiInput v-model.number="config.classifierTimeoutMs" type="number" min="100" max="120000" step="1000" /></UiField>

          <UiSettingsSwitchRow v-model="config.useRagEmbeddings" label="启用 RAG embedding 降级分类" data-settings-span="full" />
        </UiSettingsForm>
      </UiSettingsCard>

      <UiSettingsCard class="config-card dynamic-settings-surface" title="语义摘要与分类模型" variant="subtle">
        <UiSettingsForm as="div" :columns="2" gap="sm">
          <UiSettingsSwitchRow v-model="config.smallModel.enabled" label="启用后台语义摘要与增量分类" data-settings-span="full" />
          <UiField label="主 API（固定共用）" description="共用后端主 API_URL / API_Key；只需填写该主源支持的模型 ID，无需另配地址或密钥。只在后台增量或手动重建时调用。" data-settings-span="full">
            <UiInput model-value="后端主 API_URL / API_Key" readonly />
          </UiField>
          <UiField label="主源模型 ID" data-settings-span="full">
            <UiInput v-model.trim="config.smallModel.model" type="text" maxlength="200" placeholder="填写主 API 源支持的模型 ID" />
          </UiField>
          <UiField label="最大重试次数" description="首次请求之外的重试上限；格式修复失败后有界重试。">
            <UiInput v-model.number="config.smallModel.maxRetries" type="number" min="0" max="5" />
          </UiField>
          <UiField label="重试间隔 ms" description="重试等待也受分类总超时限制。">
            <UiInput v-model.number="config.smallModel.retryDelayMs" type="number" min="0" max="10000" step="50" />
          </UiField>
          <UiField label="模型输出 token 上限" description="为摘要和分类 JSON 留出空间，不等于轻量清单摘要目标。">
            <UiInput v-model.number="config.smallModel.maxTokens" type="number" min="64" max="8192" step="64" />
          </UiField>
          <UiField label="生成温度" description="范围 0-2；较低值便于保持分类稳定。">
            <UiInput v-model.number="config.smallModel.temperature" type="number" min="0" max="2" step="0.1" />
          </UiField>
        </UiSettingsForm>
      </UiSettingsCard>

      <UiSettingsCard class="config-card dynamic-settings-surface" title="语义摘要" variant="subtle">
        <UiSettingsForm as="div" :columns="1" gap="sm">
          <p class="muted">以下 token 数为软目标：保留完整词语和能力语义，不逐字硬切。需满足最小简述 ≤ 简述 ≤ 轻量清单。</p>
          <UiField label="轻量清单摘要目标 token"><UiInput v-model.number="config.summary.lightListTokenBudget" type="number" min="1" max="200" /></UiField>
          <UiField label="简述目标 token"><UiInput v-model.number="config.summary.briefTokenBudget" type="number" min="1" max="200" /></UiField>
          <UiField label="最小简述目标 token"><UiInput v-model.number="config.summary.minBriefTokenBudget" type="number" min="1" max="200" /></UiField>
        </UiSettingsForm>
      </UiSettingsCard>

      <UiSettingsCard class="config-card dynamic-settings-surface" title="语义分类与类别定义" variant="subtle">
        <UiSettingsForm as="div" :columns="2" gap="sm">
          <UiField label="单工具最大分类数"><UiInput v-model.number="config.classification.maxCategories" type="number" min="1" max="20" /></UiField>
          <UiField label="Embedding 命中阈值" description="0-1；仅用于 embedding 降级路径。"><UiInput v-model.number="config.classification.embeddingThreshold" type="number" min="0" max="1" step="0.01" /></UiField>
          <UiField label="分类规则 JSON" description="数组，每项包含唯一 category、description、非空 keywords 字符串数组；parent 可选，用于保留大类。保存前会校验结构。" data-settings-span="full">
            <UiTextarea v-model="categoryRulesText" rows="12" spellcheck="false" />
          </UiField>
        </UiSettingsForm>
      </UiSettingsCard>
    </form>

    <UiSettingsCard class="operations-card dynamic-settings-surface" title="分类维护" variant="subtle">
      <template #action>
        <div class="header-actions">
          <UiButton type="button" variant="outline" size="sm" :disabled="isClassifying" @click="rebuild('catalog')">
            <template #leading><span class="material-symbols-outlined">inventory</span></template>
            重建清单
          </UiButton>
          <UiButton type="button" variant="outline" size="sm" :disabled="isClassifying" @click="rebuild('classification')">
            <template #leading><span class="material-symbols-outlined">category</span></template>
            重建分类
          </UiButton>
          <UiButton type="button" variant="danger" size="sm" :disabled="isClassifying" @click="rebuild('all')">
            <template #leading><span class="material-symbols-outlined">sync</span></template>
            全量重建
          </UiButton>
        </div>
      </template>

      <p class="muted">保存只更新配置并热生效，不自动全量重建。修改类别定义、模型或摘要目标后，如需刷新已有分类，请先保存，再按需点击“重建分类”；未保存草稿不会因刷新或轮询丢失。</p>
      <UiField label="分类别名" class="alias-field" description="每行 别名=分类ID；可保留旧大类别名。此处与其他业务配置一起保存。">
        <UiTextarea
          v-model="aliasText"
          rows="4"
          placeholder="每行一个别名，例如：&#10;搜索=search&#10;代码=file_code"
        />
      </UiField>
    </UiSettingsCard>

    <UiSettingsCard id="dynamic-tool-override-editor" class="dynamic-settings-surface" title="工具人工说明覆盖" variant="subtle">
      <UiSettingsForm as="div" :columns="2" gap="sm">
        <UiField label="工具 originKey" description="可在下方工具表点击“编辑说明”，或选择已保存覆盖的工具；离线工具的覆盖也可编辑。" data-settings-span="full">
          <UiInput v-model.trim="selectedOriginKey" list="dynamic-tool-origin-keys" placeholder="选择或填写工具 originKey" />
          <datalist id="dynamic-tool-origin-keys"><option v-for="key in overrideOriginKeys" :key="key" :value="key" /></datalist>
        </UiField>
        <template v-if="selectedOriginKey">
          <UiField label="人工简述 brief" description="留空恢复自动简述。" data-settings-span="full"><UiInput v-model="overrideBrief" maxlength="4000" /></UiField>
          <UiField label="人工完整说明 fullDescription" description="留空恢复原工具说明。" data-settings-span="full"><UiTextarea v-model="overrideFullDescription" rows="5" maxlength="120000" /></UiField>
          <UiField label="人工分类 categories" description="逗号分隔；留空恢复自动分类。"><UiInput v-model="overrideCategories" /></UiField>
          <UiField label="人工关键词 keywords" description="逗号分隔；留空恢复自动关键词。"><UiInput v-model="overrideKeywords" /></UiField>
        </template>
      </UiSettingsForm>
    </UiSettingsCard>
    </fieldset>

    <UiSettingsCard class="records-card dynamic-settings-surface" title="工具状态" variant="subtle">
      <template #action>
        <UiInput
          v-model.trim="filterText"
          class="records-search"
          type="search"
          size="sm"
          placeholder="搜索插件、分类、关键词"
        />
      </template>

      <p v-if="editor.dirty" class="muted">请先保存配置草稿，再使用固定或排除操作，避免未保存编辑被覆盖。</p>
      <UiTableFrame class="records-table-frame" density="compact">
        <thead v-once>
          <tr>
            <th>插件</th>
            <th>来源</th>
            <th>状态</th>
            <th>分类</th>
            <th>说明</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in filteredRecords" :key="record.originKey">
            <td>
              <strong>{{ record.displayName || record.pluginName }}</strong>
              <small>{{ record.pluginName }}</small>
            </td>
            <td>
              <UiBadge variant="outline">{{ record.originKind === 'distributed' ? record.originId : 'local' }}</UiBadge>
            </td>
            <td>
              <div class="status-stack">
                <UiBadge :variant="record.available ? 'success' : 'secondary'">
                  {{ record.available ? 'available' : 'hidden' }}
                </UiBadge>
                <UiBadge v-if="!record.online" variant="warning">offline</UiBadge>
                <UiBadge v-if="isExcluded(record.originKey)" variant="danger">excluded</UiBadge>
                <UiBadge v-if="isPinned(record.originKey)" variant="info">pinned</UiBadge>
              </div>
            </td>
            <td>
              <div class="tag-list">
                <UiBadge v-for="category in record.categories" :key="`${record.originKey}-${category}`" variant="secondary">{{ category }}</UiBadge>
                <span v-if="record.categories.length === 0" class="muted">未分类</span>
              </div>
            </td>
            <td class="brief-cell">{{ record.brief || '-' }}</td>
            <td>
              <div class="row-actions">
                <UiButton type="button" variant="outline" size="xs" :disabled="editor.saving || editor.dirty || !editor.initialized" @click="toggleOverride(record, 'pinned')">
                  {{ isPinned(record.originKey) ? '取消固定' : '固定' }}
                </UiButton>
                <UiButton type="button" variant="outline" size="xs" :disabled="editor.saving || editor.dirty || !editor.initialized" @click="toggleOverride(record, 'excluded')">
                  {{ isExcluded(record.originKey) ? '恢复' : '排除' }}
                </UiButton>
                <UiButton type="button" variant="outline" size="xs" :disabled="editor.saving || !editor.initialized" @click="editOverride(record.originKey)">编辑说明</UiButton>
              </div>
            </td>
          </tr>
        </tbody>
      </UiTableFrame>

      <UiEmptyState v-if="filteredRecords.length === 0" title="没有匹配的工具记录" />
    </UiSettingsCard>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { buildConfigPayload, createConfigEditor } from "@/features/dynamic-tools/config";
import {
  dynamicToolsApi,
  type DynamicToolRecord,
  type DynamicToolsRebuildMode,
  type DynamicToolsState,
} from "@/api";
import { showMessage } from "@/utils";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { useDebounceFn } from "@/composables/useDebounceFn";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSettingsCard from "@/components/ui/UiSettingsCard.vue";
import UiSettingsForm from "@/components/ui/UiSettingsForm.vue";
import UiSettingsSwitchRow from "@/components/ui/UiSettingsSwitchRow.vue";
import UiTableFrame from "@/components/ui/UiTableFrame.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import UiToolbar from "@/components/ui/UiToolbar.vue";

const placeholderText = "{{VCPDynamicTools}}";

const SEARCH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 2500;
const MAX_POLL_COUNT = 120;

const state = shallowRef<DynamicToolsState | null>(null);
const editor = reactive(createConfigEditor());
const config = computed(() => editor.draft.config);
const aliasText = computed({
  get: () => editor.draft.aliasText,
  set: (value: string) => { editor.draft.aliasText = value; },
});
const categoryRulesText = computed({
  get: () => editor.draft.categoryRulesText,
  set: (value: string) => { editor.draft.categoryRulesText = value; },
});
const draftError = computed(() => {
  try { buildConfigPayload(editor.draft); return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
});
const selectedOriginKey = ref("");
const overrideArrayText = computed(() => editor.draft.descriptionArrayText);
function editOverride(originKey: string) {
  selectedOriginKey.value = originKey;
  document.getElementById("dynamic-tool-override-editor")?.scrollIntoView({ block: "center" });
}
const overrideOriginKeys = computed(() => [...new Set([
  ...records.value.map(record => record.originKey),
  ...Object.keys(config.value.manualOverrides.descriptionOverrides),
])]);
function overrideText(field: "brief" | "fullDescription" | "categories" | "keywords") {
  return computed({
    get: () => {
      const originKey = selectedOriginKey.value;
      if (field === "categories" || field === "keywords") {
        const raw = overrideArrayText.value[originKey]?.[field];
        if (raw !== undefined) return raw;
      }
      const value = config.value.manualOverrides.descriptionOverrides[originKey]?.[field];
      return Array.isArray(value) ? value.join(", ") : value || "";
    },
    set: (value: string) => {
      const originKey = selectedOriginKey.value.trim();
      if (!originKey) return;
      const overrides = config.value.manualOverrides.descriptionOverrides;
      const entry = { ...overrides[originKey] };
      if (field === "categories" || field === "keywords") {
        overrideArrayText.value[originKey] = { ...overrideArrayText.value[originKey], [field]: value };
        entry[field] = value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
      } else entry[field] = value;
      config.value.manualOverrides.descriptionOverrides = { ...overrides, [originKey]: entry };
    },
  });
}
const overrideBrief = overrideText("brief");
const overrideFullDescription = overrideText("fullDescription");
const overrideCategories = overrideText("categories");
const overrideKeywords = overrideText("keywords");
let stateRequestId = 0;
let configRevision = 0;
let disposed = false;
const filterText = ref("");
const debouncedFilterText = ref("");
const statusMessage = ref("");
const statusType = ref<"info" | "success" | "error">("info");
const statusBadgeVariant = computed(() => {
  if (statusType.value === "success") return "success";
  if (statusType.value === "error") return "danger";
  return "info";
});
const rebuildPollingTimer = ref<number | null>(null);

const applyDebouncedFilter = useDebounceFn(
  (value: unknown) => {
    debouncedFilterText.value = typeof value === "string" ? value : "";
  },
  { delay: SEARCH_DEBOUNCE_MS }
);

watch(filterText, (val) => {
  applyDebouncedFilter(val);
});

const records = computed(() => state.value?.records || []);
const availableCount = computed(() => records.value.filter((record) => record.available).length);
const excludedKeys = computed(() => new Set(config.value.manualOverrides.excludedOriginKeys));
const pinnedKeys = computed(() => new Set(config.value.manualOverrides.pinnedOriginKeys));
const isClassifying = computed(() => Boolean(state.value?.isClassifying));

const filteredRecords = computed(() => {
  const query = debouncedFilterText.value.toLowerCase();
  if (!query) return records.value;
  return records.value.filter((record) => {
    const haystack = [
      record.originKey,
      record.pluginName,
      record.displayName,
      record.brief,
      ...record.categories,
      ...record.keywords,
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
});

function applyState(nextState: DynamicToolsState, refreshConfig = true) {
  state.value = nextState;
  if (refreshConfig) editor.refresh(nextState.config);
}

async function loadState() {
  const requestId = ++stateRequestId;
  const revision = configRevision;
  try {
    const nextState = await dynamicToolsApi.getState({
      showLoader: false,
      loadingKey: "dynamic-tools.state.load",
    });
    if (disposed || requestId !== stateRequestId) return;
    applyState(nextState, revision === configRevision);
  } catch (error) {
    if (disposed || requestId !== stateRequestId) return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`加载动态工具清单失败：${errorMessage}`, "error");
  }
}

function stopRebuildPolling() {
  if (rebuildPollingTimer.value !== null) {
    window.clearTimeout(rebuildPollingTimer.value);
    rebuildPollingTimer.value = null;
  }
}

function startRebuildPolling() {
  stopRebuildPolling();
  let pollCount = 0;

  async function poll() {
    if (pollCount >= MAX_POLL_COUNT) {
      stopRebuildPolling();
      statusMessage.value = "重建超时，请手动刷新查看状态";
      statusType.value = "error";
      showMessage(statusMessage.value, "error");
      return;
    }

    pollCount++;
    const wasClassifying = isClassifying.value;
    await loadState();
    if (disposed) return;

    if (wasClassifying && !isClassifying.value) {
      stopRebuildPolling();
      statusMessage.value = "动态工具重建已完成";
      statusType.value = "success";
      showMessage(statusMessage.value, "success");
      return;
    }

    rebuildPollingTimer.value = window.setTimeout(poll, POLL_INTERVAL_MS);
  }

  rebuildPollingTimer.value = window.setTimeout(poll, POLL_INTERVAL_MS);
}

async function saveDynamicConfig() {
  if (!editor.initialized || editor.saving) return;
  configRevision++;
  const success = await editor.save(payload => dynamicToolsApi.saveConfig(
    payload, { loadingKey: "dynamic-tools.config.save", showLoader: false }
  ));
  configRevision++;
  statusMessage.value = success ? "已保存并热生效" : `保存失败：${editor.error}`;
  statusType.value = success ? "success" : "error";
  showMessage(statusMessage.value, statusType.value);
  if (success) void loadState();
}

async function rebuild(mode: DynamicToolsRebuildMode) {
  if (editor.saving || isClassifying.value) return;
  if (mode === "all") {
    const confirmed = await askConfirm({
      message:
        "全量重建将重新扫描所有插件并重新分类，可能需要较长时间。确定要继续吗？",
      confirmText: "全量重建",
      danger: true,
    });
    if (!confirmed) return;
  }

  try {
    const nextState = await dynamicToolsApi.rebuild(
      mode,
      {
        loadingKey: `dynamic-tools.rebuild.${mode}`,
      },
      { wait: false }
    );
    if (disposed) return;
    applyState(nextState, false);

    if (isClassifying.value) {
      statusMessage.value = "重建任务已开始，正在后台分类";
      statusType.value = "info";
      showMessage(statusMessage.value, "info");
      startRebuildPolling();
    } else {
      statusMessage.value = "重建任务已完成";
      statusType.value = "success";
      showMessage(statusMessage.value, "success");
      await loadState();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `重建失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  }
}

function isPinned(originKey: string): boolean {
  return pinnedKeys.value.has(originKey);
}

function isExcluded(originKey: string): boolean {
  return excludedKeys.value.has(originKey);
}

async function toggleOverride(record: DynamicToolRecord, field: "pinned" | "excluded") {
  if (editor.saving || !editor.initialized) return;
  if (editor.dirty) {
    showMessage("请先保存配置草稿，再固定或排除工具", "info");
    return;
  }
  const enabled = field === "pinned" ? !isPinned(record.originKey) : !isExcluded(record.originKey);
  configRevision++;
  const success = await editor.save(() => dynamicToolsApi.updateOverride(
    { originKey: record.originKey, [field]: enabled },
    { loadingKey: `dynamic-tools.override.${field}`, showLoader: false }
  ));
  configRevision++;
  statusMessage.value = success ? "已保存并热生效" : `操作失败：${editor.error}`;
  statusType.value = success ? "success" : "error";
  showMessage(statusMessage.value, statusType.value);
  if (success) void loadState();
}

async function copyPlaceholder() {
  try {
    await navigator.clipboard.writeText(placeholderText);
    showMessage("占位符已复制", "success");
  } catch {
    showMessage(placeholderText, "info");
  }
}

onMounted(() => {
  void loadState();
});

onBeforeUnmount(() => {
  disposed = true;
  stateRequestId++;
  stopRebuildPolling();
});
</script>

<style scoped>
.dynamic-tools-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.dynamic-tools-header {
  min-height: 36px;
}

.dynamic-tools-header h2 {
  margin: 0;
  line-height: 1.25;
}

.dynamic-tools-header .description {
  margin-top: var(--space-1);
}

.dynamic-settings-surface {
  --dynamic-tools-surface-border: color-mix(in srgb, var(--border-color) 88%, transparent);
  --dynamic-tools-card-surface: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
}

.dynamic-settings-surface,
:deep(.ui-card.dynamic-settings-surface) {
  border-color: var(--dynamic-tools-surface-border);
  background: var(--dynamic-tools-card-surface);
}

.dynamic-settings-surface :deep(.ui-card__header),
:deep(.ui-card.dynamic-settings-surface.ui-card--divided .ui-card__header) {
  border-bottom-color: var(--dynamic-tools-surface-border);
}

.dynamic-settings-surface :deep(.ui-input),
.dynamic-settings-surface :deep(.ui-textarea) {
  border-color: var(--dynamic-tools-surface-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 42%, transparent);
}

.dynamic-settings-surface :deep(.ui-table-frame) {
  border-color: var(--dynamic-tools-surface-border);
  background: transparent;
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.summary-item {
  border-color: color-mix(in srgb, var(--border-color) 86%, transparent);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
}

.summary-label {
  display: block;
  margin-bottom: var(--space-1);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.summary-item strong {
  font-size: 1.45rem;
  line-height: 1.1;
}

.summary-item small {
  display: block;
  margin-top: var(--space-1);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.config-editors {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}

.panel-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  gap: var(--space-3);
}

.muted {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.alias-field {
  margin-top: 0;
}

.warning-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warning-color);
  border-radius: var(--radius-md);
  color: var(--warning-color);
  background: color-mix(in srgb, var(--warning-color) 14%, transparent);
}

.records-table-frame :deep(.ui-table-frame__table) {
  min-width: 980px;
}

.records-table-frame :deep(tbody tr) {
  transition: background-color var(--transition-fast);
}

.records-table-frame :deep(tbody tr:hover) {
  background: color-mix(in srgb, var(--primary-text) 2.5%, transparent);
}

.records-search {
  width: min(280px, 100%);
}

.records-table-frame :deep(td small) {
  display: block;
  margin-top: var(--space-1);
  color: var(--secondary-text);
}

.brief-cell {
  max-width: 360px;
  color: var(--secondary-text);
}

.tag-list,
.status-stack,
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.row-actions {
  gap: var(--space-2);
}

@media (prefers-reduced-motion: reduce) {
  .records-table-frame :deep(tbody tr) {
    transition: none;
  }
}

@media (max-width: 960px) {
  .summary-grid,
  .panel-grid {
    grid-template-columns: 1fr;
  }

  .dynamic-tools-header {
    align-items: stretch;
  }

  .dynamic-tools-header :deep(.ui-toolbar__actions),
  .records-card :deep(.ui-card__action),
  .records-search {
    width: 100%;
  }
}
</style>
