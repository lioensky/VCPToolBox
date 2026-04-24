<template>
  <section class="config-section active-section dynamic-tools-page">
    <div class="dynamic-tools-header">
      <div>
        <h2>动态工具清单</h2>
        <p class="description">管理 {{ placeholderText }} 的注入配置、分类状态和工具暴露规则。</p>
      </div>
      <div class="header-actions">
        <button type="button" class="btn-secondary btn-sm btn-sm-touch" @click="loadState">
          <span class="material-symbols-outlined">refresh</span>
          刷新
        </button>
        <button type="button" class="btn-primary btn-sm btn-sm-touch" @click="copyPlaceholder">
          <span class="material-symbols-outlined">content_copy</span>
          复制占位符
        </button>
      </div>
    </div>

    <div class="summary-grid">
      <div class="summary-item">
        <span class="summary-label">可用工具</span>
        <strong>{{ availableCount }}</strong>
      </div>
      <div class="summary-item">
        <span class="summary-label">总记录</span>
        <strong>{{ records.length }}</strong>
      </div>
      <div class="summary-item">
        <span class="summary-label">分类队列</span>
        <strong>{{ state?.queueSize ?? 0 }}</strong>
        <small v-if="isClassifying">后台分类中</small>
      </div>
      <div class="summary-item">
        <span class="summary-label">快照</span>
        <strong>{{ state?.snapshotId ?? '-' }}</strong>
      </div>
    </div>

    <div v-if="state?.lastError" class="warning-box">
      <span class="material-symbols-outlined">warning</span>
      <span>{{ state.lastError }}</span>
    </div>

    <div class="panel-grid">
      <form class="card config-card" @submit.prevent="saveDynamicConfig">
        <div class="card-header">
          <h3>注入配置</h3>
          <button type="submit" class="btn-success btn-sm btn-sm-touch">
            <span class="material-symbols-outlined">save</span>
            保存
          </button>
        </div>

        <div class="switch-row">
          <span>启用动态工具清单</span>
          <label class="switch">
            <input type="checkbox" v-model="config.enabled">
            <span class="slider"></span>
          </label>
        </div>

        <div class="form-grid">
          <label class="field">
            <span>轻量清单数量</span>
            <input type="number" min="1" max="500" v-model.number="config.maxBriefListItems">
          </label>
          <label class="field">
            <span>语义命中展开数</span>
            <input type="number" min="0" max="50" v-model.number="config.maxExpandedPlugins">
          </label>
          <label class="field">
            <span>点名分类展开数</span>
            <input type="number" min="1" max="100" v-model.number="config.maxForcedCategoryPlugins">
          </label>
          <label class="field">
            <span>最大注入字符数</span>
            <input type="number" min="1000" max="120000" step="1000" v-model.number="config.maxInjectionChars">
          </label>
          <label class="field">
            <span>分类去抖 ms</span>
            <input type="number" min="0" max="60000" step="100" v-model.number="config.classificationDebounceMs">
          </label>
          <label class="field">
            <span>分类超时 ms</span>
            <input type="number" min="100" max="120000" step="1000" v-model.number="config.classifierTimeoutMs">
          </label>
        </div>

        <div class="switch-row">
          <span>启用 RAG embedding 降级分类</span>
          <label class="switch">
            <input type="checkbox" v-model="config.useRagEmbeddings">
            <span class="slider"></span>
          </label>
        </div>
      </form>

      <form class="card config-card" @submit.prevent="saveDynamicConfig">
        <div class="card-header">
          <h3>小模型分类</h3>
          <button type="button" class="btn-secondary btn-sm btn-sm-touch" @click="openPluginConfig">
            <span class="material-symbols-outlined">extension</span>
            私有配置
          </button>
        </div>

        <div class="switch-row">
          <span>启用小模型增量分类</span>
          <label class="switch">
            <input type="checkbox" v-model="config.smallModel.enabled">
            <span class="slider"></span>
          </label>
        </div>

        <div class="switch-row">
          <span>复用主 API_URL / API_Key</span>
          <label class="switch">
            <input type="checkbox" v-model="config.smallModel.useMainConfig">
            <span class="slider"></span>
          </label>
        </div>

        <label class="field">
          <span>分类模型名</span>
          <input type="text" v-model.trim="config.smallModel.model" placeholder="例如：gpt-4o-mini">
        </label>

        <label class="field">
          <span>独立 OpenAI 兼容端点</span>
          <input
            type="text"
            v-model.trim="config.smallModel.endpoint"
            :disabled="config.smallModel.useMainConfig"
            placeholder="https://example.com 或完整 /v1/chat/completions"
          >
        </label>

        <p class="field-hint">
          复用主配置时只填模型名；独立端点的 API Key 在插件中心 DynamicToolBridge 私有配置里填写。
        </p>
      </form>
    </div>

    <div class="card operations-card">
      <div class="card-header">
        <h3>分类维护</h3>
        <div class="header-actions">
          <button type="button" class="btn-secondary btn-sm btn-sm-touch" :disabled="isClassifying" @click="rebuild('catalog')">
            <span class="material-symbols-outlined">inventory</span>
            重建清单
          </button>
          <button type="button" class="btn-secondary btn-sm btn-sm-touch" :disabled="isClassifying" @click="rebuild('classification')">
            <span class="material-symbols-outlined">category</span>
            重建分类
          </button>
          <button type="button" class="btn-primary btn-sm btn-sm-touch" :disabled="isClassifying" @click="rebuild('all')">
            <span class="material-symbols-outlined">sync</span>
            全量重建
          </button>
        </div>
      </div>

      <label class="field alias-field">
        <span>分类别名</span>
        <textarea
          v-model="aliasText"
          rows="4"
          placeholder="每行一个别名，例如：&#10;搜索=search&#10;代码=file_code"
        ></textarea>
      </label>
    </div>

    <div class="card records-card">
      <div class="card-header records-header">
        <h3>工具状态</h3>
        <input
          v-model.trim="filterText"
          type="search"
          class="records-filter"
          placeholder="搜索插件、分类、关键词"
        >
      </div>

      <div class="records-table-wrap">
        <table class="records-table">
          <thead>
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
                <span class="badge">{{ record.originKind === 'distributed' ? record.originId : 'local' }}</span>
              </td>
              <td>
                <div class="status-stack">
                  <span :class="['status-pill', record.available ? 'status-pill--ok' : 'status-pill--muted']">
                    {{ record.available ? 'available' : 'hidden' }}
                  </span>
                  <span v-if="!record.online" class="status-pill status-pill--warning">offline</span>
                  <span v-if="isExcluded(record.originKey)" class="status-pill status-pill--danger">excluded</span>
                  <span v-if="isPinned(record.originKey)" class="status-pill status-pill--info">pinned</span>
                </div>
              </td>
              <td>
                <div class="tag-list">
                  <span v-for="category in record.categories" :key="`${record.originKey}-${category}`" class="tag">{{ category }}</span>
                  <span v-if="record.categories.length === 0" class="muted">未分类</span>
                </div>
              </td>
              <td class="brief-cell">{{ record.brief || '-' }}</td>
              <td>
                <div class="row-actions">
                  <button type="button" class="btn-secondary btn-sm" @click="togglePinned(record)">
                    {{ isPinned(record.originKey) ? '取消固定' : '固定' }}
                  </button>
                  <button type="button" class="btn-secondary btn-sm" @click="toggleExcluded(record)">
                    {{ isExcluded(record.originKey) ? '恢复' : '排除' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="filteredRecords.length === 0" class="empty-state">
        <span class="material-symbols-outlined">search_off</span>
        <p>没有匹配的工具记录</p>
      </div>
    </div>

    <span v-if="statusMessage" :class="['status-message', 'floating-status', statusType]">{{ statusMessage }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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

const placeholderText = "{{VCPDynamicTools}}";

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
    },
    smallModel: {
      ...defaults.smallModel,
      ...(config?.smallModel || {}),
      useMainConfig: config?.smallModel?.useMainConfig !== false,
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

const router = useRouter();
const state = ref<DynamicToolsState | null>(null);
const config = ref<DynamicToolsConfig>(createDefaultConfig());
const aliasText = ref("");
const filterText = ref("");
const statusMessage = ref("");
const statusType = ref<"info" | "success" | "error">("info");
const rebuildPollingTimer = ref<number | null>(null);

const records = computed(() => state.value?.records || []);
const availableCount = computed(() => records.value.filter((record) => record.available).length);
const excludedKeys = computed(() => new Set(config.value.manualOverrides.excludedOriginKeys));
const pinnedKeys = computed(() => new Set(config.value.manualOverrides.pinnedOriginKeys));
const isClassifying = computed(() => Boolean(state.value?.isClassifying));

const filteredRecords = computed(() => {
  const query = filterText.value.toLowerCase();
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
    window.clearInterval(rebuildPollingTimer.value);
    rebuildPollingTimer.value = null;
  }
}

function startRebuildPolling() {
  stopRebuildPolling();
  rebuildPollingTimer.value = window.setInterval(() => {
    void (async () => {
      const wasClassifying = isClassifying.value;
      await loadState();
      if (wasClassifying && !isClassifying.value) {
        stopRebuildPolling();
        statusMessage.value = "动态工具重建已完成";
        statusType.value = "success";
        showMessage(statusMessage.value, "success");
      }
    })();
  }, 2500);
}

async function saveDynamicConfig() {
  try {
    const manualOverrides: DynamicToolsManualOverrides = {
      ...config.value.manualOverrides,
      categoryAliases: parseAliases(aliasText.value),
    };
    const saved = await dynamicToolsApi.saveConfig(
      {
        enabled: config.value.enabled,
        maxBriefListItems: config.value.maxBriefListItems,
        maxExpandedPlugins: config.value.maxExpandedPlugins,
        maxForcedCategoryPlugins: config.value.maxForcedCategoryPlugins,
        maxInjectionChars: config.value.maxInjectionChars,
        classificationDebounceMs: config.value.classificationDebounceMs,
        classifierTimeoutMs: config.value.classifierTimeoutMs,
        useRagEmbeddings: config.value.useRagEmbeddings,
        smallModel: {
          enabled: config.value.smallModel.enabled,
          useMainConfig: config.value.smallModel.useMainConfig,
          endpoint: config.value.smallModel.endpoint,
          model: config.value.smallModel.model,
        },
        manualOverrides,
      },
      {
        loadingKey: "dynamic-tools.config.save",
      }
    );
    config.value = normalizeConfig(saved);
    aliasText.value = aliasesToText(config.value.manualOverrides.categoryAliases);
    statusMessage.value = "动态工具配置已保存";
    statusType.value = "success";
    showMessage(statusMessage.value, "success");
    await loadState();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `保存失败：${errorMessage}`;
    statusType.value = "error";
    showMessage(statusMessage.value, "error");
  }
}

async function rebuild(mode: DynamicToolsRebuildMode) {
  try {
    const nextState = await dynamicToolsApi.rebuild(mode, {
      loadingKey: `dynamic-tools.rebuild.${mode}`,
    }, { wait: false });
    applyState(nextState);
    statusMessage.value = isClassifying.value ? "重建任务已开始，正在后台分类" : "重建任务已完成";
    statusType.value = isClassifying.value ? "info" : "success";
    showMessage(statusMessage.value, "success");
    if (isClassifying.value) startRebuildPolling();
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

async function togglePinned(record: DynamicToolRecord) {
  const pinned = !isPinned(record.originKey);
  const saved = await dynamicToolsApi.updateOverride(
    {
      originKey: record.originKey,
      pinned,
    },
    { loadingKey: "dynamic-tools.override.pin" }
  );
  config.value = normalizeConfig(saved);
  aliasText.value = aliasesToText(config.value.manualOverrides.categoryAliases);
  await loadState();
}

async function toggleExcluded(record: DynamicToolRecord) {
  const excluded = !isExcluded(record.originKey);
  const saved = await dynamicToolsApi.updateOverride(
    {
      originKey: record.originKey,
      excluded,
    },
    { loadingKey: "dynamic-tools.override.exclude" }
  );
  config.value = normalizeConfig(saved);
  aliasText.value = aliasesToText(config.value.manualOverrides.categoryAliases);
  await loadState();
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
  gap: var(--space-4);
}

.dynamic-tools-header,
.card-header,
.records-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.dynamic-tools-header h2,
.card-header h3 {
  margin: 0;
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
  gap: var(--space-3);
}

.summary-item,
.card {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--card-bg);
}

.summary-item {
  padding: var(--space-4);
}

.summary-label {
  display: block;
  margin-bottom: var(--space-2);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.summary-item strong {
  font-size: 1.6rem;
}

.panel-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  gap: var(--space-4);
}

.config-card,
.operations-card,
.records-card {
  padding: var(--space-5);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.field span,
.switch-row > span {
  color: var(--primary-text);
  font-weight: 600;
}

.field input,
.field textarea,
.records-filter {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--primary-text);
}

.field input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.field textarea {
  resize: vertical;
  font-family: "Consolas", "Monaco", monospace;
}

.field-hint,
.muted {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.alias-field {
  margin-top: var(--space-4);
}

.warning-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--warning-color);
  border-radius: var(--radius-md);
  color: var(--warning-color);
  background: color-mix(in srgb, var(--warning-color) 14%, transparent);
}

.records-table-wrap {
  overflow-x: auto;
  margin-top: var(--space-4);
}

.records-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 980px;
}

.records-table th,
.records-table td {
  padding: var(--space-3);
  border-bottom: 1px solid var(--border-color);
  text-align: left;
  vertical-align: top;
}

.records-table th {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.records-table td small {
  display: block;
  margin-top: var(--space-1);
  color: var(--secondary-text);
}

.brief-cell {
  max-width: 360px;
  color: var(--secondary-text);
}

.badge,
.tag,
.status-pill {
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--font-size-helper);
  line-height: 1.6;
}

.badge {
  color: var(--secondary-text);
  background: var(--input-bg);
}

.tag {
  color: var(--primary-text);
  background: var(--hover-bg);
}

.tag-list,
.status-stack,
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.status-pill--ok {
  color: var(--success-color);
  background: color-mix(in srgb, var(--success-color) 12%, transparent);
}

.status-pill--muted {
  color: var(--secondary-text);
  background: var(--input-bg);
}

.status-pill--warning {
  color: var(--warning-color);
  background: color-mix(in srgb, var(--warning-color) 12%, transparent);
}

.status-pill--danger {
  color: var(--danger-color);
  background: color-mix(in srgb, var(--danger-color) 12%, transparent);
}

.status-pill--info {
  color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-text) 12%, transparent);
}

.floating-status {
  position: fixed;
  right: var(--space-5);
  bottom: var(--space-5);
  z-index: 1000;
}

@media (max-width: 960px) {
  .summary-grid,
  .panel-grid,
  .form-grid {
    grid-template-columns: 1fr;
  }

  .dynamic-tools-header,
  .card-header,
  .records-header {
    flex-direction: column;
  }
}
</style>
