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
        <UiButton type="button" size="lg" variant="primary" @click="saveDynamicConfig">
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

      <UiSettingsCard class="config-card dynamic-settings-surface" title="小模型分类" variant="subtle">
        <template #action>
          <UiButton type="button" variant="outline" size="sm" @click="openPluginConfig">
            <template #leading><span class="material-symbols-outlined">extension</span></template>
            私有配置
          </UiButton>
        </template>

        <UiSettingsForm as="div" :columns="1" gap="sm">
          <UiSettingsSwitchRow v-model="config.smallModel.enabled" label="启用小模型增量分类" />
          <UiSettingsSwitchRow v-model="config.smallModel.useMainConfig" label="复用主 API_URL / API_Key" />

          <UiField label="分类模型名">
            <UiInput v-model.trim="config.smallModel.model" type="text" placeholder="例如：gpt-4o-mini" />
          </UiField>

          <UiField
            label="独立 OpenAI 兼容端点"
            description="复用主配置时只填模型名；独立端点的 API Key 在插件中心 DynamicToolBridge 私有配置里填写。"
          >
            <UiInput
              v-model.trim="config.smallModel.endpoint"
              type="text"
              :disabled="config.smallModel.useMainConfig"
              placeholder="https://example.com 或完整 /v1/chat/completions"
            />
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

      <UiField label="分类别名" class="alias-field">
        <UiTextarea
          v-model="aliasText"
          rows="4"
          placeholder="每行一个别名，例如：&#10;搜索=search&#10;代码=file_code"
        />
      </UiField>
    </UiSettingsCard>

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
                <UiButton type="button" variant="outline" size="xs" @click="toggleOverride(record, 'pinned')">
                  {{ isPinned(record.originKey) ? '取消固定' : '固定' }}
                </UiButton>
                <UiButton type="button" variant="outline" size="xs" @click="toggleOverride(record, 'excluded')">
                  {{ isExcluded(record.originKey) ? '恢复' : '排除' }}
                </UiButton>
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
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";
import {
  dynamicToolsApi,
  type DynamicToolRecord,
  type DynamicToolsConfig,
  type DynamicToolsManualOverrides,
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

function createDefaultConfig(): DynamicToolsConfig {
  return {
    enabled: true,
    placeholder: placeholderText,
    maxBriefListItems: 120,
    maxExpandedPlugins: 4,
    maxForcedCategoryPlugins: 12,
    maxInjectionChars: 16000,
    classificationDebounceMs: 1000,
    classifierTimeoutMs: 30000,
    useRagEmbeddings: true,
    manualOverrides: {
      excludedOriginKeys: [],
      pinnedOriginKeys: [],
      categoryAliases: {},
      descriptionOverrides: {},
    },
    smallModel: {
      enabled: false,
      useMainConfig: true,
      endpoint: "",
      model: "",
    },
  };
}

function normalizeConfig(config: DynamicToolsConfig | null | undefined): DynamicToolsConfig {
  const defaults = createDefaultConfig();
  return {
    ...defaults,
    ...(config || {}),
    manualOverrides: {
      ...defaults.manualOverrides,
      ...(config?.manualOverrides || {}),
      excludedOriginKeys: Array.isArray(config?.manualOverrides?.excludedOriginKeys)
        ? config.manualOverrides.excludedOriginKeys
        : [],
      pinnedOriginKeys: Array.isArray(config?.manualOverrides?.pinnedOriginKeys)
        ? config.manualOverrides.pinnedOriginKeys
        : [],
      categoryAliases: config?.manualOverrides?.categoryAliases || {},
      descriptionOverrides: config?.manualOverrides?.descriptionOverrides || {},
    },
    smallModel: {
      ...defaults.smallModel,
      ...(config?.smallModel || {}),
      useMainConfig: config?.smallModel?.useMainConfig ?? true,
    },
  };
}

function aliasesToText(aliases: Record<string, string>): string {
  return Object.entries(aliases)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseAliases(text: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && value) aliases[key] = value;
  }
  return aliases;
}

function validateConfig(c: DynamicToolsConfig): string | null {
  if (c.maxBriefListItems < 1 || c.maxBriefListItems > 500) return "轻量清单数量需在 1-500 之间";
  if (c.maxExpandedPlugins < 0 || c.maxExpandedPlugins > 50) return "语义命中展开数需在 0-50 之间";
  if (c.maxForcedCategoryPlugins < 1 || c.maxForcedCategoryPlugins > 100) return "点名分类展开数需在 1-100 之间";
  if (c.maxInjectionChars < 1000 || c.maxInjectionChars > 120000) return "最大注入字符数需在 1000-120000 之间";
  if (c.classificationDebounceMs < 0 || c.classificationDebounceMs > 60000) return "分类去抖需在 0-60000 ms 之间";
  if (c.classifierTimeoutMs < 100 || c.classifierTimeoutMs > 120000) return "分类超时需在 100-120000 ms 之间";
  if (c.smallModel.enabled) {
    if (!c.smallModel.model.trim()) return "启用小模型分类时需填写分类模型名";
    if (!c.smallModel.useMainConfig && !c.smallModel.endpoint.trim()) return "使用独立端点时需填写 OpenAI 兼容端点";
  }
  if (!c.smallModel.useMainConfig && c.smallModel.endpoint.trim()) {
    const endpoint = c.smallModel.endpoint.trim();
    const isHttpUrl = endpoint.startsWith("http://") || endpoint.startsWith("https://");
    if (!isHttpUrl) return "独立端点需以 http:// 或 https:// 开头";
  }
  return null;
}

const router = useRouter();
const state = shallowRef<DynamicToolsState | null>(null);
const config = ref<DynamicToolsConfig>(createDefaultConfig());
const aliasText = ref("");
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

function applyState(nextState: DynamicToolsState) {
  state.value = nextState;
  config.value = normalizeConfig(nextState.config);
  aliasText.value = aliasesToText(config.value.manualOverrides.categoryAliases);
}

async function loadState() {
  try {
    const nextState = await dynamicToolsApi.getState({
      showLoader: false,
      loadingKey: "dynamic-tools.state.load",
    });
    applyState(nextState);
  } catch (error) {
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
  const error = validateConfig(config.value);
  if (error) {
    showMessage(error, "error");
    return;
  }

  try {
    const manualOverrides: DynamicToolsManualOverrides = {
      ...config.value.manualOverrides,
      categoryAliases: parseAliases(aliasText.value),
    };
    const saved = await dynamicToolsApi.saveConfig(
      { ...config.value, manualOverrides },
      { loadingKey: "dynamic-tools.config.save" }
    );
    config.value = normalizeConfig(saved);
    aliasText.value = aliasesToText(config.value.manualOverrides.categoryAliases);
    statusMessage.value = "动态工具配置已保存";
    statusType.value = "success";
    showMessage(statusMessage.value, "success");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `保存失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
    return;
  }

  try {
    await loadState();
  } catch {
    // config saved successfully, state reload is non-critical
  }
}

async function rebuild(mode: DynamicToolsRebuildMode) {
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
    applyState(nextState);

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
  const arrayKey = field === "pinned" ? "pinnedOriginKeys" : "excludedOriginKeys";
  const arr = config.value.manualOverrides[arrayKey];
  const originKey = record.originKey;
  const had = arr.includes(originKey);
  const previous = [...arr];

  config.value.manualOverrides[arrayKey] = had
    ? arr.filter((k) => k !== originKey)
    : [...arr, originKey];

  try {
    const saved = await dynamicToolsApi.updateOverride(
      { originKey, [field]: !had },
      { loadingKey: `dynamic-tools.override.${field}` }
    );
    config.value = normalizeConfig(saved);
    aliasText.value = aliasesToText(config.value.manualOverrides.categoryAliases);
    await loadState();
  } catch (error) {
    config.value.manualOverrides[arrayKey] = previous;
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`操作失败：${errorMessage}`, "error");
  }
}

async function copyPlaceholder() {
  try {
    await navigator.clipboard.writeText(placeholderText);
    showMessage("占位符已复制", "success");
  } catch {
    showMessage(placeholderText, "info");
  }
}

function openPluginConfig() {
  router.push({
    name: "PluginConfig",
    params: { pluginName: "DynamicToolBridge" },
  });
}

onMounted(() => {
  void loadState();
});

onBeforeUnmount(() => {
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
