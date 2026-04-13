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
          class="thinking-chain-item card"
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
                  <button
                    type="button"
                    class="drag-handle"
                    aria-label="拖动思维簇排序"
                    title="拖动思维簇排序"
                    @pointerdown="startChainPointerDrag(index, clusterIndex, $event)"
                  >
                    ☰
                  </button>
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
            <button
              type="button"
              class="drag-handle"
              aria-label="拖动可用思维簇"
              title="拖动可用思维簇"
              @pointerdown="startAvailablePointerDrag(cluster, $event)"
            >
              ☰
            </button>
            <span class="cluster-name">{{ cluster }}</span>
          </li>
          <li v-if="availableClusters.length === 0" class="no-clusters">
            未找到可用的思维簇模块
          </li>
        </ul>
      </div>
    </div>

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
import { useThinkingChainsEditor } from "@/features/thinking-chains-editor/useThinkingChainsEditor";

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

void dragGhostElement

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

.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--secondary-text);
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.drag-handle:active {
  cursor: grabbing;
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
}
</style>
