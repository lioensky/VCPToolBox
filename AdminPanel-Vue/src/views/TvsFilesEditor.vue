<template>
  <section class="config-section active-section tvs-files-editor-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <p class="tvs-page-summary">
          管理 TVS 变量文件，每行一个 <code>KEY=VALUE</code> 对。
        </p>
        <UiBadge :variant="isDirty ? 'warning' : 'success'">
          {{ isDirty ? '未保存' : '已同步' }}
        </UiBadge>
        <UiButton variant="outline" size="lg" :loading="loadingFiles" @click="reloadFiles">
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
        <UiButton variant="outline" size="lg" :disabled="isCreating" @click="beginCreateFile">
          <template #leading>
            <span class="material-symbols-outlined">add</span>
          </template>
          新建
        </UiButton>
        <UiButton
          variant="primary"
          size="lg"
          :disabled="!selectedFile || !isDirty"
          :title="selectedFile ? '保存 (Ctrl+S)' : ''"
          @click="saveFile"
        >
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          保存
        </UiButton>
      </UiPageActions>
    </Teleport>

    <div class="tvs-files-editor">
      <aside class="tvs-console" aria-label="变量文件列表">
        <div class="tvs-search">
          <span class="material-symbols-outlined search-icon">search</span>
          <UiInput
            id="tvs-file-search-input"
            v-model="searchQuery"
            type="search"
            class="tvs-search-input"
            placeholder="搜索变量文件…"
          />
          <UiIconButton v-if="searchQuery" class="search-clear" label="清除搜索" title="清除" @click="searchQuery = ''">
            <span class="material-symbols-outlined">close</span>
          </UiIconButton>
        </div>

        <div v-if="isCreating" class="tvs-new-file">
          <UiInput
            id="tvs-new-file-input"
            ref="newFileInputRef"
            v-model="newFileName"
            type="text"
            placeholder="文件名（自动补 .txt）"
            @keydown.enter.prevent="confirmCreateFile"
            @keydown.esc.prevent="cancelCreateFile"
          />
          <div class="tvs-new-file__actions">
            <UiButton variant="primary" size="sm" @click="confirmCreateFile">创建</UiButton>
            <UiButton variant="outline" size="sm" @click="cancelCreateFile">取消</UiButton>
          </div>
          <p v-if="createError" class="tvs-new-file__error">{{ createError }}</p>
        </div>

        <UiEmptyState
          v-if="loadingFiles"
          title="正在加载文件列表…"
          description="请稍候，面板正在读取 TVS 变量文件。"
        >
          <template #icon>
            <span class="material-symbols-outlined spinning">progress_activity</span>
          </template>
        </UiEmptyState>

        <UiEmptyState
          v-else-if="files.length === 0"
          title="暂无变量文件"
          description="点击上方新建创建第一个 TVS 变量文件。"
        >
          <template #icon>
            <span class="material-symbols-outlined">edit_note</span>
          </template>
        </UiEmptyState>

        <UiEmptyState
          v-else-if="filteredFiles.length === 0"
          title="未找到匹配文件"
          :description="`未找到匹配「${searchQuery}」的文件。`"
        />

        <ul v-else class="tvs-file-list">
          <li v-for="file in filteredFiles" :key="file" class="tvs-file-list-item">
            <button
              type="button"
              :class="['tvs-file-row', { 'is-active': file === selectedFile }]"
              @click="requestSelectFile(file)"
            >
              <span class="material-symbols-outlined tvs-file-icon">description</span>
              <span class="tvs-file-name">{{ file }}</span>
              <span v-if="file === selectedFile && isDirty" class="tvs-file-dirty">未保存</span>
            </button>
          </li>
        </ul>
      </aside>

      <main class="tvs-editor-panel" aria-label="变量文件内容">
        <header class="tvs-editor__toolbar">
          <div class="tvs-editor__title">
            <span class="tvs-pane-label">变量文件内容</span>
            <span class="tvs-editor__filename">
              <span class="material-symbols-outlined">description</span>
              {{ selectedFile || "未选择文件" }}
            </span>
            <span v-if="selectedFile" class="tvs-editor__stats">
              {{ lineCount }} 行 · {{ fileContent.length }} 字符
            </span>
            <span v-if="selectedFile && validationWarnings.length > 0" class="tvs-editor__warning">
              {{ validationWarnings.length }} 处格式提示
            </span>
          </div>

          <div class="tvs-editor__actions">
            <UiBadge
              v-if="statusMessage"
              :variant="getStatusVariant(statusType)"
              class="tvs-status-badge"
              role="status"
              aria-live="polite"
            >
              {{ statusMessage }}
            </UiBadge>
            <UiButton variant="outline" size="sm" :disabled="!isDirty" @click="resetContent">
              撤销
            </UiButton>
            <UiButton variant="outline" size="sm" :disabled="!selectedFile" @click="copyContent">
              复制
            </UiButton>
            <UiButton variant="danger" size="sm" :disabled="!selectedFile" @click="deleteFile">
              删除文件
            </UiButton>
          </div>
        </header>

        <UiEmptyState
          v-if="!selectedFile"
          title="未选择文件"
          description="从左侧列表选择一个变量文件开始编辑，或新建一个文件。"
          class="tvs-editor__hint"
        >
          <template #icon>
            <span class="material-symbols-outlined">arrow_back</span>
          </template>
        </UiEmptyState>

        <div v-else class="tvs-editor__workspace">
          <UiTextarea
            id="tvs-file-content-editor"
            v-model="fileContent"
            class="tvs-editor__textarea"
            resize="none"
            spellcheck="false"
            placeholder="# 注释以 # 开头&#10;KEY=VALUE"
            @keydown="handleEditorKeydown"
          />

          <div class="tvs-editor__footer"></div>
        </div>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { tvsApi } from "@/api";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";
import { createLogger } from "@/utils/logger";

const logger = createLogger("TvsFilesEditor");

const FILENAME_PATTERN = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]+$/;
const STATUS_AUTO_CLEAR_MS = 4000;

const files = ref<string[]>([]);
const loadingFiles = ref(false);
const selectedFile = ref("");
const fileContent = ref("");
const originalContent = ref("");
const searchQuery = ref("");

const isCreating = ref(false);
const newFileName = ref("");
const createError = ref("");
const newFileInputRef = ref<InstanceType<typeof UiInput> | null>(null);

const statusMessage = ref("");
const statusType = ref<"info" | "success" | "error">("info");
let statusTimer: ReturnType<typeof setTimeout> | null = null;

const isDirty = computed(() => fileContent.value !== originalContent.value);

const filteredFiles = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return files.value;
  return files.value.filter((f) => f.toLowerCase().includes(q));
});

const lineCount = computed(() => {
  if (!fileContent.value) return 0;
  return fileContent.value.split("\n").length;
});

const validationWarnings = computed<string[]>(() => {
  if (!selectedFile.value || !fileContent.value) return [];
  const issues: string[] = [];
  const lines = fileContent.value.split("\n");
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      issues.push(`第 ${idx + 1} 行: 缺少 KEY=VALUE 格式`);
    }
  });
  return issues;
});

function setStatus(message: string, type: "info" | "success" | "error"): void {
  statusMessage.value = message;
  statusType.value = type;
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  if (type !== "error" && message) {
    statusTimer = setTimeout(() => {
      statusMessage.value = "";
    }, STATUS_AUTO_CLEAR_MS);
  }
}

function getStatusVariant(status: "info" | "success" | "error"): "info" | "success" | "danger" {
  return status === "error" ? "danger" : status;
}

function clearStatus(): void {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  statusMessage.value = "";
}

async function confirmDiscardIfDirty(action: string): Promise<boolean> {
  if (!isDirty.value) return true;
  return await askConfirm({
    message: `当前文件「${selectedFile.value}」有未保存的更改，确定要${action}吗？`,
    danger: true,
    confirmText: "放弃更改",
  });
}

async function reloadFiles(): Promise<void> {
  loadingFiles.value = true;
  try {
    files.value = await tvsApi.getTvsFiles({
      showLoader: false,
      loadingKey: "tvs-files.list.load",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load files", error);
    showMessage(`加载文件列表失败：${msg}`, "error");
  } finally {
    loadingFiles.value = false;
  }
}

async function requestSelectFile(file: string): Promise<void> {
  if (file === selectedFile.value) return;
  if (!(await confirmDiscardIfDirty("切换文件"))) return;
  await loadFileContent(file);
}

async function loadFileContent(file: string): Promise<void> {
  try {
    const content = await tvsApi.getTvsFileContent(file, {
      showLoader: false,
      loadingKey: "tvs-files.content.load",
    });
    selectedFile.value = file;
    fileContent.value = content;
    originalContent.value = content;
    clearStatus();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load file", error);
    showMessage(`加载文件失败：${msg}`, "error");
  }
}

async function saveFile(): Promise<void> {
  if (!selectedFile.value || !isDirty.value) return;

  if (validationWarnings.value.length > 0) {
    const ok = await askConfirm({
      message: `检测到 ${validationWarnings.value.length} 处可能的格式问题（非 KEY=VALUE 行）。仍要保存吗？`,
      confirmText: "仍然保存",
    });
    if (!ok) return;
  }

  try {
    await tvsApi.saveTvsFile(selectedFile.value, fileContent.value, {
      loadingKey: "tvs-files.content.save",
    });
    originalContent.value = fileContent.value;
    setStatus(`文件「${selectedFile.value}」已保存`, "success");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to save file", error);
    setStatus(`保存失败：${msg}`, "error");
    showMessage(`保存失败：${msg}`, "error");
  }
}

function resetContent(): void {
  if (!isDirty.value) return;
  fileContent.value = originalContent.value;
  setStatus("已撤销当前更改", "info");
}

async function copyContent(): Promise<void> {
  if (!selectedFile.value) return;
  if (!navigator.clipboard?.writeText) {
    showMessage("当前环境不支持剪贴板写入", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(fileContent.value);
    setStatus("已复制到剪贴板", "success");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to copy", error);
    setStatus(`复制失败：${msg}`, "error");
  }
}

async function deleteFile(): Promise<void> {
  if (!selectedFile.value) return;

  const targetFile = selectedFile.value;
  const ok = await askConfirm({
    message: `确定要删除文件「${targetFile}」吗？${isDirty.value ? " 当前有未保存更改，" : ""}此操作不可恢复。`,
    danger: true,
    confirmText: "删除文件",
  });
  if (!ok) return;

  try {
    await tvsApi.deleteTvsFile(targetFile, {
      loadingKey: "tvs-files.content.delete",
    });

    await reloadFiles();

    if (files.value.length > 0) {
      await loadFileContent(files.value[0]);
    } else {
      selectedFile.value = "";
      fileContent.value = "";
      originalContent.value = "";
    }

    setStatus(`文件「${targetFile}」已删除`, "success");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to delete file", error);
    setStatus(`删除失败：${msg}`, "error");
    showMessage(`删除失败：${msg}`, "error");
  }
}

function handleEditorKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveFile();
  }
}

function beginCreateFile(): void {
  isCreating.value = true;
  newFileName.value = "";
  createError.value = "";
  void nextTick(() => {
    newFileInputRef.value?.focus();
  });
}

function cancelCreateFile(): void {
  isCreating.value = false;
  newFileName.value = "";
  createError.value = "";
}

function normalizeNewFileName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withExt = /\.txt$/i.test(trimmed) ? trimmed : `${trimmed}.txt`;
  if (!FILENAME_PATTERN.test(withExt)) return null;
  if (withExt.includes("..")) return null;
  return withExt;
}

async function confirmCreateFile(): Promise<void> {
  const name = normalizeNewFileName(newFileName.value);
  if (!name) {
    createError.value = "文件名只能包含字母、数字、中文、下划线、点、短横线";
    return;
  }
  if (files.value.includes(name)) {
    createError.value = `文件「${name}」已存在`;
    return;
  }
  if (!(await confirmDiscardIfDirty("新建文件"))) return;

  try {
    await tvsApi.saveTvsFile(name, "", {
      loadingKey: "tvs-files.content.save",
    });
    cancelCreateFile();
    await reloadFiles();
    await loadFileContent(name);
    setStatus(`已创建「${name}」`, "success");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to create file", error);
    createError.value = `创建失败：${msg}`;
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (isDirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}

watch(selectedFile, () => {
  clearStatus();
});

onMounted(() => {
  void reloadFiles();
  window.addEventListener("beforeunload", handleBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", handleBeforeUnload);
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
});

onBeforeRouteLeave(async () => {
  if (!isDirty.value) return true;
  return await askConfirm({
    message: `文件「${selectedFile.value}」有未保存的更改，确定要离开吗？`,
    danger: true,
    confirmText: "放弃更改",
  });
});
</script>

<style scoped>
.tvs-files-editor-page {
  min-height: 0;
}

.tvs-page-summary {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.tvs-page-summary code {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 var(--space-1);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--primary-text) 4%, transparent);
  color: var(--primary-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-helper);
}

.tvs-files-editor {
  --tvs-panel-height: calc(
    var(--app-viewport-height, 100vh) -
    var(--app-top-bar-height, 60px) -
    var(--space-6)
  );
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: stretch;
  min-height: min(680px, var(--tvs-panel-height));
}

.tvs-console,
.tvs-editor-panel {
  min-height: 0;
  height: var(--tvs-panel-height);
}

.tvs-console {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow: hidden;
}

.tvs-search {
  position: relative;
  flex-shrink: 0;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  z-index: 1;
  transform: translateY(-50%);
  color: var(--secondary-text);
  font-size: 18px !important;
  pointer-events: none;
}

.tvs-search-input {
  width: 100%;
  padding-left: 34px;
  padding-right: 34px;
}

.search-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}

.tvs-new-file {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
}

.tvs-new-file__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

.tvs-new-file__error {
  margin: 0;
  color: var(--danger-text);
  font-size: var(--font-size-helper);
}

.tvs-file-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.tvs-file-list-item {
  display: flex;
  padding: 0;
}

.tvs-file-row {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-height: 36px;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1.6%, transparent);
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.tvs-file-row:hover {
  background: color-mix(in srgb, var(--accent-bg) 52%, transparent);
}

.tvs-file-row.is-active {
  border-color: color-mix(in srgb, var(--highlight-text) 46%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 8%, transparent);
}

.tvs-file-icon {
  flex-shrink: 0;
  color: var(--secondary-text);
  font-size: 18px !important;
}

.tvs-file-row.is-active .tvs-file-icon {
  color: color-mix(in srgb, var(--highlight-text) 78%, var(--secondary-text));
}

.tvs-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--primary-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-helper);
  font-weight: 500;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tvs-file-dirty {
  flex-shrink: 0;
  color: var(--warning-color);
  font-size: var(--font-size-caption);
  font-weight: 650;
}

.tvs-editor-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 1.4%, transparent);
}

.tvs-editor__toolbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 48px;
  padding: 0 var(--space-4);
}

.tvs-editor__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.tvs-pane-label {
  color: var(--primary-text);
  font-size: var(--font-size-emphasis);
  font-weight: 650;
}

.tvs-editor__filename {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-1);
  color: var(--secondary-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-helper);
}

.tvs-editor__filename .material-symbols-outlined {
  color: var(--secondary-text);
  font-size: 16px !important;
}

.tvs-editor__actions {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.tvs-editor__hint {
  flex: 1;
  justify-content: center;
  min-height: 0;
}

.tvs-editor__workspace {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  overflow: hidden;
}

.tvs-editor__textarea {
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  max-height: none;
  border: 0;
  border-radius: 0;
  background: transparent;
  font-family: var(--font-mono);
  font-size: var(--font-size-body);
  line-height: 1.72;
  tab-size: 4;
}

.tvs-editor__footer {
  display: none;
}

.tvs-editor__stats {
  color: var(--secondary-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-helper);
}

.tvs-editor__warning {
  color: var(--warning-color);
  font-weight: 600;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1024px) {
  .tvs-files-editor {
    grid-template-columns: 1fr;
  }

  .tvs-console,
  .tvs-editor-panel {
    height: auto;
  }

  .tvs-file-list {
    max-height: 320px;
  }

  .tvs-editor__textarea {
    min-height: 420px;
  }

  .tvs-editor__textarea {
    resize: vertical;
  }
}

@media (max-width: 768px) {
  .tvs-editor__toolbar {
    align-items: stretch;
    flex-direction: column;
    padding: var(--space-3);
  }

  .tvs-editor__actions {
    justify-content: stretch;
  }

  .tvs-editor__actions :deep(.ui-button) {
    flex: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinning,
  .tvs-file-row {
    transition: none;
    animation: none;
  }
}
</style>
