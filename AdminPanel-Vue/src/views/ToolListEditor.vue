<template>
  <section class="config-section active-section tool-list-editor-page">
    <p class="description">快速制作工具列表配置文件，用于 Agent 的提示词中。</p>

    <div class="tool-list-editor">
      <ToolSelectionPanel
        :loading="loading"
        :all-tools-count="allTools.length"
        :filtered-tools="filteredTools"
        :selected-tools="selectedTools"
        :tool-descriptions="toolDescriptions"
        :search-query="searchInput"
        :searching="searching"
        :is-search-composing="isSearchComposing"
        :show-selected-only="showSelectedOnly"
        @update:searchQuery="onSearchInput"
        @clearSearch="clearSearch"
        @searchCompositionStart="onSearchCompositionStart"
        @searchCompositionEnd="onSearchCompositionEnd"
        @update:showSelectedOnly="showSelectedOnly = $event"
        @toggleTool="toggleTool"
        @selectAll="selectAll"
        @deselectAll="deselectAll"
        @editDescription="editDescription"
        @refreshTools="refreshTools"
      />

      <ToolConfigPreviewPanel
        :available-configs="availableConfigs"
        :selected-config="selectedConfig"
        :config-name-input="configNameInput"
        :config-name-error="configNameValidationError"
        :include-header="includeHeader"
        :include-examples="includeExamples"
        :preview-content="previewContent"
        :has-selection="selectedTools.size > 0"
        :is-dirty="isDirty"
        :saving="saving"
        :deleting="deleting"
        :exporting="exporting"
        :copying="copying"
        :loading-config="loadingConfig"
        :missing-tool-count="missingToolIds.length"
        @update:selectedConfig="onConfigSelectionChange"
        @update:configNameInput="configNameInput = $event"
        @deleteConfig="deleteConfig"
        @saveConfig="saveConfig"
        @exportTxt="exportTxt"
        @clearMissingTools="clearMissingTools"
        @update:includeHeader="includeHeader = $event"
        @update:includeExamples="includeExamples = $event"
        @copyPreview="copyPreview"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { toolListApi } from "@/api";
import { useDebounceFn } from "@/composables/useDebounceFn";
import { useLocalStorage } from "@/composables/useLocalStorage";
import type { Tool } from "@/features/tool-list/types";
import { askConfirm, askInput } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";
import { createLogger } from "@/utils/logger";
import {
  extractMissingToolIds,
  normalizeTools,
} from "./ToolListEditor/composables/useToolListData";
import {
  MAX_TOOL_DESCRIPTION_LENGTH,
  buildToolListPreview,
  clampToolDescription,
  createEditorStateFingerprint,
  normalizeToolDescriptionsForSave,
  validateToolConfigName,
} from "./ToolListEditor/composables/useToolListPreview";
import ToolSelectionPanel from "./ToolListEditor/ToolSelectionPanel.vue";
import ToolConfigPreviewPanel from "./ToolListEditor/ToolConfigPreviewPanel.vue";

const logger = createLogger("ToolListEditor");

const SEARCH_DEBOUNCE_MS = 180;
const PREVIEW_DEBOUNCE_MS = 100;

const loading = ref(true);
const allTools = ref<Tool[]>([]);
const selectedTools = shallowRef<Set<string>>(new Set());
const toolDescriptions = shallowRef<Record<string, string>>({});
const availableConfigs = ref<string[]>([]);
const selectedConfig = ref("");
const configNameInput = ref("");
const searchInput = ref("");
const searchQuery = ref("");
const searching = ref(false);
const isSearchComposing = ref(false);
const showSelectedOnly = ref(false);
const includeHeader = useLocalStorage<boolean>("tool-list.includeHeader", true);
const includeExamples = useLocalStorage<boolean>("tool-list.includeExamples", true);

const saving = ref(false);
const deleting = ref(false);
const exporting = ref(false);
const copying = ref(false);
const loadingConfig = ref(false);
const previewContent = ref("");
const dirtyBaseline = ref("");

const toolsById = computed(() => {
  const map = new Map<string, Tool>();
  allTools.value.forEach((tool) => {
    map.set(tool.uniqueId, tool);
  });
  return map;
});

const filteredTools = computed(() => {
  let tools = allTools.value;

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    tools = tools.filter((tool) =>
      (tool.searchText ?? `${tool.name} ${tool.pluginName} ${tool.description ?? ""}`.toLowerCase()).includes(query)
    );
  }

  if (showSelectedOnly.value) {
    tools = tools.filter((tool) => selectedTools.value.has(tool.uniqueId));
  }

  return tools;
});

const previewContentRaw = computed(() => {
  return buildToolListPreview(toolsById.value, selectedTools.value, toolDescriptions.value, {
    includeHeader: includeHeader.value,
    includeExamples: includeExamples.value,
  });
});

const configNameValidationError = computed(() => {
  const name = configNameInput.value.trim();
  if (!name) {
    return null;
  }
  return validateToolConfigName(name);
});

const missingToolIds = computed(() => {
  return extractMissingToolIds(allTools.value, selectedTools.value);
});

const currentFingerprint = computed(() => {
  return createEditorStateFingerprint({
    configName: configNameInput.value,
    selectedToolIds: selectedTools.value,
    toolDescriptions: toolDescriptions.value,
    includeHeader: includeHeader.value,
    includeExamples: includeExamples.value,
  });
});

const isDirty = computed(() => {
  if (!dirtyBaseline.value) {
    return false;
  }
  return currentFingerprint.value !== dirtyBaseline.value;
});

const applySearchQueryDebounced = useDebounceFn(
  (value: unknown) => {
    searchQuery.value = typeof value === "string" ? value.trim().toLowerCase() : "";
    searching.value = false;
  },
  { delay: SEARCH_DEBOUNCE_MS }
);

const applyPreviewDebounced = useDebounceFn(
  (value: unknown) => {
    previewContent.value = typeof value === "string" ? value : "";
  },
  { delay: PREVIEW_DEBOUNCE_MS }
);

watch(
  previewContentRaw,
  (value) => {
    applyPreviewDebounced(value);
  },
  { immediate: true }
);

function resetDirtyBaseline(): void {
  dirtyBaseline.value = currentFingerprint.value;
}

async function confirmDiscardIfDirty(actionLabel: string): Promise<boolean> {
  if (!isDirty.value) {
    return true;
  }

  return await askConfirm({
    title: "存在未保存更改",
    message: `当前配置有未保存更改，继续${actionLabel}会丢失这些修改，确定继续吗？`,
    danger: true,
    confirmText: "继续",
  });
}

function onSearchInput(value: string): void {
  searchInput.value = value;
  if (isSearchComposing.value) {
    return;
  }
  searching.value = true;
  applySearchQueryDebounced(value);
}

function onSearchCompositionStart(): void {
  isSearchComposing.value = true;
  searching.value = false;
  applySearchQueryDebounced.cancel();
}

function onSearchCompositionEnd(value: string): void {
  isSearchComposing.value = false;
  onSearchInput(value);
}

function clearSearch(): void {
  applySearchQueryDebounced.cancel();
  searchInput.value = "";
  searchQuery.value = "";
  searching.value = false;
}

function syncSelectedTools(mutator: (set: Set<string>) => void): void {
  const nextSet = new Set(selectedTools.value);
  mutator(nextSet);
  selectedTools.value = nextSet;
}

function syncDescriptions(mutator: (map: Record<string, string>) => void): void {
  const next = { ...toolDescriptions.value };
  mutator(next);
  toolDescriptions.value = next;
}

async function loadTools(options?: { forceRefresh?: boolean }): Promise<void> {
  try {
    loading.value = true;
    const toolList = await toolListApi.getTools(
      undefined,
      options?.forceRefresh ? { forceRefresh: true } : undefined
    );
    const normalized = normalizeTools(toolList);
    allTools.value = normalized.tools;

    if (normalized.fallbackIdCount > 0) {
      showMessage(
        `检测到 ${normalized.fallbackIdCount} 个工具缺少 uniqueId，已自动使用 plugin::name 回填。`,
        "warning"
      );
    }

    if (normalized.duplicateIds.length > 0) {
      showMessage(
        `检测到 ${normalized.duplicateIds.length} 个重复工具 ID，已自动忽略重复项。`,
        "warning"
      );
      logger.warn("Duplicate tool IDs ignored:", normalized.duplicateIds);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load tools:", errorMessage);
    showMessage(`加载工具失败：${errorMessage}`, "error");
  } finally {
    loading.value = false;
  }
}

async function refreshTools(): Promise<void> {
  if (loading.value) return;
  await loadTools({ forceRefresh: true });
  showMessage("工具列表已刷新。", "success");
}

async function loadConfigs(): Promise<void> {
  try {
    availableConfigs.value = await toolListApi.getConfigs();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load configs:", errorMessage);
    showMessage(`加载配置列表失败：${errorMessage}`, "error");
  }
}

function toggleTool(uniqueId: string, checked: boolean): void {
  if (checked) {
    syncSelectedTools((set) => set.add(uniqueId));
  } else {
    syncSelectedTools((set) => set.delete(uniqueId));
  }
}

function selectAll(): void {
  syncSelectedTools((set) => {
    filteredTools.value.forEach((tool) => set.add(tool.uniqueId));
  });
  showMessage("已将可见工具加入选择。", "success");
}

function deselectAll(): void {
  selectedTools.value = new Set();
  showMessage("已清空选择。", "success");
}

async function editDescription(tool: Tool): Promise<void> {
  const current =
    toolDescriptions.value[tool.uniqueId] ?? tool.description ?? "";
  const next = await askInput({
    title: `编辑说明：${tool.name}`,
    message: `插件：${tool.pluginName}。留空将恢复使用插件默认描述。`,
    initialValue: current,
    multiline: true,
    required: false,
    placeholder: `在此输入工具说明（最多 ${MAX_TOOL_DESCRIPTION_LENGTH} 字）……`,
    validate: (value) =>
      value.trim().length > MAX_TOOL_DESCRIPTION_LENGTH
        ? `说明不能超过 ${MAX_TOOL_DESCRIPTION_LENGTH} 字。`
        : null,
  });
  if (next === null) return;

  const trimmed = clampToolDescription(next);
  const defaultDesc = tool.description ?? "";
  syncDescriptions((map) => {
    if (!trimmed || trimmed === defaultDesc) {
      delete map[tool.uniqueId];
    } else {
      map[tool.uniqueId] = trimmed;
    }
  });
  showMessage("说明已更新。", "success");
}

async function onConfigSelectionChange(value: string): Promise<void> {
  if (value === selectedConfig.value) {
    return;
  }
  if (!(await confirmDiscardIfDirty(value ? "切换配置" : "新建配置"))) {
    return;
  }

  if (value) {
    selectedConfig.value = value;
    configNameInput.value = value;
    await loadConfig(value);
  } else {
    resetEditorToNewConfig();
    showMessage("已清空选择，可输入新名称后点击保存。", "info");
  }
}

function resetEditorToNewConfig(): void {
  selectedConfig.value = "";
  configNameInput.value = "";
  selectedTools.value = new Set();
  toolDescriptions.value = {};
  resetDirtyBaseline();
}

async function loadConfig(configName: string): Promise<void> {
  if (!configName) return;

  try {
    loadingConfig.value = true;
    const payload = await toolListApi.getConfig(configName, {
      showLoader: false,
      loadingKey: "tool-list.config.load",
    });

    const nextSelectedTools = payload.tools.filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0
    );
    selectedTools.value = new Set(nextSelectedTools);

    const normalizedDescriptions = normalizeToolDescriptionsForSave(
      payload.toolDescriptions ?? {}
    );
    toolDescriptions.value = normalizedDescriptions;

    if (typeof payload.includeHeader === "boolean") {
      includeHeader.value = payload.includeHeader;
    }
    if (typeof payload.includeExamples === "boolean") {
      includeExamples.value = payload.includeExamples;
    }

    const missingCount = extractMissingToolIds(allTools.value, nextSelectedTools).length;
    if (missingCount > 0) {
      showMessage(
        `配置中检测到 ${missingCount} 个失效工具 ID，可使用“清理”按钮删除。`,
        "warning"
      );
    }

    selectedConfig.value = configName;
    configNameInput.value = configName;
    resetDirtyBaseline();
    showMessage(`已加载配置 "${configName}"。`, "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`加载失败：${errorMessage}`, "error");
  } finally {
    loadingConfig.value = false;
  }
}

function clearMissingTools(): void {
  if (missingToolIds.value.length === 0) {
    return;
  }

  const missingSet = new Set(missingToolIds.value);
  syncSelectedTools((set) => {
    missingSet.forEach((id) => set.delete(id));
  });
  syncDescriptions((map) => {
    missingSet.forEach((id) => {
      delete map[id];
    });
  });

  showMessage(`已清理 ${missingSet.size} 个失效工具 ID。`, "success");
}

async function deleteConfig(): Promise<void> {
  if (!selectedConfig.value || deleting.value) return;

  const deletingName = selectedConfig.value;

  const confirmed = await askConfirm({
    message: `确认删除配置 "${deletingName}"？本地编辑内容会保留。`,
    danger: true,
    confirmText: "删除",
  });
  if (!confirmed) return;

  try {
    deleting.value = true;
    await toolListApi.deleteConfig(deletingName, {
      loadingKey: "tool-list.config.delete",
    });
    await loadConfigs();

    if (selectedConfig.value === deletingName) {
      selectedConfig.value = "";
      // 当前编辑内容保留但已脱离任何远端配置；重置 dirty 基线避免误报未保存。
      resetDirtyBaseline();
    }

    showMessage(`配置 "${deletingName}" 已删除，本地编辑已保留。`, "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`删除失败：${errorMessage}`, "error");
  } finally {
    deleting.value = false;
  }
}

function getPersistedToolDescriptions(): Record<string, string> {
  return normalizeToolDescriptionsForSave(toolDescriptions.value);
}

async function ensureGhostToolsHandled(): Promise<void> {
  if (missingToolIds.value.length === 0) {
    return;
  }

  const shouldClean = await askConfirm({
    title: "检测到失效工具",
    message: `当前包含 ${missingToolIds.value.length} 个失效工具 ID。是否在保存/导出前自动清理？`,
    confirmText: "清理并继续",
    cancelText: "保留并继续",
    danger: true,
  });

  if (shouldClean) {
    clearMissingTools();
  }
}

async function saveConfigInternal(name: string): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    showMessage("请先在上方输入配置名称。", "error");
    return;
  }

  const validationError = validateToolConfigName(trimmedName);
  if (validationError) {
    showMessage(validationError, "error");
    return;
  }

  const isOverwrite =
    availableConfigs.value.includes(trimmedName) && trimmedName !== selectedConfig.value;

  if (isOverwrite) {
    const overwriteConfirmed = await askConfirm({
      title: "确认覆盖配置",
      message: `配置 "${trimmedName}" 已存在，是否覆盖？`,
      confirmText: "覆盖",
      danger: true,
    });
    if (!overwriteConfirmed) {
      return;
    }
  }

  await ensureGhostToolsHandled();

  try {
    saving.value = true;
    await toolListApi.saveConfig(
      trimmedName,
      {
        tools: Array.from(selectedTools.value),
        toolDescriptions: getPersistedToolDescriptions(),
        includeHeader: includeHeader.value,
        includeExamples: includeExamples.value,
      },
      { loadingKey: "tool-list.config.save" }
    );
    await loadConfigs();
    selectedConfig.value = trimmedName;
    configNameInput.value = trimmedName;
    resetDirtyBaseline();
    showMessage(`配置 "${trimmedName}" 已保存。`, "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`保存失败：${errorMessage}`, "error");
  } finally {
    saving.value = false;
  }
}

async function saveConfig(): Promise<void> {
  if (saving.value) {
    return;
  }
  await saveConfigInternal(configNameInput.value);
}

async function exportTxt(): Promise<void> {
  if (selectedTools.value.size === 0 || exporting.value) {
    showMessage("请先选择至少一个工具。", "error");
    return;
  }

  const fileName = await askInput({
    title: "导出工具列表",
    message: "将导出到 tvs 目录下的 .txt 文件，名称规则同配置名。",
    initialValue: configNameInput.value || selectedConfig.value || "",
    placeholder: "文件名（不含后缀）",
    validate: (value) =>
      validateToolConfigName(value.trim()),
  });
  if (!fileName) return;

  const name = fileName.trim();
  const validationError = validateToolConfigName(name);
  if (validationError) {
    showMessage(validationError, "error");
    return;
  }

  let alreadyExists = false;
  try {
    alreadyExists = await toolListApi.checkFile(name, {
      showLoader: false,
      suppressErrorMessage: true,
    });
  } catch (error: unknown) {
    logger.warn("checkFile failed, fallback to direct export", error);
  }

  if (alreadyExists) {
    const overwriteConfirmed = await askConfirm({
      title: "文件已存在",
      message: `tvs 目录下已存在 "${name}.txt"，继续导出会覆盖，请确认。`,
      danger: true,
      confirmText: "覆盖",
    });
    if (!overwriteConfirmed) {
      return;
    }
  }

  await ensureGhostToolsHandled();

  try {
    exporting.value = true;
    const result = await toolListApi.exportTxt(
      name,
      {
        tools: Array.from(selectedTools.value),
        toolDescriptions: getPersistedToolDescriptions(),
        includeHeader: includeHeader.value,
        includeExamples: includeExamples.value,
      },
      { loadingKey: "tool-list.config.export" }
    );
    const filePath = result.filePath ?? `${name}.txt`;
    const copiedPath = await copyText(filePath);
    showMessage(
      copiedPath
        ? `已导出到 ${filePath}，路径已复制。`
        : `已导出到 ${filePath}。`,
      "success"
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`导出失败：${errorMessage}`, "error");
  } finally {
    exporting.value = false;
  }
}

async function copyText(value: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (error: unknown) {
    logger.warn("Clipboard API copy failed, fallback to execCommand", error);
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error: unknown) {
    logger.warn("execCommand copy failed", error);
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!isDirty.value) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
}

async function copyPreview(): Promise<void> {
  if (copying.value) {
    return;
  }

  try {
    copying.value = true;
    const copied = await copyText(previewContentRaw.value);
    if (!copied) {
      showMessage("复制失败：当前环境不支持自动复制，请手动选择文本。", "error");
      return;
    }
    showMessage("已复制到剪贴板。注意：敏感内容可能被其他应用读取。", "warning");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`复制失败：${errorMessage}`, "error");
  } finally {
    copying.value = false;
  }
}

onMounted(() => {
  void Promise.all([loadTools(), loadConfigs()]).finally(() => {
    resetDirtyBaseline();
  });
  window.addEventListener("beforeunload", handleBeforeUnload);
});

onBeforeUnmount(() => {
  applySearchQueryDebounced.cancel();
  applyPreviewDebounced.cancel();
  window.removeEventListener("beforeunload", handleBeforeUnload);
});

onBeforeRouteLeave(async () => {
  if (!isDirty.value) {
    return true;
  }

  return await askConfirm({
    title: "存在未保存更改",
    message: "当前配置尚未保存，确定要离开吗？",
    danger: true,
    confirmText: "放弃更改",
  });
});
</script>

<style scoped>
.tool-list-editor-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.tool-list-editor-page > .description {
  flex-shrink: 0;
}

.tool-list-editor {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  align-items: stretch;
  overflow: hidden;
}

@media (max-width: 1024px) {
  .tool-list-editor-page {
    height: auto;
    overflow: visible;
  }
  .tool-list-editor {
    grid-template-columns: 1fr;
    overflow: visible;
  }
}
</style>
