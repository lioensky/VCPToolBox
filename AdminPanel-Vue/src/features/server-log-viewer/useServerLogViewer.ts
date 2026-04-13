import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { systemApi } from '@/api'
import { usePolling } from '@/composables/usePolling'
import { useVirtualScroll } from '@/composables/useVirtualScroll'
import { useLocalStorage } from '@/composables/useLocalStorage'
import { showMessage } from '@/utils'
import { createLogger } from '@/utils/logger'

const logger = createLogger('ServerLogViewer')

const LINE_HEIGHT = 22
const OVERSCAN = 20
const LOG_RETRY_POLICY = {
  maxRetries: 2,
  retryDelayMs: 500,
} as const

function normalizeLogContent(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

export function useServerLogViewer() {
  const logPath = ref('加载中…')
  const logLines = ref<string[]>([])
  const filterText = ref('')
  const logLimit = useLocalStorage('vcp_log_limit', 5000)
  const isReverse = useLocalStorage('vcp_log_reverse', false)
  const autoScroll = useLocalStorage('vcp_log_autoscroll', true)
  const showScrollToBottom = ref(false)
  const isLoading = ref(false)
  const logOffset = ref(0)
  const isIncrementalReady = ref(false)
  const pendingLineFragment = ref('')
  const highlightCache = new Map<string, string>()

  const highlightRegex = computed<RegExp | null>(() => {
    const keyword = filterText.value.trim()
    if (!keyword) {
      return null
    }

    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(${escaped})`, 'gi')
  })

  const logContainerRef = ref<HTMLElement | null>(null)
  const containerHeight = ref(600)
  let resizeObserver: ResizeObserver | null = null

  const filteredLines = computed(() => {
    const keyword = filterText.value.trim()
    const source = keyword
      ? logLines.value.filter((line) => line.includes(keyword))
      : logLines.value

    const limited = source.length > logLimit.value ? source.slice(-logLimit.value) : source

    if (isReverse.value) {
      return [...limited].reverse()
    }

    return limited
  })

  const displayedLines = computed(() =>
    filteredLines.value.map((content, index) => ({ index, content }))
  )

  const { visibleItems: visibleLines, totalHeight, offsetY, onScroll, setScrollTop } =
    useVirtualScroll(displayedLines, {
      itemHeight: LINE_HEIGHT,
      containerHeight,
      overscan: OVERSCAN,
    })

  const totalLines = computed(() => logLines.value.length)

  function handleFilter() {
    setScrollTop(0)
    if (logContainerRef.value) {
      logContainerRef.value.scrollTop = 0
    }
  }

  function handleScroll(event: Event) {
    const target = event.target as HTMLElement
    const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight)
    if (target.scrollTop > maxScroll) {
      target.scrollTop = maxScroll
    }

    onScroll(event)

    const scrollBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    const isNearBottom = scrollBottom < 100
    showScrollToBottom.value = !isNearBottom && autoScroll.value
  }

  function updateContainerHeight() {
    containerHeight.value = logContainerRef.value?.getBoundingClientRect().height || 600
  }

  function detachResizeObserver() {
    resizeObserver?.disconnect()
    resizeObserver = null
  }

  function attachResizeObserver(element: HTMLElement | null) {
    detachResizeObserver()

    if (!(element instanceof HTMLElement) || typeof ResizeObserver === 'undefined') {
      return
    }

    resizeObserver = new ResizeObserver(() => {
      updateContainerHeight()
    })
    resizeObserver.observe(element)
  }

  function scrollToBottom() {
    if (logContainerRef.value) {
      logContainerRef.value.scrollTop = logContainerRef.value.scrollHeight
      showScrollToBottom.value = false
    }
  }

  function toggleAutoScroll() {
    autoScroll.value = !autoScroll.value
    if (autoScroll.value) {
      nextTick(() => scrollToBottom())
    }
  }

  function toggleReverse() {
    isReverse.value = !isReverse.value
  }

  function copyLog() {
    const text = displayedLines.value.map((line) => line.content).join('\n')
    navigator.clipboard.writeText(text)
    showMessage('日志已复制到剪贴板', 'success')
  }

  function clearLog() {
    if (confirm('确定要清空日志显示吗？（这不会删除实际日志文件）')) {
      logLines.value = []
      logOffset.value = 0
      isIncrementalReady.value = false
      pendingLineFragment.value = ''
      showMessage('日志显示已清空', 'success')
    }
  }

  function getLineClass(content: string): string {
    if (content.includes('[ERROR]') || content.includes(' ERROR ') || content.includes('error:')) {
      return 'log-error'
    }
    if (content.includes('[WARN]') || content.includes(' WARN ') || content.includes('warning:')) {
      return 'log-warn'
    }
    if (content.includes('[INFO]') || content.includes(' INFO ')) {
      return 'log-info'
    }
    if (content.includes('[DEBUG]') || content.includes(' DEBUG ')) {
      return 'log-debug'
    }
    return 'log-normal'
  }

  function highlightText(text: string): string {
    const regex = highlightRegex.value
    if (!regex) {
      return text
    }

    const cacheKey = `${filterText.value}\u0000${text}`
    const cached = highlightCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    const highlighted = text.replace(regex, '<mark>$1</mark>')
    const sanitized = DOMPurify.sanitize(highlighted)

    if (highlightCache.size > 2000) {
      highlightCache.clear()
    }
    highlightCache.set(cacheKey, sanitized)

    return sanitized
  }

  function trimLogLines(lines: string[]): string[] {
    return lines.length > logLimit.value ? lines.slice(-logLimit.value) : lines
  }

  function splitLogChunk(content: string, carry = ''): {
    completeLines: string[]
    displayedLines: string[]
    trailingFragment: string
  } {
    const normalized = normalizeLogContent(content)
    const combined = `${carry}${normalized}`
    const segments = combined.split('\n')
    const endsWithNewline = combined.endsWith('\n')

    if (endsWithNewline && segments[segments.length - 1] === '') {
      segments.pop()
    }

    const trailingFragment = endsWithNewline ? '' : (segments.pop() ?? '')
    const displayedLines = trailingFragment ? [...segments, trailingFragment] : segments

    return {
      completeLines: segments,
      displayedLines,
      trailingFragment,
    }
  }

  function applyFullLogSnapshot(data: Awaited<ReturnType<typeof systemApi.getServerLog>>) {
    const { displayedLines, trailingFragment } = splitLogChunk(data.content || '')

    logLines.value = trimLogLines(displayedLines)
    pendingLineFragment.value = trailingFragment
    logOffset.value = data.offset ?? data.fileSize ?? normalizeLogContent(data.content || '').length
    logPath.value = data.path || '未知'
    isIncrementalReady.value = true
  }

  function appendIncrementalLogSnapshot(
    data: Awaited<ReturnType<typeof systemApi.getIncrementalServerLog>>
  ): boolean {
    logPath.value = data.path || logPath.value || '未知'
    logOffset.value = data.offset ?? data.fileSize ?? logOffset.value

    const incrementalContent = data.content || ''
    if (!incrementalContent) {
      return false
    }

    const existingLines =
      pendingLineFragment.value && logLines.value.length > 0 ? logLines.value.slice(0, -1) : logLines.value
    const { displayedLines, trailingFragment } = splitLogChunk(
      incrementalContent,
      pendingLineFragment.value
    )

    pendingLineFragment.value = trailingFragment
    logLines.value = trimLogLines([...existingLines, ...displayedLines])
    return displayedLines.length > 0
  }

  async function loadFullLog(): Promise<boolean> {
    const data = await systemApi.getServerLog(
      {
        retry: LOG_RETRY_POLICY,
      },
      {
        showLoader: false,
      }
    )
    applyFullLogSnapshot(data)
    return logLines.value.length > 0
  }

  async function loadIncrementalLog(): Promise<boolean> {
    const data = await systemApi.getIncrementalServerLog(
      logOffset.value,
      {
        retry: LOG_RETRY_POLICY,
      },
      {
        showLoader: false,
      }
    )

    if (data.needFullReload) {
      return loadFullLog()
    }

    return appendIncrementalLogSnapshot(data)
  }

  async function loadLog() {
    isLoading.value = true
    try {
      const hasNewContent = isIncrementalReady.value ? await loadIncrementalLog() : await loadFullLog()

      if (autoScroll.value && hasNewContent) {
        await nextTick()
        scrollToBottom()
      }
    } catch (error) {
      if (logPath.value === '加载中…') {
        const errorMessage = error instanceof Error ? error.message : String(error)
        showMessage(`加载日志失败：${errorMessage}`, 'error')
      } else {
        logger.warn('Failed to load log:', error instanceof Error ? error.message : String(error))
      }
    } finally {
      isLoading.value = false
    }
  }

  watch(
    () => logLines.value.length,
    () => {
      highlightCache.clear()
      updateContainerHeight()
    },
    { flush: 'post' }
  )

  watch(
    logContainerRef,
    (element) => {
      updateContainerHeight()
      attachResizeObserver(element)
    },
    { flush: 'post' }
  )

  watch(
    () => filterText.value,
    () => {
      highlightCache.clear()
    }
  )

  const logPolling = usePolling(loadLog, {
    interval: 3000,
    immediate: true,
    onError: (error) => {
      logger.warn('polling failed:', error)
    },
  })

  onMounted(() => {
    updateContainerHeight()
    logPolling.start()
  })

  onUnmounted(() => {
    detachResizeObserver()
  })

  return {
    logPath,
    logLines,
    filterText,
    logLimit,
    isReverse,
    autoScroll,
    showScrollToBottom,
    isLoading,
    logContainerRef,
    filteredLines,
    displayedLines,
    visibleLines,
    totalHeight,
    offsetY,
    totalLines,
    handleFilter,
    handleScroll,
    scrollToBottom,
    toggleAutoScroll,
    toggleReverse,
    copyLog,
    clearLog,
    getLineClass,
    highlightText,
    loadLog,
  }
}
