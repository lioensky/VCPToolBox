<template>
  <div ref="containerRef" class="dual-pane-editor" :class="containerClass">
    <aside
      class="pane pane-left"
      :class="{ collapsed: isPaneCollapsed }"
      :style="isPaneCollapsed ? { width: props.collapsedWidth + 'px' } : { width: leftPaneWidth + 'px' }"
      :aria-label="isPaneCollapsed ? `${leftTitle}（已折叠）` : leftTitle"
    >
      <div v-if="isPaneCollapsed" class="pane-header pane-header--collapsed">
        <button
          type="button"
          class="pane-toggle-btn"
          :aria-expanded="false"
          :aria-label="`展开${leftTitle}`"
          :title="`展开${leftTitle}`"
          @click="expandLeftPane"
        >
          <span class="material-symbols-outlined">left_panel_open</span>
        </button>
      </div>

      <div v-else class="pane-header">
        <h3>{{ leftTitle }}</h3>
        <div class="pane-header-actions">
          <slot name="left-actions"></slot>
          <button
            v-if="canCollapse"
            type="button"
            class="pane-toggle-btn"
            :aria-expanded="true"
            :aria-label="`折叠${leftTitle}`"
            :title="`折叠${leftTitle}`"
            @click="collapseLeftPane"
          >
            <span class="material-symbols-outlined">left_panel_close</span>
          </button>
        </div>
      </div>

      <div v-if="isPaneCollapsed" class="pane-content pane-content--collapsed">
        <slot name="left-collapsed">
          <div class="collapsed-placeholder">
            <span class="material-symbols-outlined">view_agenda</span>
          </div>
        </slot>
      </div>
      <div v-else class="pane-content">
        <slot name="left-content"></slot>
      </div>
    </aside>

    <div
      class="pane-resizer"
      :class="{ 'is-resizing': isResizing, collapsed: isPaneCollapsed }"
      @mousedown="startResize"
      @touchstart="startResize"
      @dblclick="toggleCollapseFromResizer"
      @keydown="handleResizerKeydown"
      role="separator"
      tabindex="0"
      :aria-orientation="props.layout === 'vertical' ? 'horizontal' : 'vertical'"
      :aria-label="props.layout === 'vertical' ? '调整面板高度' : '调整面板宽度'"
      :aria-valuemin="props.minLeftWidth"
      :aria-valuemax="props.maxLeftWidth"
      :aria-valuenow="Math.round(leftPaneWidth)"
    >
      <div class="resizer-bar"></div>
    </div>

    <main class="pane pane-right" :style="{ width: rightPaneWidth + 'px' }">
      <div class="pane-header">
        <h3>{{ rightTitle }}</h3>
        <slot name="right-actions"></slot>
      </div>
      <div class="pane-content">
        <slot name="right-content"></slot>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

interface Props {
  leftTitle: string
  rightTitle: string
  initialLeftWidth?: number
  minLeftWidth?: number
  maxLeftWidth?: number
  layout?: 'horizontal' | 'vertical'
  collapsible?: boolean
  collapsedWidth?: number
  persistKey?: string
}

const props = withDefaults(defineProps<Props>(), {
  initialLeftWidth: 500,
  minLeftWidth: 300,
  maxLeftWidth: 800,
  layout: 'horizontal',
  collapsible: false,
  collapsedWidth: 48,
})

const RESIZER_SIZE = 16
const KEYBOARD_STEP = 24
const COLLAPSE_DISABLED_BREAKPOINT = 1024

const containerRef = ref<HTMLElement | null>(null)
const leftPaneWidth = ref(props.initialLeftWidth)
const rightPaneWidth = ref(800)
const containerWidth = ref(1300)
const isResizing = ref(false)
const isCollapsed = ref(false)
const isCompactViewport = ref(false)

let lastExpandedWidth = props.initialLeftWidth
let resizeObserver: ResizeObserver | null = null

const canCollapse = computed(() => props.collapsible && !isCompactViewport.value)
const isPaneCollapsed = computed(() => canCollapse.value && isCollapsed.value)

const containerClass = computed(() => ({
  'is-resizing': isResizing.value,
  'layout-vertical': props.layout === 'vertical',
}))

function storageKey(): string | null {
  if (!props.persistKey) return null
  return `dualPane:${props.persistKey}`
}

function loadPersistedState() {
  const key = storageKey()
  if (!key) return
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw) as { width?: number; collapsed?: boolean }
      if (typeof parsed.width === 'number') {
        lastExpandedWidth = clampLeftPaneWidth(parsed.width)
      }
      if (typeof parsed.collapsed === 'boolean') {
        isCollapsed.value = parsed.collapsed
      }
    }
  } catch {
    // ignore corrupted storage
  }
}

function persistState() {
  const key = storageKey()
  if (!key) return
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        width: lastExpandedWidth,
        collapsed: canCollapse.value ? isCollapsed.value : false,
      })
    )
  } catch {
    // ignore storage errors
  }
}

function updateCompactViewport() {
  const container = containerRef.value
  const nextWidth = container?.offsetWidth ?? window.innerWidth
  isCompactViewport.value = nextWidth <= COLLAPSE_DISABLED_BREAKPOINT
}

function clampLeftPaneWidth(width: number): number {
  return Math.max(props.minLeftWidth, Math.min(props.maxLeftWidth, width))
}

function syncPaneWidths(totalWidth: number, preferredLeftWidth = leftPaneWidth.value) {
  containerWidth.value = totalWidth
  leftPaneWidth.value = clampLeftPaneWidth(preferredLeftWidth)
  rightPaneWidth.value = Math.max(0, totalWidth - leftPaneWidth.value - RESIZER_SIZE)
}

function initContainerWidth() {
  const container = containerRef.value
  if (!container) return

  if (isPaneCollapsed.value) {
    containerWidth.value = container.offsetWidth
    rightPaneWidth.value = Math.max(0, container.offsetWidth - props.collapsedWidth - RESIZER_SIZE)
    leftPaneWidth.value = props.collapsedWidth
  } else {
    syncPaneWidths(container.offsetWidth, lastExpandedWidth)
  }
}

function collapseLeftPane() {
  if (!canCollapse.value) return
  lastExpandedWidth = clampLeftPaneWidth(leftPaneWidth.value)
  isCollapsed.value = true
  initContainerWidth()
  persistState()
}

function expandLeftPane() {
  if (leftPaneWidth.value <= props.collapsedWidth) {
    leftPaneWidth.value = clampLeftPaneWidth(lastExpandedWidth)
  }
  isCollapsed.value = false
  initContainerWidth()
  persistState()
}

function toggleCollapseFromResizer() {
  if (!canCollapse.value) return
  if (isPaneCollapsed.value) {
    expandLeftPane()
  } else {
    collapseLeftPane()
  }
}

function startResize(event: MouseEvent | TouchEvent) {
  if (isPaneCollapsed.value) return
  event.preventDefault()
  isResizing.value = true
  document.addEventListener('mousemove', onResize)
  document.addEventListener('mouseup', stopResize)
  document.addEventListener('touchmove', onResize, { passive: false })
  document.addEventListener('touchend', stopResize)
  document.body.style.cursor = props.layout === 'vertical' ? 'row-resize' : 'col-resize'
  document.body.style.userSelect = 'none'
}

function onResize(event: MouseEvent | TouchEvent) {
  event.preventDefault()

  const containerRect = containerRef.value?.getBoundingClientRect()
  if (!containerRect) return

  const clientPosition =
    'touches' in event
      ? props.layout === 'vertical'
        ? event.touches[0].clientY
        : event.touches[0].clientX
      : props.layout === 'vertical'
        ? event.clientY
        : event.clientX

  const nextLeftWidth =
    props.layout === 'vertical'
      ? clientPosition - containerRect.top
      : clientPosition - containerRect.left

  leftPaneWidth.value = clampLeftPaneWidth(nextLeftWidth)
  rightPaneWidth.value = Math.max(
    0,
    (props.layout === 'vertical' ? containerRect.height : containerRect.width) -
      leftPaneWidth.value -
      RESIZER_SIZE
  )
}

function stopResize() {
  isResizing.value = false
  document.removeEventListener('mousemove', onResize)
  document.removeEventListener('mouseup', stopResize)
  document.removeEventListener('touchmove', onResize)
  document.removeEventListener('touchend', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  persistState()
}

function handleResizerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    if (!canCollapse.value) return
    event.preventDefault()
    toggleCollapseFromResizer()
    return
  }
  const horizontal = props.layout === 'horizontal'
  const decreaseKeys = horizontal ? ['ArrowLeft'] : ['ArrowUp']
  const increaseKeys = horizontal ? ['ArrowRight'] : ['ArrowDown']

  if (!decreaseKeys.includes(event.key) && !increaseKeys.includes(event.key)) {
    return
  }

  event.preventDefault()
  const delta = decreaseKeys.includes(event.key) ? -KEYBOARD_STEP : KEYBOARD_STEP
  leftPaneWidth.value = clampLeftPaneWidth(leftPaneWidth.value + delta)
  rightPaneWidth.value = Math.max(0, containerWidth.value - leftPaneWidth.value - RESIZER_SIZE)
  persistState()
}

onMounted(() => {
  loadPersistedState()
  updateCompactViewport()

  if (!canCollapse.value) {
    isCollapsed.value = false
  }

  initContainerWidth()

  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateCompactViewport()
      if (!canCollapse.value && isCollapsed.value) {
        isCollapsed.value = false
      }
      initContainerWidth()
    })
    resizeObserver.observe(containerRef.value)
  }
})

watch(canCollapse, (nextCanCollapse) => {
  if (!nextCanCollapse && isCollapsed.value) {
    isCollapsed.value = false
    initContainerWidth()
    persistState()
    return
  }

  if (nextCanCollapse) {
    initContainerWidth()
  }
})

onUnmounted(() => {
  stopResize()
  resizeObserver?.disconnect()
  resizeObserver = null
})

defineExpose({
  setLeftWidth: (width: number) => {
    if (isCollapsed.value) return
    leftPaneWidth.value = clampLeftPaneWidth(width)
    rightPaneWidth.value = Math.max(0, containerWidth.value - leftPaneWidth.value - RESIZER_SIZE)
    persistState()
  },
  getLeftWidth: () => leftPaneWidth.value,
  collapseLeftPane,
  expandLeftPane,
  toggleCollapse: toggleCollapseFromResizer,
})
</script>

<style scoped>
.dual-pane-editor {
  display: flex;
  gap: 0;
  height: var(--dual-pane-height, calc(var(--app-viewport-height, 100vh) - 180px));
  min-height: var(--dual-pane-min-height, 500px);
  position: relative;
}

.pane {
  display: flex;
  flex-direction: column;
  background: var(--secondary-bg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  overflow: hidden;
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.pane-left {
  flex-shrink: 0;
  transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.pane-left.collapsed {
  border-radius: var(--radius-md);
}

.pane-right {
  flex: 1;
  min-width: 0;
}

.pane-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--tertiary-bg);
  gap: 10px 12px;
  min-height: 56px;
}

.pane-header--collapsed {
  justify-content: center;
  padding: 12px 4px;
}

.pane-header h3 {
  flex: 1 1 auto;
  min-width: 120px;
  margin: 0;
  font-size: var(--font-size-body);
  line-height: 1.3;
  color: var(--primary-text);
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  word-break: break-word;
}

.pane-header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 1 1 auto;
  min-width: 0;
  gap: 8px;
}

.pane-left .pane-header-actions {
  width: 100%;
}

.pane-toggle-btn {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--secondary-text);
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
  flex-shrink: 0;
}

.pane-toggle-btn:hover {
  background: var(--accent-bg);
  color: var(--primary-text);
  border-color: var(--border-color);
}

.pane-toggle-btn:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: -2px;
}

.pane-toggle-btn .material-symbols-outlined {
  font-size: 20px;
}

.pane-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.pane-content--collapsed {
  padding: 8px 4px;
}

.collapsed-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding-top: 8px;
  color: var(--secondary-text);
}

.collapsed-placeholder .material-symbols-outlined {
  font-size: 24px;
}

.pane-resizer {
  width: 16px;
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--secondary-bg);
  border-left: 1px solid var(--border-color);
  border-right: 1px solid var(--border-color);
  transition: background 0.2s;
  flex-shrink: 0;
  z-index: 10;
  user-select: none;
}

.pane-resizer.collapsed {
  cursor: pointer;
}

.pane-resizer:hover,
.pane-resizer.is-resizing {
  background: var(--accent-bg);
}

.pane-resizer:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: -2px;
}

.resizer-bar {
  width: 4px;
  height: 40px;
  background: var(--border-color);
  border-radius: 2px;
  transition: background 0.2s;
}

.pane-resizer:hover .resizer-bar,
.pane-resizer.is-resizing .resizer-bar,
.pane-resizer:focus-visible .resizer-bar {
  background: var(--highlight-text);
}

.layout-vertical {
  flex-direction: column;
}

.layout-vertical .pane-left {
  width: 100% !important;
  height: 50%;
}

.layout-vertical .pane-right {
  width: 100% !important;
  height: 50%;
}

.layout-vertical .pane-resizer {
  width: 100%;
  height: 16px;
  cursor: row-resize;
  flex-direction: column;
  border-left: none;
  border-right: none;
  border-top: 1px solid var(--border-color);
  border-bottom: 1px solid var(--border-color);
}

.layout-vertical .resizer-bar {
  width: 40px;
  height: 4px;
}

.dual-pane-editor.is-resizing {
  user-select: none;
  -webkit-user-select: none;
}

.dual-pane-editor.is-resizing * {
  cursor: col-resize !important;
}

.layout-vertical.dual-pane-editor.is-resizing * {
  cursor: row-resize !important;
}

@media (max-width: 1024px) {
  .dual-pane-editor {
    flex-direction: column;
    height: auto;
    min-height: auto;
  }

  .pane-left,
  .pane-right {
    width: 100% !important;
    height: auto;
  }

  .pane-left {
    min-height: 400px;
  }

  .pane-right {
    min-height: 400px;
  }

  .pane-resizer {
    display: none;
  }

  .pane-left .pane-header-actions {
    justify-content: flex-start;
  }
}

.pane-content::-webkit-scrollbar {
  width: 8px;
}

.pane-content::-webkit-scrollbar-track {
  background: var(--tertiary-bg);
}

.pane-content::-webkit-scrollbar-thumb {
  background: var(--secondary-text);
  border-radius: 4px;
  opacity: 0.5;
}

.pane-content::-webkit-scrollbar-thumb:hover {
  background: var(--primary-text);
}
</style>
