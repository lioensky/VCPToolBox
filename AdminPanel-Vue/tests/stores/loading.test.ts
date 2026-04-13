import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLoadingStore } from '@/stores/loading'

describe('loading store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('tracks loading lifecycle by key', () => {
    const store = useLoadingStore()

    store.start('dashboard')
    expect(store.isLoading('dashboard')).toBe(true)
    expect(store.hasAnyLoading).toBe(true)

    store.stop('dashboard')
    expect(store.isLoading('dashboard')).toBe(false)
    expect(store.hasAnyLoading).toBe(false)
  })

  it('supports concurrent loading counts', () => {
    const store = useLoadingStore()

    store.start('dashboard')
    store.start('dashboard')

    store.stop('dashboard')
    expect(store.isLoading('dashboard')).toBe(true)

    store.stop('dashboard')
    expect(store.isLoading('dashboard')).toBe(false)
  })
})
