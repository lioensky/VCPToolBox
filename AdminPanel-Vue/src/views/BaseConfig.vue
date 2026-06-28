<template>
  <section id="base-config-section" class="config-section active-section">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiBadge
          v-if="statusMessage"
          :variant="statusBadgeVariant"
          role="status"
          aria-live="polite"
        >
          {{ statusMessage }}
        </UiBadge>
        <UiBadge v-else-if="!isLoading" variant="outline">{{ editableEntryCount }} 项</UiBadge>
        <UiButton
          type="button"
          size="lg"
          variant="primary"
          :disabled="isLoading || groupedEntries.length === 0"
          @click="handleSubmit"
        >
          <template #leading>
            <span class="material-symbols-outlined">save</span>
          </template>
          保存全局配置
        </UiButton>
      </UiPageActions>
    </Teleport>

    <p v-if="isLoading" class="config-loading">
      <span class="loading-spinner"></span>
      加载全局配置中…
    </p>

    <form v-else-if="groupedEntries.length > 0" id="base-config-form" @submit.prevent="handleSubmit">
      <div class="base-config-workspace">
        <aside
          class="base-config-aside"
          aria-label="配置导航"
        >
          <UiSideConsoleNav
            :items="consoleNavItems"
            :open-ids="openGroupAnchorList"
            @item-click="handleConsoleGroupClick"
            @child-click="handleConsoleSectionClick"
            @toggle="handleConsoleGroupToggle"
          />
        </aside>

        <div id="base-config-details-container" class="base-config-main">
          <UiSettingsCard
            v-for="group in groupedEntries"
            :id="group.anchor"
            :key="group.id"
            class="group-card base-settings-surface"
            :title="group.title"
            :description="group.description"
            variant="flat"
          >
            <template #action>
              <UiBadge variant="outline">{{ group.totalEntries }} 项</UiBadge>
            </template>

            <div class="group-sections">
              <section
                v-for="section in group.sections"
                :key="section.id"
                :id="section.anchor"
                class="group-section-block"
              >
                <header v-if="section.title" class="group-section-row">
                  <span class="group-section">{{ section.title }}</span>
                  <span class="group-section-count">{{ section.entries.length }} 项</span>
                </header>

                <UiSettingsForm as="div" :columns="2" gap="sm">
                  <UiSettingsSwitchRow
                    v-for="entry in section.entries.filter((item) => item.type === 'boolean')"
                    :key="entry.uid"
                    :model-value="entry.value === 'true'"
                    :input-id="`config-${entry.uid}`"
                    :label="entry.key || '未命名配置'"
                    :description="entry.commentText"
                    density="compact"
                    @update:model-value="updateBooleanEntryValue(entry, $event)"
                  />

                  <UiField
                    v-for="entry in section.entries.filter((item) => item.type !== 'boolean')"
                    :key="entry.uid"
                    :label="entry.key || '未命名配置'"
                    :description="entry.commentText"
                    :for-id="`config-${entry.uid}`"
                    :data-settings-span="entry.isMultilineQuoted || String(entry.value ?? '').length > 60 ? 'full' : undefined"
                    size="sm"
                  >
                    <div v-if="entry.type === 'integer'">
                      <UiInput
                        :id="`config-${entry.uid}`"
                        :model-value="entry.value"
                        type="number"
                        step="1"
                        size="sm"
                        @input="updateIntegerEntry(entry, $event)"
                      />
                    </div>

                    <div v-else-if="entry.isMultilineQuoted || String(entry.value ?? '').length > 60">
                      <div v-if="entry.key && isSensitiveConfigKey(entry.key)" class="input-with-toggle">
                        <UiTextarea
                          :id="`config-${entry.uid}`"
                          v-model="entry.value"
                          :rows="Math.min(10, Math.max(3, String(entry.value ?? '').split('\\n').length + 1))"
                          :class="{ 'password-masked': !sensitiveFields[entry.key] }"
                          autocomplete="off"
                        />
                        <UiIconButton
                          class="toggle-visibility-btn"
                          size="sm"
                          :label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                          :title="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                          @click="toggleSensitiveField(entry.key)"
                        >
                          <span class="material-symbols-outlined">
                            {{ sensitiveFields[entry.key] ? 'visibility_off' : 'visibility' }}
                          </span>
                        </UiIconButton>
                      </div>

                      <UiTextarea
                        v-else
                        :id="`config-${entry.uid}`"
                        v-model="entry.value"
                        :rows="Math.min(10, Math.max(3, String(entry.value ?? '').split('\\n').length + 1))"
                      />
                    </div>

                    <div v-else>
                      <div v-if="entry.key && isSensitiveConfigKey(entry.key)" class="input-with-toggle">
                        <UiInput
                          :type="sensitiveFields[entry.key] ? 'text' : 'password'"
                          :id="`config-${entry.uid}`"
                          v-model="entry.value"
                          size="sm"
                          autocomplete="off"
                        />
                        <UiIconButton
                          class="toggle-visibility-btn"
                          size="sm"
                          :label="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                          :title="sensitiveFields[entry.key] ? '隐藏值' : '显示值'"
                          @click="toggleSensitiveField(entry.key)"
                        >
                          <span class="material-symbols-outlined">
                            {{ sensitiveFields[entry.key] ? 'visibility_off' : 'visibility' }}
                          </span>
                        </UiIconButton>
                      </div>

                      <UiInput
                        v-else
                        :id="`config-${entry.uid}`"
                        v-model="entry.value"
                        type="text"
                        size="sm"
                      />
                    </div>
                  </UiField>
                </UiSettingsForm>
              </section>
            </div>

          </UiSettingsCard>
        </div>

      </div>
    </form>

    <div v-else class="config-empty">
      <UiEmptyState title="暂无配置项" description="未检测到可用配置，请检查根目录的 config.env 或 config.env.example。">
        <template #icon>
          <span class="material-symbols-outlined">settings_suggest</span>
        </template>
      </UiEmptyState>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { adminConfigApi } from '@/api'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiEmptyState from '@/components/ui/UiEmptyState.vue'
import UiField from '@/components/ui/UiField.vue'
import UiIconButton from '@/components/ui/UiIconButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiSettingsCard from '@/components/ui/UiSettingsCard.vue'
import UiSettingsForm from '@/components/ui/UiSettingsForm.vue'
import UiSettingsSwitchRow from '@/components/ui/UiSettingsSwitchRow.vue'
import UiSideConsoleNav, {
  type UiSideConsoleNavChild,
  type UiSideConsoleNavItem,
} from '@/components/ui/UiSideConsoleNav.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
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
  anchor: string
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
const statusBadgeVariant = computed(() =>
  statusType.value === 'error' ? 'danger' : statusType.value
)
const isLoading = ref(true)
const activeGroupAnchor = ref('')
const activeSectionAnchor = ref('')
const openGroupAnchors = ref<Set<string>>(new Set())
const configDocumentation = ref<ConfigDocumentationMetadata>(createEmptyDocumentationMetadata())
const sensitiveFields = reactive<Record<string, boolean>>({})

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

function createSectionAnchor(groupAnchor: string, sectionTitle: string, index: number): string {
  const normalized = sectionTitle
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  return `${groupAnchor}-section-${normalized || index + 1}`
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
        anchor: '',
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

  return groups.map((group, index) => {
    const groupAnchor = createGroupAnchor(group.title, index)

    return {
      ...group,
      anchor: groupAnchor,
      sections: group.sections.map((section, sectionIndex) => ({
        ...section,
        anchor: createSectionAnchor(groupAnchor, section.title, sectionIndex),
      })),
    }
  })
})

const editableEntryCount = computed(() =>
  groupedEntries.value.reduce((sum, group) => sum + group.totalEntries, 0)
)
const openGroupAnchorList = computed(() => Array.from(openGroupAnchors.value))
const consoleNavItems = computed<UiSideConsoleNavItem[]>(() =>
  groupedEntries.value.map((group) => ({
    id: group.anchor,
    label: getJumpLabel(group.title),
    title: group.title,
    meta: `${group.totalEntries} 项`,
    active: activeGroupAnchor.value === group.anchor,
    children: visibleSectionLinks(group).map((section) => ({
      id: section.anchor,
      label: getSectionJumpLabel(section.title),
      title: section.title,
      meta: `${section.entries.length} 项`,
      active: activeSectionAnchor.value === section.anchor,
    })),
  }))
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

function getSectionJumpLabel(sectionTitle: string): string {
  return truncateLabel(sectionTitle, 12)
}

function visibleSectionLinks(group: ConfigGroup): ConfigSection[] {
  return group.sections.filter((section) => section.title.trim().length > 0)
}

function openGroup(anchor: string): void {
  openGroupAnchors.value = new Set([anchor])
}

function toggleGroupOpen(group: ConfigGroup): void {
  const next = new Set(openGroupAnchors.value)
  if (next.has(group.anchor)) {
    next.delete(group.anchor)
  } else {
    next.add(group.anchor)
  }

  openGroupAnchors.value = next
}

function handleGroupExpandClick(group: ConfigGroup): void {
  if (visibleSectionLinks(group).length === 0) {
    scrollToAnchor(group.anchor)
    return
  }

  toggleGroupOpen(group)
}

function handleConsoleGroupClick(item: UiSideConsoleNavItem): void {
  scrollToAnchor(item.id)
}

function handleConsoleGroupToggle(item: UiSideConsoleNavItem): void {
  const group = groupedEntries.value.find((entry) => entry.anchor === item.id)
  if (!group) {
    return
  }

  handleGroupExpandClick(group)
}

function handleConsoleSectionClick(
  _item: UiSideConsoleNavItem,
  child: UiSideConsoleNavChild
): void {
  scrollToAnchor(child.id)
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

function scrollToAnchor(anchor: string, options: { openGroup?: boolean } = {}): void {
  const target = document.getElementById(anchor)
  if (!target) {
    return
  }

  const group = groupedEntries.value.find((entry) =>
    entry.anchor === anchor || entry.sections.some((section) => section.anchor === anchor)
  )

  if (group) {
    activeGroupAnchor.value = group.anchor
    if (options.openGroup) {
      openGroup(group.anchor)
    }
  }

  activeSectionAnchor.value =
    group?.sections.find((section) => section.anchor === anchor)?.anchor || ''

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
  let bestSectionAnchor = ''
  let bestVisibleRatio = -1
  let bestTopDelta = Number.POSITIVE_INFINITY

  groupedEntries.value.forEach((group) => {
    const candidates = [
      { anchor: group.anchor, groupAnchor: group.anchor, sectionAnchor: '' },
      ...group.sections.map((section) => ({
        anchor: section.anchor,
        groupAnchor: group.anchor,
        sectionAnchor: section.title.trim() ? section.anchor : '',
      })),
    ]

    candidates.forEach((candidate) => {
      const target = document.getElementById(candidate.anchor)
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
        bestAnchor = candidate.groupAnchor
        bestSectionAnchor = candidate.sectionAnchor
      }
    })
  })

  if (bestAnchor) {
    const previousGroupAnchor = activeGroupAnchor.value
    activeGroupAnchor.value = bestAnchor
    activeSectionAnchor.value = bestSectionAnchor
    if (bestAnchor !== previousGroupAnchor) {
      openGroup(bestAnchor)
    }
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
    if (groupedEntries.value.length > 0 && openGroupAnchors.value.size === 0) {
      openGroup(groupedEntries.value[0].anchor)
    }
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
  width: 100%;
  max-width: min(1680px, calc(100vw - var(--space-6) * 2));
  margin: 0 auto;
  padding: 0 0 var(--space-6);
}

#base-config-form {
  display: block;
}

.base-config-workspace {
  display: grid;
  grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.base-config-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.base-config-aside {
  --base-console-viewport-gap: 0px;
  --base-console-scroll-padding: 22px;
  position: sticky;
  top: var(--base-console-viewport-gap);
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: calc(
    var(--app-viewport-height, 100vh) -
    var(--app-top-bar-height, 60px) -
    var(--base-console-scroll-padding) -
    var(--base-console-viewport-gap)
  );
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.base-settings-surface {
  --base-config-surface-border: color-mix(in srgb, var(--border-color) 88%, transparent);
  --base-config-muted-surface: color-mix(in srgb, var(--primary-text) 2.4%, transparent);
  --base-config-card-surface: color-mix(in srgb, var(--primary-text) 0.7%, transparent);
  border-color: var(--base-config-surface-border);
  background: var(--base-config-card-surface);
}

.base-settings-surface :deep(.ui-card__header),
:deep(.ui-card.base-settings-surface.ui-card--divided .ui-card__header) {
  border-bottom-color: var(--base-config-surface-border);
}

.base-settings-surface :deep(.ui-input),
.base-settings-surface :deep(.ui-textarea) {
  border-color: var(--base-config-surface-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 42%, transparent);
}

.group-section {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary-text) 1.8%, transparent);
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.group-sections {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.group-section-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-section-block + .group-section-block {
  border-top: 1px dashed color-mix(in srgb, var(--border-color) 76%, transparent);
  padding-top: var(--space-2);
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

@media (prefers-reduced-motion: reduce) {
  .base-config-aside {
    transition: none;
  }
}

.form-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
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
}

/* 敏感信息打码样式 */
.input-with-toggle {
  position: relative;
  display: flex;
  align-items: center;
}

.input-with-toggle :deep(.ui-input),
.input-with-toggle :deep(.ui-textarea) {
  flex: 1;
  padding-right: 42px;
}

.toggle-visibility-btn {
  position: absolute;
  right: 8px;
  top: 2px;
  z-index: 2;
}

/* 文本掩码样式 (用于 textarea) */
.password-masked {
  -webkit-text-security: disc !important;
}

#base-config-section {
  padding-bottom: 100px;
}

@media (max-width: 1200px) {
  #base-config-section {
    max-width: 100%;
    padding-inline: 0;
  }

  .base-config-workspace {
    grid-template-columns: minmax(200px, 240px) minmax(0, 1fr);
    gap: var(--space-4);
  }
}

@media (max-width: 768px) {
  #base-config-section {
    padding: 0 0 var(--space-4);
  }

  .base-config-workspace {
    grid-template-columns: 1fr;
  }

  .base-config-aside {
    position: static;
    height: auto;
    max-height: none;
    overflow: visible;
    padding: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
  }

  .base-config-aside :deep(.ui-side-console-nav) {
    max-height: 38vh;
  }

}
</style>
