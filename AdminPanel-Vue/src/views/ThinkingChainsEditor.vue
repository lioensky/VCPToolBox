<template>
  <section class="config-section active-section">
    <p class="description">
      管理 RAGDiaryPlugin 使用的元思考链。按住左侧手柄拖动时会实时预览插入位置，
      释放后再提交最终顺序。
    </p>

    <div id="thinking-chains-editor-controls" class="form-actions">
      <button type="button" class="btn-primary" @click="saveThinkingChains">
        保存所有更改
      </button>
      <button type="button" class="btn-secondary" @click="addThinkingChain">
        添加新主题
      </button>
      <span v-if="statusMessage" :class="['status-message', statusType]">
        {{ statusMessage }}
      </span>
    </div>

    <div id="thinking-chains-container" class="thinking-chains-layout">
      <div class="thinking-chains-editor">
        <h3>思考主题列表</h3>

        <div
          v-for="(chain, index) in thinkingChains"
          :key="chain.uiId"
          :class="[
            'thinking-chain-item',
            'card',
            { 'thinking-chain-item--active': index === pickerChainIndex },
          ]"
        >
          <details open>
            <summary class="chain-header">
              <span class="theme-name">主题：{{ chain.theme || '未命名主题' }}</span>
              <button
                type="button"
                class="btn-danger btn-sm"
                @click.stop.prevent="removeChain(index)"
              >
                删除
              </button>
            </summary>

            <div class="chain-content">
              <div class="form-group theme-editor">
                <label :for="`thinking-theme-${index}`">主题名称</label>
                <input
                  :id="`thinking-theme-${index}`"
                  v-model.trim="chain.theme"
                  type="text"
                  placeholder="请输入主题名称"
                  @click.stop
                />
              </div>

              <div class="cluster-picker-entry">
                <button
                  type="button"
                  class="btn-secondary btn-sm"
                  @click="openClusterPicker(index)"
                >
                  添加思维模块
                </button>
                <span class="cluster-picker-entry-tip">点击模块即可勾选，支持多选后批量加入当前主题</span>
              </div>

              <TransitionGroup
                tag="ul"
                name="drag-sort"
                class="draggable-list"
                :class="{
                  'draggable-list--active-target': isChainDropTarget(index),
                  'draggable-list--previewing': isPreviewDragging,
                }"
                data-chain-list="true"
                :data-chain-index="index"
              >
                <li
                  v-for="(cluster, clusterIndex) in getRenderedClusters(index)"
                  :key="cluster"
                  :class="[
                    'chain-item',
                    {
                      'chain-item--dragging': isChainClusterDragging(index, cluster),
                      'chain-item--drop-before': isChainDropBefore(index, cluster),
                      'chain-item--drop-after': isChainDropAfter(index, cluster),
                    },
                  ]"
                  data-chain-item="true"
                  :data-chain-index="index"
                  :data-cluster-index="clusterIndex"
                  :data-cluster-name="cluster"
                >
                  <DragHandle
                    label="拖动思维簇排序"
                    @pointerdown="startChainPointerDrag(index, clusterIndex, $event)"
                  />
                  <div class="cluster-content">
                    <span class="cluster-name">{{ cluster }}</span>
                    <label class="cluster-k-control" :for="`cluster-k-value-${index}-${cluster}`">
                      <span class="cluster-k-label">K 值</span>
                      <input
                        :id="`cluster-k-value-${index}-${cluster}`"
                        type="number"
                        min="1"
                        max="20"
                        class="cluster-k-input"
                        :value="getRenderedKValue(index, cluster)"
                        @input="handleKValueInput(index, cluster, $event)"
                        @click.stop
                        @pointerdown.stop
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    class="btn-danger btn-sm"
                    @click="removeClusterByName(index, cluster)"
                  >
                    移除
                  </button>
                </li>

                <li
                  v-if="getRenderedClusters(index).length === 0"
                  key="empty"
                  :class="[
                    'drop-placeholder',
                    { 'drop-placeholder--active': isChainDropTarget(index) },
                  ]"
                >
                  将思维簇拖拽到此处
                </li>
              </TransitionGroup>
            </div>
          </details>
        </div>
      </div>

      <div class="available-clusters-panel card">
        <h3>可用的思维簇模块</h3>
        <p class="description">将模块从这里拖拽到左侧的主题列表中。</p>
        <ul class="draggable-list available-clusters-list">
          <li
            v-for="cluster in availableClusters"
            :key="cluster"
            :class="[
              'chain-item',
              'chain-item--available',
              { 'chain-item--dragging': isAvailableClusterDragging(cluster) },
            ]"
            data-available-cluster="true"
          >
            <DragHandle
              label="拖动可用思维簇"
              @pointerdown="startAvailablePointerDrag(cluster, $event)"
            />
            <span class="cluster-name">{{ cluster }}</span>
          </li>
          <li v-if="availableClusters.length === 0" class="no-clusters">
            未找到可用的思维簇模块
          </li>
        </ul>
      </div>
    </div>

    <BaseModal
      v-model="isClusterPickerOpen"
      transition-name="cluster-picker-cockpit"
      aria-label="添加思维模块"
      @close="closeClusterPicker"
    >
      <template #default="{ overlayAttrs, panelAttrs, panelRef }">
        <div v-bind="overlayAttrs" class="cluster-picker-overlay">
          <div :ref="panelRef" v-bind="panelAttrs" class="cluster-picker-modal">
      <header class="cluster-picker-header">
        <div>
          <h3>添加思维模块</h3>
          <p class="description">
            当前主题：{{ pickerChain?.theme || "未命名主题" }}
          </p>
        </div>
        <button
          type="button"
          class="btn-danger btn-sm"
          @click="closeClusterPicker"
        >
          关闭
        </button>
      </header>

      <div class="cluster-picker-toolbar">
        <button type="button" class="btn-secondary btn-sm" @click="selectAllPickerClusters">
          全选可用
        </button>
        <button
          type="button"
          class="btn-secondary btn-sm"
          :disabled="pendingClusterSelection.length === 0"
          @click="clearPickerSelection"
        >
          清空选择
        </button>
      </div>

      <ul class="cluster-picker-list">
        <li
          v-for="cluster in pickerClusters"
          :key="cluster.name"
          class="cluster-picker-item"
        >
          <button
            type="button"
            :class="[
              'cluster-picker-option',
              {
                'cluster-picker-option--disabled': cluster.disabled,
                'cluster-picker-option--selected': pickerSelectionSet.has(cluster.name),
              },
            ]"
            :disabled="cluster.disabled"
            @click="togglePickerCluster(cluster.name)"
          >
            <span
              :class="[
                'cluster-picker-check',
                'app-check-indicator',
                { 'app-check-indicator--active': pickerSelectionSet.has(cluster.name) },
              ]"
              aria-hidden="true"
            >
              <span v-if="pickerSelectionSet.has(cluster.name)" class="cluster-picker-order">
                {{ pickerSelectionOrderMap.get(cluster.name) }}
              </span>
            </span>
            <span class="cluster-picker-option-label">{{ cluster.name }}</span>
            <span v-if="cluster.disabled" class="cluster-picker-badge">已在主题中</span>
          </button>
        </li>

        <li v-if="pickerClusters.length === 0" class="no-clusters">
          未找到可用的思维簇模块
        </li>
      </ul>

      <footer class="cluster-picker-footer">
        <span class="cluster-picker-count">已选 {{ pendingClusterSelection.length }} 项</span>
        <div class="cluster-picker-footer-actions">
          <button type="button" class="btn-secondary" @click="closeClusterPicker">
            取消
          </button>
          <button
            type="button"
            class="btn-primary"
            :disabled="!canConfirmPicker"
            @click="confirmAddClusters"
          >
            添加选中项
          </button>
        </div>
      </footer>
          </div>
        </div>
      </template>
    </BaseModal>

    <div
      v-if="dragGhost"
      ref="dragGhostElement"
      class="thinking-chain-drag-ghost"
    >
      <div class="thinking-chain-drag-ghost-shell">
        <div class="thinking-chain-drag-ghost-title">{{ dragGhost.label }}</div>
        <div class="thinking-chain-drag-ghost-meta">{{ dragGhost.meta }}</div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useThinkingChainsEditor } from "@/features/thinking-chains-editor/useThinkingChainsEditor";
import BaseModal from "@/components/ui/BaseModal.vue";
import DragHandle from "@/components/ui/DragHandle.vue";

const {
  thinkingChains,
  availableClusters,
  dragGhost,
  dragGhostElement,
  isPreviewDragging,
  statusMessage,
  statusType,
  saveThinkingChains,
  addThinkingChain,
  removeChain,
  removeClusterByName,
  addClusters,
  getRenderedClusters,
  getRenderedKValue,
  updateClusterKValue,
  startChainPointerDrag,
  startAvailablePointerDrag,
  isChainClusterDragging,
  isAvailableClusterDragging,
  isChainDropTarget,
  isChainDropBefore,
  isChainDropAfter,
} = useThinkingChainsEditor();

void dragGhostElement;

const isClusterPickerOpen = ref(false);
const pickerChainIndex = ref<number | null>(null);
const pendingClusterSelection = ref<string[]>([]);

const pickerSelectionSet = computed(() => new Set(pendingClusterSelection.value));
const pickerSelectionOrderMap = computed(() => {
  const selectionOrderMap = new Map<string, number>();
  pendingClusterSelection.value.forEach((clusterName, index) => {
    selectionOrderMap.set(clusterName, index + 1);
  });
  return selectionOrderMap;
});

const pickerChain = computed(() => {
  const chainIndex = pickerChainIndex.value;
  if (chainIndex === null) {
    return null;
  }

  return thinkingChains.value[chainIndex] ?? null;
});

const pickerClusters = computed(() => {
  const activeChain = pickerChain.value;
  const selectedClusters = new Set(activeChain?.clusters ?? []);

  return availableClusters.value.map((clusterName) => ({
    name: clusterName,
    disabled: selectedClusters.has(clusterName),
  }));
});

const canConfirmPicker = computed(
  () => pickerChainIndex.value !== null && pendingClusterSelection.value.length > 0
);

function openClusterPicker(chainIndex: number): void {
  if (chainIndex < 0 || chainIndex >= thinkingChains.value.length) {
    return;
  }

  pickerChainIndex.value = chainIndex;
  pendingClusterSelection.value = [];
  isClusterPickerOpen.value = true;
}

function closeClusterPicker(): void {
  isClusterPickerOpen.value = false;
  pickerChainIndex.value = null;
  pendingClusterSelection.value = [];
}

function togglePickerCluster(clusterName: string): void {
  if (!clusterName || pickerSelectionSet.value.has(clusterName)) {
    pendingClusterSelection.value = pendingClusterSelection.value.filter(
      (candidate) => candidate !== clusterName
    );
    return;
  }

  pendingClusterSelection.value = [...pendingClusterSelection.value, clusterName];
}

function selectAllPickerClusters(): void {
  const existingSelection = pickerSelectionSet.value;
  const additions = pickerClusters.value
    .filter((cluster) => !cluster.disabled && !existingSelection.has(cluster.name))
    .map((cluster) => cluster.name);

  if (additions.length === 0) {
    return;
  }

  pendingClusterSelection.value = [...pendingClusterSelection.value, ...additions];
}

function clearPickerSelection(): void {
  pendingClusterSelection.value = [];
}

function confirmAddClusters(): void {
  const chainIndex = pickerChainIndex.value;
  if (chainIndex === null || pendingClusterSelection.value.length === 0) {
    return;
  }

  addClusters(chainIndex, pendingClusterSelection.value);
  closeClusterPicker();
}

function handleKValueInput(chainIndex: number, clusterName: string, event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  updateClusterKValue(chainIndex, clusterName, target.value);
}
</script>

<style scoped>
.thinking-chains-layout {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 24px;
}

.thinking-chains-editor {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.thinking-chains-editor > h3 {
  margin: 0;
  color: var(--primary-text);
}

.thinking-chain-item {
  padding: 16px;
  transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
}

.thinking-chain-item--active {
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-text) 10%, var(--secondary-bg));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--highlight-text) 34%, transparent),
    var(--shadow-md);
}

.thinking-chain-item--active .theme-name {
  color: var(--highlight-text);
}

.chain-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  user-select: none;
}

.theme-name {
  font-weight: 600;
  font-size: var(--font-size-emphasis);
}

.chain-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 16px;
}

.theme-editor {
  margin-bottom: 0;
}

.cluster-picker-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.cluster-picker-entry-tip {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.draggable-list {
  list-style: none;
  padding: 8px;
  margin: 0;
  min-height: 60px;
  border: 2px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: var(--secondary-bg);
}

.draggable-list--active-target {
  border-color: var(--highlight-text);
}

.chain-item {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  margin-bottom: var(--space-2);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  will-change: transform;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    opacity 0.18s ease,
    filter 0.18s ease;
}

.chain-item:last-child {
  margin-bottom: 0;
}

.chain-item:hover {
  border-color: var(--highlight-text);
  box-shadow: var(--shadow-md);
}

.chain-item--dragging {
  opacity: 0.16;
  filter: saturate(0.88);
}

.chain-item--drop-before::before,
.chain-item--drop-after::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  z-index: 2;
  height: 2px;
  border-radius: 999px;
  background: var(--highlight-text);
  box-shadow: none;
}

.chain-item--drop-before::before {
  top: -6px;
}

.chain-item--drop-after::after {
  bottom: -6px;
}

.cluster-content {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.cluster-name {
  min-width: 0;
  font-weight: 500;
}

.cluster-k-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  flex-shrink: 0;
}

.cluster-k-label {
  font-size: var(--font-size-caption);
  font-weight: 700;
  color: var(--secondary-text);
  white-space: nowrap;
}

.cluster-k-input {
  width: 56px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  text-align: center;
}

.cluster-k-input:focus {
  outline: none;
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.chain-item--available {
  grid-template-columns: auto minmax(0, 1fr);
}

.drop-placeholder {
  padding: 20px;
  text-align: center;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.drop-placeholder--active {
  color: var(--highlight-text);
}

.available-clusters-panel {
  height: fit-content;
}

.available-clusters-panel > h3 {
  margin: 0 0 8px;
  font-size: var(--font-size-emphasis);
  color: var(--primary-text);
}

.available-clusters-panel > .description {
  margin: 0 0 16px;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.available-clusters-list .chain-item {
  cursor: grab;
}

.no-clusters {
  padding: 20px;
  text-align: center;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.cluster-picker-cockpit-enter-active,
.cluster-picker-cockpit-leave-active {
  transition: opacity var(--transition-fast);
}

.cluster-picker-cockpit-enter-from,
.cluster-picker-cockpit-leave-to {
  opacity: 0;
}

.cluster-picker-cockpit-enter-active .cluster-picker-modal,
.cluster-picker-cockpit-leave-active .cluster-picker-modal {
  transition:
    transform var(--transition-fast),
    opacity var(--transition-fast),
    filter var(--transition-fast);
}

.cluster-picker-cockpit-enter-from .cluster-picker-modal,
.cluster-picker-cockpit-leave-to .cluster-picker-modal {
  opacity: 0;
  transform: translateY(14px) scale(0.985);
  filter: saturate(0.92);
}

.cluster-picker-cockpit-enter-active .cluster-picker-header,
.cluster-picker-cockpit-enter-active .cluster-picker-toolbar,
.cluster-picker-cockpit-enter-active .cluster-picker-list,
.cluster-picker-cockpit-enter-active .cluster-picker-footer,
.cluster-picker-cockpit-leave-active .cluster-picker-header,
.cluster-picker-cockpit-leave-active .cluster-picker-toolbar,
.cluster-picker-cockpit-leave-active .cluster-picker-list,
.cluster-picker-cockpit-leave-active .cluster-picker-footer {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.cluster-picker-cockpit-enter-from .cluster-picker-header,
.cluster-picker-cockpit-enter-from .cluster-picker-toolbar,
.cluster-picker-cockpit-enter-from .cluster-picker-list,
.cluster-picker-cockpit-enter-from .cluster-picker-footer,
.cluster-picker-cockpit-leave-to .cluster-picker-header,
.cluster-picker-cockpit-leave-to .cluster-picker-toolbar,
.cluster-picker-cockpit-leave-to .cluster-picker-list,
.cluster-picker-cockpit-leave-to .cluster-picker-footer {
  opacity: 0;
  transform: translateY(8px);
}

.cluster-picker-cockpit-enter-active .cluster-picker-toolbar {
  transition-delay: 40ms;
}

.cluster-picker-cockpit-enter-active .cluster-picker-list {
  transition-delay: 70ms;
}

.cluster-picker-cockpit-enter-active .cluster-picker-footer {
  transition-delay: 100ms;
}

.cluster-picker-overlay {
  z-index: var(--z-index-modal);
  padding: 24px;
  background:
    radial-gradient(
      circle at top,
      color-mix(in srgb, var(--highlight-text) 18%, transparent),
      transparent 40%
    ),
    var(--overlay-backdrop-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.cluster-picker-modal {
  width: min(760px, 100%);
  max-height: min(84vh, 780px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 24px;
  overflow: hidden;
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--primary-bg) 86%, var(--surface-overlay-strong)),
      color-mix(in srgb, var(--secondary-bg) 90%, var(--primary-bg))
    ),
    var(--secondary-bg);
  box-shadow: var(--overlay-panel-shadow);
}

.cluster-picker-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 22px 24px 18px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--surface-overlay-soft), transparent);
}

.cluster-picker-header h3 {
  margin: 0;
}

.cluster-picker-header .description {
  margin: 4px 0 0;
}

.cluster-picker-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 14px 24px 0;
}

.cluster-picker-list {
  list-style: none;
  margin: 0;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.cluster-picker-item {
  list-style: none;
}

.cluster-picker-option {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--input-bg) 90%, transparent);
  color: var(--primary-text);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background-color 0.2s ease;
}

.cluster-picker-option--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.cluster-picker-option:hover {
  border-color: var(--highlight-text);
  box-shadow: var(--shadow-md);
}

.cluster-picker-option--selected {
  border-color: color-mix(in srgb, var(--highlight-text) 78%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 12%, var(--input-bg));
}

.cluster-picker-check {
  flex-shrink: 0;
}

.cluster-picker-order {
  min-width: 1ch;
  text-align: center;
}

.cluster-picker-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cluster-picker-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--warning-color) 14%, transparent);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 600;
}

.cluster-picker-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 16px 24px 20px;
  border-top: 1px solid var(--border-color);
  background: linear-gradient(0deg, var(--surface-overlay-soft), transparent);
}

.cluster-picker-count {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.cluster-picker-footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thinking-chain-drag-ghost {
  position: fixed;
  z-index: 60;
  pointer-events: none;
  will-change: left, top, transform;
}

.thinking-chain-drag-ghost-shell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100%;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 35%, var(--border-color));
  border-radius: var(--radius-md);
  background: var(--secondary-bg);
  box-shadow: var(--shadow-lg);
}

.thinking-chain-drag-ghost-title {
  font-size: var(--font-size-body);
  font-weight: 700;
  line-height: 1.3;
  color: var(--primary-text);
}

.thinking-chain-drag-ghost-meta {
  margin-top: 6px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.drag-sort-move {
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.drag-sort-enter-active,
.drag-sort-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.draggable-list--previewing .drag-sort-move,
.draggable-list--previewing .drag-sort-enter-active,
.draggable-list--previewing .drag-sort-leave-active {
  transition: none !important;
}

.drag-sort-enter-from,
.drag-sort-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 1024px) {
  .thinking-chains-layout {
    grid-template-columns: 1fr;
  }

  .available-clusters-panel {
    order: -1;
  }
}

@media (max-width: 768px) {
  .chain-item {
    grid-template-columns: auto 1fr;
  }

  .cluster-content,
  .chain-item .btn-danger {
    grid-column: 1 / -1;
  }

  .cluster-content {
    align-items: stretch;
    flex-direction: column;
  }

  .cluster-k-control,
  .chain-item .btn-danger {
    width: 100%;
  }

  .cluster-k-control {
    justify-content: space-between;
  }

  .cluster-picker-overlay {
    padding: 16px;
  }

  .cluster-picker-header,
  .cluster-picker-toolbar,
  .cluster-picker-footer {
    padding-left: 16px;
    padding-right: 16px;
  }

  .cluster-picker-list {
    padding: 12px 16px;
  }

  .cluster-picker-option {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .cluster-picker-badge {
    grid-column: 1 / -1;
    justify-self: flex-start;
    margin-left: 30px;
  }

  .cluster-picker-footer-actions {
    width: 100%;
    justify-content: flex-end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cluster-picker-cockpit-enter-active,
  .cluster-picker-cockpit-leave-active,
  .cluster-picker-cockpit-enter-active .cluster-picker-modal,
  .cluster-picker-cockpit-leave-active .cluster-picker-modal,
  .cluster-picker-cockpit-enter-active .cluster-picker-header,
  .cluster-picker-cockpit-enter-active .cluster-picker-toolbar,
  .cluster-picker-cockpit-enter-active .cluster-picker-list,
  .cluster-picker-cockpit-enter-active .cluster-picker-footer,
  .cluster-picker-cockpit-leave-active .cluster-picker-header,
  .cluster-picker-cockpit-leave-active .cluster-picker-toolbar,
  .cluster-picker-cockpit-leave-active .cluster-picker-list,
  .cluster-picker-cockpit-leave-active .cluster-picker-footer {
    transition: none !important;
  }
}
</style>
