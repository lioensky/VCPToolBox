/**
 * ENV 文件解析工具
 */

/**
 * ENV 条目接口
 */
export interface EnvEntry {
  key: string | null
  value: string
  isCommentOrEmpty: boolean
  isMultilineQuoted: boolean
  originalLineNumStart: number
  originalLineNumEnd: number
}

export type SerializableEnvValue = string | number | boolean | null | undefined

/**
 * 推断 ENV 值的类型
 * @param key - 配置键名
 * @param value - 配置值
 * @returns 推断的类型
 */
export function inferEnvValueType(key: string | null, value: string): 'string' | 'boolean' | 'integer' {
  if (!key) return 'string'
  if (/^(true|false)$/i.test(value)) return 'boolean'
  if (!isNaN(parseFloat(value)) && isFinite(parseFloat(value)) && !value.includes('.')) return 'integer'
  return 'string'
}

/**
 * 将字符串值转换为预期类型
 */
export function castEnvValue(value: string | boolean | number, type: 'string' | 'boolean' | 'integer'): string | boolean | number {
  const strValue = String(value)
  if (type === 'boolean') {
    return strValue.toLowerCase() === 'true'
  }
  if (type === 'integer') {
    const parsed = parseInt(strValue, 10)
    return isNaN(parsed) ? 0 : parsed
  }
  return strValue
}

/**
 * 判断是否为敏感配置项（API Key, Password 等）
 */
export function isSensitiveConfigKey(key: string): boolean {
  return /key|api|secret|password|token/i.test(key)
}

function isEscaped(line: string, index: number): boolean {
  let backslashCount = 0
  let cursor = index - 1
  while (cursor >= 0 && line[cursor] === '\\') {
    backslashCount++
    cursor--
  }
  return backslashCount % 2 === 1
}

function findClosingQuote(line: string, quoteChar: '"' | "'", startIndex: number): number {
  for (let cursor = startIndex; cursor < line.length; cursor++) {
    if (line[cursor] === quoteChar && !isEscaped(line, cursor)) {
      return cursor
    }
  }
  return -1
}

function unescapeDoubleQuotedValue(value: string): string {
  return value
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function escapeDoubleQuotedValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
}

function parseQuotedValue(
  firstLineValue: string,
  lines: string[],
  startLineIndex: number,
  quoteChar: '"' | "'"
): {
  value: string
  endLineNum: number
  isMultilineQuoted: boolean
} {
  const firstQuoteIndex = firstLineValue.indexOf(quoteChar)
  const firstLineContent = firstLineValue.substring(firstQuoteIndex + 1)
  const closingIndex = findClosingQuote(firstLineContent, quoteChar, 0)

  if (closingIndex !== -1) {
    const rawValue = firstLineContent.substring(0, closingIndex)
    return {
      value: quoteChar === '"' ? unescapeDoubleQuotedValue(rawValue) : rawValue,
      endLineNum: startLineIndex,
      isMultilineQuoted: false,
    }
  }

  const multilineContent: string[] = [firstLineContent]
  let lineIndex = startLineIndex + 1
  let endLineNum = startLineIndex

  while (lineIndex < lines.length) {
    const nextLine = lines[lineIndex]
    const nextClosingIndex = findClosingQuote(nextLine, quoteChar, 0)

    if (nextClosingIndex !== -1) {
      multilineContent.push(nextLine.substring(0, nextClosingIndex))
      endLineNum = lineIndex
      break
    }

    multilineContent.push(nextLine)
    endLineNum = lineIndex
    lineIndex++
  }

  const rawValue = multilineContent.join('\n')

  return {
    value: quoteChar === '"' ? unescapeDoubleQuotedValue(rawValue) : rawValue,
    endLineNum,
    isMultilineQuoted: true,
  }
}

export function serializeEnvValue(value: SerializableEnvValue): string {
  const normalizedValue = value == null ? '' : String(value)
  const shouldQuote =
    normalizedValue.length === 0 ||
    normalizedValue.includes('\n') ||
    /^\s|\s$/.test(normalizedValue) ||
    normalizedValue.includes('#') ||
    normalizedValue.includes('"') ||
    normalizedValue.includes("'")

  if (!shouldQuote) {
    return normalizedValue
  }

  return `"${escapeDoubleQuotedValue(normalizedValue)}"`
}

export function serializeEnvAssignment(key: string, value: SerializableEnvValue): string {
  return `${key}=${serializeEnvValue(value)}`
}

/**
 * 解析 .env 文件内容为对象列表
 */
export function parseEnvToList(content: string): EnvEntry[] {
  const lines = content.split(/\r?\n/)
  const entries: EnvEntry[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmedLine = line.trim()
    const currentLineNum = i

    if (trimmedLine.startsWith('#') || trimmedLine === '') {
      entries.push({
        key: null,
        value: line,
        isCommentOrEmpty: true,
        isMultilineQuoted: false,
        originalLineNumStart: currentLineNum,
        originalLineNumEnd: currentLineNum,
      })
      i++
      continue
    }

    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) {
      entries.push({
        key: null,
        value: line,
        isCommentOrEmpty: true,
        isMultilineQuoted: false,
        originalLineNumStart: currentLineNum,
        originalLineNumEnd: currentLineNum,
      })
      i++
      continue
    }

    const key = line.substring(0, eqIndex).trim()
    const valueString = line.substring(eqIndex + 1)
    const trimmedValueString = valueString.trim()
    const quoteChar = trimmedValueString.startsWith('"')
      ? '"'
      : trimmedValueString.startsWith("'")
        ? "'"
        : null

    if (quoteChar) {
      const parsed = parseQuotedValue(valueString, lines, i, quoteChar)
      entries.push({
        key,
        value: parsed.value,
        isCommentOrEmpty: false,
        isMultilineQuoted: parsed.isMultilineQuoted,
        originalLineNumStart: currentLineNum,
        originalLineNumEnd: parsed.endLineNum,
      })
      i = parsed.endLineNum + 1
      continue
    }

    entries.push({
      key,
      value: valueString.trim(),
      isCommentOrEmpty: false,
      isMultilineQuoted: false,
      originalLineNumStart: currentLineNum,
      originalLineNumEnd: currentLineNum,
    })
    i++
  }

  return entries
}

/**
 * 根据表单元素和原始解析条目构建 env 字符串
 */
export function buildEnvString(formElement: HTMLFormElement, originalParsedEntries: EnvEntry[]): string {
  const finalLines: string[] = []
  const formElementsMap = new Map<string, HTMLElement>()

  Array.from(formElement.querySelectorAll('[data-original-key], [data-is-comment-or-empty="true"]')).forEach(el => {
    const originalKey = (el as HTMLElement).dataset.originalKey
    if (originalKey) {
      formElementsMap.set(originalKey, el as HTMLElement)
    }
  })

  originalParsedEntries.forEach(entry => {
    if (entry.isCommentOrEmpty) {
      finalLines.push(entry.value)
      return
    }

    const inputElement = formElementsMap.get(entry.key!) as HTMLInputElement | HTMLTextAreaElement | undefined
    if (!inputElement) {
      finalLines.push(serializeEnvAssignment(entry.key!, entry.value))
      return
    }

    let value = inputElement.value
    const expectedType = inputElement.dataset.expectedType
    if (inputElement.type === 'checkbox' && expectedType === 'boolean') {
      value = (inputElement as HTMLInputElement).checked ? 'true' : 'false'
    } else if (expectedType === 'integer') {
      const intVal = parseInt(value, 10)
      value = isNaN(intVal) ? (value === '' ? '' : value) : String(intVal)
    }

    finalLines.push(serializeEnvAssignment(entry.key!, value))
  })

  return finalLines.join('\n')
}
