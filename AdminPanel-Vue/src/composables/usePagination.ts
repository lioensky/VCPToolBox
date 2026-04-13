/**
 * 分页组合式函数
 * 用于列表数据的分页处理
 * 
 * @example
 * ```typescript
 * const { items, currentPage, totalPages, hasNext, hasPrev, nextPage, prevPage } = usePagination(
 *   filteredNotes,
 *   { pageSize: 20 }
 * )
 * ```
 */

import { computed, ref, watch, type MaybeRefOrGetter, toValue, type ComputedRef, type Ref } from 'vue'

export interface UsePaginationOptions {
  /** 每页项目数量 */
  pageSize?: MaybeRefOrGetter<number>
  /** 初始页码 */
  initialPage?: number
}

export interface UsePaginationReturn<T> {
  /** 当前页的项目列表 */
  items: ComputedRef<T[]>
  /** 当前页码 */
  currentPage: Ref<number>
  /** 总页数 */
  totalPages: ComputedRef<number>
  /** 是否有下一页 */
  hasNext: ComputedRef<boolean>
  /** 是否有上一页 */
  hasPrev: ComputedRef<boolean>
  /** 前往下一页 */
  nextPage: () => void
  /** 前往上一页 */
  prevPage: () => void
  /** 跳转到指定页 */
  goToPage: (page: number) => void
  /** 重置到第一页 */
  reset: () => void
  /** 所有项目（原始数据） */
  allItems: ComputedRef<T[]>
  /** 总项目数 */
  total: ComputedRef<number>
}

/**
 * 创建分页逻辑
 * 
 * @param items - 项目列表（响应式或普通值）
 * @param options - 分页选项
 * @returns 分页状态和方法
 */
export function usePagination<T>(
  items: MaybeRefOrGetter<T[]>,
  options: UsePaginationOptions = {}
): UsePaginationReturn<T> {
  const { pageSize = 20, initialPage = 1 } = options
  
  const currentPage = ref(initialPage)
  const pageSizeValue = computed(() => toValue(pageSize))
  const itemsValue = computed(() => toValue(items))
  
  /** 计算总页数 */
  const totalPages = computed(() => 
    Math.max(1, Math.ceil(itemsValue.value.length / pageSizeValue.value))
  )
  
  /** 计算当前页的项目 */
  const paginatedItems = computed(() => {
    const start = (currentPage.value - 1) * pageSizeValue.value
    const end = start + pageSizeValue.value
    return itemsValue.value.slice(start, end)
  })
  
  /** 是否有下一页 */
  const hasNext = computed(() => currentPage.value < totalPages.value)
  
  /** 是否有上一页 */
  const hasPrev = computed(() => currentPage.value > 1)
  
  /** 总项目数 */
  const total = computed(() => itemsValue.value.length)
  
  /** 前往下一页 */
  function nextPage() {
    if (hasNext.value) {
      currentPage.value++
    }
  }
  
  /** 前往上一页 */
  function prevPage() {
    if (hasPrev.value) {
      currentPage.value--
    }
  }
  
  /** 跳转到指定页 */
  function goToPage(page: number) {
    currentPage.value = Math.max(1, Math.min(page, totalPages.value))
  }
  
  /** 重置到第一页 */
  function reset() {
    currentPage.value = 1
  }
  
  /** 当数据变化时，重置页码到第一页 */
  watch(itemsValue, () => {
    if (currentPage.value > totalPages.value) {
      currentPage.value = 1
    }
  })
  
  return {
    /** 当前页的项目列表 */
    items: paginatedItems,
    /** 当前页码 */
    currentPage,
    /** 总页数 */
    totalPages,
    /** 是否有下一页 */
    hasNext,
    /** 是否有上一页 */
    hasPrev,
    /** 前往下一页 */
    nextPage,
    /** 前往上一页 */
    prevPage,
    /** 跳转到指定页 */
    goToPage,
    /** 重置到第一页 */
    reset,
    /** 所有项目（原始数据） */
    allItems: itemsValue,
    /** 总项目数 */
    total
  }
}
