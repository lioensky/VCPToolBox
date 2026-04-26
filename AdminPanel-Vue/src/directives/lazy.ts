/**
 * 图片懒加载指令
 * 使用 Intersection Observer API 实现
 */

interface LazyImageElement extends HTMLImageElement {
  _lazySrc?: string
  _lazyObserver?: IntersectionObserver
}

const OBSERVER_OPTIONS: IntersectionObserverInit = {
  rootMargin: '50px 0px',
  threshold: 0.01
}

function cleanupObserver(el: LazyImageElement): void {
  if (el._lazyObserver) {
    el._lazyObserver.disconnect()
    delete el._lazyObserver
  }
  delete el._lazySrc
}

function observe(el: LazyImageElement, src: string): void {
  if (!src) {
    el.src = ''
    return
  }

  if (!('IntersectionObserver' in window)) {
    el.src = src
    return
  }

  el._lazySrc = src
  el.src = ''

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const img = entry.target as LazyImageElement
        if (img._lazySrc) {
          img.src = img._lazySrc
          delete img._lazySrc
          observer.unobserve(img)
          delete img._lazyObserver
        }
      }
    }
  }, OBSERVER_OPTIONS)

  observer.observe(el)
  el._lazyObserver = observer
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
