<template>
  <section id="base-config-section" class="config-section active-section">
    <p v-if="isLoading" class="config-loading">
      <span class="loading-spinner"></span>
      加载全局配置中…
    </p>

    <form v-else-if="groupedEntries.length > 0" id="base-config-form" @submit.prevent="handleSubmit">
      <div class="base-config-workspace" :class="{ 'is-aside-collapsed': asideCollapsed }">
        <div class="base-config-main">
          <UiSettingsCard
            v-for="group in groupedEntries"
            :id="group.anchor"
            :key="group.id"
            class="group-card"
            :title="group.title"
            :description="group.description"
            variant="subtle"
          >
            <template #action>
              <UiBadge variant="outline">{{ group.totalEntries }} 项</UiBadge>
            </template>

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

        <aside class="base-config-aside">
          <UiCard
            class="base-console"
            :class="{ 'is-collapsed': asideCollapsed }"
            :aria-label="asideCollapsed ? '配置操作台（已折叠）' : '配置操作台'"
            size="sm"
            variant="subtle"
          >
            <template v-if="asideCollapsed">
              <div class="console-rail">
                <UiIconButton
                  type="button"
                  class="console-rail-toggle"
                  label="展开操作台"
                  aria-label="展开操作台"
                  title="展开操作台"
                  @click="toggleAside"
                >
                  <span class="material-symbols-outlined">right_panel_open</span>
                </UiIconButton>
                <div class="console-rail-divider"></div>
                <UiIconButton
                  class="console-rail-icon"
                  label="保存全局配置"
                  title="保存全局配置"
                  @click="handleSubmit"
                >
                  <span class="material-symbols-outlined">save</span>
                </UiIconButton>
                <UiIconButton
                  v-for="group in groupedEntries.slice(0, 8)"
                  :key="`${group.id}-rail`"
                  type="button"
                  class="console-rail-icon"
                  :active="activeGroupAnchor === group.anchor"
                  :label="group.title"
                  :title="group.title"
                  @click="scrollToGroup(group.anchor)"
                >
                  <span class="material-symbols-outlined">tune</span>
                </UiIconButton>
              </div>
            </template>
            <template v-else>
            <div class="base-console__section">
              <div class="base-console__header">
                <div>
                  <span class="base-console__label">操作台</span>
                  <h3>保存与跳转</h3>
                </div>
                <UiIconButton
                  type="button"
                  class="console-rail-toggle"
                  label="折叠操作台"
                  aria-label="折叠操作台"
                  title="折叠操作台"
                  @click="toggleAside"
                >
                  <span class="material-symbols-outlined">right_panel_close</span>
                </UiIconButton>
              </div>
            </div>

            <div class="base-console__actions">
              <UiButton type="submit">保存全局配置</UiButton>
            </div>

            <p class="entry-count">共 {{ editableEntryCount }} 个配置项</p>

            <UiBadge
              v-if="statusMessage"
              :variant="statusBadgeVariant"
              class="base-console__status"
              role="status"
              aria-live="polite"
            >
              {{ statusMessage }}
            </UiBadge>

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
          </UiCard>
        </aside>
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
import UiCard from '@/components/ui/UiCard.vue'
import UiEmptyState from '@/components/ui/UiEmptyState.vue'
import UiField from '@/components/ui/UiField.vue'
import UiIconButton from '@/components/ui/UiIconButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiSettingsCard from '@/components/ui/UiSettingsCard.vue'
import UiSettingsForm from '@/components/ui/UiSettingsForm.vue'
import UiSettingsSwitchRow from '@/components/ui/UiSettingsSwitchRow.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
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
const statusBadgeVariant = computed(() =>
  statusType.value === 'error' ? 'danger' : statusType.value
)
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
  width: 100%;
  max-width: min(1680px, calc(100vw - var(--space-6) * 2));
  margin: 0 auto;
  padding: 0 var(--space-5) var(--space-6);
}

#base-config-form {
  display: block;
}

.base-config-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(340px, 400px);
  gap: var(--space-6);
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

.group-section {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--highlight-text) 16%, transparent);
  color: var(--primary-text);
  font-size: var(--font-size-helper);
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

.base-console :deep(.ui-card__content) {
  min-height: 0;
  flex: 1;
}

.base-console:not(.is-collapsed) :deep(.ui-card__content) {
  display: flex;
  flex-direction: column;
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
  justify-content: flex-start;
  max-width: 100%;
  height: auto;
  min-height: 24px;
  white-space: normal;
  line-height: 1.45;
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
  border-color: color-mix(in srgb, var(--highlight-text) 38%, var(--border-color));
  background: var(--accent-bg);
}

.base-console__jump-btn.is-active {
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-text) 10%, transparent);
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
    padding-inline: var(--space-4);
  }

  .base-config-workspace {
    grid-template-columns: minmax(0, 1fr) minmax(300px, 340px);
    gap: var(--space-4);
  }
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

}
</style>
