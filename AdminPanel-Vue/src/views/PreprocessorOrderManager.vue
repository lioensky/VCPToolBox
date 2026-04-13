<template>
  <section class="config-section active-section">
    <p class="description">
      在这里，您可以调整消息预处理器的执行顺序。按住左侧手柄拖动时会实时预览落位，
      越靠上的插件越优先执行。
    </p>

    <div class="preprocessor-order-controls">
      <button @click="saveOrder" class="btn-primary">保存顺序并热重载</button>
      <span v-if="statusMessage" :class="['status-message', statusType]">
        {{ statusMessage }}
      </span>
    </div>

    <TransitionGroup
      id="preprocessor-list"
      tag="ul"
      name="drag-sort"
      class="draggable-list"
      data-preprocessor-list="true"
    >
      <li
        v-for="(plugin, index) in orderedPreprocessors"
        :key="plugin.name"
        :data-preprocessor-name="plugin.name"
        :class="[
          'draggable-item',
          {
            'draggable-item--dragging': draggingPluginName === plugin.name,
            'draggable-item--drop-before':
              draggingPluginName !== null &&
              dragOverPluginName === plugin.name &&
              dropPlacement === 'before',
            'draggable-item--drop-after':
              draggingPluginName !== null &&
              dragOverPluginName === plugin.name &&
              dropPlacement === 'after',
          },
        ]"
      >
        <button
          type="button"
          class="drag-handle"
          aria-label="拖动排序"
          title="拖动排序"
          @pointerdown="handleDragHandlePointerDown(plugin.name, $event)"
        >
          ☰
        </button>

        <span class="plugin-index">{{ index + 1 }}.</span>

        <span class="plugin-copy">
          <span class="plugin-name">{{ plugin.displayName || plugin.name }}</span>
          <span v-if="plugin.description" class="plugin-description">
            {{ plugin.description }}
          </span>
        </span>
      </li>
    </TransitionGroup>

    <div v-if="dragGhost" ref="dragGhostElement" class="preprocessor-drag-ghost">
      <div class="preprocessor-drag-ghost-shell">
        <div class="preprocessor-drag-ghost-title">{{ dragGhost.label }}</div>
        <div v-if="dragGhost.description" class="preprocessor-drag-ghost-meta">
          {{ dragGhost.description }}
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { usePreprocessorOrderManager } from "@/features/preprocessor-order-manager/usePreprocessorOrderManager";

const {
  orderedPreprocessors,
  draggingPluginName,
  dragOverPluginName,
  dropPlacement,
  dragGhost,
  dragGhostElement,
  statusMessage,
  statusType,
  handleDragHandlePointerDown,
  saveOrder,
} = usePreprocessorOrderManager();

void dragGhostElement
</script>

<style scoped>
.preprocessor-order-controls {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin-bottom: var(--space-4);
}

.draggable-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.draggable-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  padding: var(--space-4) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--secondary-bg);
  will-change: transform;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    opacity 0.18s ease,
    filter 0.18s ease;
}

.draggable-item:hover {
  border-color: var(--highlight-text);
  box-shadow: var(--shadow-md);
}

.draggable-item--dragging {
  opacity: 0.16;
  filter: saturate(0.88);
}

.draggable-item--drop-before::before,
.draggable-item--drop-after::after {
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

.draggable-item--drop-before::before {
  top: -6px;
}

.draggable-item--drop-after::after {
  bottom: -6px;
}

.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-body);
  cursor: grab;
  user-select: none;
  touch-action: none;
  transition: color 0.2s ease, background-color 0.2s ease;
}

.drag-handle:hover {
  color: var(--primary-text);
  background: var(--accent-bg);
}

.drag-handle:active {
  cursor: grabbing;
}

.plugin-index {
  min-width: 30px;
  color: var(--secondary-text);
  font-weight: 700;
}

.plugin-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.plugin-name {
  font-weight: 600;
  color: var(--primary-text);
}

.plugin-description {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.preprocessor-drag-ghost {
  position: fixed;
  z-index: 60;
  pointer-events: none;
  will-change: left, top, transform;
}

.preprocessor-drag-ghost-shell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100%;
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 35%, var(--border-color));
  border-radius: var(--radius-md);
  background: var(--secondary-bg);
  box-shadow: var(--shadow-lg);
}

.preprocessor-drag-ghost-title {
  font-size: var(--font-size-body);
  font-weight: 700;
  line-height: 1.3;
  color: var(--primary-text);
}

.preprocessor-drag-ghost-meta {
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

.drag-sort-enter-from,
.drag-sort-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
