/**
 * 图片懒加载指令
 * 使用 Intersection Observer API 实现
 */

interface LazyImageElement extends HTMLImageElement {
  _lazySrc?: string
  _lazyObserver?: IntersectionObserver
}

export default {
  mounted(el: LazyImageElement, binding: { value: string }) {
    const src = binding.value
    
    // 如果没有 src，直接返回
    if (!src) return
    
    // 如果浏览器不支持 Intersection Observer，直接加载
    if (!('IntersectionObserver' in window)) {
      el.src = src
      return
    }
    
    // 保存原始 src
    el._lazySrc = src
    el.src = '' // 先清空 src
    
    // 创建观察者
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target as LazyImageElement
          if (img._lazySrc) {
            img.src = img._lazySrc
            delete img._lazySrc
            // 加载完成后停止观察
            observer.unobserve(img)
            delete img._lazyObserver
          }
        }
      })
    }, {
      rootMargin: '50px 0px', // 提前 50px 开始加载
      threshold: 0.01
    })
    
    // 开始观察
    observer.observe(el)
    el._lazyObserver = observer
  },
  
  beforeUnmount(el: LazyImageElement) {
    // 清理观察者
    if (el._lazyObserver) {
      el._lazyObserver.disconnect()
      delete el._lazyObserver
    }
    if (el._lazySrc) {
      delete el._lazySrc
    }
  }
}
