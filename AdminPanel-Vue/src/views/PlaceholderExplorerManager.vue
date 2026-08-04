<template>
  <section class="config-section active-section explorer-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton variant="outline" :disabled="loading || scanning" @click="loadIndex(true)">
          <template #leading>
            <span class="material-symbols-outlined" :class="{ spinning: loading }">refresh</span>
          </template>
          刷新索引
        </UiButton>
        <UiButton variant="primary" :loading="scanning" :disabled="loading || scanning" @click="runScan">
          <template #leading><span class="material-symbols-outlined">manage_search</span></template>
          全量扫描
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="page-card hero-card">
      <span class="material-symbols-outlined hero-icon">account_tree</span>
      <div class="hero-copy">
        <h2>占位符索引管理</h2>
        <p>统一管理 PlaceholderExplorer 的索引与 PlaceholderExplorerCommand 的定位、预览、健康检查和安全编辑能力。</p>
      </div>
      <div class="plugin-statuses">
        <div v-for="plugin in snapshot?.plugins || []" :key="plugin.name" class="plugin-status">
          <span class="status-dot" :class="{ enabled: plugin.enabled }" />
          <span>
            <strong>{{ plugin.displayName }}</strong>
            <small>{{ plugin.pluginType }} · v{{ plugin.version || "?" }}</small>
          </span>
          <UiBadge :variant="plugin.enabled ? 'success' : 'warning'">
            {{ plugin.enabled ? "已启用" : "未启用" }}
          </UiBadge>
        </div>
      </div>
    </header>

    <UiEmptyState v-if="loading && !snapshot" title="正在读取占位符索引..." role="status">
      <template #icon><span class="material-symbols-outlined">hourglass_top</span></template>
    </UiEmptyState>

    <template v-else-if="snapshot">
      <div class="stats-grid">
        <article v-for="card in statCards" :key="card.key" class="stat-card" :class="`tone-${card.tone}`">
          <span class="material-symbols-outlined">{{ card.icon }}</span>
          <div><strong>{{ card.value }}</strong><small>{{ card.label }}</small></div>
        </article>
      </div>

      <section class="page-card filter-card">
        <UiField label="搜索占位符、类型或文件">
          <UiInput v-model="keyword" placeholder="例如 VarToolList、config.env、plugin_tool" />
        </UiField>
        <UiField label="类型">
          <UiSelect v-model="selectedType">
            <option value="">全部类型</option>
            <option v-for="type in typeOptions" :key="type" :value="type">{{ type }}</option>
          </UiSelect>
        </UiField>
        <UiField label="健康状态">
          <UiSelect v-model="healthFilter">
            <option value="all">全部</option>
            <option value="editable">可编辑</option>
            <option value="dead">死链</option>
            <option value="orphan">孤儿定义</option>
            <option value="healthy">正常</option>
          </UiSelect>
        </UiField>
        <div class="filter-summary">显示 {{ filteredEntries.length }} / {{ entries.length }} 项</div>
      </section>

      <div class="explorer-grid">
        <section class="page-card entry-list-card">
          <header class="section-header">
            <div>
              <h3>索引条目</h3>
              <p>扫描于 {{ formatTime(snapshot.index.generatedAt) }}</p>
            </div>
          </header>
          <div class="entry-list" role="listbox" aria-label="占位符索引条目">
            <button
              v-for="entry in filteredEntries"
              :key="entry.placeholder"
              type="button"
              class="entry-row"
              :class="{ selected: entry.placeholder === selectedPlaceholder }"
              :aria-selected="entry.placeholder === selectedPlaceholder"
              @click="selectEntry(entry)"
            >
              <span class="entry-main">
                <code>{{ entry.placeholder }}</code>
                <small>{{ entry.type }} · 定义 {{ entry.definitions.length }} · 引用 {{ entry.references.length }}</small>
              </span>
              <span class="entry-flags">
                <UiBadge v-if="entry.editable" variant="info">可编辑</UiBadge>
                <UiBadge v-if="deadLinkSet.has(entry.placeholder)" variant="danger">死链</UiBadge>
                <UiBadge v-else-if="orphanSet.has(entry.placeholder)" variant="warning">孤儿</UiBadge>
              </span>
            </button>
            <UiEmptyState v-if="filteredEntries.length === 0" title="没有匹配当前筛选条件的条目" />
          </div>
        </section>

        <section class="page-card detail-card">
          <UiEmptyState v-if="!selectedEntry" title="从左侧选择一个占位符查看详情" />
          <template v-else>
            <header class="detail-header">
              <div>
                <div class="detail-title-row">
                  <h3><code>{{ selectedEntry.placeholder }}</code></h3>
                  <UiBadge variant="outline">{{ selectedEntry.type }}</UiBadge>
                </div>
                <p>最后扫描：{{ formatTime(selectedEntry.lastScan) }}</p>
              </div>
              <div class="detail-tabs" role="tablist">
                <UiButton size="sm" :variant="activeTab === 'detail' ? 'secondary' : 'ghost'" @click="activateTab('detail')">定位</UiButton>
                <UiButton size="sm" :variant="activeTab === 'preview' ? 'secondary' : 'ghost'" @click="activateTab('preview')">预览</UiButton>
                <UiButton
                  size="sm"
                  :variant="activeTab === 'edit' ? 'secondary' : 'ghost'"
                  :disabled="!selectedEntry.editable"
                  @click="activateTab('edit')"
                >编辑</UiButton>
              </div>
            </header>

            <div v-if="activeTab === 'detail'" class="detail-content">
              <section class="detail-section">
                <h4>定义位置 <UiBadge variant="outline">{{ selectedEntry.definitions.length }}</UiBadge></h4>
                <div v-if="selectedEntry.definitions.length" class="location-list">
                  <article v-for="(definition, index) in selectedEntry.definitions" :key="`definition-${index}`" class="location-card">
                    <div class="location-heading">
                      <code>{{ locationLabel(definition) }}</code>
                      <UiBadge :variant="definition.editable ? 'info' : 'outline'">{{ definition.source || definition.type || "定义" }}</UiBadge>
                    </div>
                    <p v-if="definition.resolvesTo">指向 <code>{{ definition.resolvesTo }}</code></p>
                    <pre v-if="definition.value">{{ truncateValue(definition.value) }}</pre>
                  </article>
                </div>
                <p v-else class="muted warning-text">无定义位置，这是一个待修复的死链。</p>
              </section>

              <section class="detail-section">
                <h4>引用位置 <UiBadge variant="outline">{{ selectedEntry.references.length }}</UiBadge></h4>
                <div v-if="selectedEntry.references.length" class="reference-grid">
                  <div v-for="(reference, index) in selectedEntry.references" :key="`reference-${index}`" class="reference-item">
                    <code>{{ locationLabel(reference) }}</code><small>{{ reference.source || "引用" }}</small>
                  </div>
                </div>
                <p v-else class="muted">没有其他引用位置。</p>
              </section>

              <section v-if="selectedEntry.referenceChains.length" class="detail-section">
                <h4>嵌套展开链 <UiBadge variant="outline">{{ selectedEntry.referenceChains.length }}</UiBadge></h4>
                <div class="chain-list">
                  <div v-for="(chain, index) in selectedEntry.referenceChains" :key="`chain-${index}`" class="chain-row">
                    <template v-for="(part, partIndex) in chain.path" :key="`${part}-${partIndex}`">
                      <span v-if="partIndex" class="material-symbols-outlined">arrow_forward</span>
                      <code>{{ part }}</code>
                    </template>
                    <UiBadge v-if="chain.cycle" variant="danger">循环</UiBadge>
                  </div>
                </div>
              </section>
            </div>

            <div v-else-if="activeTab === 'preview'" class="detail-content">
              <div class="form-grid">
                <UiField label="角色">
                  <UiSelect v-model="previewRole">
                    <option value="system">system（特权展开）</option>
                    <option value="user">user</option>
                    <option value="assistant">assistant</option>
                  </UiSelect>
                </UiField>
                <UiField label="模型（可选）"><UiInput v-model="previewModel" placeholder="placeholder-explorer-preview" /></UiField>
                <UiField class="wide" label="待展开文本">
                  <UiTextarea v-model="previewText" rows="5" placeholder="默认使用当前占位符，也可输入包含多个占位符的文本。" />
                </UiField>
              </div>
              <div class="actions end">
                <UiButton variant="primary" :loading="previewing" @click="runPreview">执行干跑预览</UiButton>
              </div>
              <article v-if="previewResult" class="preview-result">
                <header>
                  <UiBadge :variant="previewResult.expanded ? 'success' : 'warning'">
                    {{ previewResult.expanded ? "已展开" : "未展开" }}
                  </UiBadge>
                  <span>{{ previewResult.securityNote }}</span>
                </header>
                <pre>{{ previewResult.output }}</pre>
                <p>{{ previewResult.limitation }}</p>
              </article>
            </div>

            <div v-else class="detail-content">
              <div class="edit-warning">
                <span class="material-symbols-outlined">security</span>
                <span>保存会按插件原流程执行临时文件校验、原文件备份和原子替换；config.env 修改后必须重启 VCP。</span>
              </div>
              <div class="form-grid">
                <UiField label="编辑范围">
                  <UiSelect v-model="editScope" @change="loadEditDraft">
                    <option value="definition">定义值（config.env / sarprompt.json）</option>
                    <option v-if="canEditResolvedFile" value="file">指向的 TVStxt 文件正文</option>
                  </UiSelect>
                </UiField>
                <UiField label="来源"><UiInput :model-value="editSourceLabel" disabled /></UiField>
                <UiField class="wide" label="新内容">
                  <UiTextarea v-model="editDraft" rows="14" :disabled="loadingEditDraft || savingEdit" />
                </UiField>
              </div>
              <div class="actions end">
                <UiButton variant="outline" :loading="loadingEditDraft" @click="loadEditDraft">重新读取</UiButton>
                <UiButton variant="primary" :loading="savingEdit" :disabled="loadingEditDraft" @click="saveEdit">安全保存</UiButton>
              </div>
            </div>
          </template>
        </section>
      </div>

      <section class="page-card health-card">
        <header class="section-header">
          <div><h3>健康检查</h3><p>死链、孤儿定义与扫描源错误来自同一次索引快照。</p></div>
        </header>
        <div class="health-columns">
          <div>
            <h4>死链（{{ snapshot.index.checks.deadLinks.length }}）</h4>
            <button
              v-for="item in snapshot.index.checks.deadLinks.slice(0, 20)"
              :key="item.placeholder"
              class="issue-row"
              type="button"
              @click="focusPlaceholder(item.placeholder)"
            ><code>{{ item.placeholder }}</code><span>{{ item.references.length }} 个引用</span></button>
            <p v-if="!snapshot.index.checks.deadLinks.length" class="muted">未发现死链。</p>
          </div>
          <div>
            <h4>扫描错误（{{ snapshot.index.errors.length }}）</h4>
            <div v-for="(error, index) in snapshot.index.errors.slice(0, 20)" :key="`error-${index}`" class="issue-row static">
              <code>{{ error.file }}{{ error.line ? `:${error.line}` : "" }}</code><span>{{ error.message }}</span>
            </div>
            <p v-if="!snapshot.index.errors.length" class="muted">所有扫描源均读取正常。</p>
          </div>
        </div>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  placeholderExplorerApi,
  type PlaceholderExplorerEditableContent,
  type PlaceholderExplorerEntry,
  type PlaceholderExplorerLocation,
  type PlaceholderExplorerPreview,
  type PlaceholderExplorerSnapshot,
} from "@/api/placeholderExplorer";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";

const snapshot = ref<PlaceholderExplorerSnapshot | null>(null);
const loading = ref(false);
const scanning = ref(false);
const keyword = ref("");
const selectedType = ref("");
const healthFilter = ref<"all" | "editable" | "dead" | "orphan" | "healthy">("all");
const selectedPlaceholder = ref("");
const activeTab = ref<"detail" | "preview" | "edit">("detail");
const previewRole = ref<"system" | "user" | "assistant">("system");
const previewModel = ref("");
const previewText = ref("");
const previewing = ref(false);
const previewResult = ref<PlaceholderExplorerPreview | null>(null);
const editScope = ref<"definition" | "file">("definition");
const editDraft = ref("");
const editableContent = ref<PlaceholderExplorerEditableContent | null>(null);
const loadingEditDraft = ref(false);
const savingEdit = ref(false);

const entries = computed(() => snapshot.value?.index.entries || []);
const selectedEntry = computed(() => entries.value.find(item => item.placeholder === selectedPlaceholder.value) || null);
const deadLinkSet = computed(() => new Set((snapshot.value?.index.checks.deadLinks || []).map(item => item.placeholder)));
const orphanSet = computed(() => new Set((snapshot.value?.index.checks.orphans || []).map(item => item.placeholder)));
const typeOptions = computed(() => [...new Set(entries.value.map(item => item.type))].sort((a, b) => a.localeCompare(b, "zh-CN")));
const canEditResolvedFile = computed(() => selectedEntry.value?.definitions.filter(item => item.resolvesTo).length === 1);
const editSourceLabel = computed(() => editableContent.value ? `${editableContent.value.source} · ${editableContent.value.file}` : "尚未读取");

const statCards = computed(() => {
  const stats = snapshot.value?.index.stats;
  return [
    { key: "placeholders", label: "占位符", value: stats?.placeholders || 0, icon: "data_object", tone: "info" },
    { key: "definitions", label: "定义", value: stats?.definitions || 0, icon: "deployed_code", tone: "neutral" },
    { key: "references", label: "引用", value: stats?.references || 0, icon: "link", tone: "neutral" },
    { key: "deadLinks", label: "死链", value: stats?.deadLinks || 0, icon: "link_off", tone: "danger" },
    { key: "orphans", label: "孤儿定义", value: stats?.orphans || 0, icon: "conversion_path", tone: "warning" },
    { key: "scanErrors", label: "扫描错误", value: stats?.scanErrors || 0, icon: "error", tone: "danger" },
  ];
});

const filteredEntries = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return entries.value.filter((entry) => {
    if (selectedType.value && entry.type !== selectedType.value) return false;
    const isDead = deadLinkSet.value.has(entry.placeholder);
    const isOrphan = orphanSet.value.has(entry.placeholder);
    if (healthFilter.value === "editable" && !entry.editable) return false;
    if (healthFilter.value === "dead" && !isDead) return false;
    if (healthFilter.value === "orphan" && !isOrphan) return false;
    if (healthFilter.value === "healthy" && (isDead || isOrphan)) return false;
    if (!query) return true;
    return [
      entry.placeholder,
      entry.type,
      ...entry.definitions.flatMap(item => [item.file, item.source || "", item.resolvesTo || ""]),
      ...entry.references.flatMap(item => [item.file, item.source || ""]),
    ].join("\n").toLowerCase().includes(query);
  });
});

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function locationLabel(location: PlaceholderExplorerLocation): string {
  const start = location.line ? `:${location.line}` : "";
  const end = location.endLine && location.endLine !== location.line ? `-${location.endLine}` : "";
  return `${location.file}${start}${end}`;
}

function truncateValue(value: string): string {
  return value.length > 1200 ? `${value.slice(0, 1200)}\n…（已截断）` : value;
}

function applySnapshot(nextSnapshot: PlaceholderExplorerSnapshot): void {
  snapshot.value = nextSnapshot;
  if (!entries.value.some(item => item.placeholder === selectedPlaceholder.value)) {
    selectedPlaceholder.value = entries.value.find(item => item.placeholder === "{{VarToolList}}")?.placeholder
      || entries.value[0]?.placeholder
      || "";
  }
  if (selectedEntry.value && !previewText.value) previewText.value = selectedEntry.value.placeholder;
}

async function loadIndex(showSuccess = false): Promise<void> {
  loading.value = true;
  try {
    applySnapshot(await placeholderExplorerApi.getIndex());
    if (showSuccess) showMessage("占位符索引已刷新", "success");
  } catch (error) {
    showMessage(`读取占位符索引失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    loading.value = false;
  }
}

async function runScan(): Promise<void> {
  scanning.value = true;
  try {
    applySnapshot(await placeholderExplorerApi.scan({ loadingKey: "placeholder-explorer.scan" }));
    showMessage("占位符全量索引已重建", "success");
  } catch (error) {
    showMessage(`扫描失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    scanning.value = false;
  }
}

function selectEntry(entry: PlaceholderExplorerEntry): void {
  selectedPlaceholder.value = entry.placeholder;
  activeTab.value = "detail";
  previewText.value = entry.placeholder;
  previewResult.value = null;
  editScope.value = "definition";
  editableContent.value = null;
  editDraft.value = "";
}

function focusPlaceholder(placeholder: string): void {
  const entry = entries.value.find(item => item.placeholder === placeholder);
  if (!entry) return;
  keyword.value = "";
  selectedType.value = "";
  healthFilter.value = "all";
  selectEntry(entry);
}

function activateTab(tab: "detail" | "preview" | "edit"): void {
  activeTab.value = tab;
  if (tab === "preview" && selectedEntry.value) previewText.value = selectedEntry.value.placeholder;
  if (tab === "edit") void loadEditDraft();
}

async function runPreview(): Promise<void> {
  if (!selectedEntry.value) return;
  previewing.value = true;
  try {
    previewResult.value = await placeholderExplorerApi.preview({
      placeholder: selectedEntry.value.placeholder,
      role: previewRole.value,
      model: previewModel.value.trim() || undefined,
      text: previewText.value,
      context: "AdminPanel 占位符索引管理器预览",
    }, { loadingKey: "placeholder-explorer.preview" });
  } catch (error) {
    showMessage(`预览失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    previewing.value = false;
  }
}

async function loadEditDraft(): Promise<void> {
  if (!selectedEntry.value?.editable) return;
  if (editScope.value === "file" && !canEditResolvedFile.value) editScope.value = "definition";
  loadingEditDraft.value = true;
  try {
    editableContent.value = await placeholderExplorerApi.getEditableContent(selectedEntry.value.placeholder, editScope.value);
    editDraft.value = editableContent.value.content;
  } catch (error) {
    editableContent.value = null;
    editDraft.value = "";
    showMessage(`读取编辑内容失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    loadingEditDraft.value = false;
  }
}

async function saveEdit(): Promise<void> {
  if (!selectedEntry.value || !editableContent.value) return;
  const confirmed = await askConfirm({
    title: "确认安全写入",
    message: `确定修改 ${selectedEntry.value.placeholder} 的${editScope.value === "file" ? "文件正文" : "定义值"}吗？保存前会自动备份原文件。`,
    confirmText: "保存并备份",
    cancelText: "取消",
  });
  if (!confirmed) return;

  savingEdit.value = true;
  try {
    const result = await placeholderExplorerApi.edit({
      placeholder: selectedEntry.value.placeholder,
      newValue: editDraft.value,
      scope: editScope.value,
    }, { loadingKey: "placeholder-explorer.edit" });
    applySnapshot(result.snapshot);
    showMessage(result.message, result.edit.restartRequired ? "warning" : "success", 6000);
    await loadEditDraft();
  } catch (error) {
    showMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    savingEdit.value = false;
  }
}

onMounted(() => void loadIndex());
</script>

<style scoped>
.explorer-page { display: flex; min-width: 0; flex-direction: column; gap: var(--space-4); }
.page-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: transparent; }
.hero-card { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(300px, auto); align-items: center; gap: var(--space-3); }
.hero-icon { color: var(--highlight-text); font-size: 40px !important; }
.hero-copy h2, .section-header h3, .detail-header h3, .detail-section h4, .health-columns h4 { margin: 0; }
.hero-copy p, .section-header p, .detail-header p { margin: 5px 0 0; color: var(--secondary-text); }
.plugin-statuses { display: flex; flex-direction: column; gap: 7px; }
.plugin-status { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.plugin-status > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; }
.plugin-status small { color: var(--secondary-text); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warning-color); }
.status-dot.enabled { background: var(--success-color); }
.stats-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--space-3); }
.stat-card { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.stat-card > span { color: var(--secondary-text); }
.stat-card div { display: flex; flex-direction: column; }
.stat-card strong { font-size: 1.15rem; }
.stat-card small { color: var(--secondary-text); }
.stat-card.tone-danger > span, .stat-card.tone-danger strong { color: var(--danger-color); }
.stat-card.tone-warning > span, .stat-card.tone-warning strong { color: var(--warning-color); }
.stat-card.tone-info > span, .stat-card.tone-info strong { color: var(--highlight-text); }
.filter-card { display: grid; grid-template-columns: minmax(260px, 2fr) minmax(150px, 1fr) minmax(150px, 1fr) auto; align-items: end; gap: var(--space-3); }
.filter-summary { height: 32px; display: flex; align-items: center; color: var(--secondary-text); white-space: nowrap; }
.explorer-grid { display: grid; grid-template-columns: minmax(360px, 0.82fr) minmax(0, 1.5fr); gap: var(--space-4); min-height: 620px; }
.entry-list-card, .detail-card { display: flex; min-height: 0; flex-direction: column; }
.section-header, .detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.entry-list { display: flex; max-height: 760px; margin-top: var(--space-3); overflow: auto; flex-direction: column; gap: 5px; }
.entry-row { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 10px; border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; color: var(--primary-text); text-align: left; cursor: pointer; }
.entry-row:hover { background: color-mix(in srgb, var(--primary-text) 4%, transparent); }
.entry-row.selected { border-color: color-mix(in srgb, var(--highlight-text) 55%, var(--border-color)); background: color-mix(in srgb, var(--highlight-text) 10%, transparent); }
.entry-main { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.entry-main code { overflow: hidden; color: var(--primary-text); text-overflow: ellipsis; white-space: nowrap; }
.entry-main small { color: var(--secondary-text); }
.entry-flags { display: flex; flex: 0 0 auto; gap: 4px; }
.detail-header { padding-bottom: var(--space-3); border-bottom: 1px solid var(--border-color); }
.detail-title-row, .detail-tabs, .actions, .location-heading { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.detail-title-row h3 { min-width: 0; overflow-wrap: anywhere; }
.detail-content { display: flex; flex-direction: column; gap: var(--space-4); padding-top: var(--space-4); }
.detail-section { display: flex; flex-direction: column; gap: var(--space-2); }
.detail-section h4 { display: flex; align-items: center; gap: 6px; }
.location-list, .chain-list { display: flex; flex-direction: column; gap: 7px; }
.location-card { padding: 10px; border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.location-card p { margin: 7px 0 0; color: var(--secondary-text); }
.location-card pre, .preview-result pre { max-height: 320px; margin: 8px 0 0; padding: 10px; overflow: auto; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--primary-text) 5%, transparent); color: var(--primary-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.reference-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.reference-item { display: flex; min-width: 0; flex-direction: column; gap: 3px; padding: 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); }
.reference-item code { overflow-wrap: anywhere; }
.reference-item small { color: var(--secondary-text); }
.chain-row { display: flex; align-items: center; gap: 5px; overflow-x: auto; padding: 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); }
.chain-row .material-symbols-outlined { color: var(--secondary-text); font-size: 16px !important; }
.chain-row code { white-space: nowrap; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
.wide { grid-column: 1 / -1; }
.end { justify-content: flex-end; }
.preview-result, .edit-warning { padding: 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.preview-result header { display: flex; align-items: center; gap: 8px; color: var(--secondary-text); }
.preview-result p { margin: 8px 0 0; color: var(--secondary-text); }
.edit-warning { display: flex; align-items: flex-start; gap: 8px; border-color: color-mix(in srgb, var(--warning-color) 45%, var(--border-color)); color: var(--secondary-text); }
.edit-warning .material-symbols-outlined { color: var(--warning-color); }
.health-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); margin-top: var(--space-3); }
.health-columns > div { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.issue-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: transparent; color: var(--primary-text); text-align: left; cursor: pointer; }
.issue-row.static { grid-template-columns: minmax(160px, auto) minmax(0, 1fr); cursor: default; }
.issue-row code { overflow-wrap: anywhere; }
.issue-row span { color: var(--secondary-text); }
.muted { margin: 0; color: var(--secondary-text); }
.warning-text { color: var(--danger-color); }
code { color: var(--highlight-text); }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1200px) {
  .stats-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .hero-card { grid-template-columns: auto minmax(0, 1fr); }
  .plugin-statuses { grid-column: 1 / -1; }
  .explorer-grid { grid-template-columns: 1fr; }
  .entry-list { max-height: 420px; }
}
@media (max-width: 760px) {
  .stats-grid, .filter-card, .form-grid, .reference-grid, .health-columns { grid-template-columns: 1fr; }
  .wide { grid-column: auto; }
  .hero-card { grid-template-columns: 1fr; }
  .detail-header, .section-header { flex-direction: column; }
  .entry-flags { display: none; }
}
</style>
