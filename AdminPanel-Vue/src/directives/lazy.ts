/**
 * 图片懒加载指令
 * 使用 Intersection Observer API 实现
 */

interface LazyImageElement extends HTMLImageElement {
  _lazySrc?: string
}

const OBSERVER_OPTIONS: IntersectionObserverInit = {
  rootMargin: '50px 0px',
  threshold: 0.01
}

const observedImages = new Map<LazyImageElement, string>()
let sharedObserver: IntersectionObserver | null = null

function disconnectObserverIfIdle(): void {
  if (sharedObserver && observedImages.size === 0) {
    sharedObserver.disconnect()
    sharedObserver = null
  }
}

function getSharedObserver(): IntersectionObserver | null {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
    return null
  }

  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue

        const img = entry.target as LazyImageElement
        const src = observedImages.get(img)
        if (!src) continue

        img.src = src
        delete img._lazySrc
        observedImages.delete(img)
        sharedObserver?.unobserve(img)
      }

      disconnectObserverIfIdle()
    }, OBSERVER_OPTIONS)
  }

  return sharedObserver
}

function cleanupObserver(el: LazyImageElement): void {
  if (sharedObserver) {
    sharedObserver.unobserve(el)
  }
  observedImages.delete(el)
  delete el._lazySrc
  disconnectObserverIfIdle()
}

function observe(el: LazyImageElement, src: string): void {
  if (!src) {
    cleanupObserver(el)
    el.src = ''
    return
  }

  const observer = getSharedObserver()
  if (!observer) {
    el.src = src
    return
  }

  el._lazySrc = src
  el.src = ''
  observedImages.set(el, src)
  observer.observe(el)
}

export default {
  mounted(el: LazyImageElement, binding: { value: string }) {
    observe(el, binding.value)
  },

  updated(el: LazyImageElement, binding: { value: string; oldValue?: string | null }) {
    if (binding.value === binding.oldValue) return
    if (el.src === binding.value && !el._lazySrc) return
    cleanupObserver(el)
    observe(el, binding.value)
  },

  beforeUnmount(el: LazyImageElement) {
    cleanupObserver(el)
  }
}
