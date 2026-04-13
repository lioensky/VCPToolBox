import { computed, onMounted, ref } from 'vue'
import { ragApi } from '@/api'
import { usePointerDragSession } from '@/composables/usePointerDragSession'
import { showMessage } from '@/utils'
import { createLogger } from '@/utils/logger'
import { reorderByDragIndex } from './reorderClusters'
import {
  getVerticalDropPlacement,
  reorderIdsByPlacement,
  type PointerDropPlacement,
} from '@/utils/pointerReorder'

interface ThinkingChain {
  uiId: string
  theme: string
  clusters: string[]
  kSequence: number[]
}

interface ThinkingChainRecord {
  clusters?: string[]
  kSequence?: number[]
}

type ThinkingChainConfig = string[] | ThinkingChainRecord

type DraggedItem =
  | {
      type: 'chain'
      chainIndex: number
      clusterName: string
    }
  | {
      type: 'available'
      clusterName: string
    }

interface ChainDropTarget {
  chainIndex: number
  targetClusterName: string | null
  insertionIndex: number
  placement: PointerDropPlacement
}

interface ChainPreviewState {
  chainIndex: number
  clusters: string[]
  kSequence: number[]
}

interface ChainListItemTarget {
  clusterName: string
  element: HTMLElement
}

const logger = createLogger('ThinkingChainsEditor')
let thinkingChainUiId = 0

function createThinkingChainUiId(): string {
  thinkingChainUiId += 1
  return `thinking-chain-${thinkingChainUiId}`
}

function clampKValue(rawValue: unknown): number {
  const numericValue =
    typeof rawValue === 'number'
      ? rawValue
      : Number.parseInt(String(rawValue ?? ''), 10)

  if (!Number.isFinite(numericValue)) {
    return 1
  }

  return Math.max(1, Math.min(20, Math.trunc(numericValue)))
}

function buildNormalizedKSequence(
  clusters: readonly string[],
  sourceKSequence: readonly unknown[]
): number[] {
  return clusters.map((_, index) => clampKValue(sourceKSequence[index]))
}

function normalizeThinkingChain(
  theme: string,
  config: ThinkingChainConfig | undefined
): ThinkingChain {
  const clusters = Array.isArray(config) ? [...config] : [...(config?.clusters ?? [])]
  const sourceKSequence = Array.isArray(config) ? [] : (config?.kSequence ?? [])

  return {
    uiId: createThinkingChainUiId(),
    theme,
    clusters,
    kSequence: buildNormalizedKSequence(clusters, sourceKSequence),
  }
}

export function useThinkingChainsEditor() {
  const thinkingChains = ref<ThinkingChain[]>([])
  const availableClusters = ref<string[]>([])
  const statusMessage = ref('')
  const statusType = ref<'info' | 'success' | 'error'>('info')
  const dropTarget = ref<ChainDropTarget | null>(null)
  const chainPreview = ref<ChainPreviewState | null>(null)

  async function loadThinkingChains() {
    try {
      const data = await ragApi.getThinkingChains({
        showLoader: false,
        loadingKey: 'thinking-chains.load',
      })
      const chainsObj = (data.chains ?? {}) as Record<string, ThinkingChainConfig>

      thinkingChains.value = Object.entries(chainsObj).map(([theme, config]) =>
        normalizeThinkingChain(theme, config)
      )
    } catch (error) {
      logger.error('Failed to load thinking chains:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      showMessage(`加载思维链失败：${errorMessage}`, 'error')
    }
  }

  async function loadAvailableClusters() {
    try {
      const clusters = await ragApi.getAvailableClusters({
        showLoader: false,
        loadingKey: 'thinking-chains.available-clusters.load',
      })

      availableClusters.value = Array.isArray(clusters) ? [...clusters] : []
    } catch (error) {
      logger.error('Failed to load available clusters:', error)
    }
  }

  async function saveThinkingChains() {
    try {
      const chainsObj: Record<string, { clusters: string[]; kSequence: number[] }> = {}
      const seenThemes = new Set<string>()

      thinkingChains.value.forEach((chain) => {
        const normalizedTheme = chain.theme.trim()
        if (!normalizedTheme) {
          throw new Error('主题名称不能为空')
        }
        if (seenThemes.has(normalizedTheme)) {
          throw new Error(`主题名称重复：${normalizedTheme}`)
        }

        const normalizedKSequence = buildNormalizedKSequence(chain.clusters, chain.kSequence)

        seenThemes.add(normalizedTheme)
        chain.theme = normalizedTheme
        chain.kSequence = normalizedKSequence
        chainsObj[normalizedTheme] = {
          clusters: [...chain.clusters],
          kSequence: [...normalizedKSequence],
        }
      })

      await ragApi.saveThinkingChains(
        { chains: chainsObj },
        {
          loadingKey: 'thinking-chains.save',
        }
      )
      statusMessage.value = '思维链已保存！'
      statusType.value = 'success'
      showMessage('思维链已保存！', 'success')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      statusMessage.value = `保存失败：${errorMessage}`
      statusType.value = 'error'
      showMessage(`保存失败：${errorMessage}`, 'error')
    }
  }

  function addThinkingChain() {
    thinkingChains.value.push({
      uiId: createThinkingChainUiId(),
      theme: '新主题',
      clusters: [],
      kSequence: [],
    })
  }

  function removeChain(index: number) {
    if (confirm('确定要删除这个思维链主题吗？')) {
      thinkingChains.value.splice(index, 1)
    }
  }

  function removeCluster(chainIndex: number, clusterIndex: number) {
    const chain = thinkingChains.value[chainIndex]
    if (!chain || clusterIndex < 0 || clusterIndex >= chain.clusters.length) {
      return
    }

    chain.clusters.splice(clusterIndex, 1)
    chain.kSequence.splice(clusterIndex, 1)
  }

  function removeClusterByName(chainIndex: number, clusterName: string) {
    const chain = thinkingChains.value[chainIndex]
    if (!chain) {
      return
    }

    const clusterIndex = chain.clusters.indexOf(clusterName)
    if (clusterIndex >= 0) {
      removeCluster(chainIndex, clusterIndex)
    }
  }

  function addCluster(chainIndex: number, clusterName: string) {
    const chain = thinkingChains.value[chainIndex]
    if (!chain || chain.clusters.includes(clusterName)) {
      return
    }

    chain.clusters.push(clusterName)
    chain.kSequence.push(1)
  }

  function createChainSnapshot(chainIndex: number): ChainPreviewState | null {
    if (chainPreview.value?.chainIndex === chainIndex) {
      return {
        chainIndex,
        clusters: [...chainPreview.value.clusters],
        kSequence: [...chainPreview.value.kSequence],
      }
    }

    const chain = thinkingChains.value[chainIndex]
    if (!chain) {
      return null
    }

    return {
      chainIndex,
      clusters: [...chain.clusters],
      kSequence: [...chain.kSequence],
    }
  }

  function hasPreviewChanged(base: ChainPreviewState, next: ChainPreviewState): boolean {
    if (base.clusters.length !== next.clusters.length) {
      return true
    }

    if (base.kSequence.length !== next.kSequence.length) {
      return true
    }

    return base.clusters.some((cluster, index) => {
      return cluster !== next.clusters[index] || base.kSequence[index] !== next.kSequence[index]
    })
  }

  function buildKSequenceForClusters(
    chainIndex: number,
    clusterOrder: readonly string[],
    basePreview: ChainPreviewState
  ): number[] {
    const kValueByCluster = new Map<string, number>()

    basePreview.clusters.forEach((cluster, index) => {
      kValueByCluster.set(cluster, basePreview.kSequence[index] ?? 1)
    })

    const chain = thinkingChains.value[chainIndex]
    chain?.clusters.forEach((cluster, index) => {
      if (!kValueByCluster.has(cluster)) {
        kValueByCluster.set(cluster, chain.kSequence[index] ?? 1)
      }
    })

    return clusterOrder.map((cluster) => kValueByCluster.get(cluster) ?? 1)
  }

  function getRenderedClusters(chainIndex: number): string[] {
    if (chainPreview.value?.chainIndex === chainIndex) {
      return chainPreview.value.clusters
    }

    return thinkingChains.value[chainIndex]?.clusters ?? []
  }

  function getRenderedKValue(chainIndex: number, clusterName: string): number {
    if (chainPreview.value?.chainIndex === chainIndex) {
      const previewIndex = chainPreview.value.clusters.indexOf(clusterName)
      if (previewIndex >= 0) {
        return chainPreview.value.kSequence[previewIndex] ?? 1
      }
    }

    const chain = thinkingChains.value[chainIndex]
    if (!chain) {
      return 1
    }

    const actualIndex = chain.clusters.indexOf(clusterName)
    return actualIndex >= 0 ? chain.kSequence[actualIndex] ?? 1 : 1
  }

  function updateClusterKValue(chainIndex: number, clusterName: string, rawValue: string) {
    const normalizedValue = clampKValue(rawValue)
    const chain = thinkingChains.value[chainIndex]
    if (!chain) {
      return
    }

    const actualIndex = chain.clusters.indexOf(clusterName)
    if (actualIndex >= 0) {
      chain.kSequence[actualIndex] = normalizedValue
    }

    if (chainPreview.value?.chainIndex === chainIndex) {
      const previewIndex = chainPreview.value.clusters.indexOf(clusterName)
      if (previewIndex >= 0) {
        chainPreview.value.kSequence[previewIndex] = normalizedValue
      }
    }
  }

  function getChainDropTarget(clientX: number, clientY: number): ChainDropTarget | null {
    if (typeof document === 'undefined') {
      return null
    }

    const hoveredElement = document.elementFromPoint(clientX, clientY)
    if (!(hoveredElement instanceof Element)) {
      return null
    }

    const listElement = hoveredElement.closest('[data-chain-list="true"]') as HTMLElement | null
    if (!(listElement instanceof HTMLElement)) {
      return null
    }

    const chainIndex = Number.parseInt(listElement.dataset.chainIndex ?? '', 10)
    if (!Number.isInteger(chainIndex) || chainIndex < 0) {
      return null
    }

    const renderedClusters = getRenderedClusters(chainIndex)
    const listItemTargets = getChainListItemTargets(listElement, renderedClusters)

    for (const [index, itemTarget] of listItemTargets.entries()) {
      const placement = getVerticalDropPlacement(itemTarget.element, clientY)
      if (placement === 'before') {
        return {
          chainIndex,
          targetClusterName: itemTarget.clusterName,
          insertionIndex: index,
          placement: 'before',
        }
      }
    }

    if (listItemTargets.length > 0) {
      const lastItemTarget = listItemTargets[listItemTargets.length - 1]
      return {
        chainIndex,
        targetClusterName: lastItemTarget.clusterName,
        insertionIndex: listItemTargets.length,
        placement: 'after',
      }
    }

    return {
      chainIndex,
      targetClusterName: null,
      insertionIndex: 0,
      placement: 'after',
    }
  }

  function getChainListItemTargets(
    listElement: HTMLElement,
    renderedClusters: readonly string[]
  ): ChainListItemTarget[] {
    if (typeof listElement.querySelectorAll !== 'function') {
      return []
    }

    const seenClusters = new Set<string>()
    const targets: ChainListItemTarget[] = []

    for (const result of Array.from(listElement.querySelectorAll('[data-chain-item="true"]'))) {
      if (!(result instanceof HTMLElement)) {
        continue
      }

      const clusterName = result.dataset.clusterName ?? ''
      if (!clusterName || seenClusters.has(clusterName) || !renderedClusters.includes(clusterName)) {
        continue
      }

      seenClusters.add(clusterName)
      targets.push({
        clusterName,
        element: result,
      })
    }

    return targets
  }

  function buildPreviewState(target: ChainDropTarget): ChainPreviewState | null {
    const activeState = pointerState.value
    if (!activeState) {
      return null
    }

    const basePreview = createChainSnapshot(target.chainIndex)
    if (!basePreview) {
      return null
    }

    if (activeState.item.type === 'chain') {
      if (activeState.item.chainIndex !== target.chainIndex) {
        return null
      }

      const currentIndex = basePreview.clusters.indexOf(activeState.item.clusterName)
      if (currentIndex < 0) {
        return null
      }

      const nextClusters =
        target.targetClusterName && target.targetClusterName !== activeState.item.clusterName
          ? reorderIdsByPlacement(
              basePreview.clusters,
              activeState.item.clusterName,
              target.targetClusterName,
              target.placement
            )
          : reorderByDragIndex(basePreview.clusters, currentIndex, target.insertionIndex).items

      const nextPreview = {
        chainIndex: target.chainIndex,
        clusters: nextClusters,
        kSequence: buildKSequenceForClusters(target.chainIndex, nextClusters, basePreview),
      }

      return hasPreviewChanged(basePreview, nextPreview) ? nextPreview : null
    }

    const chain = thinkingChains.value[target.chainIndex]
    if (!chain || chain.clusters.includes(activeState.item.clusterName)) {
      return null
    }

    const nextClusters = basePreview.clusters.filter(
      (cluster) => cluster !== activeState.item.clusterName
    )

    if (target.targetClusterName && target.targetClusterName !== activeState.item.clusterName) {
      const targetIndex = nextClusters.indexOf(target.targetClusterName)
      if (targetIndex >= 0) {
        const insertIndex = target.placement === 'before' ? targetIndex : targetIndex + 1
        nextClusters.splice(insertIndex, 0, activeState.item.clusterName)
      } else {
        nextClusters.push(activeState.item.clusterName)
      }
    } else {
      const safeInsertionIndex = Math.max(0, Math.min(target.insertionIndex, nextClusters.length))
      nextClusters.splice(safeInsertionIndex, 0, activeState.item.clusterName)
    }

    const nextPreview = {
      chainIndex: target.chainIndex,
      clusters: nextClusters,
      kSequence: buildKSequenceForClusters(target.chainIndex, nextClusters, basePreview),
    }

    return hasPreviewChanged(basePreview, nextPreview) ? nextPreview : null
  }

  function updatePreviewState(clientX: number, clientY: number) {
    const target = getChainDropTarget(clientX, clientY)
    if (!target) {
      dropTarget.value = null
      chainPreview.value = null
      return
    }

    const preview = buildPreviewState(target)
    if (!preview) {
      if (chainPreview.value?.chainIndex === target.chainIndex) {
        dropTarget.value = target
        return
      }

      dropTarget.value = null
      chainPreview.value = null
      return
    }

    dropTarget.value = target
    chainPreview.value = preview
  }

  const { pointerState, dragGhost, dragGhostElement, startPointerDrag } = usePointerDragSession<
    DraggedItem,
    { label: string; meta: string }
  >({
    createGhost: (item) =>
      item.type === 'chain'
        ? {
            label: item.clusterName,
            meta: thinkingChains.value[item.chainIndex]?.theme || '当前主题',
          }
        : {
            label: item.clusterName,
            meta: '可用思维簇',
          },
    onFrame: (state) => {
      updatePreviewState(state.currentX, state.currentY)
    },
    onCommit: () => {
      if (!chainPreview.value) {
        return
      }

      const targetChain = thinkingChains.value[chainPreview.value.chainIndex]
      if (targetChain) {
        targetChain.clusters = [...chainPreview.value.clusters]
        targetChain.kSequence = [...chainPreview.value.kSequence]
      }
    },
    onClear: () => {
      dropTarget.value = null
      chainPreview.value = null
    },
  })
  const isPreviewDragging = computed(() => pointerState.value?.dragging === true)

  function startChainPointerDrag(chainIndex: number, clusterIndex: number, event: PointerEvent) {
    const currentTarget = event.currentTarget
    if (!(currentTarget instanceof HTMLElement)) {
      return
    }

    const itemElement = currentTarget.closest('[data-chain-item="true"]') as HTMLElement | null
    if (!(itemElement instanceof HTMLElement)) {
      return
    }

    const clusterName = thinkingChains.value[chainIndex]?.clusters[clusterIndex]
    if (!clusterName) {
      return
    }

    startPointerDrag({
      item: {
        type: 'chain',
        chainIndex,
        clusterName,
      },
      event,
      itemElement,
      captureElement: currentTarget,
    })
  }

  function startAvailablePointerDrag(clusterName: string, event: PointerEvent) {
    const currentTarget = event.currentTarget
    if (!(currentTarget instanceof HTMLElement)) {
      return
    }

    const itemElement = currentTarget.closest('[data-available-cluster="true"]') as HTMLElement | null
    if (!(itemElement instanceof HTMLElement)) {
      return
    }

    startPointerDrag({
      item: {
        type: 'available',
        clusterName,
      },
      event,
      itemElement,
      captureElement: currentTarget,
    })
  }

  function isChainClusterDragging(chainIndex: number, clusterName: string) {
    const activeItem = pointerState.value?.item
    return (
      pointerState.value?.dragging === true &&
      activeItem?.type === 'chain' &&
      activeItem.chainIndex === chainIndex &&
      activeItem.clusterName === clusterName
    )
  }

  function isAvailableClusterDragging(clusterName: string) {
    const activeItem = pointerState.value?.item
    return (
      pointerState.value?.dragging === true &&
      activeItem?.type === 'available' &&
      activeItem.clusterName === clusterName
    )
  }

  function isChainDropTarget(chainIndex: number) {
    return dropTarget.value?.chainIndex === chainIndex
  }

  function isChainDropBefore(chainIndex: number, clusterName: string) {
    return (
      dropTarget.value?.chainIndex === chainIndex &&
      dropTarget.value.targetClusterName === clusterName &&
      dropTarget.value.placement === 'before'
    )
  }

  function isChainDropAfter(chainIndex: number, clusterName: string) {
    return (
      dropTarget.value?.chainIndex === chainIndex &&
      dropTarget.value.targetClusterName === clusterName &&
      dropTarget.value.placement === 'after'
    )
  }

  onMounted(() => {
    loadThinkingChains()
    loadAvailableClusters()
  })

  return {
    thinkingChains,
    availableClusters,
    dragGhost,
    dragGhostElement,
    isPreviewDragging,
    statusMessage,
    statusType,
    loadThinkingChains,
    loadAvailableClusters,
    saveThinkingChains,
    addThinkingChain,
    removeChain,
    removeCluster,
    removeClusterByName,
    addCluster,
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
  }
}
