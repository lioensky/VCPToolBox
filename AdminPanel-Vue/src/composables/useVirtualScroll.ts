/**
 * 虚拟滚动工具函数
 * 用于优化长列表渲染性能
 */
import { ref, computed, toValue, type MaybeRefOrGetter } from 'vue'

export interface VirtualScrollOptions {
  itemHeight: number        // 每个项目的高度（像素）
  visibleCount: number      // 可见区域项目数量
  total: number             // 总项目数
  overscan?: number         // 缓冲项目数量（双向）
}

export interface VirtualScrollState {
  startIndex: number        // 起始索引
  endIndex: number          // 结束索引
  offsetY: number           // 偏移量
  totalHeight: number       // 总高度
}

export interface UseVirtualScrollOptions {
  itemHeight: MaybeRefOrGetter<number>
  containerHeight: MaybeRefOrGetter<number>
  overscan?: MaybeRefOrGetter<number>
}

/**
 * 计算虚拟滚动状态
 */
export function calculateVirtualScroll(
  scrollTop: number,
  options: VirtualScrollOptions
): VirtualScrollState {
  const { itemHeight, visibleCount, total, overscan = 4 } = options

  const rawStart = Math.floor(scrollTop / itemHeight)
  // 向前也保留缓冲，滚动时可减少白屏和布局跳变
  const startIndex = Math.max(0, rawStart - overscan)
  const endIndex = Math.min(rawStart + visibleCount + overscan, total)
  // 计算偏移量
  const offsetY = startIndex * itemHeight
  // 计算总高度
  const totalHeight = total * itemHeight

  return {
    startIndex,
    endIndex,
    offsetY,
    totalHeight
  }
}

/**
 * 虚拟滚动 Hook（用于 Vue 组件）
 */
export function useVirtualScroll<T>(
  items: MaybeRefOrGetter<T[]>,
  options: UseVirtualScrollOptions
) {
  const { itemHeight, containerHeight, overscan = 4 } = options
  const containerRef = ref<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const itemHeightValue = computed(() => toValue(itemHeight))
  const containerHeightValue = computed(() => toValue(containerHeight))
  const overscanValue = computed(() => Math.max(0, toValue(overscan)))

  const total = computed(() => toValue(items).length)
  
  // 计算可见项目数量：容器高度 / 项目高度 + 额外缓冲
  const visibleCount = computed(() => {
    const height = Math.max(containerHeightValue.value, 1)
    const item = Math.max(itemHeightValue.value, 1)
    // 额外 +2 确保底部有足够缓冲，防止内容被截断
    return Math.ceil(height / item) + 2
  })
  
  const totalHeight = computed(() => total.value * itemHeightValue.value)
  
  // 计算最大可滚动距离
  const maxScrollTop = computed(() => {
    return Math.max(0, totalHeight.value - containerHeightValue.value)
  })

  const state = computed(() => {
    // 限制 scrollTop 在有效范围内，防止拉到底部后继续下拉
    const clampedScrollTop = Math.min(scrollTop.value, maxScrollTop.value)
    return calculateVirtualScroll(clampedScrollTop, {
      itemHeight: itemHeightValue.value,
      visibleCount: visibleCount.value,
      total: total.value,
      overscan: overscanValue.value
    })
  })

  const visibleItems = computed(() => {
    const source = toValue(items)
    const { startIndex, endIndex } = state.value
    return source.slice(startIndex, endIndex).map((item, index) => ({
      item,
      index: startIndex + index
    }))
  })

  function onScroll(event: Event) {
    const target = event.target as HTMLElement
    // 限制滚动位置，防止超出内容底部
    const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight)
    scrollTop.value = Math.min(target.scrollTop, maxScroll)
  }

  function setScrollTop(value: number) {
    scrollTop.value = Math.max(0, Math.min(value, maxScrollTop.value))
  }
  
  // 同步容器滚动位置的工具函数
  function syncContainerScroll() {
    if (containerRef.value) {
      const maxScroll = Math.max(0, containerRef.value.scrollHeight - containerRef.value.clientHeight)
      containerRef.value.scrollTop = Math.min(containerRef.value.scrollTop, maxScroll)
    }
  }

  return {
    containerRef,
    onScroll,
    setScrollTop,
    syncContainerScroll,
    visibleItems,
    totalHeight,
    scrollTop,
    offsetY: computed(() => state.value.offsetY),
    startIndex: computed(() => state.value.startIndex),
    endIndex: computed(() => state.value.endIndex),
    maxScrollTop
  }
}
