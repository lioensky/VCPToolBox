/**
 * IntersectionObserver 滚动追踪 composable
 *
 * 追踪哪个分组元素当前可见（用于「快速跳转」高亮）。
 */

import { type Ref, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface UseActiveGroupTrackerOptions {
  /** 分组 anchor id 列表（响应式） */
  groupAnchors: Ref<string[]>
  /** 返回滚动容器（非 document） */
  getScrollRoot: () => HTMLElement | null
  /** 跳转时的顶部偏移（避免遮挡） */
  scrollOffset?: number
}

export function useActiveGroupTracker(options: UseActiveGroupTrackerOptions) {
  const { groupAnchors, getScrollRoot, scrollOffset = 16 } = options

  const activeGroupAnchor = ref('')
  let observer: IntersectionObserver | null = null
  const visibleAnchors = new Set<string>()

  function pickActive() {
    const ordered = groupAnchors.value
    for (const anchor of ordered) {
      if (visibleAnchors.has(anchor)) {
        activeGroupAnchor.value = anchor
        return
      }
    }
    // 如果没有任何可见，保持上次值
  }

  function setupObserver() {
    teardownObserver()
    visibleAnchors.clear()

    const root = getScrollRoot()
    if (!root) return

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id
          if (entry.isIntersecting) {
            visibleAnchors.add(id)
          } else {
            visibleAnchors.delete(id)
          }
        }
        pickActive()
      },
      {
        root,
        rootMargin: '-10% 0px -60% 0px',
        threshold: 0,
      }
    )

    for (const anchor of groupAnchors.value) {
      const el = document.getElementById(anchor)
      if (el) {
        observer.observe(el)
      }
    }
  }

  function teardownObserver() {
    if (observer) {
      observer.disconnect()
      observer = null
    }
  }

  function scrollToGroup(anchor: string) {
    const el = document.getElementById(anchor)
    if (!el) return

    const root = getScrollRoot()
    if (!root) return

    const rootRect = root.getBoundingClientRect()
    const targetRect = el.getBoundingClientRect()
    const targetTop = root.scrollTop + (targetRect.top - rootRect.top) - scrollOffset

    root.scrollTo({
      top: Math.max(targetTop, 0),
      behavior: 'smooth',
    })

    activeGroupAnchor.value = anchor
  }

  watch(groupAnchors, () => {
    setupObserver()
  })

  onMounted(() => {
    // 延迟初始化，确保 DOM 已渲染
    requestAnimationFrame(() => {
      setupObserver()
    })
  })

  onBeforeUnmount(() => {
    teardownObserver()
  })

  return {
    activeGroupAnchor,
    scrollToGroup,
  }
}
