import { describe, expect, it } from 'vitest'
import {
  inferEnvValueType,
  isSensitiveConfigKey,
  parseEnvToList,
  serializeEnvAssignment,
  serializeEnvValue,
} from '../../src/utils/env'

describe('env utilities', () => {
  it('parses quoted multiline values and preserves comments', () => {
    const entries = parseEnvToList('# heading\nAPI_KEY="line1\nline2"\nFLAG=true')

    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({
      key: null,
      value: '# heading',
      isCommentOrEmpty: true
    })
    expect(entries[1]).toMatchObject({
      key: 'API_KEY',
      value: 'line1\nline2',
      isCommentOrEmpty: false,
      isMultilineQuoted: true
    })
    expect(entries[2]).toMatchObject({
      key: 'FLAG',
      value: 'true',
      isCommentOrEmpty: false
    })
  })

  it('serializes values with quotes, hashes and newlines safely', () => {
    expect(serializeEnvValue('plain-value')).toBe('plain-value')
    expect(serializeEnvAssignment('TITLE', 'value #1')).toBe('TITLE="value #1"')
    expect(serializeEnvAssignment('SECRET', 'line "one"\nline two')).toBe(
      'SECRET="line \\"one\\"\\nline two"'
    )
  })

  it('keeps token-like keys as string and only detects pure integers', () => {
    expect(inferEnvValueType('NEWAPI_MONITOR_ACCESS_TOKEN', '4TQJ6oxRC+vy6WrBlSsK2EFmapfZ')).toBe(
      'string'
    )
    expect(inferEnvValueType('tavilykey', '123456')).toBe('string')
    expect(inferEnvValueType('adminpassword', '123456')).toBe('string')
    expect(inferEnvValueType('WhitelistEmbeddingModelMaxToken', '3072')).toBe('integer')
    expect(inferEnvValueType('MODEL_ALIAS', '4o-mini')).toBe('string')
    expect(inferEnvValueType('RETRY_COUNT', '03')).toBe('integer')
  })

  it('detects concatenated sensitive keys while keeping token limits non-sensitive', () => {
    expect(isSensitiveConfigKey('tavilykey')).toBe(true)
    expect(isSensitiveConfigKey('TavilyKey')).toBe(true)
    expect(isSensitiveConfigKey('adminpassword')).toBe(true)
    expect(isSensitiveConfigKey('openaiApiKey')).toBe(true)

    expect(isSensitiveConfigKey('WhitelistEmbeddingModelMaxToken')).toBe(false)
    expect(isSensitiveConfigKey('MultiModalModelOutputMaxTokens')).toBe(false)
  })
})
