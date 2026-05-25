/**
 * 多媒体缓存测试数据（仅开发模式使用）
 */

import type { MediaCacheItem } from '@/api/media-cache'

interface MediaCacheFixtures {
  items: MediaCacheItem[]
  total: number
  totalPages: number
  page: number
  pageSize: number
}

// 1×1 px 透明 PNG（最小合法 base64 图片）
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export function getMediaCacheFixtures(): MediaCacheFixtures {
  const items: MediaCacheItem[] = [
    {
      hash: 'test-001',
      base64: TINY_PNG,
      description: '测试图片 1 — 风景照片',
      timestamp: '2025-01-15 14:30:00',
      mimeType: 'image/png',
    },
    {
      hash: 'test-002',
      base64: TINY_PNG,
      description: '测试图片 2 — 头像',
      timestamp: '2025-01-16 09:00:00',
      mimeType: 'image/png',
    },
    {
      hash: 'test-003',
      base64: TINY_PNG,
      description: '测试图片 3 — 截图',
      timestamp: '2025-01-17 18:45:00',
      mimeType: 'image/jpeg',
    },
    {
      hash: 'test-004',
      base64: '',
      description: '测试音频 — 语音消息',
      timestamp: '2025-01-18 12:00:00',
      mimeType: 'audio/mpeg',
    },
    {
      hash: 'test-005',
      base64: '',
      description: '测试视频 — 屏幕录制',
      timestamp: '2025-01-19 20:30:00',
      mimeType: 'video/mp4',
    },
  ]

  return {
    items,
    total: items.length,
    totalPages: 1,
    page: 1,
    pageSize: 20,
  }
}
