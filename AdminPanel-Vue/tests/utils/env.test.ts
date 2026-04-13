import { describe, expect, it } from 'vitest'
import { parseEnvToList, serializeEnvAssignment, serializeEnvValue } from '@/utils/env'

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
})
