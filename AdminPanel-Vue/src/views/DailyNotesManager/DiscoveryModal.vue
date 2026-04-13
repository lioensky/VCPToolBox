<template>
  <div v-if="modelValue" class="modal-overlay" @click="closeModal">
    <div class="modal-content discovery-modal" @click.stop>
      <div class="modal-header">
        <h3>联想追溯：{{ sourceFileName }}</h3>
        <button class="modal-close" @click="closeModal">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="modal-body">
        <!-- 配置区域 -->
        <div class="discovery-config">
          <div class="config-row">
            <label>K 值（返回数量）:</label>
            <div class="k-slider-container">
              <input
                type="range"
                min="1"
                max="200"
                v-model.number="kValue"
                @input="updateKDisplay"
              />
              <span class="k-value-display">{{ kDisplay }}</span>
            </div>
          </div>

          <div class="config-row">
            <label>搜索范围:</label>
            <div class="folder-chips-container">
              <div
                v-for="folder in folders"
                :key="folder"
                class="folder-chip"
                :class="{ active: selectedFolders.includes(folder) }"
                @click="toggleFolder(folder)"
              >
                {{ folder }}
              </div>
            </div>
          </div>
        </div>

        <!-- 加载状态 -->
        <div v-if="loading" class="loading-state">
          <span class="loading-spinner"></span>
          <p>正在进行联想追溯…</p>
        </div>

        <!-- 警告信息 -->
        <div v-if="warning" class="warning-message">
          <span class="material-symbols-outlined">warning</span>
          {{ warning }}
        </div>

        <!-- 结果列表 -->
        <div v-if="results.length > 0" class="discovery-results-list">
          <div
            v-for="(result, index) in results"
            :key="result.path || `${result.name}-${index}`"
            class="discovery-result-card"
            @click="openResult(result)"
          >
            <div class="result-header">
              <span class="result-filename">{{ result.name }}</span>
              <span class="result-score-tag"
                >匹配度：{{ result.scorePercent }}%</span
              >
            </div>
            <div class="result-score-bar-container">
              <div
                class="result-score-bar"
                :style="{ width: result.scorePercent + '%' }"
              ></div>
            </div>
            <div class="result-tags">
              <span
                v-for="(tag, i) in result.matchedTags?.slice(0, 5)"
                :key="`${tag}-${i}`"
                class="result-tag"
              >
                #{{ tag }}
              </span>
            </div>
            <div class="result-preview">{{ result.preview }}</div>
          </div>
        </div>

        <!-- 无结果 -->
        <div v-else-if="!loading && hasSearched" class="no-results">
          <span class="material-symbols-outlined">search_off</span>
          <p>未发现相关的记忆节点。</p>
        </div>
      </div>

      <div class="modal-footer">
        <button
          class="btn-primary"
          @click="performDiscovery"
          :disabled="loading"
        >
          <span class="material-symbols-outlined">psychology</span>
          开始联想
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { diaryApi } from "@/api";
import { showMessage } from "@/utils";

const props = defineProps<{
  modelValue: boolean;
  sourceNote: { file: string; title?: string } | null;
  selectedFolder: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "openNote", folder: string, file: string): void;
}>();

const folders = ref<string[]>([]);
const selectedFolders = ref<string[]>([]);
const kValue = ref(50);
const kDisplay = ref("50");
const loading = ref(false);
const warning = ref("");
const results = ref<
  Array<{
    name: string;
    path: string;
    score: number;
    scorePercent: number;
    matchedTags?: string[];
    preview: string;
    chunks?: string[];
  }>
>([]);
const hasSearched = ref(false);

const sourceFileName = computed(
  () => props.sourceNote?.title || props.sourceNote?.file || ""
);

// 加载文件夹列表
async function loadFolders() {
  try {
    const data = await diaryApi.getFolders();
    folders.value = data.map((folder) => folder.name);
    // 默认选中当前文件夹
    if (props.selectedFolder) {
      selectedFolders.value = [props.selectedFolder];
    }
  } catch (error) {
    console.error("Failed to load folders:", error);
  }
}

function updateKDisplay() {
  kDisplay.value = String(kValue.value);
}

function toggleFolder(folder: string) {
  const index = selectedFolders.value.indexOf(folder);
  if (index > -1) {
    selectedFolders.value.splice(index, 1);
  } else {
    selectedFolders.value.push(folder);
  }
}

async function performDiscovery() {
  if (!props.sourceNote) return;

  loading.value = true;
  warning.value = "";
  results.value = [];
  hasSearched.value = false;

  try {
    const data = await diaryApi.associativeDiscovery(
      {
        sourceFilePath: `${props.selectedFolder}/${props.sourceNote.file}`,
        k: kValue.value,
        range: selectedFolders.value,
        tagBoost: 0.15,
      }
    );

    if (data.warning) {
      warning.value = data.warning;
    }

    if (data.results && data.results.length > 0) {
      results.value = data.results.map((r) => ({
        ...r,
        scorePercent: Math.min(Math.round(r.score * 100), 100),
        preview: Array.isArray(r.chunks)
          ? r.chunks.map((c: string) => c.substring(0, 100)).join(" ... ")
          : "",
      }));
    }

    hasSearched.value = true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`联想失败：${errorMessage}`, "error");
  } finally {
    loading.value = false;
  }
}

function openResult(result: { path: string }) {
  const parts = result.path.split(/[/\\]/);
  const folder = parts[0];
  const file = parts[parts.length - 1];
  emit("openNote", folder, file);
  closeModal();
}

function closeModal() {
  emit("update:modelValue", false);
}

watch(
  () => props.modelValue,
  (newVal) => {
    if (newVal) {
      loadFolders();
      results.value = [];
      hasSearched.value = false;
      warning.value = "";
    }
  }
);
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--overlay-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  animation: fadeIn 0.2s ease;
}

.modal-content {
  background: var(--secondary-bg);
  border-radius: var(--radius-md);
  max-width: 800px;
  width: 90%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  animation: slideIn 0.3s ease;
}

.discovery-modal {
  border: 1px solid var(--border-color);
  box-shadow: var(--overlay-panel-shadow);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  margin: 0;
  font-size: var(--font-size-title);
  color: var(--primary-text);
}

.modal-close {
  background: transparent;
  border: none;
  color: var(--secondary-text);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s ease;
}

.modal-close:hover {
  background: var(--accent-bg);
  color: var(--primary-text);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.discovery-config {
  margin-bottom: var(--space-5);
  padding: 16px;
  background: var(--tertiary-bg);
  border-radius: var(--radius-sm);
}

.config-row {
  margin-bottom: var(--space-4);
}

.config-row:last-child {
  margin-bottom: 0;
}

.config-row label {
  display: block;
  margin-bottom: var(--space-2);
  font-weight: 600;
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.k-slider-container {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.k-slider-container input[type="range"] {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--border-color);
  -webkit-appearance: none;
}

.k-slider-container input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--highlight-text);
  cursor: pointer;
}

.k-value-display {
  min-width: 40px;
  text-align: center;
  font-weight: 600;
  color: var(--highlight-text);
  font-size: var(--font-size-emphasis);
}

.folder-chips-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.folder-chip {
  padding: 6px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  font-size: var(--font-size-helper);
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;
  color: var(--primary-text);
}

.folder-chip:hover {
  border-color: var(--highlight-text);
  background: var(--accent-bg);
}

.folder-chip.active {
  background: var(--highlight-text);
  color: var(--on-accent-text);
  border-color: var(--highlight-text);
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 20px;
  color: var(--secondary-text);
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-color);
  border-top-color: var(--highlight-text);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: var(--space-4);
}

.warning-message {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-sm);
  color: var(--warning-text);
  margin-bottom: var(--space-4);
}

.warning-message .material-symbols-outlined {
  font-size: var(--font-size-title) !important;
}

.discovery-results-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.discovery-result-card {
  padding: 16px;
  background: var(--tertiary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.discovery-result-card:hover {
  border-color: var(--highlight-text);
  background: var(--accent-bg);
  transform: translateX(4px);
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-2);
}

.result-filename {
  font-weight: 600;
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.result-score-tag {
  padding: 4px 8px;
  background: var(--highlight-text);
  color: var(--on-accent-text);
  border-radius: 4px;
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.result-score-bar-container {
  height: 6px;
  background: var(--border-color);
  border-radius: 3px;
  margin-bottom: var(--space-2);
  overflow: hidden;
}

.result-score-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--highlight-text), var(--button-bg));
  border-radius: 3px;
  transition: width 0.3s ease;
}

.result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--space-2);
}

.result-tag {
  padding: 2px 8px;
  background: var(--info-bg);
  color: var(--highlight-text);
  border-radius: var(--radius-md);
  font-size: var(--font-size-helper);
}

.result-preview {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.no-results {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 20px;
  color: var(--secondary-text);
}

.no-results .material-symbols-outlined {
  font-size: var(--font-size-icon-empty-lg) !important;
  opacity: 0.3;
  margin-bottom: var(--space-4);
}

.modal-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: flex-end;
}

.modal-footer button {
  display: flex;
  align-items: center;
  gap: 6px;
}

.modal-footer .material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
}

@media (max-width: 768px) {
  .modal-content {
    width: calc(100% - 16px);
    max-height: 92vh;
    border-radius: var(--radius-sm);
  }

  .modal-header {
    padding: 12px 14px;
    align-items: flex-start;
    gap: 8px;
  }

  .modal-header h3 {
    font-size: var(--font-size-body);
    min-width: 0;
    line-height: 1.4;
    word-break: break-word;
  }

  .modal-close {
    min-width: 36px;
    min-height: 36px;
  }

  .modal-body {
    padding: 12px;
  }

  .discovery-config {
    margin-bottom: var(--space-4);
    padding: 12px;
  }

  .k-slider-container {
    align-items: center;
    gap: 8px;
  }

  .k-value-display {
    min-width: 34px;
    font-size: var(--font-size-body);
  }

  .discovery-result-card {
    padding: 12px;
  }

  .result-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .result-score-tag {
    align-self: flex-start;
  }

  .modal-footer {
    padding: 12px;
  }

  .modal-footer .btn-primary {
    width: 100%;
    justify-content: center;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slideIn {
  from {
    transform: translateY(-20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
