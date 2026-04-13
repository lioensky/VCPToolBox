import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export const useLoadingStore = defineStore('loading', () => {
  const activeLoaders = ref<Record<string, number>>({})

  const hasAnyLoading = computed(() => Object.keys(activeLoaders.value).length > 0)

  function start(key: string) {
    const current = activeLoaders.value[key] ?? 0
    activeLoaders.value[key] = current + 1
  }

  function stop(key: string) {
    const current = activeLoaders.value[key] ?? 0
    if (current <= 1) {
      delete activeLoaders.value[key]
      return
    }
    activeLoaders.value[key] = current - 1
  }

  function isLoading(key: string): boolean {
    return (activeLoaders.value[key] ?? 0) > 0
  }

  function reset() {
    activeLoaders.value = {}
  }

  return {
    activeLoaders,
    hasAnyLoading,
    start,
    stop,
    isLoading,
    reset
  }
})
