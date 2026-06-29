<template>
  <section class="config-section active-section agent-files-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <p class="agent-page-summary">
          管理 Agent 名称、关联文件与文本内容。
        </p>
        <UiBadge
          :variant="mapDirty ? 'warning' : 'success'"
          :title="mapDirty ? '映射未保存' : '映射已同步'"
          :aria-label="mapDirty ? '映射未保存' : '映射已同步'"
        >
          {{ mapDirty ? '映射未保存' : '映射已同步' }}
        </UiBadge>
        <UiButton
          @click="refreshAll"
          variant="outline"
          size="lg"
          aria-label="刷新 Agent 数据"
          title="刷新 Agent 数据"
        >
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
        <UiButton
          @click="addAgentEntry"
          variant="outline"
          size="lg"
          aria-label="添加新 Agent"
          title="添加新 Agent"
        >
          <template #leading>
            <span class="material-symbols-outlined" aria-hidden="true">add</span>
          </template>
          添加
        </UiButton>
        <UiButton
          @click="saveAgentMap"
          variant="primary"
          size="lg"
          :disabled="isSavingMap || !mapDirty"
          aria-label="保存映射表"
          title="保存映射表"
        >
          <template #leading>
            <span
              class="material-symbols-outlined"
              :class="{ spinning: isSavingMap }"
              aria-hidden="true"
            >{{ isSavingMap ? "sync" : "save" }}</span>
          </template>
          {{ isSavingMap ? "保存中…" : mapDirty ? "保存映射" : "已保存" }}
        </UiButton>
      </UiPageActions>
    </Teleport>

    <!-- 移动端视口切换胶囊 -->
    <div class="mobile-tab-nav">
      <button 
        type="button"
        class="mobile-tab-btn" 
        :class="{ active: activeTab === 'list' }" 
        @click="activeTab = 'list'"
      >
        <span class="material-symbols-outlined">smart_toy</span>
        映射列表
      </button>
      <button 
        type="button"
        class="mobile-tab-btn" 
        :class="{ active: activeTab === 'editor' }" 
        @click="activeTab = 'editor'"
      >
        <span class="material-symbols-outlined">edit_note</span>
        编辑器
        <UiBadge v-if="fileDirty" variant="warning" class="mobile-dirty-badge">
          未保存
        </UiBadge>
      </button>
    </div>

    <div class="agent-editor-shell" :class="'mobile-view-' + activeTab">
      <aside class="agent-map-pane" aria-label="Agent 映射表">
        <div class="agent-map-list">
          <article
            v-for="(entry, index) in agentMap"
            :key="entry.localId"
            class="agent-map-entry"
            :class="{ 'is-active': !!entry.file && editingFile === resolveAgentFileName(entry.file) }"
          >
            <!-- 第一层：头部标题栏 -->
            <div class="agent-entry-header">
              <span class="material-symbols-outlined header-icon">smart_toy</span>
              <span class="header-title">{{ entry.name || "未命名 Agent" }}</span>
              <UiBadge :variant="doesFileExist(entry.file) ? 'success' : 'warning'" class="agent-binding-badge">
                {{ doesFileExist(entry.file) ? '已绑定' : '待绑定' }}
              </UiBadge>
              <div class="agent-entry-actions">
                <UiIconButton
                  @click="createAndBindAgentFile(entry)"
                  :disabled="!canCreateAgentFile(entry.file)"
                  label="创建并绑定"
                  title="创建并绑定"
                >
                  <span class="material-symbols-outlined">note_add</span>
                </UiIconButton>
                <UiIconButton
                  @click="selectAgentFile(resolveAgentFileName(entry.file))"
                  :disabled="!doesFileExist(entry.file)"
                  label="编辑文件"
                  title="编辑文件"
                >
                  <span class="material-symbols-outlined">edit</span>
                </UiIconButton>
                <UiIconButton
                  @click="removeAgentEntry(index)"
                  variant="danger"
                  label="删除"
                  title="删除"
                >
                  <span class="material-symbols-outlined">delete</span>
                </UiIconButton>
              </div>
            </div>

            <!-- 第二层：中间输入配置 (PC垂直，移动端并排对齐) -->
            <div class="agent-entry-fields">
              <div class="agent-entry-row">
                <label>Agent 名称:</label>
                <UiInput
                  v-model="entry.name"
                  type="text"
                  placeholder="输入 Agent 名称"
                />
              </div>

              <div class="agent-entry-row">
                <label>关联文件:</label>
                <UiSelect
                  :model-value="resolveAgentFileName(entry.file)"
                  class="agent-file-picker"
                  :disabled="isLoadingFiles || availableFiles.length === 0"
                  aria-label="选择已有 Agent 文件"
                  @change="handleAgentFilePickerChange(entry, $event)"
                >
                  <option value="">选择已有文件…</option>
                  <optgroup
                    v-if="getAgentFilePickerGroups(entry).matched.length > 0"
                    label="名称匹配（置顶）"
                  >
                    <option
                      v-for="file in getAgentFilePickerGroups(entry).matched"
                      :key="`matched-${entry.localId}-${file}`"
                      :value="file"
                    >
                      {{ file }}
                    </option>
                  </optgroup>
                  <optgroup
                    v-if="getAgentFilePickerGroups(entry).others.length > 0"
                    label="──────── 其他文件 ────────"
                  >
                    <option
                      v-for="file in getAgentFilePickerGroups(entry).others"
                      :key="`other-${entry.localId}-${file}`"
                      :value="file"
                    >
                      {{ file }}
                    </option>
                  </optgroup>
                </UiSelect>
              </div>
            </div>

            <!-- 提示信息区域 (跨列独占一行) -->
            <div class="agent-entry-hints">
              <span v-if="isLoadingFiles" class="loading-hint">
                <span class="material-symbols-outlined spinning">sync</span>
                加载文件列表中...
              </span>

              <span
                v-else-if="entry.file && (!doesFileExist(entry.file) || hasInvalidAgentFilePath(entry.file))"
                :class="[
                  'file-hint',
                  hasInvalidAgentFilePath(entry.file)
                    ? 'error'
                    : doesFileExist(entry.file)
                      ? 'success'
                      : 'info',
                ]"
              >
                {{
                  hasInvalidAgentFilePath(entry.file)
                    ? "文件名不能包含绝对路径、空目录、. 或 .."
                    : doesFileExist(entry.file)
                      ? `将绑定已有文件：${resolveAgentFileName(entry.file)}`
                      : `点击“创建并绑定”后会新建：${normalizeAgentFileName(entry.file)}`
                }}
              </span>
            </div>

          </article>

          <div v-if="agentMap.length === 0" class="empty-state">
            <span class="material-symbols-outlined">smart_toy</span>
            <p>暂无 Agent 映射</p>
            <UiButton @click="addAgentEntry" variant="primary">
              添加第一个 Agent
            </UiButton>
          </div>
        </div>
      </aside>

      <main class="agent-file-pane" aria-label="Agent 文件内容">
        <header class="agent-file-pane-header">
          <div class="agent-file-title">
            <span class="agent-pane-label">Agent 文件内容</span>
            <span class="agent-file-name">
              <span class="material-symbols-outlined">description</span>
              {{ editingFile || "未选择文件" }}
            </span>
            <UiBadge v-if="fileDirty" variant="warning">未保存</UiBadge>
          </div>
          <div v-if="editingFile" class="agent-file-actions">
            <UiButton
              @click="openDiarySyntaxEditor"
              variant="outline"
              size="sm"
              aria-label="打开日记本语法编辑器"
              title="日记本语法编辑器"
            >
              <template #leading>
                <span class="material-symbols-outlined">auto_fix_high</span>
              </template>
              日记本语法编辑器
            </UiButton>
            <UiButton
              @click="saveAgentFile"
              :disabled="!fileDirty || isSavingFile"
              variant="primary"
              size="sm"
            >
              <template #leading>
                <span class="material-symbols-outlined" :class="{ spinning: isSavingFile }">{{ isSavingFile ? "sync" : "save" }}</span>
              </template>
              {{ isSavingFile ? "保存中…" : fileDirty ? "保存文件" : "已保存" }}
            </UiButton>
          </div>
        </header>

        <div class="agent-file-workspace">
          <div class="agent-file-editor">
            <UiTextarea
              ref="fileContentEditorRef"
              v-model="fileContent"
              spellcheck="false"
              rows="20"
              placeholder="从左侧选择一个 Agent 以编辑其关联的 .txt / .md 文件…"
              class="file-content-editor"
            />
            <UiBadge
              v-if="fileStatusMessage"
              :variant="fileStatusBadgeVariant"
            >
              {{ fileStatusMessage }}
            </UiBadge>
          </div>
        </div>
      </main>

      <aside class="placeholder-sidebar" aria-label="常用占位符">
        <header class="placeholder-sidebar-header">
          <div class="placeholder-source-tabs" role="tablist" aria-label="占位符类型">
            <button
              v-for="group in placeholderGroups"
              :key="group.key"
              type="button"
              class="placeholder-source-tab"
              :class="{ 'is-active': activePlaceholderSource === group.key }"
              role="tab"
              :aria-selected="activePlaceholderSource === group.key"
              @click="activePlaceholderSource = group.key"
            >
              <span class="material-symbols-outlined">{{ group.icon }}</span>
              <span>{{ group.shortTitle }}</span>
              <span class="placeholder-count">{{ group.items.length }}</span>
            </button>
          </div>

          <div class="placeholder-search">
            <span class="material-symbols-outlined search-icon">search</span>
            <UiInput
              v-model="placeholderQuery"
              type="text"
              placeholder="搜索占位符…"
            />
            <UiIconButton
              v-if="placeholderQuery"
              class="search-clear"
              label="清除搜索"
              title="清除搜索"
              @click="placeholderQuery = ''"
            >
              <span class="material-symbols-outlined">close</span>
            </UiIconButton>
          </div>
        </header>

        <div
          v-if="isLoadingCommonPlaceholders"
          class="placeholder-sidebar-status"
          role="status"
          aria-live="polite"
        >
          正在加载占位符…
        </div>

        <div
          v-else-if="placeholderLoadError"
          class="placeholder-sidebar-status error"
          role="status"
          aria-live="polite"
        >
          {{ placeholderLoadError }}
        </div>

        <div v-else class="placeholder-scroll">
          <section
            v-for="group in filteredPlaceholderGroups"
            :key="group.key"
            class="placeholder-group"
          >
            <div class="placeholder-command-list">
              <button
                v-for="item in group.items"
                :key="`${group.key}-${item.token}`"
                type="button"
                class="placeholder-command-item"
                :title="item.description || item.token"
                @click="insertPlaceholderAtCursor(item.token)"
              >
                <code>{{ item.token }}</code>
                <span v-if="item.description">{{ item.description }}</span>
              </button>
            </div>
          </section>

          <div
            v-if="filteredPlaceholderGroups.length === 0"
            class="placeholder-sidebar-status"
          >
            没有匹配的占位符。
          </div>
        </div>
      </aside>
    </div>

    <datalist :id="agentFilesDatalistId">
      <option v-for="file in availableFiles" :key="file" :value="file">
        {{ file }}
      </option>
    </datalist>

    <DiarySyntaxEditorModal
      v-model="isDiarySyntaxEditorOpen"
      @insert="insertDiarySyntax"
    />

    <UiBadge
      v-if="statusMessage"
      :variant="statusBadgeVariant"
      class="floating-status"
      role="status"
      aria-live="polite"
    >
      {{ statusMessage }}
    </UiBadge>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { agentApi, placeholderApi, toolboxApi } from "@/api";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import DiarySyntaxEditorModal from "./AgentFilesEditor/DiarySyntaxEditorModal.vue";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import type {
  AgentFilesStatusType,
  AgentMapEntry,
} from "@/features/agent-files-editor/types";
import { showMessage } from "@/utils";
import { createLogger } from "@/utils/logger";

const logger = createLogger("AgentFilesEditor");

interface AgentMapDraft extends AgentMapEntry {
  localId: string;
}

interface QuickPlaceholderItem {
  token: string;
  description: string;
  source: "toolbox" | "env";
}

interface QuickPlaceholderGroup {
  key: "toolbox" | "env";
  title: string;
  shortTitle: string;
  icon: string;
  items: QuickPlaceholderItem[];
}

let nextAgentMapDraftId = 0;

function createAgentMapDraft(
  entry: Partial<AgentMapEntry> = {}
): AgentMapDraft {
  nextAgentMapDraftId += 1;

  return {
    localId: `agent-map-draft-${nextAgentMapDraftId}`,
    name: entry.name ?? "",
    file: entry.file ?? "",
  };
}

const activeTab = ref<'list' | 'editor'>('list'); // 移动端视口当前激活面板
const agentMap = ref<AgentMapDraft[]>([]);
const availableFiles = ref<string[]>([]);
const isLoadingFiles = ref(false);
const statusMessage = ref("");
const statusType = ref<AgentFilesStatusType>("info");
const editingFile = ref("");
const fileContent = ref("");
const originalFileContent = ref("");
const fileStatusMessage = ref("");
const fileStatusType = ref<AgentFilesStatusType>("info");
const statusBadgeVariant = computed(() =>
  statusType.value === "error" ? "danger" : statusType.value
);
const fileStatusBadgeVariant = computed(() =>
  fileStatusType.value === "error" ? "danger" : fileStatusType.value
);
const isSavingMap = ref(false);
const isSavingFile = ref(false);
const initialAgentMapSnapshot = ref("[]");
const isDiarySyntaxEditorOpen = ref(false);
const isLoadingCommonPlaceholders = ref(false);
const placeholderLoadError = ref("");
const placeholderQuery = ref("");
const activePlaceholderSource = ref<QuickPlaceholderGroup["key"]>("toolbox");
const toolboxPlaceholders = ref<QuickPlaceholderItem[]>([]);
const envPlaceholders = ref<QuickPlaceholderItem[]>([]);
const fileContentEditorRef = ref<InstanceType<typeof UiTextarea> | null>(null);

const agentFilesDatalistId = "agent-file-options";
const AGENT_FILE_EXTENSION_PATTERN = /\.(txt|md)$/i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//;

const availableFileLookup = computed(() => {
  const lookup = new Map<string, string>();

  availableFiles.value.forEach((file) => {
    lookup.set(file.toLowerCase(), file);
  });

  return lookup;
});

function serializeAgentMap(entries: AgentMapDraft[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      name: entry.name.trim(),
      file: entry.file.trim(),
    }))
  );
}

const mapDirty = computed(
  () => serializeAgentMap(agentMap.value) !== initialAgentMapSnapshot.value
);

const fileDirty = computed(() => {
  if (!editingFile.value) {
    return false;
  }
  return fileContent.value !== originalFileContent.value;
});

const hasPendingChanges = computed(() => mapDirty.value || fileDirty.value);

function sanitizeAgentFileInput(fileName: string): string {
  return fileName.trim().replace(/\\/g, "/");
}

function hasInvalidAgentFilePath(fileName: string): boolean {
  const sanitized = sanitizeAgentFileInput(fileName);

  if (!sanitized) {
    return false;
  }

  if (
    sanitized.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(sanitized) ||
    sanitized.includes("\0")
  ) {
    return true;
  }

  return sanitized.split("/").some((segment) => {
    const trimmedSegment = segment.trim();
    return (
      trimmedSegment.length === 0 ||
      trimmedSegment === "." ||
      trimmedSegment === ".."
    );
  });
}

function normalizeAgentFileName(fileName: string): string {
  const sanitized = sanitizeAgentFileInput(fileName);

  if (!sanitized || hasInvalidAgentFilePath(sanitized)) {
    return "";
  }

  const normalized = sanitized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");

  if (!normalized) {
    return "";
  }

  return AGENT_FILE_EXTENSION_PATTERN.test(normalized)
    ? normalized
    : `${normalized}.txt`;
}

function findExistingAgentFile(fileName: string): string | null {
  const normalized = normalizeAgentFileName(fileName);

  if (!normalized) {
    return null;
  }

  return availableFileLookup.value.get(normalized.toLowerCase()) ?? null;
}

function resolveAgentFileName(fileName: string): string {
  return findExistingAgentFile(fileName) ?? normalizeAgentFileName(fileName);
}

function normalizeEntryFile(entry: AgentMapDraft): string {
  const sanitized = sanitizeAgentFileInput(entry.file);

  if (!sanitized) {
    entry.file = "";
    return "";
  }

  if (hasInvalidAgentFilePath(sanitized)) {
    entry.file = sanitized;
    return sanitized;
  }

  const normalized = normalizeAgentFileName(sanitized);
  entry.file = findExistingAgentFile(normalized) ?? normalized;
  return entry.file;
}

function doesFileExist(fileName: string): boolean {
  return findExistingAgentFile(fileName) !== null;
}

function canCreateAgentFile(fileName: string): boolean {
  const normalized = normalizeAgentFileName(fileName);

  return (
    normalized !== "" &&
    !hasInvalidAgentFilePath(fileName) &&
    findExistingAgentFile(normalized) === null
  );
}

function splitAgentFilePath(fileName: string): {
  fileName: string;
  folderPath?: string;
} {
  const lastSlashIndex = fileName.lastIndexOf("/");

  if (lastSlashIndex < 0) {
    return { fileName };
  }

  return {
    fileName: fileName.slice(lastSlashIndex + 1),
    folderPath: fileName.slice(0, lastSlashIndex),
  };
}

function deduplicateAgentFiles(files: readonly string[]): string[] {
  const uniqueFiles = new Map<string, string>();

  files.forEach((file) => {
    const normalizedFile = sanitizeAgentFileInput(String(file));

    if (!normalizedFile) {
      return;
    }

    const lookupKey = normalizedFile.toLowerCase();
    if (!uniqueFiles.has(lookupKey)) {
      uniqueFiles.set(lookupKey, normalizedFile);
    }
  });

  return [...uniqueFiles.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" })
  );
}

function getAgentFilePickerGroups(entry: AgentMapDraft): {
  matched: string[];
  others: string[];
} {
  const normalizedName = entry.name.trim().toLowerCase();
  const matched: string[] = [];
  const others: string[] = [];

  availableFiles.value.forEach((file) => {
    const comparableFile = file.toLowerCase();
    if (normalizedName && comparableFile.includes(normalizedName)) {
      matched.push(file);
      return;
    }

    others.push(file);
  });

  return { matched, others };
}

function handleAgentFilePickerChange(entry: AgentMapDraft, event: Event): void {
  const selectedFile = (event.target as HTMLSelectElement).value;
  if (!selectedFile) {
    return;
  }

  entry.file = selectedFile;
}

function normalizePlaceholderToken(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("{{") && trimmed.endsWith("}}") ? trimmed : `{{${trimmed}}}`;
}

function isTargetEnvPlaceholderName(name: string): boolean {
  const normalized = name.replace(/^\{\{|\}\}$/g, "");
  return /^(Tar|Var|Sar)/.test(normalized);
}

function matchesPlaceholderQuery(item: QuickPlaceholderItem, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }

  return `${item.token}\n${item.description}`.toLowerCase().includes(normalizedQuery);
}

const placeholderGroups = computed<QuickPlaceholderGroup[]>(() => [
  {
    key: "toolbox",
    title: "Toolbox 占位符",
    shortTitle: "Toolbox",
    icon: "inventory_2",
    items: toolboxPlaceholders.value,
  },
  {
    key: "env",
    title: "Tar / Var / Sar 变量",
    shortTitle: "Tar 变量",
    icon: "tune",
    items: envPlaceholders.value,
  },
]);

const filteredPlaceholderGroups = computed<QuickPlaceholderGroup[]>(() => {
  const query = placeholderQuery.value.trim().toLowerCase();

  return placeholderGroups.value
    .filter((group) => group.key === activePlaceholderSource.value)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => matchesPlaceholderQuery(item, query)),
    }))
    .filter((group) => group.items.length > 0);
});

async function loadCommonPlaceholders(): Promise<void> {
  isLoadingCommonPlaceholders.value = true;
  placeholderLoadError.value = "";

  try {
    const [toolboxMap, placeholders] = await Promise.all([
      toolboxApi.getToolboxMap({ showLoader: false, loadingKey: "agent-files.toolbox-placeholders.load" }),
      placeholderApi.getPlaceholders({ showLoader: false, loadingKey: "agent-files.env-placeholders.load" }),
    ]);

    toolboxPlaceholders.value = Object.entries(toolboxMap || {})
      .map(([alias, value]) => {
        const token = normalizePlaceholderToken(alias);
        return {
          token,
          description: [value?.file, value?.description].filter(Boolean).join(" · "),
          source: "toolbox" as const,
        };
      })
      .filter((item) => item.token.length > 0)
      .sort((left, right) => left.token.localeCompare(right.token, undefined, { sensitivity: "base" }));

    envPlaceholders.value = placeholders
      .filter((placeholder) => isTargetEnvPlaceholderName(placeholder.name))
      .map((placeholder) => ({
        token: normalizePlaceholderToken(placeholder.name),
        description: placeholder.description || placeholder.preview || placeholder.type,
        source: "env" as const,
      }))
      .filter((item) => item.token.length > 0)
      .sort((left, right) => left.token.localeCompare(right.token, undefined, { sensitivity: "base" }));
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load common placeholders:", errorMessage);
    placeholderLoadError.value = `加载常用占位符失败: ${errorMessage}`;
  } finally {
    isLoadingCommonPlaceholders.value = false;
  }
}

async function insertPlaceholderAtCursor(token: string): Promise<void> {
  if (!token) {
    return;
  }

  const editor = fileContentEditorRef.value;
  if (!editor) {
    fileContent.value = `${fileContent.value}${token}`;
    showMessage(`已插入 ${token}`, "success");
    return;
  }

  const { start: selectionStart, end: selectionEnd } = editor.getSelectionRange();
  const before = fileContent.value.slice(0, selectionStart);
  const after = fileContent.value.slice(selectionEnd);
  const previousScrollPosition = editor.getScrollPosition();
  fileContent.value = `${before}${token}${after}`;

  await nextTick();
  editor.focus({ preventScroll: true });
  const nextCursor = selectionStart + token.length;
  editor.setSelectionRange(nextCursor, nextCursor);
  editor.setScrollPosition(previousScrollPosition);
  showMessage(`已插入 ${token}`, "success");
}

function buildAgentMapPayload(): Record<string, string> {
  const payload: Record<string, string> = {};
  const seenNames = new Set<string>();

  for (const entry of agentMap.value) {
    const name = entry.name.trim();
    const normalizedFile = normalizeEntryFile(entry);

    if (!name && !normalizedFile) {
      continue;
    }

    if (!name || !normalizedFile) {
      throw new Error("Agent 名称和关联文件都需要填写。");
    }

    if (hasInvalidAgentFilePath(normalizedFile)) {
      throw new Error(`文件路径格式不正确: ${entry.file}`);
    }

    const resolvedFile = findExistingAgentFile(normalizedFile);
    if (!resolvedFile) {
      throw new Error(
        `文件 ${normalizedFile} 还不存在，请先点击“创建并绑定”或选择已有文件。`
      );
    }

    if (seenNames.has(name)) {
      throw new Error(`Agent 名称重复: ${name}`);
    }

    seenNames.add(name);
    payload[name] = resolvedFile;
  }

  return payload;
}

async function loadAvailableFiles(): Promise<void> {
  isLoadingFiles.value = true;

  try {
    const files = await agentApi.getAgentFiles(
      {},
      {
        showLoader: false,
        loadingKey: "agent-files.available-files.load",
      }
    );

    availableFiles.value = deduplicateAgentFiles(files);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load available files:", errorMessage);
    showMessage(`Failed to load available files: ${errorMessage}`, "error");
    availableFiles.value = [];
  } finally {
    isLoadingFiles.value = false;
  }
}

async function loadAgentMap(): Promise<void> {
  try {
    const data = await agentApi.getAgentMap(
      {},
      {
        showLoader: false,
        loadingKey: "agent-files.map.load",
      }
    );

    if (data && typeof data === "object") {
      agentMap.value = Object.entries(data).map(([name, file]) =>
        createAgentMapDraft({
          name,
          file: String(file),
        })
      );
    } else {
      agentMap.value = [];
    }
    initialAgentMapSnapshot.value = serializeAgentMap(agentMap.value);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load agent map:", errorMessage);
    showMessage(`Failed to load agent map: ${errorMessage}`, "error");
    agentMap.value = [];
    initialAgentMapSnapshot.value = serializeAgentMap(agentMap.value);
  }
}

async function saveAgentMap(): Promise<void> {
  if (isSavingMap.value) {
    return;
  }

  isSavingMap.value = true;

  try {
    const agentMapObject = buildAgentMapPayload();

    await agentApi.saveAgentMap(agentMapObject, {
      loadingKey: "agent-files.map.save",
    });

    initialAgentMapSnapshot.value = serializeAgentMap(agentMap.value);

    statusMessage.value = "Agent 映射已保存。";
    statusType.value = "success";
    showMessage("Agent 映射已保存。", "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `保存 Agent 映射失败: ${errorMessage}`;
    statusType.value = "error";
    showMessage(`保存 Agent 映射失败: ${errorMessage}`, "error");
  } finally {
    isSavingMap.value = false;
  }
}

function addAgentEntry(): void {
  agentMap.value.push(createAgentMapDraft());
}

async function removeAgentEntry(index: number): Promise<void> {
  if (!(await askConfirm({
    message: "确定删除这条 Agent 映射吗？",
    danger: true,
    confirmText: "删除",
  }))) {
    return;
  }

  agentMap.value.splice(index, 1);
}

async function createAndBindAgentFile(entry: AgentMapDraft): Promise<void> {
  const rawFileName = sanitizeAgentFileInput(entry.file);

  if (!rawFileName) {
    showMessage("请先输入要创建的 Agent 文件名。", "info");
    return;
  }

  if (hasInvalidAgentFilePath(rawFileName)) {
    showMessage("文件名不能包含绝对路径、空目录、. 或 ..。", "error");
    return;
  }

  const normalizedFileName = normalizeAgentFileName(rawFileName);
  entry.file = normalizedFileName;

  const existingFile = findExistingAgentFile(normalizedFileName);
  if (existingFile) {
    entry.file = existingFile;
    showMessage(`已绑定已有文件 ${existingFile}。`, "success");
    await selectAgentFile(existingFile);
    return;
  }

  const createTarget = splitAgentFilePath(normalizedFileName);

  try {
    await agentApi.createAgentFile(createTarget.fileName, createTarget.folderPath, {
      loadingKey: "agent-files.file.create",
    });

    await loadAvailableFiles();
    entry.file = normalizeEntryFile(entry);
    showMessage(`已创建并绑定文件 ${entry.file}。`, "success");
    await selectAgentFile(entry.file);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`创建文件失败: ${errorMessage}`, "error");
  }
}

async function selectAgentFile(fileName: string): Promise<void> {
  if (!fileName) {
    return;
  }

  if (editingFile.value !== fileName && fileDirty.value) {
    const shouldDiscard = await askConfirm({
      message: `文件「${editingFile.value}」有未保存改动，确定放弃并切换吗？`,
      danger: true,
      confirmText: "放弃改动",
    });
    if (!shouldDiscard) {
      return;
    }
  }

  editingFile.value = fileName;
  activeTab.value = 'editor'; // 自动滑动切入至编辑器视图
  fileStatusMessage.value = "";

  try {
    fileContent.value = await agentApi.getAgentFileContent(
      fileName,
      {},
      {
        showLoader: false,
        loadingKey: "agent-files.file.load",
      }
    );
    originalFileContent.value = fileContent.value;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`Failed to load file: ${errorMessage}`, "error");
    fileContent.value = "";
    originalFileContent.value = "";
  }
}

function openDiarySyntaxEditor(): void {
  isDiarySyntaxEditorOpen.value = true;
}

function insertDiarySyntax(syntax: string): void {
  if (!syntax) {
    return;
  }

  const separator = fileContent.value && !fileContent.value.endsWith("\n") ? "\n" : "";
  fileContent.value = `${fileContent.value}${separator}${syntax}`;
  isDiarySyntaxEditorOpen.value = false;
}

async function saveAgentFile(): Promise<void> {
  if (!editingFile.value || isSavingFile.value) {
    return;
  }

  isSavingFile.value = true;

  try {
    await agentApi.saveAgentFile(editingFile.value, fileContent.value, {
      loadingKey: "agent-files.file.save",
    });

    originalFileContent.value = fileContent.value;

    fileStatusMessage.value = "文件已保存。";
    fileStatusType.value = "success";
    showMessage("文件已保存。", "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    fileStatusMessage.value = `保存文件失败: ${errorMessage}`;
    fileStatusType.value = "error";
  } finally {
    isSavingFile.value = false;
  }
}

async function refreshAll(): Promise<void> {
  if (hasPendingChanges.value) {
    const shouldContinue = await askConfirm({
      message: "存在未保存改动，刷新会覆盖当前编辑内容，是否继续？",
      danger: true,
      confirmText: "继续刷新",
    });
    if (!shouldContinue) {
      return;
    }
  }

  await Promise.all([loadAvailableFiles(), loadAgentMap(), loadCommonPlaceholders()]);
  if (editingFile.value) {
    await selectAgentFile(editingFile.value);
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (fileDirty.value) {
      void saveAgentFile();
      return;
    }

    if (mapDirty.value && !isEditableTarget(event.target)) {
      void saveAgentMap();
    }
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasPendingChanges.value) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
}

onMounted(() => {
  void Promise.all([loadAvailableFiles(), loadAgentMap(), loadCommonPlaceholders()]);
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("beforeunload", handleBeforeUnload);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("beforeunload", handleBeforeUnload);
});

onBeforeRouteLeave(async () => {
  if (!hasPendingChanges.value) {
    return true;
  }

  return await askConfirm({
    message: "存在未保存的 Agent 改动，确定要离开吗？",
    danger: true,
    confirmText: "放弃改动",
  });
});
</script>

<style scoped>
.agent-files-page {
  --agent-workspace-height: calc(var(--app-viewport-height, 100vh) - 150px);
  --agent-workspace-min-height: 520px;
}

.agent-page-summary {
  max-width: 340px;
  margin: 0 var(--space-2) 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.35;
}

.agent-editor-shell {
  display: grid;
  grid-template-columns: minmax(292px, 340px) minmax(360px, 1fr) minmax(320px, 360px);
  gap: var(--space-4);
  min-height: var(--agent-workspace-min-height);
  height: max(var(--agent-workspace-height), var(--agent-workspace-min-height));
}

.agent-map-pane,
.agent-file-pane,
.placeholder-sidebar {
  min-width: 0;
  min-height: 0;
}

.agent-map-pane {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

.agent-file-pane {
  display: flex;
  flex-direction: column;
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
  overflow: hidden;
}

.agent-pane-label {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 var(--space-2);
  color: color-mix(in srgb, var(--secondary-text) 72%, transparent);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.25;
  text-transform: uppercase;
}

.agent-file-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 58px;
  padding: var(--space-3) var(--space-4);
}

.agent-file-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.agent-file-pane-header .agent-pane-label {
  min-height: 0;
  padding: 0;
  flex: 0 0 auto;
}

.agent-file-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-file-name .material-symbols-outlined {
  flex: 0 0 auto;
  font-size: 16px !important;
}

.agent-file-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.agent-map-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-1) var(--space-3) 0;
  scrollbar-gutter: stable;
}

.agent-map-entry {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 5%, transparent),
      color-mix(in srgb, var(--primary-text) 0.8%, transparent)
    );
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease;
  overflow: hidden;
}

.agent-map-entry:hover {
  border-color: color-mix(in srgb, var(--button-bg) 24%, var(--border-color));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 8%, transparent),
      color-mix(in srgb, var(--primary-text) 1.8%, transparent)
    );
}

.agent-map-entry.is-active {
  border-color: color-mix(in srgb, var(--button-bg) 42%, var(--border-color));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--button-bg) 12%, transparent),
      color-mix(in srgb, var(--primary-text) 2.2%, transparent)
    );
}

.agent-map-entry.is-active::before {
  content: "";
  position: absolute;
  inset: 8px auto 8px 0;
  width: 2px;
  border-radius: var(--radius-full);
  background: var(--button-bg);
}

.agent-entry-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  margin-bottom: 0;
}

.agent-file-picker {
  width: 100%;
}

.agent-entry-row label {
  color: var(--secondary-text);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.25;
  white-space: nowrap;
}

.loading-hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 4px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.loading-hint .spinning {
  animation: spin 1s linear infinite;
}

.file-hint {
  display: block;
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.file-hint.info {
  color: var(--primary-text);
  opacity: 0.85;
}

.file-hint.success {
  color: var(--success-text);
}

.file-hint.error {
  color: var(--danger-text);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.agent-entry-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
  margin-left: auto;
}

.agent-entry-actions :deep(.ui-icon-button) {
  width: 28px;
  height: 28px;
}

.agent-entry-actions :deep(.ui-icon-button .material-symbols-outlined) {
  font-size: 16px !important;
}

.agent-file-workspace {
  display: flex;
  min-height: 0;
  flex: 1;
  padding: 0 var(--space-3) var(--space-3);
}

.agent-file-editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.file-content-editor {
  flex: 1;
  width: 100%;
  min-height: 240px;
  font-size: var(--font-size-body);
  line-height: 1.6;
  font-family: "Consolas", "Monaco", monospace;
}

.file-content-editor :deep(.ui-textarea),
.file-content-editor.ui-textarea {
  height: 100%;
  max-height: none;
  min-height: 240px;
  border-color: transparent;
  background: transparent;
  border-radius: 0;
  resize: none;
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.file-content-editor :deep(.ui-textarea:hover:not(:disabled)),
.file-content-editor.ui-textarea:hover:not(:disabled) {
  border-color: transparent;
  background: transparent;
}

.file-content-editor :deep(.ui-textarea:focus-visible),
.file-content-editor.ui-textarea:focus-visible {
  border-color: transparent;
  background: transparent;
  outline-offset: -2px;
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.placeholder-sidebar {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 84%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.placeholder-sidebar-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: stretch;
  gap: var(--space-2);
  padding: var(--space-3);
}

.placeholder-source-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  width: 100%;
  padding: 3px;
  border: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1.6%, transparent);
}

.placeholder-source-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  min-height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.placeholder-source-tab:hover {
  background: var(--accent-bg);
  color: var(--primary-text);
}

.placeholder-source-tab.is-active {
  background: color-mix(in srgb, var(--button-bg) 12%, transparent);
  color: var(--primary-text);
}

.placeholder-source-tab .material-symbols-outlined {
  flex: 0 0 auto;
  font-size: 16px !important;
}

.placeholder-source-tab .placeholder-count {
  margin-left: 0;
  background: color-mix(in srgb, var(--primary-text) 5%, transparent);
}

.placeholder-search {
  position: relative;
  width: 100%;
}

.placeholder-search :deep(.ui-input) {
  padding-left: 34px;
  padding-right: 32px;
}

.placeholder-search .search-icon {
  position: absolute;
  top: 50%;
  left: 10px;
  transform: translateY(-50%);
  color: var(--secondary-text);
  font-size: 18px !important;
  pointer-events: none;
}

.placeholder-search .search-clear {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
}

.placeholder-search .search-clear .material-symbols-outlined {
  font-size: 16px !important;
}

.placeholder-sidebar-status {
  margin: var(--space-3);
  padding: var(--space-3);
  border: 1px dashed color-mix(in srgb, var(--border-color) 84%, transparent);
  border-radius: var(--radius-md);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.5;
}

.placeholder-sidebar-status.error {
  border-style: solid;
  border-color: color-mix(in srgb, var(--danger-color) 34%, var(--border-color));
  background: color-mix(in srgb, var(--danger-color) 8%, transparent);
  color: var(--primary-text);
}

.placeholder-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 2px var(--space-2);
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--secondary-text) 26%, transparent) transparent;
}

.placeholder-scroll::-webkit-scrollbar {
  width: 8px;
}

.placeholder-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.placeholder-scroll::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: var(--radius-full);
  background-color: color-mix(in srgb, var(--secondary-text) 28%, transparent);
  background-clip: padding-box;
}

.placeholder-group {
  flex: 0 0 auto;
  padding: var(--space-2);
}

.placeholder-group:last-child {
  border-bottom: none;
}

.placeholder-group-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 28px;
  padding: 0 var(--space-2);
  color: color-mix(in srgb, var(--secondary-text) 78%, transparent);
  font-size: var(--font-size-caption);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.placeholder-group-title .material-symbols-outlined {
  color: var(--secondary-text);
  font-size: 15px !important;
}

.placeholder-count {
  margin-left: auto;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--primary-text) 4%, transparent);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
}

.placeholder-command-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.placeholder-command-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  min-height: 0;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--primary-text);
  cursor: pointer;
  text-align: left;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.placeholder-command-item:hover {
  background: var(--accent-bg);
}

.placeholder-command-item code {
  min-width: 0;
  color: var(--highlight-text);
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.35;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.placeholder-command-item span {
  min-width: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.4;
  white-space: normal;
}

/* .empty-state 已在全局 layout.css 中统一定义 */

.floating-status {
  position: fixed;
  right: 30px;
  bottom: 30px;
  z-index: 1000;
  animation: slideInRight 0.3s ease;
}

@keyframes slideInRight {
  from {
    transform: translateX(100%);
    opacity: 0;
  }

  to {
    transform: translateX(0);
    opacity: 1;
  }
}

/* 左侧映射列表：保持类似基础配置操作台的轻量层级 */
.agent-entry-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 30px;
  padding: 0;
}

.header-icon {
  color: var(--secondary-text);
  font-size: 16px !important;
  flex: 0 0 auto;
}

.header-title {
  font-weight: 600;
  font-size: 0.875rem;
  line-height: 1.25;
  color: var(--primary-text);
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-binding-badge {
  margin-left: var(--space-1);
  flex: 0 0 auto;
}

.agent-entry-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.agent-entry-hints {
  min-height: 0;
  padding: 0;
  overflow-wrap: anywhere;
}

/* 移动端精致化响应式滑盖与底置 Segmented 胶囊导航 */
.mobile-tab-nav {
  display: none;
}

@media (max-width: 768px) {
  .agent-page-summary {
    display: none;
  }

  /* 根据 activeTab 完全隐藏另一侧，保障单屏100%全景视图 */
  .agent-editor-shell.mobile-view-list .agent-file-pane {
    display: none !important;
  }

  .agent-editor-shell .placeholder-sidebar {
    display: none !important;
  }

  .agent-editor-shell.mobile-view-editor .agent-map-pane {
    display: none !important;
  }

  .agent-editor-shell {
    display: flex;
    min-height: calc(var(--app-viewport-height, 100vh) - 150px);
    height: calc(var(--app-viewport-height, 100vh) - 150px);
  }

  .agent-map-pane,
  .agent-file-pane {
    width: 100%;
    flex: 1;
  }

  .agent-map-entry {
    border-color: color-mix(in srgb, var(--border-color) 84%, transparent);
  }

  .agent-entry-fields {
    display: flex !important;
    gap: var(--space-2) !important;
  }

  .agent-entry-fields .agent-entry-row {
    margin-bottom: 0 !important;
  }

  .agent-entry-row {
    grid-template-columns: 68px minmax(0, 1fr);
  }

  .agent-entry-hints {
    margin: 0;
  }

  .agent-entry-actions {
    gap: var(--space-1) !important;
    margin-left: auto;
  }

  .agent-file-workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .agent-file-editor {
    height: 100%;
  }

  .placeholder-sidebar {
    max-height: 360px;
  }

  .file-content-editor {
    height: 100%;
    min-height: 280px;
  }

  .mobile-tab-nav {
    display: flex !important;
    position: fixed !important;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999;
    border: 1px solid color-mix(in srgb, var(--border-color) 84%, transparent);
    background: var(--secondary-bg);
    padding: 4px;
    gap: 4px;
    width: 220px;
    border-radius: var(--radius-full);
    margin: 0 !important;
  }

  .mobile-tab-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 12px;
    border: none;
    background: transparent;
    color: var(--secondary-text);
    font-size: var(--font-size-helper);
    font-weight: 500;
    border-radius: var(--radius-full);
    cursor: pointer;
    position: relative;
    transition:
      background var(--transition-fast),
      color var(--transition-fast);
  }

  .mobile-tab-btn:hover {
    background: color-mix(in srgb, var(--primary-text) 3%, transparent);
    color: var(--primary-text);
  }

  .mobile-tab-btn.active {
    background: var(--accent-bg);
    color: var(--primary-text);
    font-weight: 600;
  }

  .mobile-tab-btn.active .material-symbols-outlined {
    color: var(--primary-text);
  }

  .mobile-dirty-badge {
    position: absolute;
    top: -8px;
    right: 2px;
    transform: scale(0.86);
    transform-origin: top right;
  }

  .agent-files-page {
    --agent-workspace-height: calc(var(--app-viewport-height, 100vh) - 150px);
  }
}

@media (max-width: 1024px) and (min-width: 769px) {
  .agent-editor-shell {
    grid-template-columns: minmax(280px, 320px) minmax(0, 1fr);
  }

  .agent-editor-shell .placeholder-sidebar {
    display: none;
  }

  .agent-map-list {
    max-height: none;
  }

  .agent-file-editor {
    height: auto;
    min-height: auto;
  }

  .file-content-editor {
    min-height: 300px;
  }
}
</style>
