/**
 * 防抖函数组合式函数
 * 用于延迟执行函数，直到指定时间过去后没有新的调用
 * 
 * @example
 * ```typescript
 * const searchFn = useDebounceFn((query: string) => {
 *   // 执行搜索
 * }, { delay: 300 })
 * 
 * // 在输入框中使用
 * <input @input="searchFn($event.target.value)" />
 * ```
 */

import { ref, readonly, onUnmounted, type Ref } from 'vue'

export interface UseDebounceOptions {
  /** 延迟时间（毫秒） */
  delay: number
  /** 是否立即执行首次调用 */
  immediate?: boolean
}

export interface UseDebounceReturn<T extends (...args: unknown[]) => unknown> {
  /** 防抖处理后的函数 */
  (...args: Parameters<T>): void
  /** 取消待执行的调用 */
  cancel: () => void
  /** 是否有待执行的调用 */
  isPending: Ref<boolean>
}

/**
 * 创建防抖函数
 *
 * @param fn - 需要防抖处理的函数
 * @param options - 防抖选项
 * @returns 防抖处理后的函数
 */
export function useDebounceFn<T extends (...args: unknown[]) => unknown>(
  fn: T,
  options: UseDebounceOptions
): UseDebounceReturn<T> {
  const { delay } = options
  const timer = ref<ReturnType<typeof setTimeout> | null>(null)
  const isPending = ref(false)
  
  /** 取消待执行的调用 */
  const cancel = () => {
    if (timer.value) {
      clearTimeout(timer.value)
      timer.value = null
      isPending.value = false
    }
  }
  
  /** 防抖处理后的函数 */
  const debouncedFn = (...args: Parameters<T>) => {
    // 清除之前的定时器
    if (timer.value) {
      clearTimeout(timer.value)
    }
    
    isPending.value = true
    
    // 设置新的定时器
    timer.value = setTimeout(() => {
      fn(...args)
      isPending.value = false
      timer.value = null
    }, delay)
  }
  
  /** 组件卸载时清理定时器 */
  onUnmounted(() => {
    cancel()
  })
  
  return Object.assign(debouncedFn, {
    cancel,
    isPending: readonly(isPending)
  }) as UseDebounceReturn<T>
}

/**
 * 创建节流函数
 * 用于限制函数在指定时间内只执行一次
 * 
 * @example
 * ```typescript
 * const scrollHandler = useThrottleFn(() => {
 *   // 处理滚动
 * }, { limit: 200 })
 * ```
 */
export interface UseThrottleOptions {
  /** 时间间隔（毫秒） */
  limit: number
  /** 是否立即执行首次调用 */
  immediate?: boolean
}

export function useThrottleFn<T extends (...args: unknown[]) => unknown>(
  fn: T,
  options: UseThrottleOptions
): UseDebounceReturn<T> {
  const { limit } = options
  const lastCall = ref(0)
  const timer = ref<ReturnType<typeof setTimeout> | null>(null)
  const isPending = ref(false)
  
  const cancel = () => {
    if (timer.value) {
      clearTimeout(timer.value)
      timer.value = null
      isPending.value = false
    }
  }
  
  const throttledFn = (...args: Parameters<T>) => {
    const now = Date.now()
    
    // 如果距离上次调用已超过限制时间，立即执行
    if (now - lastCall.value >= limit) {
      lastCall.value = now
      fn(...args)
      isPending.value = false
    } else {
      // 否则设置定时器延迟执行
      if (timer.value) {
        clearTimeout(timer.value)
      }
      
      isPending.value = true
      timer.value = setTimeout(() => {
        lastCall.value = Date.now()
        fn(...args)
        isPending.value = false
        timer.value = null
      }, limit - (now - lastCall.value))
    }
  }
  
  onUnmounted(() => {
    cancel()
  })
  
  return Object.assign(throttledFn, {
    cancel,
    isPending: readonly(isPending)
  }) as UseDebounceReturn<T>
}
