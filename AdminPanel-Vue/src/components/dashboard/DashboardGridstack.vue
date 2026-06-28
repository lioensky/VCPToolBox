<template>
  <div ref="gridElement" class="dashboard-gridstack grid-stack">
    <div
      v-for="card in cards"
      :key="card.instance.instanceId"
      class="dashboard-gridstack-item grid-stack-item"
      :gs-id="card.instance.instanceId"
      :gs-x="getGridWidget(card).x"
      :gs-y="getGridWidget(card).y"
      :gs-w="getGridWidget(card).w"
      :gs-h="getGridWidget(card).h"
      :gs-min-w="getGridWidget(card).minW"
      :gs-min-h="getGridWidget(card).minH"
      :gs-max-w="getGridWidget(card).maxW"
      :gs-max-h="getGridWidget(card).maxH"
    >
      <div class="dashboard-gridstack-content grid-stack-item-content">
        <slot :card="card" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import "gridstack/dist/gridstack.min.css";
import { GridStack, type GridStackNode, type GridStackOptions, type GridStackWidget } from "gridstack";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DashboardCardContribution,
  DashboardCardInstance,
} from "@/dashboard/core/types";

type DashboardGridstackBreakpoint = "lg" | "md" | "xs";

interface DashboardGridstackItemLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DashboardResolvedCard {
  instance: DashboardCardInstance;
  contribution: DashboardCardContribution | null;
  label: string;
}

const props = defineProps<{
  cards: DashboardResolvedCard[];
}>();

const gridElement = ref<HTMLElement | null>(null);
let grid: GridStack | null = null;
let persistTimer: number | null = null;
let isSyncingGrid = false;

const DASHBOARD_GRIDSTACK_LAYOUT_STORAGE_KEY =
  "dashboard.layout.gridstack.experimental";

const visibleCardKey = computed(() =>
  props.cards.map((card) => card.instance.instanceId).join("|")
);

const gridOptions: GridStackOptions = {
  column: 12,
  cellHeight: 22,
  margin: 8,
  float: false,
  animate: true,
  alwaysShowResizeHandle: "mobile",
  handle: ".dashboard-card-header, .dashboard-gridstack-content",
  draggable: {
    handle: ".dashboard-card-header, .dashboard-gridstack-content",
    scroll: false,
  },
  resizable: {
    handles: "se",
  },
  columnOpts: {
    breakpoints: [
      { w: 767, c: 1, layout: "list" },
      { w: 1279, c: 6, layout: "compact" },
    ],
    layout: "compact",
  },
};

onMounted(() => {
  void initializeGrid();
});

onBeforeUnmount(() => {
  destroyGrid();
});

watch(visibleCardKey, () => {
  void rebuildGrid();
});

function getBreakpoint(): DashboardGridstackBreakpoint {
  const width = gridElement.value?.clientWidth ?? window.innerWidth;
  if (width < 768) {
    return "xs";
  }

  if (width < 1280) {
    return "md";
  }

  return "lg";
}

function getColumnCount(): number {
  const breakpoint = getBreakpoint();
  if (breakpoint === "xs") {
    return 1;
  }

  if (breakpoint === "md") {
    return 6;
  }

  return 12;
}

function getGridWidget(card: DashboardResolvedCard): Required<
  Pick<GridStackWidget, "x" | "y" | "w" | "h" | "minW" | "minH" | "maxW" | "maxH">
> {
  const columnCount = getColumnCount();
  const breakpoint = getBreakpoint();
  const persistedLayout = readStoredGridstackLayouts()[breakpoint]?.[card.instance.instanceId];
  const fallbackWidth =
    breakpoint === "lg"
      ? card.instance.size.desktopCols
      : breakpoint === "md"
        ? card.instance.size.tabletCols
        : 1;
  const minWidth =
    breakpoint === "lg"
      ? card.contribution?.minSize.desktopCols ?? 1
      : breakpoint === "md"
        ? card.contribution?.minSize.tabletCols ?? 1
        : 1;
  const maxWidth =
    breakpoint === "lg"
      ? card.contribution?.maxSize.desktopCols ?? columnCount
      : breakpoint === "md"
        ? card.contribution?.maxSize.tabletCols ?? columnCount
        : 1;

  return {
    x: Math.min(persistedLayout?.x ?? 0, columnCount - 1),
    y: persistedLayout?.y ?? card.instance.order * card.instance.size.rows,
    w: Math.min(persistedLayout?.w ?? fallbackWidth, columnCount),
    h: persistedLayout?.h ?? card.instance.size.rows,
    minW: Math.min(Math.max(1, minWidth), columnCount),
    minH: card.contribution?.minSize.rows ?? 4,
    maxW: Math.min(Math.max(1, maxWidth), columnCount),
    maxH: Math.max(card.contribution?.maxSize.rows ?? 60, card.instance.size.rows, 40),
  };
}

async function initializeGrid() {
  await nextTick();
  if (!gridElement.value || grid) {
    return;
  }

  isSyncingGrid = true;
  grid = GridStack.init(gridOptions, gridElement.value);
  grid.on("change dragstop resizestop", queuePersistLayout);
  grid.compact("compact", false);
  isSyncingGrid = false;
}

async function rebuildGrid() {
  destroyGrid();
  await initializeGrid();
}

function destroyGrid() {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }

  if (!grid) {
    return;
  }

  grid.off("change");
  grid.off("dragstop");
  grid.off("resizestop");
  grid.destroy(false);
  grid = null;
}

function queuePersistLayout() {
  if (!grid || isSyncingGrid) {
    return;
  }

  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
  }

  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistLayout();
  }, 180);
}

function persistLayout() {
  if (!grid) {
    return;
  }

  const layouts: Record<string, DashboardGridstackItemLayout> = {};
  grid.engine.nodes.forEach((node: GridStackNode) => {
    const id = String(node.id ?? "");
    if (!id) {
      return;
    }

    layouts[id] = {
      x: Math.max(0, Math.round(node.x ?? 0)),
      y: Math.max(0, Math.round(node.y ?? 0)),
      w: Math.max(1, Math.round(node.w ?? 1)),
      h: Math.max(1, Math.round(node.h ?? 1)),
    };
  });

  writeStoredGridstackLayouts(getBreakpoint(), layouts);
}

function readStoredGridstackLayouts(): Partial<
  Record<DashboardGridstackBreakpoint, Record<string, DashboardGridstackItemLayout>>
> {
  try {
    const rawValue = window.localStorage.getItem(DASHBOARD_GRIDSTACK_LAYOUT_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsedValue = JSON.parse(rawValue) as unknown;
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return {};
    }

    return parsedValue as Partial<
      Record<DashboardGridstackBreakpoint, Record<string, DashboardGridstackItemLayout>>
    >;
  } catch {
    return {};
  }
}

function writeStoredGridstackLayouts(
  breakpoint: DashboardGridstackBreakpoint,
  layouts: Record<string, DashboardGridstackItemLayout>
) {
  const storedLayouts = readStoredGridstackLayouts();
  window.localStorage.setItem(
    DASHBOARD_GRIDSTACK_LAYOUT_STORAGE_KEY,
    JSON.stringify({
      ...storedLayouts,
      [breakpoint]: layouts,
    })
  );
}
</script>

<style scoped>
.dashboard-gridstack {
  width: 100%;
  min-height: 320px;
}

.dashboard-gridstack :deep(.grid-stack-placeholder > .placeholder-content) {
  border: 1px dashed var(--ring);
  border-radius: var(--radius-lg, 16px);
  background: color-mix(in srgb, var(--accent) 40%, transparent);
}

.dashboard-gridstack-item {
  min-width: 0;
}

.dashboard-gridstack-content {
  display: flex;
  overflow: visible;
  border-radius: var(--radius-xl, 18px);
  background: transparent;
}

.dashboard-gridstack-content > :deep(*) {
  flex: 1;
  min-width: 0;
  max-width: 100%;
  height: 100%;
}

.dashboard-gridstack :deep(.ui-resizable-se) {
  right: 8px;
  bottom: 8px;
  z-index: 120;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 4px;
  background-image: none;
  opacity: 0.58;
  transform: none;
  transition: opacity var(--transition-fast), background-color var(--transition-fast);
}

.dashboard-gridstack :deep(.ui-resizable-se::before),
.dashboard-gridstack :deep(.ui-resizable-se::after) {
  content: "";
  position: absolute;
  right: 3px;
  bottom: 4px;
  height: 1.5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted-foreground) 58%, transparent);
  transform: rotate(-45deg);
  transform-origin: center;
}

.dashboard-gridstack :deep(.ui-resizable-se::before) {
  width: 11px;
}

.dashboard-gridstack :deep(.ui-resizable-se::after) {
  right: 6px;
  bottom: 7px;
  width: 7px;
}

.dashboard-gridstack :deep(.grid-stack-item:hover > .ui-resizable-se),
.dashboard-gridstack :deep(.grid-stack-item:focus-within > .ui-resizable-se),
.dashboard-gridstack :deep(.ui-resizable-se:hover) {
  background-color: color-mix(in srgb, var(--muted) 56%, transparent);
  opacity: 1;
}

.dashboard-gridstack :deep(.ui-draggable-dragging .dashboard-card),
.dashboard-gridstack :deep(.ui-resizable-resizing .dashboard-card) {
  border-color: color-mix(in srgb, var(--ring) 45%, var(--border));
}

@media (prefers-reduced-motion: reduce) {
  .dashboard-gridstack :deep(.grid-stack-item) {
    transition: none !important;
  }
}
</style>
