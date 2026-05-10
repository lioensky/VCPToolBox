<template>
  <section id="base-config-section" class="config-section active-section">
    <p v-if="isLoading" class="config-loading">
      <span class="loading-spinner"></span>
      加载全局配置中…
    </p>

    <form v-else-if="groupedEntries.length > 0" id="base-config-form" @submit.prevent="handleSubmit">
      <div class="base-config-workspace" :class="{ 'is-aside-collapsed': asideCollapsed }">
        <div class="base-config-main">
          <section
            v-for="group in groupedEntries"
            :id="group.anchor"
            :key="group.id"
            class="group-card card"
          >
            <header class="group-header">
              <div class="group-head-main">
                <h3>{{ group.title }}</h3>
                <p v-if="group.description" class="group-description">
                  {{ group.description }}
                </p>
              </div>
              <div class="group-head-meta">
                <span class="group-count">{{ group.totalEntries }} 项</span>
              </div>
            </header>

            <div class="group-sections">
              <section
                v-for="section in group.sections"
                :key="section.id"
                class="group-section-block"
              >
                <header v-if="section.title" class="group-section-row">
                  <span class="group-section">{{ section.title }}</span>
                  <span class="group-section-count">{{ section.entries.length }} 项</span>
                </header>

                <div class="group-grid">
                  <div v-for="entry in section.entries" :key="entry.uid" class="form-group">
                    <label :for="`config-${entry.uid}`">
                      <span class="key-name">{{ entry.key }}</span>
                    </label>

                    <div v-if="entry.type === 'boolean'" class="switch-container">
                      <AppSwitch
                        :input-id="`config-${entry.uid}`"
                        :model-value="entry.value === 'true'"
                        :label="entry.value === 'true' ? '启用' : '禁用'"
                        @update:model-value="updateBooleanEntryValue(entry, $event)"
                      />
                    </div>

                    <div v-else-if="entry.type === 'integer'">
                      <input
                        :id="`config-${entry.uid}`"
                        :value="entry.value"
                        type="number"
                        step="1"
                        @input="updateIntegerEntry(entry, $event)"
                      >
                    </div>

                    <div
                      v-else-if="entry.isMultilineQuoted || String(entry.value ?? '').length > 60"
                    >
                      <div v-if="entry.key && isSensitiveConfigKey(entry.key)" class="input-with-toggle">
                        <textarea
                          :id="`config-${entry.uid}`"
                          v-model="entry.value"
                          :rows="Math.min(10, Math.max(3, String(entry.value ?? '').split('\\n').length + 1))"
                          :class="{ 'password-masked': !sensitiveFields[entry.key] }"
                          autocomplete="off"
                        ></textarea>
                        <button
                          type="button"
                          class="toggle-visibility-btn"
                          @click="toggleSensitiveField(entry.key)"
                          :aria-label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                        >
                          {{ sensitiveFields[entry.key] ? '隐藏' : '显示' }}
                        </button>
                      </div>

                      <textarea
                        v-else
                        :id="`config-${entry.uid}`"
                        v-model="entry.value"
                        :rows="Math.min(10, Math.max(3, String(entry.value ?? '').split('\\n').length + 1))"
                      ></textarea>
                    </div>

                    <div v-else>
                      <div v-if="entry.key && isSensitiveConfigKey(entry.key)" class="input-with-toggle">
                        <input
                          :type="sensitiveFields[entry.key] ? 'text' : 'password'"
                          :id="`config-${entry.uid}`"
                          v-model="entry.value"
                          autocomplete="off"
                        >
                        <button
                          type="button"
                          class="toggle-visibility-btn"
                          @click="toggleSensitiveField(entry.key)"
                          :aria-label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                        >
                          {{ sensitiveFields[entry.key] ? '隐藏' : '显示' }}
                        </button>
                      </div>

                      <input
                        v-else
                        :id="`config-${entry.uid}`"
                        v-model="entry.value"
                        type="text"
                      >
                    </div>

                    <span v-if="entry.commentText" class="description">
                      {{ entry.commentText }}
                    </span>
                  </div>
                </div>
              </section>
            </div>

          </section>
        </div>

        <aside class="base-config-aside">
          <div
            class="base-console card"
            :class="{ 'is-collapsed': asideCollapsed }"
            :aria-label="asideCollapsed ? '配置操作台（已折叠）' : '配置操作台'"
          >
            <template v-if="asideCollapsed">
              <div class="console-rail">
                <button
                  type="button"
                  class="console-rail-toggle"
                  aria-label="展开操作台"
                  title="展开操作台"
                  @click="toggleAside"
                >
                  <span class="material-symbols-outlined">right_panel_open</span>
                </button>
                <div class="console-rail-divider"></div>
                <button
                  type="submit"
                  class="console-rail-icon"
                  aria-label="保存全局配置"
                  title="保存全局配置"
                >
                  <span class="material-symbols-outlined">save</span>
                </button>
                <button
                  v-for="group in groupedEntries.slice(0, 8)"
                  :key="`${group.id}-rail`"
                  type="button"
                  class="console-rail-icon"
                  :class="{ 'is-active': activeGroupAnchor === group.anchor }"
                  :title="group.title"
                  @click="scrollToGroup(group.anchor)"
                >
                  <span class="material-symbols-outlined">tune</span>
                </button>
              </div>
            </template>
            <template v-else>
            <div class="base-console__section">
              <div class="base-console__header">
                <div>
                  <span class="base-console__label">操作台</span>
                  <h3>保存与跳转</h3>
                </div>
                <button
                  type="button"
                  class="console-rail-toggle"
                  aria-label="折叠操作台"
                  title="折叠操作台"
                  @click="toggleAside"
                >
                  <span class="material-symbols-outlined">right_panel_close</span>
                </button>
              </div>
            </div>

            <div class="base-console__actions">
              <button type="submit" class="btn-primary">保存全局配置</button>
            </div>

            <p class="entry-count">共 {{ editableEntryCount }} 个配置项</p>

            <p
              v-if="statusMessage"
              :class="['base-console__status', `base-console__status--${statusType}`]"
              role="status"
              aria-live="polite"
            >
              {{ statusMessage }}
            </p>

            <div class="base-console__section base-console__section--jump">
              <span class="base-console__label">快速跳转</span>
              <div class="base-console__jump-list">
                <button
                  v-for="group in groupedEntries"
                  :key="`${group.id}-jump`"
                  type="button"
                  :class="[
                    'base-console__jump-btn',
                    { 'is-active': activeGroupAnchor === group.anchor },
                  ]"
                  :title="group.title"
                  @click="scrollToGroup(group.anchor)"
                >
                  <span>{{ getJumpLabel(group.title) }}</span>
                  <small>{{ group.totalEntries }} 项</small>
                </button>
              </div>
            </div>
            </template>
          </div>
        </aside>
      </div>
    </form>

    <div v-else class="config-empty">
      <span class="material-symbols-outlined">settings_suggest</span>
      <h3>暂无配置项</h3>
      <p>未检测到可用配置，请检查根目录的 config.env 或 config.env.example。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { adminConfigApi } from '@/api'
import AppSwitch from '@/components/ui/AppSwitch.vue'
import { useConsoleCollapse } from '@/composables/useConsoleCollapse'
import {
  showMessage,
  parseEnvToList,
  serializeEnvAssignment,
  inferEnvValueType,
  isSensitiveConfigKey,
  buildMergedMainConfigContent,
  type EnvEntry,
} from '@/utils'

type ConfigValueType = 'string' | 'boolean' | 'integer'

interface ConfigEntry extends EnvEntry {
  uid: string
  type: ConfigValueType
  groupTitle: string
  sectionTitle: string
  groupDescription: string
  commentText: string
}

interface ConfigSection {
  id: string
  title: string
  entries: ConfigEntry[]
}

interface ConfigGroup {
  id: string
  anchor: string
  title: string
  description: string
  totalEntries: number
  sections: ConfigSection[]
}

interface ConfigDocumentationMetadata {
  groupDescriptionMap: Record<string, string>
  groupOrderMap: Record<string, number>
  sectionOrderMap: Record<string, number>
  keyMetadataMap: Record<
    string,
    {
      groupTitle: string
      sectionTitle: string
      commentText: string
    }
  >
}

const configEntries = ref<ConfigEntry[]>([])
const statusMessage = ref('')
const statusType = ref<'info' | 'success' | 'error'>('info')
const isLoading = ref(true)
const activeGroupAnchor = ref('')
const configDocumentation = ref<ConfigDocumentationMetadata>(createEmptyDocumentationMetadata())
const sensitiveFields = reactive<Record<string, boolean>>({})

const { collapsed: asideCollapsed, toggle: toggleAside } = useConsoleCollapse(
  'base-config-aside'
)

function toggleSensitiveField(key: string): void {
  sensitiveFields[key] = !sensitiveFields[key]
}

const DEFAULT_GROUP_TITLE = '未分类配置'
const SECTION_KEY_SEPARATOR = '::'
const GROUP_TITLE_REGEX = /^\[(.+?)\]\s*(.*)$/
const SECTION_TITLE_REGEX = /^-+\s*(.+?)\s*-+$/
const COMMENTED_ASSIGNMENT_REGEX = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
const CONTENT_CONTAINER_ID = 'config-details-container'
const GROUP_SCROLL_OFFSET = 16

let contentScrollContainer: HTMLElement | null = null
let pendingVisibilityFrame = 0

function createSafeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function createEmptyDocumentationMetadata(): ConfigDocumentationMetadata {
  return {
    groupDescriptionMap: createSafeRecord<string>(),
    groupOrderMap: createSafeRecord<number>(),
    sectionOrderMap: createSafeRecord<number>(),
    keyMetadataMap: createSafeRecord<{
      groupTitle: string
      sectionTitle: string
      commentText: string
    }>(),
  }
}

function createGroupAnchor(groupId: string, index: number): string {
  const normalized = groupId
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  return `base-config-group-${normalized || index + 1}`
}

const groupedEntries = computed<ConfigGroup[]>(() => {
  const groupMap = new Map<
    string,
    {
      title: string
      description: string
      sectionsMap: Map<string, ConfigSection>
    }
  >()
  const groupOrderMap = configDocumentation.value.groupOrderMap
  const sectionOrderMap = configDocumentation.value.sectionOrderMap

  configEntries.value.forEach((entry) => {
    if (entry.isCommentOrEmpty || !entry.key) {
      return
    }

    const title = entry.groupTitle || DEFAULT_GROUP_TITLE
    if (!groupMap.has(title)) {
      groupMap.set(title, {
        title,
        description: entry.groupDescription,
        sectionsMap: new Map<string, ConfigSection>(),
      })
    }

    const groupBucket = groupMap.get(title)!
    const sectionTitle = entry.sectionTitle || ''
    const sectionId = `${title}${SECTION_KEY_SEPARATOR}${sectionTitle}`

    if (!groupBucket.sectionsMap.has(sectionId)) {
      groupBucket.sectionsMap.set(sectionId, {
        id: sectionId,
        title: sectionTitle,
        entries: [],
      })
    }

    groupBucket.sectionsMap.get(sectionId)!.entries.push(entry)
  })

  const groups = Array.from(groupMap.values()).map((bucket) => {
    const sections = Array.from(bucket.sectionsMap.values()).sort((a, b) => {
      const aOrder = sectionOrderMap[a.id] ?? Number.MAX_SAFE_INTEGER
      const bOrder = sectionOrderMap[b.id] ?? Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) {
        return aOrder - bOrder
      }

      return a.title.localeCompare(b.title, 'zh-CN', { sensitivity: 'base' })
    })

    const totalEntries = sections.reduce((sum, section) => sum + section.entries.length, 0)

    return {
      id: bucket.title,
      anchor: '',
      title: bucket.title,
      description: bucket.description,
      totalEntries,
      sections,
    }
  })

  groups.sort((a, b) => {
    const aGroupOrder = groupOrderMap[a.title] ?? Number.MAX_SAFE_INTEGER
    const bGroupOrder = groupOrderMap[b.title] ?? Number.MAX_SAFE_INTEGER
    if (aGroupOrder !== bGroupOrder) {
      return aGroupOrder - bGroupOrder
    }

    return a.title.localeCompare(b.title, 'zh-CN', { sensitivity: 'base' })
  })

  return groups.map((group, index) => ({
    ...group,
    anchor: createGroupAnchor(group.title, index),
  }))
})

const editableEntryCount = computed(() =>
  groupedEntries.value.reduce((sum, group) => sum + group.totalEntries, 0)
)

const JUMP_LABEL_ALIAS: Record<string, string> = {
  '知识库 (Knowledge Base) V2 - Powered by Vexus-Lite': '知识库 V2',
}

function truncateLabel(text: string, maxLength = 14): string {
  const chars = Array.from(text)
  if (chars.length <= maxLength) {
    return text
  }

  return `${chars.slice(0, maxLength).join('')}…`
}

function getJumpLabel(groupTitle: string): string {
  const alias = JUMP_LABEL_ALIAS[groupTitle]
  if (alias) {
    return alias
  }

  const compactTitle = groupTitle
    .replace(/\([^)]*\)/g, '')
    .replace(/-+\s*Powered\s+by.+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  return truncateLabel(compactTitle || groupTitle)
}

function normalizeCommentLine(rawLine: string): string | null {
  const trimmed = rawLine.trim()
  if (!trimmed.startsWith('#')) {
    return null
  }

  const text = trimmed.replace(/^#\s?/, '').trim()
  if (!text || /^-+$/.test(text)) {
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

function buildDocumentationMetadata(content: string): ConfigDocumentationMetadata {
  const metadata = createEmptyDocumentationMetadata()
  const entries = parseEnvToList(content)

  let currentGroupTitle = DEFAULT_GROUP_TITLE
  let currentSectionTitle = ''
  let pendingKeyComments: string[] = []
  let collectingGroupDescription = false
  let groupOrderCursor = 0
  let sectionOrderCursor = 0

  const ensureGroup = (groupTitle: string): void => {
    if (metadata.groupOrderMap[groupTitle] == null) {
      metadata.groupOrderMap[groupTitle] = groupOrderCursor++
    }
  }

  const ensureSection = (groupTitle: string, sectionTitle: string): void => {
    const sectionKey = `${groupTitle}${SECTION_KEY_SEPARATOR}${sectionTitle}`
    if (metadata.sectionOrderMap[sectionKey] == null) {
      metadata.sectionOrderMap[sectionKey] = sectionOrderCursor++
    }
  }

  ensureGroup(currentGroupTitle)
  ensureSection(currentGroupTitle, currentSectionTitle)

  for (const entry of entries) {
    if (entry.isCommentOrEmpty) {
      const commentLine = normalizeCommentLine(entry.value)

      if (commentLine === null) {
        if (entry.value.trim() === '') {
          pendingKeyComments = []
        }
        continue
      }

      if (!commentLine) {
        continue
      }

      const groupMatch = commentLine.match(GROUP_TITLE_REGEX)
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
        pendingKeyComments = []
        continue
      }

      const sectionMatch = commentLine.match(SECTION_TITLE_REGEX)
      if (sectionMatch) {
        currentSectionTitle = sectionMatch[1]?.trim() || ''
        ensureSection(currentGroupTitle, currentSectionTitle)
        collectingGroupDescription = false
        pendingKeyComments = []
        continue
      }

      const commentedAssignmentMatch = commentLine.match(COMMENTED_ASSIGNMENT_REGEX)
      if (commentedAssignmentMatch) {
        const commentedKey = commentedAssignmentMatch[1]?.trim()
        if (commentedKey) {
          ensureGroup(currentGroupTitle)
          ensureSection(currentGroupTitle, currentSectionTitle)

          metadata.keyMetadataMap[commentedKey] = {
            groupTitle: currentGroupTitle,
            sectionTitle: currentSectionTitle,
            commentText: pendingKeyComments.join('\n').trim(),
          }
        }

        collectingGroupDescription = false
        pendingKeyComments = []
        continue
      }

      if (collectingGroupDescription) {
        metadata.groupDescriptionMap[currentGroupTitle] = appendDescription(
          metadata.groupDescriptionMap[currentGroupTitle] || '',
          commentLine
        )
        continue
      }

      pendingKeyComments.push(commentLine)
      continue
    }

    collectingGroupDescription = false

    if (!entry.key) {
      pendingKeyComments = []
      continue
    }

    ensureGroup(currentGroupTitle)
    ensureSection(currentGroupTitle, currentSectionTitle)

    metadata.keyMetadataMap[entry.key] = {
      groupTitle: currentGroupTitle,
      sectionTitle: currentSectionTitle,
      commentText: pendingKeyComments.join('\n').trim(),
    }

    pendingKeyComments = []
  }

  return metadata
}

function extractFallbackGroupMarkers(
  content: string
): Array<{ line: number; groupTitle: string; sectionTitle: string }> {
  const markers: Array<{ line: number; groupTitle: string; sectionTitle: string }> = [
    {
      line: -1,
      groupTitle: DEFAULT_GROUP_TITLE,
      sectionTitle: '',
    },
  ]

  let currentGroupTitle = DEFAULT_GROUP_TITLE
  let currentSectionTitle = ''

  content.split(/\r?\n/).forEach((line, index) => {
    const commentLine = normalizeCommentLine(line)
    if (!commentLine) {
      return
    }

    const groupMatch = commentLine.match(GROUP_TITLE_REGEX)
    if (groupMatch) {
      currentGroupTitle = groupMatch[1]?.trim() || DEFAULT_GROUP_TITLE
      currentSectionTitle = ''
      markers.push({
        line: index,
        groupTitle: currentGroupTitle,
        sectionTitle: currentSectionTitle,
      })
      return
    }

    const sectionMatch = commentLine.match(SECTION_TITLE_REGEX)
    if (sectionMatch) {
      currentSectionTitle = sectionMatch[1]?.trim() || ''
      markers.push({
        line: index,
        groupTitle: currentGroupTitle,
        sectionTitle: currentSectionTitle,
      })
    }
  })

  return markers
}

function resolveFallbackGroupInfo(
  lineNumber: number,
  markers: Array<{ line: number; groupTitle: string; sectionTitle: string }>
): { groupTitle: string; sectionTitle: string } {
  let resolved = markers[0]

  for (const marker of markers) {
    if (marker.line <= lineNumber) {
      resolved = marker
      continue
    }
    break
  }

  return {
    groupTitle: resolved.groupTitle,
    sectionTitle: resolved.sectionTitle,
  }
}

function normalizeValue(value: string, type: ConfigValueType): string {
  if (type === 'boolean') {
    return /^true$/i.test(value.trim()) ? 'true' : 'false'
  }

  if (type === 'integer') {
    const parsed = Number.parseInt(value, 10)
    return Number.isNaN(parsed) ? value : String(parsed)
  }

  return value
}

function updateBooleanEntryValue(entry: ConfigEntry, checked: boolean): void {
  entry.value = checked ? 'true' : 'false'
}

function updateIntegerEntry(entry: ConfigEntry, event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim()
  if (raw === '') {
    entry.value = ''
    return
  }

  const parsed = Number.parseInt(raw, 10)
  entry.value = Number.isNaN(parsed) ? raw : String(parsed)
}

function resolveContentContainer(target?: HTMLElement): HTMLElement | null {
  const container = document.getElementById(CONTENT_CONTAINER_ID)
  if (container instanceof HTMLElement) {
    return container
  }

  if (target) {
    const fallbackContainer = target.closest<HTMLElement>('.content')
    if (fallbackContainer) {
      return fallbackContainer
    }
  }

  return null
}

function scrollToGroup(anchor: string): void {
  const target = document.getElementById(anchor)
  if (!target) {
    return
  }

  activeGroupAnchor.value = anchor

  const contentContainer = resolveContentContainer(target)
  if (contentContainer) {
    const containerRect = contentContainer.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const targetTop =
      contentContainer.scrollTop + (targetRect.top - containerRect.top) - GROUP_SCROLL_OFFSET

    contentContainer.scrollTo({
      top: Math.max(targetTop, 0),
      behavior: 'smooth',
    })
  }
}

function updateActiveGroupByViewport(): void {
  if (groupedEntries.value.length === 0) {
    activeGroupAnchor.value = ''
    return
  }

  const contentContainer = resolveContentContainer()
  if (!contentContainer) {
    return
  }

  const viewportTop = contentContainer.getBoundingClientRect().top
  const viewportBottom = contentContainer.getBoundingClientRect().bottom

  let bestAnchor = groupedEntries.value[0]?.anchor || ''
  let bestVisibleRatio = -1
  let bestTopDelta = Number.POSITIVE_INFINITY

  groupedEntries.value.forEach((group) => {
    const target = document.getElementById(group.anchor)
    if (!target) {
      return
    }

    const rect = target.getBoundingClientRect()
    const visibleTop = Math.max(rect.top, viewportTop)
    const visibleBottom = Math.min(rect.bottom, viewportBottom)
    const visiblePx = Math.max(0, visibleBottom - visibleTop)
    const visibleRatio = visiblePx / Math.max(rect.height, 1)
    const topDelta = Math.abs(rect.top - viewportTop - GROUP_SCROLL_OFFSET)

    if (
      visibleRatio > bestVisibleRatio ||
      (visibleRatio === bestVisibleRatio && topDelta < bestTopDelta)
    ) {
      bestVisibleRatio = visibleRatio
      bestTopDelta = topDelta
      bestAnchor = group.anchor
    }
  })

  if (bestAnchor) {
    activeGroupAnchor.value = bestAnchor
  }
}

function scheduleActiveGroupUpdate(): void {
  if (typeof window === 'undefined') {
    return
  }

  if (pendingVisibilityFrame) {
    return
  }

  pendingVisibilityFrame = window.requestAnimationFrame(() => {
    pendingVisibilityFrame = 0
    updateActiveGroupByViewport()
  })
}

function bindVisibilityListeners(): void {
  if (typeof window === 'undefined') {
    return
  }

  if (contentScrollContainer) {
    contentScrollContainer.removeEventListener('scroll', scheduleActiveGroupUpdate)
    contentScrollContainer = null
  }

  contentScrollContainer = resolveContentContainer()
  if (contentScrollContainer) {
    contentScrollContainer.addEventListener('scroll', scheduleActiveGroupUpdate, {
      passive: true,
    })
  }

  window.addEventListener('resize', scheduleActiveGroupUpdate)
}

function unbindVisibilityListeners(): void {
  if (typeof window === 'undefined') {
    return
  }

  if (contentScrollContainer) {
    contentScrollContainer.removeEventListener('scroll', scheduleActiveGroupUpdate)
    contentScrollContainer = null
  }

  window.removeEventListener('resize', scheduleActiveGroupUpdate)

  if (pendingVisibilityFrame) {
    window.cancelAnimationFrame(pendingVisibilityFrame)
    pendingVisibilityFrame = 0
  }
}

async function loadConfig() {
  isLoading.value = true
  statusMessage.value = ''
  configDocumentation.value = createEmptyDocumentationMetadata()

  try {
    const result = await adminConfigApi.getMainConfig({
      showLoader: false,
      loadingKey: 'base-config.load'
    })

    const mergedContent = buildMergedMainConfigContent(result)
    const entries = parseEnvToList(mergedContent)
    const documentationSource = result.exampleContent || mergedContent
    const documentationMetadata = buildDocumentationMetadata(documentationSource)
    const fallbackMarkers = extractFallbackGroupMarkers(mergedContent)

    configDocumentation.value = documentationMetadata

    configEntries.value = entries.map((entry, index) => ({
      ...(entry.key
        ? (() => {
            const keyMetadata = documentationMetadata.keyMetadataMap[entry.key]
            const fallbackMetadata = resolveFallbackGroupInfo(
              entry.originalLineNumStart,
              fallbackMarkers
            )

            const groupTitle =
              keyMetadata?.groupTitle || fallbackMetadata.groupTitle || DEFAULT_GROUP_TITLE
            const sectionTitle = keyMetadata?.sectionTitle || fallbackMetadata.sectionTitle || ''

            return {
              groupTitle,
              sectionTitle,
              groupDescription: documentationMetadata.groupDescriptionMap[groupTitle] || '',
              commentText: keyMetadata?.commentText || '',
            }
          })()
        : {
            groupTitle: DEFAULT_GROUP_TITLE,
            sectionTitle: '',
            groupDescription: '',
            commentText: '',
          }),
      ...entry,
      value: normalizeValue(
        entry.value,
        entry.isCommentOrEmpty ? 'string' : inferEnvValueType(entry.key, entry.value)
      ),
      uid: `${entry.key ?? 'line'}-${String(entry.value)}-${index}`,
      type: entry.isCommentOrEmpty ? 'string' : inferEnvValueType(entry.key, entry.value),
    }))
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`加载全局配置失败：${errorMessage}`, 'error')
  } finally {
    isLoading.value = false
  }
}

async function handleSubmit() {
  const newConfigString = buildEnvStringForEntries(configEntries.value)
  
  try {
    await adminConfigApi.saveMainConfig(newConfigString, {
      loadingKey: 'base-config.save'
    })
    statusMessage.value = '全局配置已保存！部分更改可能需要重启服务生效。'
    statusType.value = 'success'
    showMessage('全局配置已保存！', 'success')
    await loadConfig()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    statusMessage.value = `保存失败：${errorMessage}`
    statusType.value = 'error'
  }
}

function buildEnvStringForEntries(entries: ConfigEntry[]): string {
  return entries.map((entry) => {
    if (entry.isCommentOrEmpty) {
      return String(entry.value ?? '')
    }

    let value = String(entry.value ?? '')

    if (entry.type === 'boolean') {
      value = entry.value === 'true' ? 'true' : 'false'
    }

    if (entry.type === 'integer') {
      const raw = String(entry.value ?? '').trim()
      if (raw === '') {
        value = ''
      } else {
        const parsed = Number.parseInt(raw, 10)
        value = Number.isNaN(parsed) ? raw : String(parsed)
      }
    }

    return serializeEnvAssignment(entry.key!, value)
  }).join('\n')
}

watch(
  groupedEntries,
  async () => {
    await nextTick()
    scheduleActiveGroupUpdate()
  },
  { flush: 'post' }
)

onMounted(async () => {
  bindVisibilityListeners()
  await loadConfig()
  await nextTick()
  scheduleActiveGroupUpdate()
})

onBeforeUnmount(() => {
  unbindVisibilityListeners()
})
</script>

<style scoped>
#base-config-section {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 var(--space-4) var(--space-6);
}

#base-config-form {
  display: block;
}

.base-config-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
  gap: var(--space-5);
  align-items: start;
}

.base-config-workspace.is-aside-collapsed {
  grid-template-columns: minmax(0, 1fr) 56px;
}

.base-console__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}

.base-console__header > div {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.base-config-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.base-config-aside {
  --base-console-viewport-gap: var(--space-4);
  position: sticky;
  top: var(--base-console-viewport-gap);
  align-self: start;
}

.source-banner {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4);
}

.source-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--highlight-text) 18%, transparent);
}

.source-label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.source-hint {
  color: var(--secondary-text);
  font-size: var(--font-size-body);
}

.group-card {
  padding: var(--space-4);
}

.group-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.group-head-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-head-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.group-header h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
  color: var(--primary-text);
}

.group-description {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  white-space: pre-line;
}

.group-section {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--highlight-text) 16%, transparent);
  color: var(--primary-text);
  font-size: var(--font-size-helper);
}

.group-count {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.group-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.group-sections {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.group-section-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.group-section-block + .group-section-block {
  border-top: 1px dashed color-mix(in srgb, var(--border-color) 76%, transparent);
  padding-top: var(--space-3);
}

.group-section-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.group-section-count {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  background: color-mix(in srgb, var(--tertiary-bg) 55%, transparent);
}

.key-name {
  font-weight: 600;
  color: var(--primary-text);
}

.description {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  white-space: pre-line;
}

.switch-container {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.form-group textarea {
  min-height: 120px;
  resize: vertical;
}

.base-console {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  border-radius: var(--radius-xl);
  height: calc(
    var(--app-viewport-height, 100vh) -
    var(--app-top-bar-height, 60px) -
    var(--base-console-viewport-gap) -
    var(--base-console-viewport-gap)
  );
  overflow: hidden;
  transition: padding 0.2s ease;
}

.base-console.is-collapsed {
  padding: var(--space-3) 0;
  gap: 0;
  align-items: center;
}

.base-console__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.base-console__section--jump {
  min-height: 0;
  flex: 1;
}

.base-console__section h3,
.base-console__section p {
  margin: 0;
}

.base-console__section p {
  color: var(--secondary-text);
  font-size: var(--font-size-body);
}

.base-console__label {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.base-console__actions,
.base-console__jump-list {
  display: grid;
  gap: 10px;
}

.base-console__jump-list {
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-gutter: stable;
}

.base-console__actions button {
  justify-content: center;
}

.base-console__status {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid transparent;
  font-size: var(--font-size-body);
}

.base-console__status--info {
  background: var(--info-bg);
  border-color: var(--info-border);
}

.base-console__status--success {
  background: var(--success-bg);
  border-color: var(--success-border);
  color: var(--success-text);
}

.base-console__status--error {
  background: var(--danger-bg);
  border-color: var(--danger-border);
  color: var(--danger-text);
}

.base-console__jump-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay-soft);
  color: var(--primary-text);
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
  text-align: left;
}

.base-console__jump-btn > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.base-console__jump-btn:hover {
  border-color: var(--highlight-text);
  background: var(--info-bg);
  transform: translateY(-1px);
}

.base-console__jump-btn.is-active {
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-text) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--highlight-text) 34%, transparent);
}

.base-console__jump-btn:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.base-console__jump-btn small {
  color: var(--secondary-text);
  flex-shrink: 0;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.entry-count {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.config-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-9) var(--space-4);
  color: var(--secondary-text);
}

.config-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-9) var(--space-4);
  color: var(--secondary-text);
  text-align: center;
}

.config-empty .material-symbols-outlined {
  font-size: var(--font-size-icon-empty-lg);
  opacity: 0.3;
  color: var(--highlight-text);
}

.config-empty h3 {
  color: var(--primary-text);
  font-size: var(--font-size-emphasis);
}

.config-empty p {
  max-width: 45ch;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.form-group-comment pre {
  color: var(--secondary-text);
  font-family: inherit;
  white-space: pre-wrap;
  margin: 8px 0;
}

/* 敏感信息打码样式 */
.input-with-toggle {
  position: relative;
  display: flex;
  align-items: center;
}

.input-with-toggle input {
  flex: 1;
  padding-right: 70px;
}

.toggle-visibility-btn {
  position: absolute;
  right: 8px;
  min-height: 30px;
  padding: 4px 10px;
  background: var(--tertiary-bg);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  cursor: pointer;
  z-index: 2;
}

/* 文本掩码样式 (用于 textarea) */
.password-masked {
  -webkit-text-security: disc !important;
}

.toggle-visibility-btn:hover {
  background: var(--accent-bg);
}

/* 一体化胶囊操作中心 */
.config-action-capsule-container {
  position: fixed;
  bottom: 30px;
  right: 30px;
  z-index: var(--z-index-message);
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
  transition: transform var(--transition-normal), opacity var(--transition-normal);
}

.config-action-capsule {
  pointer-events: auto;
  display: flex;
  align-items: center;
  height: 50px;
  background-color: var(--button-bg);
  color: var(--on-accent-text);
  border-radius: 25px;
  box-shadow: var(--shadow-overlay-soft);
  overflow: hidden;
  transition:
    background-color var(--transition-spring),
    transform var(--transition-spring),
    box-shadow var(--transition-spring);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.config-action-capsule:hover {
  background-color: var(--button-hover-bg);
  transform: translateY(-4px);
  box-shadow: var(--overlay-panel-shadow);
}

.capsule-segment {
  height: 100%;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  transition: background-color var(--transition-fast);
}

.capsule-segment:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.save-segment {
  gap: 8px;
  min-width: 120px;
}

.top-segment {
  width: 50px;
  padding: 0;
}

.capsule-divider {
  width: 1px;
  height: 24px;
  background-color: rgba(255, 255, 255, 0.2);
}

.label-text, .status-text {
  font-size: var(--font-size-helper);
  font-weight: 500;
}

.status-text.success {
  color: #a7f3d0;
}

.status-text.error {
  color: #fecaca;
}

.loading-spinner-sm {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* 文本切换动画 */
.fade-text-enter-active,
.fade-text-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.fade-text-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.fade-text-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* 隐藏全局回到顶部 */
:global(.hide-global-back-to-top .back-to-top-btn) {
  display: none !important;
}

#base-config-section {
  padding-bottom: 100px;
}

@media (max-width: 768px) {
  #base-config-section {
    padding: 0 var(--space-3) var(--space-4);
  }

  .base-config-workspace,
  .base-config-workspace.is-aside-collapsed {
    grid-template-columns: 1fr;
  }

  .base-config-aside {
    position: static;
  }

  .base-console {
    padding: var(--space-4);
    height: auto;
    max-height: none;
    overflow: visible;
  }

  .base-console__section--jump {
    flex: initial;
  }

  .base-console__jump-list {
    max-height: 38vh;
  }

  .source-banner {
    align-items: flex-start;
  }
}
</style>
