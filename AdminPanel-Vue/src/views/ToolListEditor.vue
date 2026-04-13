<template>
  <section class="config-section active-section">
    <p class="description">快速制作工具列表配置文件，用于 Agent 的提示词中。</p>

    <div class="tool-list-editor">
      <ToolSelectionPanel
        :loading="loading"
        :filtered-tools="filteredTools"
        :selected-tools="selectedTools"
        :search-query="searchQuery"
        :show-selected-only="showSelectedOnly"
        @update:searchQuery="searchQuery = $event"
        @update:showSelectedOnly="showSelectedOnly = $event"
        @toggleTool="toggleTool"
        @selectAll="selectAll"
        @deselectAll="deselectAll"
      />

      <ToolConfigPreviewPanel
        :available-configs="availableConfigs"
        :selected-config="selectedConfig"
        :status-message="statusMessage"
        :status-type="statusType"
        :include-header="includeHeader"
        :include-examples="includeExamples"
        :preview-content="previewContent"
        @update:selectedConfig="onConfigSelectionChange"
        @loadConfig="loadConfig"
        @createConfig="createConfig"
        @deleteConfig="deleteConfig"
        @saveConfig="saveConfig"
        @update:includeHeader="onIncludeHeaderChange"
        @update:includeExamples="onIncludeExamplesChange"
        @copyPreview="copyPreview"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import { toolListApi } from "@/api";
import type { Tool } from "@/features/tool-list/types";
import { showMessage } from "@/utils";
import { createLogger } from "@/utils/logger";
import ToolSelectionPanel from "./ToolListEditor/ToolSelectionPanel.vue";
import ToolConfigPreviewPanel from "./ToolListEditor/ToolConfigPreviewPanel.vue";

const logger = createLogger("ToolListEditor");

const loading = ref(true);
const allTools = ref<Tool[]>([]);
const selectedTools = shallowRef<Set<string>>(new Set());
const availableConfigs = ref<string[]>([]);
const selectedConfig = ref("");
const searchQuery = ref("");
const showSelectedOnly = ref(false);
const includeHeader = ref(true);
const includeExamples = ref(true);
const previewContent = ref("");
const statusMessage = ref("");
const statusType = ref<"info" | "success" | "error">("info");

const filteredTools = computed(() => {
  let tools = allTools.value;

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    tools = tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(query) ||
        tool.pluginName.toLowerCase().includes(query)
    );
  }

  if (showSelectedOnly.value) {
    tools = tools.filter((tool) => selectedTools.value.has(tool.uniqueId));
  }

  return tools;
});

function syncSelectedTools(mutator: (set: Set<string>) => void): void {
  const nextSet = new Set(selectedTools.value);
  mutator(nextSet);
  selectedTools.value = nextSet;
}

async function loadTools(): Promise<void> {
  try {
    loading.value = true;
    const toolList = await toolListApi.getTools();
    allTools.value = toolList.map((tool, index) => ({
      ...tool,
      uniqueId: tool.uniqueId || `${tool.pluginName}__${tool.name}__${index}`,
    }));
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load tools:", errorMessage);
    showMessage(`Failed to load tools: ${errorMessage}`, "error");
  } finally {
    loading.value = false;
  }
}

async function loadConfigs(): Promise<void> {
  try {
    availableConfigs.value = await toolListApi.getConfigs();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load configs:", errorMessage);
  }
}

function updatePreview(): void {
  const tools = allTools.value.filter((tool) => selectedTools.value.has(tool.uniqueId));

  let content = "";

  if (includeHeader.value) {
    content += "# Available Tools\n\n";
    content += "The following tools are currently available:\n\n";
  }

  tools.forEach((tool) => {
    content += `## ${tool.name}\n`;
    content += `**Plugin**: ${tool.pluginName}\n`;
    if (tool.description) {
      content += `**Description**: ${tool.description}\n`;
    }
    content += "\n";
  });

  if (includeExamples.value) {
    content += "## Example Usage\n\n";
    content += "```\n";
    content += `Use tools: ${tools.map((tool) => tool.name).join(", ")}\n`;
    content += "```\n";
  }

  previewContent.value = content;
}

function toggleTool(uniqueId: string, checked: boolean): void {
  if (checked) {
    syncSelectedTools((set) => set.add(uniqueId));
  } else {
    syncSelectedTools((set) => set.delete(uniqueId));
  }

  updatePreview();
}

function selectAll(): void {
  syncSelectedTools((set) => {
    filteredTools.value.forEach((tool) => {
      set.add(tool.uniqueId);
    });
  });

  updatePreview();
  showMessage("Selected all visible tools.", "success");
}

function deselectAll(): void {
  selectedTools.value = new Set();
  updatePreview();
  showMessage("Cleared selection.", "success");
}

function onConfigSelectionChange(value: string): void {
  selectedConfig.value = value;
  if (value) {
    void loadConfig();
  }
}

function onIncludeHeaderChange(value: boolean): void {
  includeHeader.value = value;
  updatePreview();
}

function onIncludeExamplesChange(value: boolean): void {
  includeExamples.value = value;
  updatePreview();
}

async function loadConfig(): Promise<void> {
  if (!selectedConfig.value) {
    return;
  }

  try {
    const tools = await toolListApi.getConfig(selectedConfig.value, {
      showLoader: false,
      loadingKey: "tool-list.config.load",
    });

    selectedTools.value = new Set(tools);
    updatePreview();
    statusMessage.value = "Configuration loaded.";
    statusType.value = "success";
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `Failed to load config: ${errorMessage}`;
    statusType.value = "error";
  }
}

function createConfig(): void {
  selectedConfig.value = "";
  selectedTools.value = new Set();
  updatePreview();
  statusMessage.value = "Enter a name for the new config.";
  statusType.value = "info";
}

async function deleteConfig(): Promise<void> {
  if (!selectedConfig.value) {
    return;
  }

  if (!confirm(`Delete config "${selectedConfig.value}"?`)) {
    return;
  }

  try {
    await toolListApi.deleteConfig(selectedConfig.value, {
      loadingKey: "tool-list.config.delete",
    });

    await loadConfigs();
    selectedConfig.value = "";
    selectedTools.value = new Set();
    updatePreview();

    statusMessage.value = "Configuration deleted.";
    statusType.value = "success";
    showMessage("Configuration deleted.", "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `Failed to delete config: ${errorMessage}`;
    statusType.value = "error";
  }
}

async function saveConfig(): Promise<void> {
  const configName = prompt("Enter config file name:", selectedConfig.value || "");
  if (!configName) {
    return;
  }

  try {
    await toolListApi.saveConfig(configName, Array.from(selectedTools.value), {
      loadingKey: "tool-list.config.save",
    });

    await loadConfigs();
    selectedConfig.value = configName;

    statusMessage.value = "Configuration saved.";
    statusType.value = "success";
    showMessage("Configuration saved.", "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusMessage.value = `Failed to save config: ${errorMessage}`;
    statusType.value = "error";
  }
}

async function copyPreview(): Promise<void> {
  try {
    await navigator.clipboard.writeText(previewContent.value);
    showMessage("Copied preview to clipboard.", "success");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`Failed to copy preview: ${errorMessage}`, "error");
  }
}

onMounted(() => {
  void Promise.all([loadTools(), loadConfigs()]);
});
</script>

<style scoped>
.tool-list-editor {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  height: calc(var(--app-viewport-height, 100vh) - 140px);
  min-height: 600px;
}

@media (max-width: 1024px) {
  .tool-list-editor {
    grid-template-columns: 1fr;
    height: auto;
  }
}
</style>
