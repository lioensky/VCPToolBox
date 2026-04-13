<template>
  <section class="config-section active-section agent-files-page">
    <p class="description">
      管理 Agent 的定义名称与对应的 `.txt` / `.md` 文件。你可以在这里添加、删除和修改
      Agent 映射，并直接编辑关联的文本文件。
    </p>

    <DualPaneEditor
      left-title="Agent 映射表"
      right-title="Agent 文件内容"
      :initial-left-width="450"
      :min-left-width="350"
      :max-left-width="600"
    >
      <template #left-actions>
        <div class="header-actions">
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
            class="btn-primary btn-sm btn-sm-touch"
            :disabled="isSavingMap"
            aria-label="保存映射表"
            title="保存映射表"
          >
            <span
              class="material-symbols-outlined"
              :class="{ spinning: isSavingMap }"
              aria-hidden="true"
            >{{ isSavingMap ? "sync" : "save" }}</span>
            {{ isSavingMap ? "保存中…" : "保存" }}
          </button>
        </div>
      </template>

      <template #left-content>
        <div class="agent-map-list">
          <div
            v-for="(entry, index) in agentMap"
            :key="entry.localId"
            class="agent-map-entry card"
          >
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
                placeholder="输入新文件名，或选择已有文件"
                @blur="normalizeEntryFile(entry)"
              />

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

      <template #right-content>
        <div class="agent-file-editor">
          <div class="agent-editor-controls">
            <span class="editing-file-display">
              <span class="material-symbols-outlined">description</span>
              {{ editingFile || "未选择文件" }}
            </span>
          </div>
          <textarea
            v-model="fileContent"
            spellcheck="false"
            rows="20"
            placeholder="从左侧选择一个 Agent 以编辑其关联的 .txt / .md 文件…"
            class="file-content-editor"
          ></textarea>
          <div class="editor-actions">
            <button
              type="button"
              @click="saveAgentFile"
              :disabled="!editingFile || isSavingFile"
              class="btn-primary"
            >
              <span
                class="material-symbols-outlined"
                :class="{ spinning: isSavingFile }"
              >{{ isSavingFile ? "sync" : "save" }}</span>
              {{ isSavingFile ? "保存中…" : "保存文件内容" }}
            </button>
            <span
              v-if="fileStatusMessage"
              :class="['status-message', fileStatusType]"
            >
              {{ fileStatusMessage }}
            </span>
          </div>
        </div>
      </template>
    </DualPaneEditor>

    <datalist :id="agentFilesDatalistId">
      <option v-for="file in availableFiles" :key="file" :value="file">
        {{ file }}
      </option>
    </datalist>

    <span
      v-if="statusMessage"
      :class="['status-message', 'floating-status', statusType]"
    >
      {{ statusMessage }}
    </span>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { agentApi } from "@/api";
import DualPaneEditor from "@/components/DualPaneEditor.vue";
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

const agentMap = ref<AgentMapDraft[]>([]);
const availableFiles = ref<string[]>([]);
const isLoadingFiles = ref(false);
const statusMessage = ref("");
const statusType = ref<AgentFilesStatusType>("info");
const editingFile = ref("");
const fileContent = ref("");
const fileStatusMessage = ref("");
const fileStatusType = ref<AgentFilesStatusType>("info");
const isSavingMap = ref(false);
const isSavingFile = ref(false);

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
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load agent map:", errorMessage);
    showMessage(`Failed to load agent map: ${errorMessage}`, "error");
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

function removeAgentEntry(index: number): void {
  if (confirm("确定删除这条 Agent 映射吗？")) {
    agentMap.value.splice(index, 1);
  }
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

  editingFile.value = fileName;
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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`Failed to load file: ${errorMessage}`, "error");
  }
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

onMounted(() => {
  void Promise.all([loadAvailableFiles(), loadAgentMap()]);
});
</script>

<style scoped>
.header-actions {
  display: flex;
  gap: var(--space-2);
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

/* 本页按钮兜底：确保保存按钮在任意主题/浏览器下都有可见边框和背景 */
.agent-files-page .btn-primary,
.agent-files-page .btn-success {
  border-width: 1px;
  border-style: solid;
}

.agent-files-page .btn-primary {
  background: #1f6feb;
  border-color: #1f6feb;
  color: #fff;
  background: var(--button-bg);
  border-color: var(--button-bg);
  color: var(--on-accent-text);
}

.agent-files-page .btn-success {
  background: #1e8e3e;
  border-color: #1e8e3e;
  color: #fff;
  background: var(--success-color);
  border-color: var(--success-color);
  color: var(--on-accent-text);
}

.agent-files-page .btn-primary:hover {
  background: #1967d2;
  border-color: #1967d2;
  background: var(--button-hover-bg);
  border-color: var(--button-hover-bg);
}

.agent-files-page .btn-success:hover {
  background: #188038;
  border-color: #188038;
  background: var(--success-hover-bg);
  border-color: var(--success-hover-bg);
}

.agent-files-page .btn-primary:focus-visible,
.agent-files-page .btn-success:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
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

@media (max-width: 1024px) {
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
