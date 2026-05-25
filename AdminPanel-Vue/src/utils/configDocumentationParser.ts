/**
 * 配置文件文档解析器
 *
 * 从 config.env.example 注释中提取分组、小节与键级说明，供 BaseConfig 分组视图。
 *
 * 兼容的注释格式：
 *   # [核心配置] xxx描述         → 一级分组
 *   # --- 核心路径 ---           → 小节标题
 *   # -------------------------------------------------------------------
 *                                  → 分隔线（应忽略，不能被识别为 "-" 分组）
 *   # 说明文字                    → 紧随配置项的注释
 */

export const DEFAULT_GROUP_TITLE = '其他配置'
export const SECTION_KEY_SEPARATOR = '::'

export interface KeyMetadata {
  groupTitle: string
  sectionTitle: string
  commentText: string
}

export interface ConfigDocumentationMetadata {
  /** key → 该键所属的分组、小节及注释 */
  keyMetadataMap: Record<string, KeyMetadata>
  /** 分组标题 → 排列序号 */
  groupOrderMap: Record<string, number>
  /** "分组::小节" → 排列序号 */
  sectionOrderMap: Record<string, number>
  /** 分组标题 → 分组描述 */
  groupDescriptionMap: Record<string, string>
}

export function createEmptyDocumentationMetadata(): ConfigDocumentationMetadata {
  return {
    keyMetadataMap: {},
    groupOrderMap: {},
    sectionOrderMap: {},
    groupDescriptionMap: {},
  }
}

const GROUP_TITLE_RE = /^\[(.+?)\]\s*(.*)$/
const SECTION_TITLE_RE = /^[-—–─═━]{3,}\s*(.+?)\s*[-—–─═━]{3,}$/
const PURE_SEPARATOR_RE = /^[-—–─═━]{3,}$/
const COMMENTED_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
const VALID_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function normalizeCommentLine(rawLine: string): string | null {
  const trimmed = rawLine.trim()
  if (!trimmed.startsWith('#')) {
    return null
  }

  const text = trimmed.replace(/^#\s?/, '').trim()
  if (!text || PURE_SEPARATOR_RE.test(text)) {
    return ''
  }

  return text
}

function appendDescription(existing: string, line: string): string {
  if (!line) {
    return existing
  }

  if (!existing) {
    return line
  }

  return `${existing}\n${line}`
}

/**
 * 从文档源（通常是 example 文件）中构建完整的文档元数据。
 */
export function buildDocumentationMetadata(source: string): ConfigDocumentationMetadata {
  const lines = source.split(/\r?\n/)
  const metadata = createEmptyDocumentationMetadata()

  let currentGroupTitle = DEFAULT_GROUP_TITLE
  let currentSectionTitle = ''
  let groupOrderCursor = 0
  let sectionOrderCursor = 0
  let pendingComments: string[] = []
  let collectingGroupDescription = false

  const ensureGroup = (groupTitle: string): void => {
    if (!(groupTitle in metadata.groupOrderMap)) {
      metadata.groupOrderMap[groupTitle] = groupOrderCursor++
    }
  }

  const ensureSection = (groupTitle: string, sectionTitle: string): void => {
    const sectionKey = `${groupTitle}${SECTION_KEY_SEPARATOR}${sectionTitle}`
    if (!(sectionKey in metadata.sectionOrderMap)) {
      metadata.sectionOrderMap[sectionKey] = sectionOrderCursor++
    }
  }

  ensureGroup(currentGroupTitle)
  ensureSection(currentGroupTitle, currentSectionTitle)

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    const trimmed = line.trim()
    const commentLine = normalizeCommentLine(line)

    if (commentLine === null) {
      // 非注释行：尝试解析 key=value
      collectingGroupDescription = false

      if (!trimmed) {
        pendingComments = []
        continue
      }

      const eqIndex = line.indexOf('=')
      if (eqIndex <= 0) {
        pendingComments = []
        continue
      }

      const key = line.substring(0, eqIndex).trim()
      if (!VALID_KEY_RE.test(key)) {
        pendingComments = []
        continue
      }

      ensureGroup(currentGroupTitle)
      ensureSection(currentGroupTitle, currentSectionTitle)

      metadata.keyMetadataMap[key] = {
        groupTitle: currentGroupTitle,
        sectionTitle: currentSectionTitle,
        commentText: pendingComments.join('\n').trim(),
      }

      pendingComments = []
      continue
    }

    // 注释分隔线：忽略且保持当前分组上下文
    if (!commentLine) {
      continue
    }

    // 分组标题：# [xxx] 可带尾部描述
    const groupMatch = commentLine.match(GROUP_TITLE_RE)
    if (groupMatch) {
      currentGroupTitle = groupMatch[1]?.trim() || DEFAULT_GROUP_TITLE
      currentSectionTitle = ''

      ensureGroup(currentGroupTitle)
      ensureSection(currentGroupTitle, currentSectionTitle)

      const inlineDescription = groupMatch[2]?.trim() || ''
      if (inlineDescription) {
        metadata.groupDescriptionMap[currentGroupTitle] = appendDescription(
          metadata.groupDescriptionMap[currentGroupTitle] || '',
          inlineDescription
        )
      }

      collectingGroupDescription = true
      pendingComments = []
      continue
    }

    // 小节标题：# --- xxx ---
    const sectionMatch = commentLine.match(SECTION_TITLE_RE)
    if (sectionMatch) {
      currentSectionTitle = sectionMatch[1]?.trim() || ''
      ensureSection(currentGroupTitle, currentSectionTitle)

      collectingGroupDescription = false
      pendingComments = []
      continue
    }

    // 注释中的被注释键：# KEY=xxx
    const commentedAssignmentMatch = commentLine.match(COMMENTED_ASSIGNMENT_RE)
    if (commentedAssignmentMatch) {
      const commentedKey = commentedAssignmentMatch[1]?.trim()
      if (commentedKey && VALID_KEY_RE.test(commentedKey)) {
        ensureGroup(currentGroupTitle)
        ensureSection(currentGroupTitle, currentSectionTitle)

        metadata.keyMetadataMap[commentedKey] = {
          groupTitle: currentGroupTitle,
          sectionTitle: currentSectionTitle,
          commentText: pendingComments.join('\n').trim(),
        }
      }

      collectingGroupDescription = false
      pendingComments = []
      continue
    }

    // 分组标题后的说明注释
    if (collectingGroupDescription) {
      metadata.groupDescriptionMap[currentGroupTitle] = appendDescription(
        metadata.groupDescriptionMap[currentGroupTitle] || '',
        commentLine
      )
      continue
    }

    // 普通注释：作为下一键的注释文案
    pendingComments.push(commentLine)
  }

  return metadata
}

// ── 回退分组标记（从实际配置文件中提取） ──

export interface FallbackGroupMarker {
  lineNum: number
  groupTitle: string
  sectionTitle: string
}

/**
 * 从配置文件内容中提取分组标题注释行及其行号，
 * 用于在文档元数据缺失某些键时的回退查找。
 */
export function extractFallbackGroupMarkers(content: string): FallbackGroupMarker[] {
  const lines = content.split(/\r?\n/)
  const markers: FallbackGroupMarker[] = []

  let currentGroupTitle = DEFAULT_GROUP_TITLE
  let currentSectionTitle = ''

  for (let i = 0; i < lines.length; i++) {
    const commentLine = normalizeCommentLine(lines[i])
    if (commentLine === null || commentLine === '') {
      continue
    }

    const groupMatch = commentLine.match(GROUP_TITLE_RE)
    if (groupMatch) {
      currentGroupTitle = groupMatch[1]?.trim() || DEFAULT_GROUP_TITLE
      currentSectionTitle = ''
      markers.push({
        lineNum: i,
        groupTitle: currentGroupTitle,
        sectionTitle: currentSectionTitle,
      })
      continue
    }

    const sectionMatch = commentLine.match(SECTION_TITLE_RE)
    if (sectionMatch) {
      currentSectionTitle = sectionMatch[1]?.trim() || ''
      markers.push({
        lineNum: i,
        groupTitle: currentGroupTitle,
        sectionTitle: currentSectionTitle,
      })
    }
  }

  return markers
}

/**
 * 根据行号在回退标记列表中查找该行所属的分组。
 */
export function resolveFallbackGroupInfo(
  lineNum: number,
  markers: FallbackGroupMarker[]
): { groupTitle: string; sectionTitle: string } {
  let best: FallbackGroupMarker | undefined

  for (const marker of markers) {
    if (marker.lineNum <= lineNum) {
      best = marker
    } else {
      break
    }
  }

  return {
    groupTitle: best?.groupTitle || '',
    sectionTitle: best?.sectionTitle || '',
  }
}
