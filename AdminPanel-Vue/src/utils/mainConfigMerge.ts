/**
 * 主配置合并工具
 *
 * 合并策略：
 * - 以 config.env.example 作为文档与注释结构来源
 * - 对于 example 中的键，仅当 config.env 的值与 example 不同时覆盖
 * - 对于 config.env 中存在但 example 中不存在的键，保留并追加到末尾
 */

import type { MainConfigData } from '@/api/admin-config'
import { parseEnvToList, serializeEnvAssignment, type EnvEntry } from './env'

export type ConfigValueType = 'string' | 'boolean' | 'integer'

/**
 * 将配置值按类型归一化
 */
export function normalizeValue(value: string, type: ConfigValueType): string {
  const trimmed = value.trim()

  if (type === 'boolean') {
    return /^true$/i.test(trimmed) ? 'true' : 'false'
  }

  if (type === 'integer') {
    if (trimmed === '') return ''
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isNaN(parsed) ? trimmed : String(parsed)
  }

  return value
}

/**
 * 构建合并后的主配置内容。
 *
 * 结果保证：
 * - 分组与注释结构来自 example 文件
 * - 仅“偏离 example 的实际值”来自 config 文件
 * - config 独有键不会丢失
 */
export function buildMergedMainConfigContent(data: MainConfigData): string {
  const configContent = data.content || ''
  const exampleContent = data.exampleContent || ''

  if (!exampleContent.trim()) {
    return configContent
  }

  if (!configContent.trim()) {
    return exampleContent
  }

  const exampleLines = exampleContent.split(/\r?\n/)
  const configLines = configContent.split(/\r?\n/)

  const exampleEntries = parseEnvToList(exampleContent)
  const configEntries = parseEnvToList(configContent)
  const configValueMap = buildConfigValueMap(configEntries)

  const mergedLines: string[] = []
  const seenExampleKeys = new Set<string>()

  for (const entry of exampleEntries) {
    if (entry.isCommentOrEmpty || !entry.key) {
      mergedLines.push(entry.value)
      continue
    }

    const exampleKey = entry.key
    const exampleValue = entry.value
    const configValue = configValueMap.get(exampleKey)

    seenExampleKeys.add(exampleKey)

    // 仅在 config 显式偏离 example 时覆盖。
    if (typeof configValue === 'string' && configValue !== exampleValue) {
      mergedLines.push(serializeEnvAssignment(exampleKey, configValue))
      continue
    }

    // 保持 example 原始文本，最大化保留格式与注释语义。
    mergedLines.push(getRawEntryBlock(entry, exampleLines))
  }

  const configOnlyEntries = collectConfigOnlyEntries(configEntries, seenExampleKeys)
  if (configOnlyEntries.length > 0) {
    if (mergedLines.length > 0 && mergedLines[mergedLines.length - 1]?.trim() !== '') {
      mergedLines.push('')
    }

    mergedLines.push('# -------------------------------------------------------------------')
    mergedLines.push('# [config.env 专有配置] 以下键不在 config.env.example 中，已从 config.env 保留')
    mergedLines.push('# -------------------------------------------------------------------')

    for (const entry of configOnlyEntries) {
      mergedLines.push(getRawEntryBlock(entry, configLines))
    }
  }

  return mergedLines.join('\n')
}

function buildConfigValueMap(entries: EnvEntry[]): Map<string, string> {
  const valueMap = new Map<string, string>()

  for (const entry of entries) {
    if (entry.isCommentOrEmpty || !entry.key) {
      continue
    }

    // 按常见 env 语义，后出现的同名键覆盖前值。
    valueMap.set(entry.key, entry.value)
  }

  return valueMap
}

function collectConfigOnlyEntries(entries: EnvEntry[], excludedKeys: Set<string>): EnvEntry[] {
  const latestByKey = new Map<string, EnvEntry>()

  for (const entry of entries) {
    if (entry.isCommentOrEmpty || !entry.key || excludedKeys.has(entry.key)) {
      continue
    }

    if (latestByKey.has(entry.key)) {
      latestByKey.delete(entry.key)
    }

    latestByKey.set(entry.key, entry)
  }

  return Array.from(latestByKey.values())
}

function getRawEntryBlock(entry: EnvEntry, sourceLines: string[]): string {
  return sourceLines.slice(entry.originalLineNumStart, entry.originalLineNumEnd + 1).join('\n')
}
