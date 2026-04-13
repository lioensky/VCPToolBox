import { onBeforeUnmount, ref, shallowRef } from 'vue'

export interface PointerDragSessionState<TItem> {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  offsetX: number
  offsetY: number
  itemWidth: number
  itemHeight: number
  dragging: boolean
  rafId: number | null
  item: TItem
  captureElement: HTMLElement | null
}

interface StartPointerDragOptions<TItem> {
  item: TItem
  event: PointerEvent
  itemElement: HTMLElement
  captureElement: HTMLElement
}

interface UsePointerDragSessionOptions<TItem, TGhost> {
  activationDistance?: number
  ghostScale?: number
  ghostRotateDivisor?: number
  commitOnPointerCancel?: boolean
  commitOnWindowBlur?: boolean
  commitOnVisibilityHidden?: boolean
  createGhost: (item: TItem) => TGhost | null
  onActivate?: (state: PointerDragSessionState<TItem>) => void
  onFrame?: (state: PointerDragSessionState<TItem>) => void
  onCommit?: (state: PointerDragSessionState<TItem>) => void
  onCancel?: (state: PointerDragSessionState<TItem>) => void
  onClear?: () => void
}

const DEFAULT_ACTIVATION_DISTANCE = 8
const DEFAULT_GHOST_SCALE = 1.016
const DEFAULT_GHOST_ROTATE_DIVISOR = 34

export function usePointerDragSession<TItem, TGhost>(
  options: UsePointerDragSessionOptions<TItem, TGhost>
) {
  const pointerState = shallowRef<PointerDragSessionState<TItem> | null>(null)
  const dragGhostElement = ref<HTMLElement | null>(null)
  const dragGhost = shallowRef<TGhost | null>(null)

  function updateDragGhostPosition(state: PointerDragSessionState<TItem>) {
    const ghostElement = dragGhostElement.value
    if (!ghostElement) {
      return
    }

    const deltaX = state.currentX - state.startX
    const scale = options.ghostScale ?? DEFAULT_GHOST_SCALE
    const rotateDivisor =
      options.ghostRotateDivisor ?? DEFAULT_GHOST_ROTATE_DIVISOR
    const clampedRotate = Math.max(-2.2, Math.min(2.2, deltaX / rotateDivisor))

    ghostElement.style.left = `${state.currentX - state.offsetX}px`
    ghostElement.style.top = `${state.currentY - state.offsetY}px`
    ghostElement.style.width = `${state.itemWidth}px`
    ghostElement.style.height = `${state.itemHeight}px`
    ghostElement.style.transform =
      `translate3d(0, 0, 0) scale(${scale}) rotate(${clampedRotate}deg)`
  }

  function releasePointerCapture(state: PointerDragSessionState<TItem> | null) {
    const captureElement = state?.captureElement
    if (
      captureElement instanceof HTMLElement &&
      state &&
      captureElement.hasPointerCapture(state.pointerId)
    ) {
      captureElement.releasePointerCapture(state.pointerId)
    }
  }

  function removeGlobalPointerListeners() {
    if (typeof window === 'undefined') {
      return
    }

    window.removeEventListener('pointermove', handleGlobalPointerMove)
    window.removeEventListener('pointerup', handleGlobalPointerUp)
    window.removeEventListener('pointercancel', handleGlobalPointerCancel)
    window.removeEventListener('blur', handleWindowBlur)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }

  function clearInteractionState() {
    const state = pointerState.value
    if (state?.rafId != null) {
      cancelAnimationFrame(state.rafId)
    }

    releasePointerCapture(state)
    removeGlobalPointerListeners()

    pointerState.value = null
    dragGhost.value = null
    options.onClear?.()
  }

  function addGlobalPointerListeners() {
    if (typeof window === 'undefined') {
      return
    }

    window.addEventListener('pointermove', handleGlobalPointerMove, {
      passive: false,
    })
    window.addEventListener('pointerup', handleGlobalPointerUp, {
      passive: false,
    })
    window.addEventListener('pointercancel', handleGlobalPointerCancel, {
      passive: false,
    })
    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  function finishInteraction(commit: boolean) {
    const state = pointerState.value
    if (!state) {
      return
    }

    if (commit && state.dragging) {
      options.onCommit?.(state)
    } else if (!commit) {
      options.onCancel?.(state)
    }

    clearInteractionState()
  }

  function scheduleInteractionFrame() {
    const state = pointerState.value
    if (!state || state.rafId !== null) {
      return
    }

    state.rafId = requestAnimationFrame(() => {
      const activeState = pointerState.value
      if (!activeState) {
        return
      }

      activeState.rafId = null

      const deltaX = activeState.currentX - activeState.startX
      const deltaY = activeState.currentY - activeState.startY
      const movedDistance = Math.hypot(deltaX, deltaY)

      if (
        !activeState.dragging &&
        movedDistance <
          (options.activationDistance ?? DEFAULT_ACTIVATION_DISTANCE)
      ) {
        return
      }

      if (!activeState.dragging) {
        activeState.dragging = true
        dragGhost.value = options.createGhost(activeState.item)
        options.onActivate?.(activeState)
      }

      updateDragGhostPosition(activeState)
      options.onFrame?.(activeState)
    })
  }

  function startPointerDrag({
    item,
    event,
    itemElement,
    captureElement,
  }: StartPointerDragOptions<TItem>): boolean {
    if (pointerState.value) {
      return false
    }

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()

    const itemRect = itemElement.getBoundingClientRect()
    captureElement.setPointerCapture(event.pointerId)
    addGlobalPointerListeners()

    pointerState.value = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      offsetX: event.clientX - itemRect.left,
      offsetY: event.clientY - itemRect.top,
      itemWidth: itemRect.width,
      itemHeight: itemRect.height,
      dragging: false,
      rafId: null,
      item,
      captureElement,
    }

    return true
  }

  function handleGlobalPointerMove(event: PointerEvent) {
    const state = pointerState.value
    if (!state || state.pointerId !== event.pointerId) {
      return
    }

    state.currentX = event.clientX
    state.currentY = event.clientY
    event.preventDefault()
    scheduleInteractionFrame()
  }

  function handleGlobalPointerUp(event: PointerEvent) {
    const state = pointerState.value
    if (!state || state.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    finishInteraction(true)
  }

  function handleGlobalPointerCancel(event: PointerEvent) {
    const state = pointerState.value
    if (!state || state.pointerId !== event.pointerId) {
      return
    }

    finishInteraction(options.commitOnPointerCancel === true)
  }

  function handleWindowBlur() {
    if (pointerState.value) {
      finishInteraction(options.commitOnWindowBlur !== false)
    }
  }

  function handleVisibilityChange() {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      pointerState.value
    ) {
      finishInteraction(options.commitOnVisibilityHidden !== false)
    }
  }

  onBeforeUnmount(() => {
    clearInteractionState()
  })

  return {
    pointerState,
    dragGhost,
    dragGhostElement,
    startPointerDrag,
    handlePointerMove: handleGlobalPointerMove,
    handlePointerUp: handleGlobalPointerUp,
    handlePointerCancel: handleGlobalPointerCancel,
    clearInteractionState,
    finishInteraction,
  }
}
