<template>
  <div ref="containerRef" class="dual-pane-editor" :class="containerClass">
    <aside class="pane pane-left" :style="{ width: leftPaneWidth + 'px' }">
      <div class="pane-header">
        <h3>{{ leftTitle }}</h3>
        <slot name="left-actions"></slot>
      </div>
      <div class="pane-content">
        <slot name="left-content"></slot>
      </div>
    </aside>

    <div
      class="pane-resizer"
      :class="{ 'is-resizing': isResizing }"
      @mousedown="startResize"
      @touchstart="startResize"
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
import { computed, onMounted, onUnmounted, ref } from 'vue'

interface Props {
  leftTitle: string
  rightTitle: string
  initialLeftWidth?: number
  minLeftWidth?: number
  maxLeftWidth?: number
  layout?: 'horizontal' | 'vertical'
}

const props = withDefaults(defineProps<Props>(), {
  initialLeftWidth: 500,
  minLeftWidth: 300,
  maxLeftWidth: 800,
  layout: 'horizontal',
})

const RESIZER_SIZE = 16
const KEYBOARD_STEP = 24

const containerRef = ref<HTMLElement | null>(null)
const leftPaneWidth = ref(props.initialLeftWidth)
const rightPaneWidth = ref(800)
const containerWidth = ref(1300)
const isResizing = ref(false)

let resizeObserver: ResizeObserver | null = null

const containerClass = computed(() => ({
  'is-resizing': isResizing.value,
  'layout-vertical': props.layout === 'vertical',
}))

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
  if (!container) {
    return
  }

  syncPaneWidths(container.offsetWidth)
}

function startResize(event: MouseEvent | TouchEvent) {
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
  if (!containerRect) {
    return
  }

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
}

function handleResizerKeydown(event: KeyboardEvent) {
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
}

onMounted(() => {
  initContainerWidth()

  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      initContainerWidth()
    })
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
  stopResize()
  resizeObserver?.disconnect()
  resizeObserver = null
})

defineExpose({
  setLeftWidth: (width: number) => {
    leftPaneWidth.value = clampLeftPaneWidth(width)
    rightPaneWidth.value = Math.max(0, containerWidth.value - leftPaneWidth.value - RESIZER_SIZE)
  },
  getLeftWidth: () => leftPaneWidth.value,
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
  transition: width 0.1s linear;
}

.pane-right {
  flex: 1;
  min-width: 0;
}

.pane-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--tertiary-bg);
  gap: 12px;
}

.pane-header h3 {
  margin: 0;
  font-size: var(--font-size-body);
  color: var(--primary-text);
  white-space: nowrap;
}

.pane-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
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
