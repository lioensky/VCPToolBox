<template>
  <section class="config-section active-section">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiDirtyIndicator :dirty="hasChanges" :label="`已修改 ${changedItemCount} 项`" />
        <UiBadge v-if="!hasChanges" variant="secondary">当前顺序未修改</UiBadge>
        <UiBadge v-if="statusMessage" :variant="statusBadgeVariant">
          {{ statusMessage }}
        </UiBadge>
        <UiButton
          type="button"
          variant="outline"
          size="lg"
          :disabled="!hasChanges || isSaving"
          @click="resetOrder"
        >
          撤销
        </UiButton>
        <UiButton
          type="button"
          variant="primary"
          size="lg"
          :loading="isSaving"
          :disabled="!hasChanges || isSaving"
          @click="saveOrder"
        >
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          保存顺序
        </UiButton>
      </UiPageActions>
    </Teleport>

    <UiCard
      class="preprocessor-order-panel"
      variant="subtle"
      size="sm"
      title="预处理器执行顺序"
      description="按住左侧手柄拖动排序，越靠上的插件越优先执行。保存后会触发热重载。"
      divided
    >
      <UiToolbar class="order-toolbar" density="compact">
        <div class="order-summary">
          <UiBadge variant="outline">
            {{ orderedPreprocessors.length }} 个预处理器
          </UiBadge>
        </div>
      </UiToolbar>

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
          <DragHandle
            label="拖动排序"
            @pointerdown="handleDragHandlePointerDown(plugin.name, $event)"
          />

          <span class="plugin-index">{{ index + 1 }}.</span>

          <span class="plugin-copy">
            <span class="plugin-name">{{ plugin.displayName || plugin.name }}</span>
            <span v-if="plugin.description" class="plugin-description">
              {{ plugin.description }}
            </span>
          </span>
        </li>
      </TransitionGroup>
    </UiCard>

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
import { computed, onBeforeUnmount, onMounted } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { usePreprocessorOrderManager } from "@/features/preprocessor-order-manager/usePreprocessorOrderManager";
import DragHandle from "@/components/ui/DragHandle.vue";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiDirtyIndicator from "@/components/ui/UiDirtyIndicator.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiToolbar from "@/components/ui/UiToolbar.vue";
import { askConfirm } from "@/platform/feedback/feedbackBus";

const {
  orderedPreprocessors,
  draggingPluginName,
  dragOverPluginName,
  dropPlacement,
  dragGhost,
  dragGhostElement,
  statusMessage,
  statusType,
  isSaving,
  hasChanges,
  changedItemCount,
  handleDragHandlePointerDown,
  resetOrder,
  saveOrder,
} = usePreprocessorOrderManager();

const statusBadgeVariant = computed(() => {
  if (statusType.value === "success") return "success";
  if (statusType.value === "error") return "danger";
  return "info";
});

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function handlePageHotkeys(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    if (isEditableTarget(event.target)) {
      return;
    }
    event.preventDefault();
    void saveOrder();
  }
}

onMounted(() => {
  document.addEventListener("keydown", handlePageHotkeys);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handlePageHotkeys);
});

onBeforeRouteLeave(async () => {
  if (!hasChanges.value) {
    return true;
  }

  return await askConfirm({
    message: "预处理器顺序有未保存改动，确定要离开吗？",
    danger: true,
    confirmText: "放弃改动",
  });
});

void dragGhostElement
</script>

<style scoped>
.preprocessor-order-panel {
  border-color: color-mix(in srgb, var(--border-color) 88%, transparent);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
}

.preprocessor-order-panel :deep(.ui-card__header) {
  border-bottom-color: color-mix(in srgb, var(--border-color) 88%, transparent);
}

.order-toolbar {
  min-height: 28px;
  margin-bottom: var(--space-2);
}

.order-summary {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.draggable-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 84%, transparent);
  border-radius: var(--radius-md);
  background: transparent;
}

.draggable-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 48px;
  padding: 8px 10px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: 0;
  background: transparent;
  will-change: transform;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    opacity 0.18s ease,
    filter 0.18s ease;
}

.draggable-item:last-child {
  border-bottom: 0;
}

.draggable-item:hover {
  background: color-mix(in srgb, var(--primary-text) 2.5%, transparent);
}

.draggable-item--dragging {
  opacity: 0.16;
  filter: saturate(0.88);
}

.draggable-item--drop-before::before,
.draggable-item--drop-after::after {
  content: "";
  position: absolute;
  left: 10px;
  right: 10px;
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

.plugin-index {
  min-width: 26px;
  color: var(--secondary-text);
  font-family: "Consolas", "Monaco", "Courier New", monospace;
  font-size: var(--font-size-helper);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
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
  line-height: 1.35;
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
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 28%, var(--border-color));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 96%, transparent);
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

@media (prefers-reduced-motion: reduce) {
  .draggable-item,
  .drag-sort-move,
  .drag-sort-enter-active,
  .drag-sort-leave-active {
    transition: none;
  }
}

</style>
