import { describe, expect, it } from 'vitest'
import { isSafeExternalUrl, sanitizeExternalUrl } from '@/utils/url'

describe('url utilities', () => {
  it('accepts http and https external urls', () => {
    expect(sanitizeExternalUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1')
    expect(sanitizeExternalUrl('http://example.com')).toBe('http://example.com/')
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
  })

  it('rejects unsupported or unsafe protocols', () => {
    expect(sanitizeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeExternalUrl('data:text/html,hello')).toBeNull()
    expect(sanitizeExternalUrl('/relative/path')).toBeNull()
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
