/**
 * 请求组合式函数
 * 统一处理 API 请求、加载状态和错误处理
 */

import { getActivePinia } from 'pinia'
import { getCurrentInstance, onUnmounted, ref, type Ref } from 'vue'
import { useLoadingStore } from '@/stores/loading'

export interface RequestContext {
  signal: AbortSignal
}

export type RequestResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error; aborted: boolean }

export interface UseRequestOptions<T = unknown> {
  immediate?: boolean
  globalLoadingKey?: string
  onSuccess?: (data: T) => void
  onError?: (error: Error) => void
}

export interface UseRequestReturn<T> {
  data: Ref<T | null>
  isLoading: Ref<boolean>
  error: Ref<Error | null>
  execute: (options?: { retry?: boolean }) => Promise<RequestResult<T>>
  cancel: () => void
  reset: () => void
}

export function useRequest<T = unknown>(
  requestFn: (context?: RequestContext) => Promise<T>,
  options: UseRequestOptions<T> = {}
): UseRequestReturn<T> {
  const { immediate = false, globalLoadingKey, onSuccess, onError } = options

  const data = ref<T | null>(null) as Ref<T | null>
  const isLoading = ref(false)
  const error = ref<Error | null>(null)

  let controller: AbortController | null = null

  function resolveLoadingStore() {
    if (!globalLoadingKey) {
      return null
    }

    const requestPinia = getActivePinia()
    return requestPinia ? useLoadingStore(requestPinia) : null
  }

  function createAbortError(): DOMException {
    return new DOMException('Request aborted', 'AbortError')
  }

  function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError())
        return
      }

      const timer = globalThis.setTimeout(() => {
        cleanup()
        resolve()
      }, delay)

      const handleAbort = () => {
        globalThis.clearTimeout(timer)
        cleanup()
        reject(createAbortError())
      }

      const cleanup = () => {
        signal.removeEventListener('abort', handleAbort)
      }

      signal.addEventListener('abort', handleAbort, { once: true })
    })
  }

  function cancel() {
    if (controller) {
      controller.abort()
      controller = null
    }
  }

  async function execute(executeOptions: { retry?: boolean } = {}): Promise<RequestResult<T>> {
    const { retry = true } = executeOptions

    cancel()
    controller = new AbortController()
    const { signal } = controller

    isLoading.value = true
    error.value = null

    const loadingStore = resolveLoadingStore()
    if (globalLoadingKey && loadingStore) {
      loadingStore.start(globalLoadingKey)
    }

    try {
      let result: T | undefined

      if (retry) {
        const maxRetries = 3
        const baseDelay = 1000

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            result = await requestFn({ signal })
            if (signal.aborted) {
              throw createAbortError()
            }
            break
          } catch (err) {
            if (signal.aborted) {
              throw createAbortError()
            }
            if (attempt === maxRetries) {
              throw err
            }
            const delay = baseDelay * Math.pow(2, attempt - 1)
            await waitForRetry(delay, signal)
          }
        }
      } else {
        result = await requestFn({ signal })
        if (signal.aborted) {
          throw createAbortError()
        }
      }

      data.value = result!
      onSuccess?.(result!)
      return { success: true, data: result! }
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error(String(err))
      const aborted = errObj.name === 'AbortError'
      error.value = errObj
      onError?.(errObj)
      return { success: false, error: errObj, aborted }
    } finally {
      controller = null
      isLoading.value = false
      if (globalLoadingKey && loadingStore) {
        loadingStore.stop(globalLoadingKey)
      }
    }
  }

  function reset() {
    data.value = null
    isLoading.value = false
    error.value = null
  }

  if (immediate) {
    void execute()
  }

  if (getCurrentInstance()) {
    onUnmounted(() => {
      cancel()
    })
  }

  return {
    data,
    isLoading,
    error,
    execute,
    cancel,
    reset,
  }
}
