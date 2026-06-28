<template>
  <section class="config-section active-section tvs-files-editor-page">
    <p class="description">
      TVS 变量文件用于存储系统自定义变量，每行一个 <code>KEY=VALUE</code> 对。
    </p>

    <div class="tvs-files-editor" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
      <!-- 左侧：文件列表（操作台风格） -->
      <aside
        class="tvs-console card"
        :class="{ 'is-collapsed': sidebarCollapsed }"
        :aria-label="sidebarCollapsed ? '变量文件操作台（已折叠）' : '变量文件操作台'"
      >
        <template v-if="sidebarCollapsed">
          <div class="console-rail">
            <UiIconButton
              type="button"
              class="console-rail-toggle"
              label="展开操作台"
              title="展开操作台"
              @click="toggleSidebar"
            >
              <span class="material-symbols-outlined">left_panel_open</span>
            </UiIconButton>
            <div class="console-rail-divider"></div>
            <UiIconButton
              type="button"
              class="console-rail-icon"
              label="新建文件"
              title="新建文件"
              :disabled="isCreating"
              @click="beginCreateFile"
            >
              <span class="material-symbols-outlined">add</span>
            </UiIconButton>
            <UiIconButton
              v-for="file in filteredFiles.slice(0, 8)"
              :key="file"
              class="console-rail-icon"
              :active="file === selectedFile"
              :label="`打开变量文件 ${file}`"
              :title="file"
              @click="requestSelectFile(file)"
            >
              <span class="material-symbols-outlined">description</span>
            </UiIconButton>
          </div>
        </template>
        <template v-else>
          <div class="tvs-console__section">
            <span class="tvs-console__label">操作台</span>
            <div class="tvs-console__header">
              <h3>变量文件</h3>
              <div class="sidebar-header-meta">
                <span class="tvs-file-count">
                  {{ filteredFiles.length }}/{{ files.length }} 个
                </span>
                <UiIconButton
                  type="button"
                  class="console-rail-toggle"
                  label="折叠操作台"
                  title="折叠操作台"
                  @click="toggleSidebar"
                >
                  <span class="material-symbols-outlined">left_panel_close</span>
                </UiIconButton>
              </div>
            </div>
          </div>

          <div class="tvs-console__section">
            <UiField label="搜索筛选" for-id="tvs-file-search-input" size="sm">
              <div class="tvs-search-box">
                <UiInput
                  id="tvs-file-search-input"
                  v-model="searchQuery"
                  type="search"
                  class="tvs-search-input"
                  placeholder="按文件名筛选..."
                />
                <UiButton
                  v-if="searchQuery"
                  variant="ghost"
                  size="sm"
                  aria-label="清空筛选"
                  @click="searchQuery = ''"
                >
                  清空
                </UiButton>
              </div>
            </UiField>
          </div>

          <div class="tvs-console__actions">
            <UiIconButton
              type="button"
              class="tvs-refresh-button"
              size="sm"
              label="刷新文件列表"
              title="刷新"
              :disabled="loadingFiles"
              @click="reloadFiles"
            >
              <span class="material-symbols-outlined">refresh</span>
            </UiIconButton>
            <UiButton
              variant="outline"
              size="sm"
              :disabled="isCreating"
              @click="beginCreateFile"
            >
              新建
            </UiButton>
          </div>

          <div v-if="isCreating" class="tvs-console__section tvs-new-file">
            <UiField label="新建文件" for-id="tvs-new-file-input" size="sm">
              <div class="tvs-search-box">
                <UiInput
                  id="tvs-new-file-input"
                  ref="newFileInputRef"
                  v-model="newFileName"
                  type="text"
                  class="tvs-search-input"
                  placeholder="文件名（自动补 .txt）"
                  @keydown.enter.prevent="confirmCreateFile"
                  @keydown.esc.prevent="cancelCreateFile"
                />
              </div>
            </UiField>
            <div class="tvs-new-file__actions">
              <UiButton
                variant="primary"
                size="sm"
                block
                @click="confirmCreateFile"
              >
                创建
              </UiButton>
              <UiButton
                variant="outline"
                size="sm"
                block
                @click="cancelCreateFile"
              >
                取消
              </UiButton>
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
            <li
              v-for="file in filteredFiles"
              :key="file"
              class="tvs-file-list-item"
            >
              <button
                type="button"
                :class="['tvs-file-row', { 'is-active': file === selectedFile }]"
                @click="requestSelectFile(file)"
              >
                <span class="material-symbols-outlined tvs-file-icon">description</span>
                <span class="tvs-file-name">{{ file }}</span>
                <span
                  v-if="file === selectedFile && isDirty"
                  class="tvs-file-dirty"
                  title="有未保存更改"
                  aria-label="有未保存更改"
                >●</span>
              </button>
            </li>
          </ul>
        </template>
      </aside>

      <!-- 右侧：编辑器 -->
      <main class="tvs-editor-panel">
        <div class="tvs-editor card">
          <div class="tvs-editor__toolbar">
            <div class="tvs-editor__title">
              <span class="material-symbols-outlined tvs-editor__title-icon">edit_note</span>
              <div class="tvs-editor__title-main">
                <h3>编辑内容</h3>
                <div class="tvs-editor__meta">
                  <span class="tvs-editor__filename">
                    {{ selectedFile || "未选择文件" }}
                  </span>
                  <UiBadge v-if="isDirty" variant="warning">未保存</UiBadge>
                </div>
              </div>
            </div>

            <div class="tvs-editor__actions">
              <UiButton
                variant="outline"
                size="sm"
                :disabled="!isDirty"
                @click="resetContent"
              >
                撤销更改
              </UiButton>
              <UiButton
                variant="outline"
                size="sm"
                :disabled="!selectedFile"
                @click="copyContent"
              >
                复制
              </UiButton>
              <UiButton
                variant="danger"
                size="sm"
                :disabled="!selectedFile"
                @click="deleteFile"
              >
                删除
              </UiButton>
              <UiButton
                variant="primary"
                :disabled="!selectedFile || !isDirty"
                :title="selectedFile ? '保存 (Ctrl+S)' : ''"
                @click="saveFile"
              >
                保存
              </UiButton>
            </div>
          </div>

          <UiBadge
            v-if="statusMessage"
            :variant="getStatusVariant(statusType)"
            class="tvs-status-badge"
            role="status"
            aria-live="polite"
          >
            {{ statusMessage }}
          </UiBadge>

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

            <div class="tvs-editor__footer">
              <span class="tvs-editor__stats">
                {{ lineCount }} 行 · {{ fileContent.length }} 字符
              </span>
            </div>
          </div>
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
import UiField from "@/components/ui/UiField.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import { useConsoleCollapse } from "@/composables/useConsoleCollapse";
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

const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useConsoleCollapse(
  "tvs-files"
);

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
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tvs-files-editor-page > .description {
  margin: 0;
}

.tvs-files-editor-page > .description code {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 var(--space-2);
  background: color-mix(in srgb, var(--primary-text) 5%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--font-size-helper);
}

/* ── 双列布局（参考 .daily-notes-manager / VcptavernEditor 的本地 grid 定义；
      .dual-pane 是 VcptavernEditor 的 scoped 类，无法跨组件复用） ── */
.tvs-files-editor {
  --tvs-panel-viewport-gap: var(--space-4);
  --tvs-panel-height: calc(
    var(--app-viewport-height, 100vh) -
    var(--app-top-bar-height, 60px) -
    var(--tvs-panel-viewport-gap) * 2
  );
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.tvs-files-editor.is-sidebar-collapsed {
  grid-template-columns: 56px minmax(0, 1fr);
}

.sidebar-header-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

/* ── 左侧：操作台（参考 FolderList / VcptavernEditor 的控制台模式） ── */
.tvs-console {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  position: sticky;
  top: var(--tvs-panel-viewport-gap);
  align-self: start;
  height: var(--tvs-panel-height);
  overflow: hidden;
  padding: var(--space-5);
  border-radius: var(--radius-xl);
  transition: padding var(--transition-fast);
}

.tvs-console.is-collapsed {
  padding: var(--space-3) 0;
  gap: 0;
  align-items: center;
}

.tvs-console__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tvs-console__label {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.tvs-console__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.tvs-console__header h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
  color: var(--primary-text);
}

.tvs-file-count {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  font-weight: 500;
}

.tvs-search-box {
  display: flex;
  gap: var(--space-2);
}

.tvs-search-input {
  flex: 1;
  min-width: 0;
}

.tvs-console__actions {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-2);
  flex-shrink: 0;
}

.tvs-new-file__actions {
  display: flex;
  gap: var(--space-2);
}

.tvs-new-file__error {
  margin: 0;
  color: var(--danger-text);
  font-size: var(--font-size-helper);
}

.tvs-file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.tvs-file-list-item {
  display: flex;
  padding: 0;
}

.tvs-file-row {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  min-height: 36px;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.tvs-file-row:hover {
  background: var(--accent-bg);
}

.tvs-file-row.is-active {
  border-color: color-mix(in srgb, var(--highlight-text) 52%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 10%, transparent);
}

.tvs-file-icon {
  font-size: var(--font-size-emphasis) !important;
  color: var(--secondary-text);
  flex-shrink: 0;
}

.tvs-file-row.is-active .tvs-file-icon {
  color: color-mix(in srgb, var(--highlight-text) 78%, var(--secondary-text));
}

.tvs-file-name {
  flex: 1;
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--primary-text);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tvs-file-row.is-active .tvs-file-name {
  font-weight: 600;
}

.tvs-file-dirty {
  color: var(--warning-color);
  font-size: var(--font-size-helper);
  line-height: 1;
  flex-shrink: 0;
}

/* ── 右侧：编辑器 ── */
.tvs-editor-panel {
  min-width: 0;
  display: flex;
}

.tvs-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  height: var(--tvs-panel-height);
  overflow: hidden;
  padding: var(--space-5);
  border-radius: var(--radius-xl);
}

.tvs-editor__toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-color);
}

.tvs-editor__title {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}

.tvs-editor__title-icon {
  color: var(--highlight-text);
  font-size: var(--font-size-display) !important;
  flex-shrink: 0;
}

.tvs-editor__title-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}

.tvs-editor__title-main h3 {
  margin: 0;
  font-size: var(--font-size-title);
  color: var(--primary-text);
  line-height: 1.2;
}

.tvs-editor__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.tvs-editor__filename {
  font-family: var(--font-mono);
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  padding: 2px 10px;
  background: var(--surface-overlay-soft);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  word-break: break-all;
}

.tvs-editor__actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.tvs-editor__hint {
  flex: 1;
  justify-content: center;
  min-height: 0;
}

.tvs-editor__workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow: hidden;
}

.tvs-editor__textarea {
  flex: 1;
  width: 100%;
  height: auto;
  min-height: 0;
}

.tvs-editor__textarea :deep(.ui-textarea) {
  height: 100%;
  max-height: none;
  min-height: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-body);
  line-height: 1.75;
  tab-size: 4;
  border-radius: var(--radius-md);
}

.tvs-editor__footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  flex-wrap: wrap;
  border-top: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
  border-radius: var(--radius-md);
}

.tvs-editor__stats {
  font-family: var(--font-mono);
}

@media (max-width: 1024px) {
  .tvs-files-editor,
  .tvs-files-editor.is-sidebar-collapsed {
    grid-template-columns: 1fr;
  }

  .tvs-console {
    position: static;
    height: auto;
    max-height: none;
  }

  .tvs-file-list {
    max-height: 320px;
  }

  .tvs-console,
  .tvs-editor {
    padding: var(--space-4);
  }

  .tvs-editor {
    height: auto;
    overflow: visible;
  }

  .tvs-editor__textarea {
    height: auto;
    min-height: 360px;
  }

  .tvs-editor__textarea :deep(.ui-textarea) {
    min-height: 360px;
    resize: vertical;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tvs-console,
  .tvs-file-row {
    transition: none;
  }
}

@media (max-width: 768px) {
  .tvs-editor__toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .tvs-editor__actions {
    justify-content: stretch;
  }

  .tvs-editor__actions :deep(.ui-button) {
    flex: 1;
  }
}
</style>
