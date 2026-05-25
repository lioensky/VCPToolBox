<template>
  <section class="config-section active-section agent-files-page">
    <p class="description">
      管理 Agent 的定义名称与对应的 `.txt` / `.md` 文件。你可以在这里添加、删除和修改
      Agent 映射，并直接编辑关联的文本文件。
    </p>

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
        <span v-if="fileDirty" class="dirty-badge"></span>
      </button>
    </div>

    <DualPaneEditor
      left-title="Agent 映射表"
      right-title="Agent 文件内容"
      :initial-left-width="450"
      :min-left-width="350"
      :max-left-width="600"
      collapsible
      persist-key="agentFilesEditor"
      class="agent-dual-pane"
      :class="'mobile-view-' + activeTab"
    >
      <template #left-actions>
        <div class="pane-toolbar pane-toolbar--left">
          <div class="pane-toolbar-main">
            <button
              @click="addAgentEntry"
              class="btn-primary btn-sm btn-sm-touch"
              aria-label="添加新 Agent"
              title="添加新 Agent"
            >
              <span class="material-symbols-outlined" aria-hidden="true">add</span>
              添加
            </button>
            <button
              type="button"
              @click="saveAgentMap"
              class="btn-success btn-sm btn-sm-touch"
              :disabled="isSavingMap || !mapDirty"
              aria-label="保存映射表"
              title="保存映射表"
            >
              <span
                class="material-symbols-outlined"
                :class="{ spinning: isSavingMap }"
                aria-hidden="true"
              >{{ isSavingMap ? "sync" : "save" }}</span>
              {{ isSavingMap ? "保存中…" : mapDirty ? "保存" : "已保存" }}
            </button>
            <details class="pane-toolbar-menu">
              <summary class="pane-toolbar-menu-trigger" aria-label="更多操作" title="更多操作">
                <span class="material-symbols-outlined">more_vert</span>
              </summary>
              <div class="pane-toolbar-menu-content" role="menu" aria-label="Agent 映射更多操作">
                <button type="button" @click="refreshAll" class="pane-toolbar-menu-item">
                  <span class="material-symbols-outlined">refresh</span>
                  刷新数据
                </button>
              </div>
            </details>
          </div>
          <span
            class="pane-toolbar-chip"
            :class="{ 'pane-toolbar-chip--active': mapDirty }"
            :title="mapDirty ? '映射未保存' : '映射已同步'"
            :aria-label="mapDirty ? '映射未保存' : '映射已同步'"
          >
            {{ mapDirty ? '映射未保存' : '映射已同步' }}
          </span>
        </div>
      </template>

      <template #left-collapsed>
        <div class="collapsed-list">
          <button
            v-for="entry in agentMap"
            :key="entry.localId"
            type="button"
            class="collapsed-item"
            :title="entry.name || entry.file"
            @click="selectAgentFile(resolveAgentFileName(entry.file))"
          >
            <span class="collapsed-avatar">{{ (entry.name || entry.file || 'A').slice(0, 1).toUpperCase() }}</span>
          </button>
          <div v-if="agentMap.length === 0" class="collapsed-empty">
            <span class="material-symbols-outlined">smart_toy</span>
          </div>
        </div>
      </template>

      <template #left-content>
        <div class="agent-map-list">
          <div
            v-for="(entry, index) in agentMap"
            :key="entry.localId"
            class="agent-map-entry card"
          >
            <!-- 第一层：头部标题栏 -->
            <div class="agent-entry-header">
              <span class="material-symbols-outlined header-icon">smart_toy</span>
              <span class="header-title">{{ entry.name || "未命名 Agent" }}</span>
              <span class="header-status-badge" :class="doesFileExist(entry.file) ? 'active' : 'pending'">
                {{ doesFileExist(entry.file) ? '已绑定' : '待绑定' }}
              </span>
            </div>

            <!-- 第二层：中间输入配置 (PC垂直，移动端并排对齐) -->
            <div class="agent-entry-fields">
              <div class="agent-entry-row">
                <label>Agent 名称:</label>
                <input
                  v-model="entry.name"
                  type="text"
                  placeholder="输入 Agent 名称"
                />
              </div>

              <div class="agent-entry-row">
                <label>关联文件:</label>
                <input
                  v-model="entry.file"
                  :list="agentFilesDatalistId"
                  type="text"
                  class="file-input"
                  :disabled="isLoadingFiles"
                  placeholder="选择或输入文件名"
                  @blur="normalizeEntryFile(entry)"
                />
              </div>
            </div>

            <!-- 提示信息区域 (跨列独占一行) -->
            <div class="agent-entry-hints">
              <span v-if="isLoadingFiles" class="loading-hint">
                <span class="material-symbols-outlined spinning">sync</span>
                加载文件列表中...
              </span>

              <span
                v-else-if="entry.file"
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

            <!-- 第三层：操作动作按钮组 -->
            <div class="agent-entry-actions">
              <button
                @click="createAndBindAgentFile(entry)"
                :disabled="!canCreateAgentFile(entry.file)"
                class="btn-primary btn-sm btn-sm-touch"
              >
                <span class="material-symbols-outlined">note_add</span>
                创建并绑定
              </button>
              <button
                @click="selectAgentFile(resolveAgentFileName(entry.file))"
                :disabled="!doesFileExist(entry.file)"
                class="btn-secondary btn-sm btn-sm-touch"
              >
                <span class="material-symbols-outlined">edit</span>
                编辑文件
              </button>
              <button
                @click="removeAgentEntry(index)"
                class="btn-danger btn-sm btn-sm-touch"
              >
                <span class="material-symbols-outlined">delete</span>
                删除
              </button>
            </div>
          </div>

          <div v-if="agentMap.length === 0" class="empty-state">
            <span class="material-symbols-outlined">smart_toy</span>
            <p>暂无 Agent 映射</p>
            <button @click="addAgentEntry" class="btn-primary">
              添加第一个 Agent
            </button>
          </div>
        </div>
      </template>

      <template #right-actions>
        <div v-if="editingFile" class="pane-toolbar pane-toolbar--right">
          <div class="pane-toolbar-main">
            <button
              type="button"
              @click="openDiarySyntaxEditor"
              class="btn-secondary btn-sm btn-sm-touch"
              aria-label="打开日记本语法编辑器"
              title="日记本语法编辑器"
            >
              <span class="material-symbols-outlined">auto_fix_high</span>
              日记本语法编辑器
            </button>
            <button
              type="button"
              @click="saveAgentFile"
              :disabled="!fileDirty || isSavingFile"
              class="btn-success btn-sm btn-sm-touch"
            >
              <span class="material-symbols-outlined" :class="{ spinning: isSavingFile }">{{ isSavingFile ? "sync" : "save" }}</span>
              {{ isSavingFile ? "保存中…" : fileDirty ? "保存文件" : "已保存" }}
            </button>
          </div>
        </div>
      </template>

      <template #right-content>
        <div class="agent-file-editor">
          <div class="agent-editor-controls">
            <span class="editing-file-display">
              <span class="material-symbols-outlined">description</span>
              {{ editingFile || "未选择文件" }}
              <span v-if="fileDirty" class="dirty-indicator">（未保存）</span>
            </span>
          </div>
          <textarea
            v-model="fileContent"
            spellcheck="false"
            rows="20"
            placeholder="从左侧选择一个 Agent 以编辑其关联的 .txt / .md 文件…"
            class="file-content-editor"
          ></textarea>
          <span
            v-if="fileStatusMessage"
            :class="['status-message', fileStatusType]"
          >
            {{ fileStatusMessage }}
          </span>
        </div>
      </template>
    </DualPaneEditor>

    <datalist :id="agentFilesDatalistId">
      <option v-for="file in availableFiles" :key="file" :value="file">
        {{ file }}
      </option>
    </datalist>

    <DiarySyntaxEditorModal
      v-model="isDiarySyntaxEditorOpen"
      @insert="insertDiarySyntax"
    />

    <span
      v-if="statusMessage"
      :class="['status-message', 'floating-status', statusType]"
    >
      {{ statusMessage }}
    </span>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { agentApi } from "@/api";
import DualPaneEditor from "@/components/DualPaneEditor.vue";
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
const isSavingMap = ref(false);
const isSavingFile = ref(false);
const initialAgentMapSnapshot = ref("[]");
const isDiarySyntaxEditorOpen = ref(false);

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

  await Promise.all([loadAvailableFiles(), loadAgentMap()]);
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
  void Promise.all([loadAvailableFiles(), loadAgentMap()]);
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
.collapsed-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.collapsed-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--tertiary-bg);
  color: var(--secondary-text);
  cursor: pointer;
  padding: 0;
}

.collapsed-avatar {
  font-size: var(--font-size-helper);
  font-weight: 700;
  color: inherit;
}

.collapsed-empty {
  color: var(--secondary-text);
}

.agent-files-page {
  --dual-pane-height: calc(var(--app-viewport-height, 100vh) - 260px);
  --dual-pane-min-height: 420px;
}

.agent-files-page :deep(.pane-right .pane-content) {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.agent-map-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.agent-map-entry {
  padding: var(--space-4);
}

.agent-entry-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.agent-entry-row label {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  font-weight: 500;
}

.agent-entry-row input,
.agent-entry-row select {
  width: 100%;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-family: inherit;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.agent-entry-row input {
  padding-right: 12px;
  cursor: text;
}

.agent-entry-row input:hover,
.agent-entry-row select:hover {
  border-color: var(--highlight-text);
}

.agent-entry-row input:focus-visible,
.agent-entry-row select:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 2px var(--primary-color-translucent);
}

.agent-entry-row input:focus:not(:focus-visible),
.agent-entry-row select:focus:not(:focus-visible) {
  border-color: var(--highlight-text);
}

.agent-entry-row input::placeholder {
  color: var(--secondary-text);
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
  margin-top: 2px;
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
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: 8px;
}

.agent-file-editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.agent-editor-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  padding: 12px;
  background: var(--tertiary-bg);
  border-radius: var(--radius-sm);
}

.editing-file-display {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--secondary-text);
  font-size: var(--font-size-body);
  font-weight: 500;
}

.editing-file-display .material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
}

.dirty-indicator {
  color: var(--highlight-text);
  font-size: var(--font-size-helper);
}

.file-content-editor {
  flex: 1;
  width: 100%;
  min-height: 240px;
  resize: none;
  padding: 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  line-height: 1.6;
  font-family: "Consolas", "Monaco", monospace;
}

.file-content-editor:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-color: var(--highlight-text);
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: 12px;
  padding: 12px;
  background: var(--tertiary-bg);
  border-radius: var(--radius-sm);
}

/* .empty-state 已在全局 layout.css 中统一定义 */

.floating-status {
  position: fixed;
  right: 30px;
  bottom: 30px;
  z-index: 1000;
  padding: 12px 20px;
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-lg);
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

/* 卡片三层架构默认基础类名 (PC端布局) */
.agent-entry-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px dashed var(--border-color, rgba(0, 0, 0, 0.08));
}

.header-icon {
  color: var(--highlight-text, #00f0ff);
  font-size: 18px !important;
}

.header-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--primary-text);
}

.header-status-badge {
  margin-left: auto;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}

.header-status-badge.active {
  background: rgba(46, 204, 113, 0.1);
  color: var(--success-text, #2ecc71);
}

.header-status-badge.pending {
  background: rgba(241, 196, 15, 0.15);
  color: var(--warning-text, #f1c40f);
}

.agent-entry-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.agent-entry-hints {
  margin-top: 4px;
  margin-bottom: 12px;
  min-height: 16px;
}

/* 移动端精致化响应式滑盖与底置 Segmented 胶囊导航 */
.mobile-tab-nav {
  display: none;
}

@media (max-width: 768px) {
  .description {
    margin-bottom: var(--space-3) !important;
  }

  /* 根据 activeTab 完全隐藏另一侧，保障单屏100%全景视图 */
  .agent-dual-pane.mobile-view-list :deep(.pane-right) {
    display: none !important;
  }

  .agent-dual-pane.mobile-view-editor :deep(.pane-left) {
    display: none !important;
  }

  /* 消除分割线 */
  .agent-dual-pane :deep(.split-handle) {
    display: none !important;
  }

  .agent-dual-pane.mobile-view-list :deep(.pane-left),
  .agent-dual-pane.mobile-view-editor :deep(.pane-right) {
    width: 100% !important;
    flex: 1 !important;
  }

  /* 智能体卡片移动端极简化去投影阴影，完全不强写 background，使其自适应、天然继承 PC 端全局 .card 已有暗色模式/浅色模式底色 */
  .agent-map-entry.card {
    border: 1px solid var(--border-color, rgba(0, 0, 0, 0.08)) !important;
    box-shadow: none !important;
    border-radius: 8px;
    padding: var(--space-3) !important;
  }

  /* 第二层：中间输入配置在移动端开启双列 Grid 水平对齐排布 */
  .agent-entry-fields {
    display: grid !important;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) !important;
    align-items: start;
  }

  .agent-entry-fields .agent-entry-row {
    margin-bottom: 0 !important;
  }

  .agent-entry-hints {
    margin-top: 8px;
    margin-bottom: 8px;
  }

  /* 操作按钮精致栅格排布，杜绝由于挤压造成的堆叠错位，降低误触 */
  .agent-entry-actions {
    display: grid !important;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-2) !important;
    margin-top: 12px;
  }

  /* 让删除按钮独占一整行，红底警示且醒目 */
  .agent-entry-actions button:last-child {
    grid-column: span 2;
  }

  .agent-file-editor {
    height: 100%;
  }

  .file-content-editor {
    height: 100%;
    min-height: 280px;
    background: var(--input-bg, #ffffff) !important; /* 完美兼容深色模式输入框背景 */
    color: var(--primary-text) !important;
    border: 1px solid var(--border-color, rgba(0, 0, 0, 0.08)) !important;
    border-radius: 8px;
  }

  /* 移动端底部极简悬浮胶囊 (iOS Segmented Control 质感) - 彻底消灭顶部滞空压迫感 */
  .mobile-tab-nav {
    display: flex !important;
    position: fixed !important;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999;
    background: rgba(245, 245, 247, 0.88) !important; /* 精致浅灰白半透明磨砂 */
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(0, 0, 0, 0.06) !important;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08); /* 优雅环境环境投影 */
    padding: 4px;
    gap: 4px;
    width: 220px; /* 固定精致小巧宽度 */
    border-radius: 30px;
    margin: 0 !important;
  }

  .mobile-tab-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 12px;
    border: none;
    background: transparent;
    color: var(--secondary-text, #555555);
    font-size: 13px;
    font-weight: 500;
    border-radius: 20px;
    cursor: pointer;
    position: relative;
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .mobile-tab-btn.active {
    background: #ffffff !important; /* 激活项采用纯白实体卡片滑块 */
    color: #4a4a4a !important; /* 彻底重构为高级莫灰色，不刺眼不辣眼 */
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    font-weight: 600;
  }

  /* 确保激活状态下的 SVG 图标也同步转为莫灰色，彻底消融刺眼高亮蓝 */
  .mobile-tab-btn.active .material-symbols-outlined {
    color: #4a4a4a !important;
  }

  .dirty-badge {
    width: 6px;
    height: 6px;
    background: var(--danger-text, #ff4a4a);
    border-radius: 50%;
    position: absolute;
    top: 8px;
    right: 12%;
  }

  /* 强力释放编辑大视口：顶部不再有 tab 占高，给编辑区域与输入法最广阔的空间 */
  .agent-files-page {
    --dual-pane-height: calc(var(--app-viewport-height, 100vh) - 150px);
  }
}

@media (max-width: 1024px) and (min-width: 769px) {
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
