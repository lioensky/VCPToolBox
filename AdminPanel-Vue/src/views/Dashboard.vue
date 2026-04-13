<template>
  <section id="dashboard-section" class="config-section active-section">
    <VcpAnimation />

    <div class="dashboard-layout-toolbar">
      <p class="dashboard-layout-hint">
        按住卡片顶部拖动排序，右下角调整大小，布局会自动保存到本地。
      </p>
      <div class="dashboard-layout-actions">
        <button type="button" class="btn-primary dashboard-layout-manage" @click="showManager = true">
          管理卡片
        </button>
        <button type="button" class="btn-secondary dashboard-layout-reset" @click="resetLayout">
          恢复默认
        </button>
      </div>
    </div>

    <!-- 加载状态 -->
    <div v-if="!catalogReady" class="dashboard-loading">
      <div class="dashboard-loading-spinner"></div>
      <p>加载 Dashboard 卡片…</p>
    </div>

    <!-- 空状态 -->
    <div v-else-if="visibleCards.length === 0" class="dashboard-empty">
      <span class="material-symbols-outlined dashboard-empty-icon">dashboard</span>
      <h3>还没有添加任何卡片</h3>
      <p>点击"管理卡片"按钮开始自定义你的 Dashboard</p>
      <button type="button" class="btn-primary dashboard-empty-btn" @click="showManager = true">
        <span class="material-symbols-outlined">add</span>
        管理卡片
      </button>
    </div>

    <!-- 卡片网格 -->
    <div v-else ref="dashboardGridElement" class="dashboard-grid">
      <TransitionGroup name="dashboard-grid">
        <div
          v-for="card in visibleCards"
          :key="card.instance.instanceId"
          :data-card-id="card.instance.instanceId"
          :style="getCardGridStyle(card.instance.instanceId)"
          :class="[
            'dashboard-item',
            {
              'dashboard-item--dragging': draggingId === card.instance.instanceId,
              'dashboard-item--resizing': resizingId === card.instance.instanceId,
              'dashboard-item--drop-before':
                draggingId !== null &&
                dragOverId === card.instance.instanceId &&
                dropPlacement === 'before',
              'dashboard-item--drop-after':
                draggingId !== null &&
                dragOverId === card.instance.instanceId &&
                dropPlacement === 'after',
              'dashboard-item--pointer-active': pointerState?.instanceId === card.instance.instanceId,
            },
          ]"
        >
          <div
            class="dashboard-item-dragzone"
            @pointerdown="handleReorderPointerDown(card.instance.instanceId, $event)"
          ></div>

          <BuiltinCardHost
            v-if="isBuiltinContribution(card.contribution)"
            :contribution="card.contribution"
            :state="dashboardState as unknown as Record<string, unknown>"
          />
          <WebComponentCardHost
            v-else-if="isWebComponentContribution(card.contribution)"
            :contribution="card.contribution"
            :instance="card.instance"
            :theme="currentTheme"
          />
          <MissingCardHost v-else :instance="card.instance" />

          <button
            type="button"
            class="dashboard-item-resize-handle"
            :aria-label="`调整 ${card.label} 大小`"
            @pointerdown="handleResizePointerDown(card.instance.instanceId, $event)"
          ></button>
        </div>
      </TransitionGroup>
    </div>

    <div v-if="dragGhost" ref="dragGhostElement" class="dashboard-drag-ghost">
      <div class="dashboard-drag-ghost-shell">
        <div class="dashboard-drag-ghost-bar"></div>
        <div class="dashboard-drag-ghost-title">{{ dragGhost.label }}</div>
      </div>
    </div>

    <CardManager
      v-model="showManager"
      :contributions="cards"
      :instances="instances"
      @add-card="handleAddCard"
      @toggle-instance="handleToggleInstance"
      @remove-instance="removeInstance"
      @reset-layout="resetLayout"
    />
  </section>
</template>

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type CSSProperties,
} from "vue";
import CardManager from "@/components/dashboard/CardManager.vue";
import VcpAnimation from "@/components/dashboard/VcpAnimation.vue";
import { getBuiltinDashboardCards } from "@/dashboard/core/builtinCards";
import { useDashboardCatalog } from "@/dashboard/core/useDashboardCatalog";
import { useDashboardLayoutV2 } from "@/dashboard/core/useDashboardLayoutV2";
import type {
  BuiltinDashboardCardContribution,
  DashboardCardContribution,
  DashboardCardInstance,
  DashboardCardSize,
  DashboardDropPlacement,
  WebComponentDashboardCardContribution,
} from "@/dashboard/core/types";
import BuiltinCardHost from "@/dashboard/hosts/BuiltinCardHost.vue";
import MissingCardHost from "@/dashboard/hosts/MissingCardHost.vue";
import WebComponentCardHost from "@/dashboard/hosts/WebComponentCardHost.vue";
import { useDashboardState } from "@/composables/useDashboardState";
import { useAppStore } from "@/stores/app";
import { reorderIdsByPlacement } from "@/utils/pointerReorder";

interface DashboardGridMetrics {
  columnCount: number;
  columnWidth: number;
  columnGap: number;
  rowSize: number;
  rowGap: number;
}

interface DashboardResolvedCard {
  instance: DashboardCardInstance;
  contribution: DashboardCardContribution | null;
  label: string;
}

type DashboardViewportMode = "desktop" | "tablet" | "mobile";

interface DashboardPointerDragState {
  mode: "reorder";
  pointerId: number;
  instanceId: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  offsetX: number;
  offsetY: number;
  cardWidth: number;
  cardHeight: number;
  dragging: boolean;
  rafId: number | null;
  captureElement: HTMLElement | null;
}

interface DashboardPointerResizeState {
  mode: "resize";
  pointerId: number;
  instanceId: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startSize: DashboardCardSize;
  nextSize: DashboardCardSize;
  breakpoint: DashboardViewportMode;
  metrics: DashboardGridMetrics;
  rafId: number | null;
  captureElement: HTMLElement | null;
}

type DashboardPointerState = DashboardPointerDragState | DashboardPointerResizeState;

const DRAG_ACTIVATION_DISTANCE = 8;

const activeBuiltinComponentKeys = ref<string[]>([]);
const dashboardState = useDashboardState(activeBuiltinComponentKeys);
const appStore = useAppStore();
const currentTheme = computed(() => appStore.theme);
const builtinCards = computed(() => getBuiltinDashboardCards(dashboardState));
const { cards, contributionMap, catalogReady } = useDashboardCatalog(builtinCards);
const {
  instances,
  addCard,
  removeInstance,
  replaceInstances,
  resetLayout,
  setInstanceEnabled,
  setInstanceSize,
} = useDashboardLayoutV2(cards, catalogReady);

const dashboardGridElement = ref<HTMLElement | null>(null);
const dragGhostElement = ref<HTMLElement | null>(null);
const pointerState = ref<DashboardPointerState | null>(null);
const previewOrder = ref<string[] | null>(null);
const previewCardSizes = ref<Record<string, DashboardCardSize> | null>(null);
const draggingId = ref<string | null>(null);
const resizingId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);
const dropPlacement = ref<DashboardDropPlacement>("after");
const dragGhost = shallowRef<{ label: string } | null>(null);
const showManager = ref(false);

const activeCardOrder = computed(() => previewOrder.value ?? instances.value.map((item) => item.instanceId));
const activeCardSizes = computed(() => {
  if (previewCardSizes.value) {
    return previewCardSizes.value;
  }

  return Object.fromEntries(
    instances.value.map((instance) => [instance.instanceId, instance.size])
  ) as Record<string, DashboardCardSize>;
});

const orderedCards = computed<DashboardResolvedCard[]>(() => {
  const instanceMap = new Map(instances.value.map((instance) => [instance.instanceId, instance]));

  return activeCardOrder.value
    .map((instanceId) => instanceMap.get(instanceId))
    .filter((instance): instance is DashboardCardInstance => instance !== undefined)
    .map((instance) => {
      const contribution = contributionMap.value.get(instance.typeId) ?? null;
      return {
        instance,
        contribution,
        label: contribution?.title ?? instance.typeId,
      };
    });
});

const visibleCards = computed(() =>
  orderedCards.value.filter((item) => item.instance.enabled !== false)
);

watch(
  visibleCards,
  (cards) => {
    activeBuiltinComponentKeys.value = [
      ...new Set(
        cards.flatMap((card) =>
          isBuiltinContribution(card.contribution)
            ? [card.contribution.renderer.componentKey]
            : []
        )
      ),
    ];
  },
  { immediate: true }
);

const draggingCard = computed<DashboardResolvedCard | null>(() => {
  if (!draggingId.value) {
    return null;
  }

  return orderedCards.value.find((item) => item.instance.instanceId === draggingId.value) ?? null;
});

function createCardSizeSnapshot() {
  return Object.fromEntries(
    instances.value.map((instance) => [instance.instanceId, { ...instance.size }])
  ) as Record<string, DashboardCardSize>;
}

function getSizeBounds(instanceId: string) {
  const instance = instances.value.find((item) => item.instanceId === instanceId);
  const contribution = instance ? contributionMap.value.get(instance.typeId) : undefined;
  if (!contribution) {
    return {
      minSize: { desktopCols: 1, tabletCols: 1, rows: 4 },
      maxSize: { desktopCols: 12, tabletCols: 6, rows: 60 },
    };
  }

  return {
    minSize: contribution.minSize,
    maxSize: contribution.maxSize,
  };
}

function getCardGridStyle(instanceId: string): CSSProperties {
  const size = activeCardSizes.value[instanceId];

  return {
    "--dashboard-card-cols-desktop": String(size.desktopCols),
    "--dashboard-card-cols-tablet": String(size.tabletCols),
    "--dashboard-card-rows": String(size.rows),
  };
}

function getViewportMode(columnCount: number): DashboardViewportMode {
  if (columnCount <= 1) {
    return "mobile";
  }
  if (columnCount <= 6) {
    return "tablet";
  }
  return "desktop";
}

function getGridMetrics(): DashboardGridMetrics | null {
  const gridElement = dashboardGridElement.value;
  if (!(gridElement instanceof HTMLElement)) {
    return null;
  }

  const styles = window.getComputedStyle(gridElement);
  const gridTemplateColumns = styles.gridTemplateColumns
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
  const columnCount = gridTemplateColumns.length;
  if (columnCount === 0) {
    return null;
  }

  const columnGap = Number.parseFloat(styles.columnGap) || 0;
  const rowGap = Number.parseFloat(styles.rowGap) || 0;
  const rowSize = Number.parseFloat(styles.gridAutoRows) || 10;
  const { width } = gridElement.getBoundingClientRect();
  const columnWidth = (width - columnGap * (columnCount - 1)) / columnCount;

  return {
    columnCount,
    columnWidth,
    columnGap,
    rowSize,
    rowGap,
  };
}

function updateDragGhostPosition(state: DashboardPointerDragState) {
  const ghostElement = dragGhostElement.value;
  if (!ghostElement) {
    return;
  }

  const deltaX = state.currentX - state.startX;
  const clampedRotate = Math.max(-2.2, Math.min(2.2, deltaX / 30));
  ghostElement.style.left = `${state.currentX - state.offsetX}px`;
  ghostElement.style.top = `${state.currentY - state.offsetY}px`;
  ghostElement.style.width = `${state.cardWidth}px`;
  ghostElement.style.height = `${state.cardHeight}px`;
  ghostElement.style.transform =
    `translate3d(0, 0, 0) scale(1.018) rotate(${clampedRotate}deg)`;
}

function getDropPlacementForTarget(
  cardElement: HTMLElement,
  clientX: number,
  clientY: number
): DashboardDropPlacement {
  const rect = cardElement.getBoundingClientRect();
  const deltaX = clientX - (rect.left + rect.width / 2);
  const deltaY = clientY - (rect.top + rect.height / 2);

  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return deltaX < 0 ? "before" : "after";
  }

  return deltaY < 0 ? "before" : "after";
}

function updatePreviewOrder(clientX: number, clientY: number) {
  const state = pointerState.value;
  if (!draggingId.value || !state || state.mode !== "reorder") {
    return;
  }

  const hoveredElement = document.elementFromPoint(clientX, clientY);
  if (!(hoveredElement instanceof Element)) {
    return;
  }

  const cardElement = hoveredElement.closest(".dashboard-item[data-card-id]");
  if (!(cardElement instanceof HTMLElement)) {
    return;
  }

  const targetId = cardElement.dataset.cardId;
  if (!targetId || targetId === draggingId.value) {
    dragOverId.value = draggingId.value;
    return;
  }

  const workingOrder = previewOrder.value ?? [...instances.value.map((instance) => instance.instanceId)];
  const placement = getDropPlacementForTarget(cardElement, clientX, clientY);
  const nextOrder = reorderIdsByPlacement(
    workingOrder,
    draggingId.value,
    targetId,
    placement
  );

  dragOverId.value = targetId;
  dropPlacement.value = placement;

  const hasChanged = nextOrder.some((id, index) => id !== workingOrder[index]);
  if (hasChanged) {
    previewOrder.value = nextOrder;
  }
}

function updatePreviewSize(state: DashboardPointerResizeState) {
  const bounds = getSizeBounds(state.instanceId);
  const deltaX = state.currentX - state.startX;
  const deltaY = state.currentY - state.startY;
  const columnStep = state.metrics.columnWidth + state.metrics.columnGap;
  const rowStep = state.metrics.rowSize + state.metrics.rowGap;
  const columnDelta =
    state.breakpoint === "mobile" ? 0 : Math.round(deltaX / Math.max(columnStep, 1));
  const rowDelta = Math.round(deltaY / Math.max(rowStep, 1));

  const desktopCols =
    state.breakpoint === "desktop"
      ? Math.min(
          bounds.maxSize.desktopCols,
          Math.max(bounds.minSize.desktopCols, state.startSize.desktopCols + columnDelta)
        )
      : state.startSize.desktopCols;
  const tabletCols =
    state.breakpoint === "tablet"
      ? Math.min(
          Math.min(bounds.maxSize.tabletCols, desktopCols),
          Math.max(bounds.minSize.tabletCols, state.startSize.tabletCols + columnDelta)
        )
      : Math.min(state.startSize.tabletCols, desktopCols);
  const rows = Math.min(
    bounds.maxSize.rows,
    Math.max(bounds.minSize.rows, state.startSize.rows + rowDelta)
  );

  const nextSize: DashboardCardSize = {
    desktopCols,
    tabletCols,
    rows,
  };
  const previousSize = state.nextSize;

  if (
    previousSize.desktopCols === nextSize.desktopCols &&
    previousSize.tabletCols === nextSize.tabletCols &&
    previousSize.rows === nextSize.rows
  ) {
    return;
  }

  state.nextSize = nextSize;
  previewCardSizes.value = {
    ...(previewCardSizes.value ?? createCardSizeSnapshot()),
    [state.instanceId]: nextSize,
  };
}

function scheduleInteractionFrame() {
  const state = pointerState.value;
  if (!state || state.rafId !== null) {
    return;
  }

  state.rafId = requestAnimationFrame(() => {
    const activeState = pointerState.value;
    if (!activeState) {
      return;
    }

    activeState.rafId = null;

    if (activeState.mode === "reorder") {
      const deltaX = activeState.currentX - activeState.startX;
      const deltaY = activeState.currentY - activeState.startY;
      const movedDistance = Math.hypot(deltaX, deltaY);

      if (!activeState.dragging && movedDistance < DRAG_ACTIVATION_DISTANCE) {
        return;
      }

      if (!activeState.dragging) {
        activeState.dragging = true;
        draggingId.value = activeState.instanceId;
        dragOverId.value = activeState.instanceId;
        previewOrder.value = [...instances.value.map((instance) => instance.instanceId)];

        const card = draggingCard.value;
        if (card) {
          dragGhost.value = {
            label: card.label,
          };
        }
      }

      updateDragGhostPosition(activeState);
      updatePreviewOrder(activeState.currentX, activeState.currentY);
      return;
    }

    updatePreviewSize(activeState);
  });
}

function releasePointerCapture(state: DashboardPointerState | null) {
  const captureElement = state?.captureElement;
  if (
    captureElement instanceof HTMLElement &&
    state &&
    captureElement.hasPointerCapture(state.pointerId)
  ) {
    captureElement.releasePointerCapture(state.pointerId);
  }
}

function removeGlobalPointerListeners() {
  window.removeEventListener("pointermove", handleGlobalPointerMove);
  window.removeEventListener("pointerup", handleGlobalPointerUp);
  window.removeEventListener("pointercancel", handleGlobalPointerCancel);
  window.removeEventListener("blur", handleWindowBlur);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

function clearInteractionState() {
  const state = pointerState.value;
  if (state?.rafId != null) {
    cancelAnimationFrame(state.rafId);
  }

  releasePointerCapture(state);
  removeGlobalPointerListeners();

  pointerState.value = null;
  previewOrder.value = null;
  previewCardSizes.value = null;
  draggingId.value = null;
  resizingId.value = null;
  dragOverId.value = null;
  dropPlacement.value = "after";
  dragGhost.value = null;
}

function addGlobalPointerListeners() {
  window.addEventListener("pointermove", handleGlobalPointerMove, { passive: false });
  window.addEventListener("pointerup", handleGlobalPointerUp, { passive: false });
  window.addEventListener("pointercancel", handleGlobalPointerCancel, { passive: false });
  window.addEventListener("blur", handleWindowBlur);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function finishInteraction(commit: boolean) {
  const state = pointerState.value;
  if (!state) {
    return;
  }

  if (commit) {
    if (state.mode === "reorder" && state.dragging && previewOrder.value) {
      const instanceMap = new Map(instances.value.map((instance) => [instance.instanceId, instance]));
      replaceInstances(
        previewOrder.value
          .map((instanceId) => instanceMap.get(instanceId))
          .filter((instance): instance is DashboardCardInstance => instance !== undefined)
      );
    }

    if (state.mode === "resize" && previewCardSizes.value) {
      setInstanceSize(state.instanceId, previewCardSizes.value[state.instanceId]);
    }
  }

  clearInteractionState();
}

function handleReorderPointerDown(instanceId: string, event: PointerEvent) {
  if (pointerState.value) {
    return;
  }

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  const currentTarget = event.currentTarget;
  if (!(currentTarget instanceof HTMLElement)) {
    return;
  }

  const cardElement = currentTarget.closest(".dashboard-item");
  if (!(cardElement instanceof HTMLElement)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const cardRect = cardElement.getBoundingClientRect();
  currentTarget.setPointerCapture(event.pointerId);
  addGlobalPointerListeners();

  pointerState.value = {
    mode: "reorder",
    pointerId: event.pointerId,
    instanceId,
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    offsetX: event.clientX - cardRect.left,
    offsetY: event.clientY - cardRect.top,
    cardWidth: cardRect.width,
    cardHeight: cardRect.height,
    dragging: false,
    rafId: null,
    captureElement: currentTarget,
  };
}

function handleResizePointerDown(instanceId: string, event: PointerEvent) {
  if (pointerState.value) {
    return;
  }

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  const currentTarget = event.currentTarget;
  if (!(currentTarget instanceof HTMLElement)) {
    return;
  }

  const metrics = getGridMetrics();
  if (!metrics) {
    return;
  }

  const currentInstance = instances.value.find((instance) => instance.instanceId === instanceId);
  if (!currentInstance) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const startSize = { ...currentInstance.size };
  previewCardSizes.value = {
    ...createCardSizeSnapshot(),
    [instanceId]: startSize,
  };
  resizingId.value = instanceId;

  currentTarget.setPointerCapture(event.pointerId);
  addGlobalPointerListeners();
  pointerState.value = {
    mode: "resize",
    pointerId: event.pointerId,
    instanceId,
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    startSize,
    nextSize: startSize,
    breakpoint: getViewportMode(metrics.columnCount),
    metrics,
    rafId: null,
    captureElement: currentTarget,
  };
}

function handleGlobalPointerMove(event: PointerEvent) {
  const state = pointerState.value;
  if (!state || state.pointerId !== event.pointerId) {
    return;
  }

  state.currentX = event.clientX;
  state.currentY = event.clientY;

  event.preventDefault();
  scheduleInteractionFrame();
}

function handleGlobalPointerUp(event: PointerEvent) {
  const state = pointerState.value;
  if (!state || state.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  finishInteraction(true);
}

function handleGlobalPointerCancel(event: PointerEvent) {
  const state = pointerState.value;
  if (!state || state.pointerId !== event.pointerId) {
    return;
  }

  finishInteraction(false);
}

function handleWindowBlur() {
  if (pointerState.value) {
    finishInteraction(true);
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden" && pointerState.value) {
    finishInteraction(true);
  }
}

function handleAddCard(typeId: string) {
  addCard(typeId);
}

function isBuiltinContribution(
  contribution: DashboardCardContribution | null
): contribution is BuiltinDashboardCardContribution {
  return contribution?.renderer.kind === "builtin";
}

function isWebComponentContribution(
  contribution: DashboardCardContribution | null
): contribution is WebComponentDashboardCardContribution {
  return contribution?.renderer.kind === "web-component";
}

function handleToggleInstance(payload: { instanceId: string; enabled: boolean }) {
  setInstanceEnabled(payload.instanceId, payload.enabled);
}

onBeforeUnmount(() => {
  clearInteractionState();
});
</script>

<style scoped>
.config-section {
  animation: fadeIn 0.5s ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .config-section {
    animation: none;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 加载状态 */
.dashboard-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-8, 64px) var(--space-4, 16px);
  text-align: center;
  color: var(--secondary-text);
}

.dashboard-loading-spinner {
  width: 48px;
  height: 48px;
  border: 4px solid var(--border-color);
  border-top-color: var(--highlight-text);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dashboard-loading-spinner {
    animation: none;
  }
}

.dashboard-loading p {
  margin-top: var(--space-4, 16px);
  font-size: var(--font-size-body);
}

/* 空状态 */
.dashboard-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-8, 64px) var(--space-4, 16px);
  text-align: center;
  color: var(--secondary-text);
}

.dashboard-empty-icon {
  font-size: var(--font-size-icon-hero) !important;
  margin-bottom: var(--space-5, 24px);
  opacity: 0.3;
  color: var(--highlight-text);
}

.dashboard-empty h3 {
  font-size: var(--font-size-title);
  color: var(--primary-text);
  margin-bottom: var(--space-2, 8px);
}

.dashboard-empty p {
  font-size: var(--font-size-body);
  max-width: 400px;
  line-height: 1.6;
  margin-bottom: var(--space-5, 24px);
}

.dashboard-empty-btn {
  border-radius: 999px;
  font-size: var(--font-size-body);
  font-weight: 600;
}

.dashboard-empty-btn:hover {
  transform: translateY(-2px);
}

.dashboard-layout-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4, 16px);
  margin-bottom: var(--space-5, 24px);
  padding: var(--space-3, 12px) var(--space-4, 16px);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl, 20px);
  background:
    linear-gradient(180deg, var(--surface-overlay), var(--surface-overlay-soft)),
    var(--secondary-bg);
}

.dashboard-layout-hint {
  margin: 0;
  font-size: var(--font-size-body);
  line-height: 1.5;
  color: var(--secondary-text);
}

.dashboard-layout-actions {
  display: flex;
  gap: 10px;
}

.dashboard-layout-manage,
.dashboard-layout-reset {
  flex-shrink: 0;
  padding: 9px 14px;
  border-radius: 999px;
  font-size: var(--font-size-helper);
  font-weight: 700;
}

.dashboard-layout-manage:hover,
.dashboard-layout-reset:hover {
  transform: translateY(-1px);
}

.dashboard-grid {
  --dashboard-grid-column-gap: var(--space-4, 16px);
  --dashboard-grid-row-gap: var(--space-4, 16px);
  --dashboard-grid-row-size: var(--space-2, 8px);
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-auto-flow: dense;
  grid-auto-rows: var(--dashboard-grid-row-size);
  column-gap: var(--dashboard-grid-column-gap);
  row-gap: var(--dashboard-grid-row-gap);
  align-items: stretch;
}

.dashboard-item {
  --dashboard-card-cols: var(--dashboard-card-cols-desktop);
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  grid-column: span var(--dashboard-card-cols);
  grid-row: span var(--dashboard-card-rows);
  transition:
    opacity var(--transition-fast),
    filter var(--transition-fast),
    transform var(--transition-fast);
}

.dashboard-item > *:nth-child(2) {
  flex: 1;
  min-width: 0;
  max-width: 100%;
  height: 100%;
}

.dashboard-item--dragging {
  opacity: 0.14;
  filter: saturate(0.9);
}

.dashboard-item--resizing,
.dashboard-item--pointer-active {
  z-index: 5;
}

.dashboard-item--drop-before::before,
.dashboard-item--drop-after::after {
  content: "";
  position: absolute;
  left: 10px;
  right: 10px;
  z-index: 3;
  height: 3px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--dashboard-accent, var(--highlight-text)),
    transparent
  );
  box-shadow: 0 0 16px color-mix(
    in srgb,
    var(--dashboard-accent, var(--highlight-text)) 28%,
    transparent
  );
}

.dashboard-item--drop-before::before {
  top: -8px;
}

.dashboard-item--drop-after::after {
  bottom: -8px;
}

.dashboard-item-dragzone {
  position: absolute;
  top: 0;
  left: var(--space-4, 16px);
  right: var(--space-4, 16px);
  z-index: 4;
  height: var(--space-4, 16px);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.dashboard-item-dragzone:active {
  cursor: grabbing;
}

.dashboard-item--pointer-active :deep(.dashboard-card-shell::before),
.dashboard-item:hover :deep(.dashboard-card-shell::before) {
  opacity: 1;
}

.dashboard-item-resize-handle {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 4;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: nwse-resize;
  touch-action: none;
}

.dashboard-item-resize-handle:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-radius: 4px;
}

.dashboard-item-resize-handle::before,
.dashboard-item-resize-handle::after {
  content: "";
  position: absolute;
  right: 3px;
  bottom: 5px;
  border-radius: 999px;
  background: var(--secondary-text);
  transform-origin: center;
}

.dashboard-item-resize-handle::before {
  width: 11px;
  height: 2px;
  transform: rotate(-45deg);
}

.dashboard-item-resize-handle::after {
  right: 7px;
  bottom: 9px;
  width: 7px;
  height: 2px;
  transform: rotate(-45deg);
}

.dashboard-item--resizing :deep(.dashboard-card-shell),
.dashboard-item--pointer-active :deep(.dashboard-card-shell) {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  box-shadow: 0 24px 44px -30px color-mix(
    in srgb,
    var(--dashboard-accent, var(--highlight-text)) 22%,
    transparent
  );
}

.dashboard-grid-move {
  transition: transform var(--transition-spring);
}

.dashboard-grid-enter-active,
.dashboard-grid-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.dashboard-grid-enter-from,
.dashboard-grid-leave-to {
  opacity: 0;
  transform: scale(0.98);
}

.dashboard-drag-ghost {
  position: fixed;
  z-index: 60;
  pointer-events: none;
  will-change: left, top, transform;
}

.dashboard-drag-ghost-shell {
  position: relative;
  display: flex;
  align-items: flex-start;
  min-height: 100%;
  padding: 28px 24px 20px;
  border: 1px solid var(--info-border);
  border-radius: var(--dashboard-radius, 20px);
  background:
    linear-gradient(180deg, var(--surface-overlay-strong), var(--surface-overlay-soft)),
    var(--secondary-bg);
  backdrop-filter: var(--glass-blur, blur(12px));
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}

.dashboard-drag-ghost-bar {
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--dashboard-accent, var(--highlight-text)),
    transparent
  );
  opacity: 0.95;
}

.dashboard-drag-ghost-title {
  font-size: var(--font-size-body);
  font-weight: 700;
  line-height: 1.3;
  color: var(--primary-text);
}

@media (max-width: 1279px) {
  .dashboard-grid {
    --dashboard-grid-column-gap: 16px;
    --dashboard-grid-row-gap: 16px;
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .dashboard-item {
    --dashboard-card-cols: var(--dashboard-card-cols-tablet);
  }
}

@media (max-width: 767px) {
  .dashboard-layout-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .dashboard-layout-actions {
    width: 100%;
    flex-direction: column;
  }

  .dashboard-layout-manage,
  .dashboard-layout-reset {
    width: 100%;
  }

  .dashboard-grid {
    --dashboard-grid-column-gap: 14px;
    --dashboard-grid-row-gap: 14px;
    grid-template-columns: 1fr;
  }

  .dashboard-item {
    grid-column: 1 / -1;
  }

  .dashboard-item--drop-before::before,
  .dashboard-item--drop-after::after {
    left: 8px;
    right: 8px;
  }
}

@media (max-width: 480px) {
  .dashboard-layout-toolbar {
    margin-bottom: 18px;
    padding: 12px 14px;
    border-radius: 16px;
  }

  .dashboard-layout-hint {
    font-size: var(--font-size-body);
  }

  .dashboard-item-dragzone {
    left: 12px;
    right: 12px;
  }

  .dashboard-item-resize-handle {
    right: 6px;
    bottom: 6px;
  }
}
</style>
