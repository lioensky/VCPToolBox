import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { showLoading, showMessage } from '@/utils/ui'
import { setFeedbackSink } from '@/platform/feedback/feedbackBus'
import {
  feedbackSink,
  feedbackState,
  isLoadingVisible,
} from '@/platform/feedback/feedbackState'

describe('ui utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setFeedbackSink(feedbackSink)
    feedbackState.loadingCount = 0
    feedbackState.message.id = 0
    feedbackState.message.text = ''
    feedbackState.message.type = 'info'
    feedbackState.message.visible = false
  })

  afterEach(() => {
    setFeedbackSink(null)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('keeps loading state visible until all concurrent requests finish', () => {
    showLoading(true)
    showLoading(true)
    showLoading(false)

    expect(feedbackState.loadingCount).toBe(1)
    expect(isLoadingVisible.value).toBe(true)

    showLoading(false)

    expect(feedbackState.loadingCount).toBe(0)
    expect(isLoadingVisible.value).toBe(false)
  })

  it('only hides the latest message when multiple messages overlap', () => {
    showMessage('first', 'info', 1000)
    showMessage('second', 'error', 2000)

    expect(feedbackState.message.text).toBe('second')
    expect(feedbackState.message.type).toBe('error')
    expect(feedbackState.message.visible).toBe(true)

    vi.advanceTimersByTime(1000)
    expect(feedbackState.message.visible).toBe(true)

    vi.advanceTimersByTime(1000)
    expect(feedbackState.message.visible).toBe(false)
  })
})
