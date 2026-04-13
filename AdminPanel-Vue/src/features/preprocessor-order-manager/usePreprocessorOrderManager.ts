import { computed, onMounted, ref } from 'vue'
import { adminConfigApi } from '@/api'
import type { Preprocessor } from '@/types/api.admin-config'
import { usePointerDragSession } from '@/composables/usePointerDragSession'
import { showMessage } from '@/utils'
import { createLogger } from '@/utils/logger'
import {
  getVerticalDropPlacement,
  reorderIdsByPlacement,
  type PointerDropPlacement,
} from '@/utils/pointerReorder'
import type { PreprocessorOrderStatusType } from './types'

const logger = createLogger('PreprocessorOrderManager')

export function usePreprocessorOrderManager() {
  const preprocessors = ref<Preprocessor[]>([])
  const statusMessage = ref('')
  const statusType = ref<PreprocessorOrderStatusType>('info')
  const previewOrder = ref<string[] | null>(null)
  const draggingPluginName = ref<string | null>(null)
  const dragOverPluginName = ref<string | null>(null)
  const dropPlacement = ref<PointerDropPlacement>('after')

  const orderedPreprocessors = computed<Preprocessor[]>(() => {
    if (!previewOrder.value) {
      return preprocessors.value
    }

    const itemMap = new Map(preprocessors.value.map((item) => [item.name, item] as const))
    return previewOrder.value
      .map((name) => itemMap.get(name))
      .filter((item): item is Preprocessor => item !== undefined)
  })

  function getCommittedOrder(): string[] {
    return preprocessors.value.map((item) => item.name)
  }

  function getWorkingOrder(): string[] {
    return previewOrder.value ?? getCommittedOrder()
  }

  function commitPreviewOrder(nextOrder: readonly string[]) {
    const itemMap = new Map(preprocessors.value.map((item) => [item.name, item] as const))
    preprocessors.value = nextOrder
      .map((name) => itemMap.get(name))
      .filter((item): item is Preprocessor => item !== undefined)
  }

  function updatePreviewOrder(clientX: number, clientY: number) {
    const draggedId = draggingPluginName.value
    if (!draggedId || typeof document === 'undefined') {
      return
    }

    const hoveredElement = document.elementFromPoint(clientX, clientY)
    if (!(hoveredElement instanceof Element)) {
      dragOverPluginName.value = null
      return
    }

    const workingOrder = getWorkingOrder()
    const itemElement = hoveredElement.closest('[data-preprocessor-name]') as HTMLElement | null
    const listElement = hoveredElement.closest('[data-preprocessor-list="true"]') as
      | HTMLElement
      | null

    let targetId: string | null = null
    let placement: PointerDropPlacement = 'after'

    if (itemElement) {
      targetId = itemElement.dataset.preprocessorName ?? null
      placement = getVerticalDropPlacement(itemElement, clientY)
    } else if (listElement && workingOrder.length > 0) {
      targetId = workingOrder[workingOrder.length - 1] ?? null
      placement = 'after'
    }

    if (!targetId) {
      dragOverPluginName.value = null
      return
    }

    const nextOrder = reorderIdsByPlacement(workingOrder, draggedId, targetId, placement)
    const hasChanged = nextOrder.some((id, index) => id !== workingOrder[index])

    dragOverPluginName.value = hasChanged ? targetId : null
    dropPlacement.value = placement

    if (hasChanged) {
      previewOrder.value = nextOrder
    }
  }

  const { dragGhost, dragGhostElement, startPointerDrag, handlePointerMove, handlePointerUp } =
    usePointerDragSession<{ pluginName: string }, { label: string; description?: string }>({
      ghostScale: 1.015,
      createGhost: ({ pluginName }) => {
        const activeItem = preprocessors.value.find((item) => item.name === pluginName) ?? null

        if (!activeItem) {
          return null
        }

        return {
          label: activeItem.displayName || activeItem.name,
          description: activeItem.description,
        }
      },
      onActivate: ({ item }) => {
        draggingPluginName.value = item.pluginName
        previewOrder.value = getCommittedOrder()
      },
      onFrame: (state) => {
        updatePreviewOrder(state.currentX, state.currentY)
      },
      onCommit: () => {
        if (previewOrder.value) {
          commitPreviewOrder(previewOrder.value)
        }
      },
      onClear: () => {
        previewOrder.value = null
        draggingPluginName.value = null
        dragOverPluginName.value = null
        dropPlacement.value = 'after'
      },
    })

  async function loadPreprocessors() {
    try {
      logger.debug('Loading preprocessors...')

      const order = await adminConfigApi.getPreprocessorOrder({
        showLoader: false,
        loadingKey: 'preprocessors.order.load',
      })

      if (!Array.isArray(order)) {
        logger.error('Preprocessor order API did not return an array:', order)
        showMessage('获取预处理器列表失败：返回数据格式错误', 'error')
        preprocessors.value = []
        return
      }

      if (order.length === 0) {
        showMessage('未找到预处理器插件', 'info')
        preprocessors.value = []
        return
      }

      preprocessors.value = order.map((item: Preprocessor) => ({
        name: item.name,
        displayName: item.displayName || item.name,
        description: item.description,
      }))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('Failed to load preprocessors:', error)
      showMessage(`加载预处理器列表失败：${errorMessage}`, 'error')
      preprocessors.value = []
    }
  }

  function handleDragHandlePointerDown(pluginName: string, event: PointerEvent) {
    const currentTarget = event.currentTarget
    if (!(currentTarget instanceof HTMLElement)) {
      return
    }

    const itemElement = currentTarget.closest('[data-preprocessor-name]') as HTMLElement | null
    if (!(itemElement instanceof HTMLElement)) {
      return
    }

    startPointerDrag({
      item: { pluginName },
      event,
      itemElement,
      captureElement: currentTarget,
    })
  }

  async function saveOrder() {
    try {
      await adminConfigApi.savePreprocessorOrder(
        preprocessors.value.map((item) => item.name),
        {
          loadingKey: 'preprocessors.order.save',
        }
      )
      statusMessage.value = '顺序已保存！'
      statusType.value = 'success'
      showMessage('顺序已保存！', 'success')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      statusMessage.value = `保存失败：${errorMessage}`
      statusType.value = 'error'
    }
  }

  onMounted(() => {
    loadPreprocessors()
  })

  return {
    orderedPreprocessors,
    preprocessors,
    draggingPluginName,
    dragOverPluginName,
    dropPlacement,
    dragGhost,
    dragGhostElement,
    statusMessage,
    statusType,
    loadPreprocessors,
    handleDragHandlePointerDown,
    handlePointerMove,
    handlePointerUp,
    saveOrder,
  }
}
