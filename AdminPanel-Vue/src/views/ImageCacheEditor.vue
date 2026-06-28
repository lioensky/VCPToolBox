<template>
  <section class="config-section active-section media-cache-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton
          v-if="isDev"
          variant="outline"
          type="button"
          @click="loadTestData"
          :disabled="isLoading"
        >
          加载测试数据
        </UiButton>
        <UiButton variant="outline" type="button" @click="openMultiModalConfigModal" :disabled="isMultiModalConfigLoading">
          多模态配置
        </UiButton>
        <UiButton variant="outline" type="button" @click="refreshCurrentPage" :disabled="isLoading">
          刷新
        </UiButton>
      </UiPageActions>
    </Teleport>

    <div class="page-header">
      <div>
        <p class="description">编辑多媒体缓存记录，支持搜索、分页、重新识别与预览。</p>
      </div>
    </div>

    <div class="toolbar">
      <div class="search-box">
        <UiInput
          v-model.trim="searchInput"
          type="search"
          placeholder="搜索媒体描述…"
          :disabled="isLoading"
          @keydown.enter.prevent="applySearch"
        />
        <UiButton variant="outline" type="button" @click="applySearch" :disabled="isLoading">
          搜索
        </UiButton>
      </div>

      <div class="pagination-controls">
        <UiButton variant="outline" type="button" @click="goToPreviousPage" :disabled="isLoading || currentPage <= 1">
          上一页
        </UiButton>
        <span class="pagination-summary">{{ paginationSummary }}</span>
        <UiButton
          variant="outline"
          type="button"
          @click="goToNextPage"
          :disabled="isLoading || currentPage >= totalPages"
        >
          下一页
        </UiButton>
      </div>
    </div>

    <UiEmptyState
      v-if="isLoading"
      title="正在加载多媒体缓存数据…"
      description="请稍候，面板正在同步缓存索引。"
    >
      <template #icon>
        <span class="material-symbols-outlined spinning">progress_activity</span>
      </template>
    </UiEmptyState>
    <UiEmptyState
      v-else-if="mediaItems.length === 0"
      title="暂无多媒体缓存"
      :description="emptyMessage"
    >
      <template #icon>
        <span class="material-symbols-outlined">perm_media</span>
      </template>
    </UiEmptyState>

    <div v-else class="media-grid">
      <UiCard v-for="item in mediaItems" :key="item.hash" class="media-card" size="sm" variant="flat">
        <div class="card-actions">
          <UiIconButton
            class="reidentify"
            type="button"
            :disabled="isItemBusy(item)"
            :label="item.isReidentifying ? '正在重新识别' : '重新识别媒体描述'"
            @click="reidentifyItem(item)"
          >
            <span class="material-symbols-outlined">{{ item.isReidentifying ? 'progress_activity' : 'refresh' }}</span>
          </UiIconButton>
          <UiIconButton
            class="delete"
            type="button"
            :disabled="isItemBusy(item)"
            label="删除条目"
            @click="removeItem(item)"
          >
            <span class="material-symbols-outlined">{{ item.isDeleting ? 'progress_activity' : 'delete' }}</span>
          </UiIconButton>
        </div>

        <h3>时间戳: {{ item.timestamp || 'N/A' }}</h3>

        <div class="media-preview-wrap">
          <button
            v-if="mediaKind(item.mimeType) === 'image' || mediaKind(item.mimeType) === 'video'"
            class="media-preview-button"
            type="button"
            @click="openPreview(item)"
            :aria-label="`预览${mediaKind(item.mimeType) === 'image' ? '图片' : '视频'}`"
          >
            <img
              v-if="mediaKind(item.mimeType) === 'image'"
              v-lazy="getDataUrl(item.hash)"
              alt="媒体预览"
              class="media-preview"
            >
            <video
              v-else
              :src="getDataUrl(item.hash)"
              class="media-preview"
              preload="metadata"
              muted
            ></video>
          </button>

          <audio
            v-else-if="mediaKind(item.mimeType) === 'audio'"
            :src="getDataUrl(item.hash)"
            controls
            preload="metadata"
            class="media-audio"
          ></audio>

          <div v-else class="unsupported-media">
            <p>不支持的媒体类型</p>
            <span>{{ item.mimeType }}</span>
          </div>
        </div>

        <UiField class="media-description-field" label="媒体描述" :for-id="`desc-${item.hash}`" size="sm">
          <UiTextarea
            :id="`desc-${item.hash}`"
            v-model="item.description"
            rows="4"
            size="sm"
            :disabled="item.isDeleting || item.isSaving"
            placeholder="请输入媒体描述…"
          />
        </UiField>

        <UiButton
          block
          type="button"
          :disabled="isItemBusy(item) || !isItemDirty(item)"
          @click="saveItem(item)"
        >
          {{ saveButtonLabel(item) }}
        </UiButton>

        <div class="hash-info">Hash (部分): {{ item.hash.slice(0, 30) }}{{ item.hash.length > 30 ? '…' : '' }}</div>
      </UiCard>
    </div>

    <!-- 多模态配置模态窗：编辑 multimodal-config.json，热更新 image-processor / reidentify -->
    <BaseModal
      v-model="multiModalConfigOpen"
      aria-label="多模态配置编辑器"
      @close="closeMultiModalConfigModal"
    >
      <template #default="{ overlayAttrs, panelAttrs, panelRef }">
        <div v-bind="overlayAttrs" class="mm-config-overlay">
          <div :ref="panelRef" v-bind="panelAttrs" class="mm-config-panel" role="dialog" aria-modal="true">
            <header class="mm-config-header">
              <div>
                <h3>多模态配置 (multimodal-config.json)</h3>
                <p>JSON 真相源，保存后立即热加载，无需重启服务器。</p>
              </div>
              <UiIconButton class="modal-close" type="button" label="关闭" @click="closeMultiModalConfigModal">
                <span class="material-symbols-outlined">close</span>
              </UiIconButton>
            </header>

            <UiBadge v-if="isMultiModalConfigLoading" variant="outline" role="status" aria-live="polite">
              正在加载…
            </UiBadge>
            <UiBadge v-if="multiModalConfigError" variant="danger" role="status" aria-live="polite">
              {{ multiModalConfigError }}
            </UiBadge>

            <div class="mm-config-body">
              <UiField label="多模态识别模型 (MultiModalModel)">
                <UiInput v-model="multiModalConfigDraft.MultiModalModel" type="text" placeholder="例如：gemini-2.5-flash" />
              </UiField>

              <UiField label="多模态识别提示词 (MultiModalPrompt)">
                <UiTextarea v-model="multiModalConfigDraft.MultiModalPrompt" rows="6" />
              </UiField>

              <UiField label="多模态信息插入提示词 (MediaInsertPrompt)">
                <UiTextarea v-model="multiModalConfigDraft.MediaInsertPrompt" rows="3" />
              </UiField>

              <div class="mm-grid">
                <UiField label="最大输出 Tokens (MultiModalModelOutputMaxTokens)">
                  <UiInput v-model.number="multiModalConfigDraft.MultiModalModelOutputMaxTokens" type="number" min="1" />
                </UiField>
                <UiField label="最大上下文 Tokens (MultiModalModelContent)">
                  <UiInput v-model.number="multiModalConfigDraft.MultiModalModelContent" type="number" min="1" />
                </UiField>
                <UiField label="Thinking Budget (MultiModalModelThinkingBudget)">
                  <UiInput v-model.number="multiModalConfigDraft.MultiModalModelThinkingBudget" type="number" min="0" />
                </UiField>
                <UiField label="异步并发上限 (MultiModalModelAsynchronousLimit)">
                  <UiInput v-model.number="multiModalConfigDraft.MultiModalModelAsynchronousLimit" type="number" min="1" />
                </UiField>
              </div>

              <UiField
                label="纯文本模型强制翻译列表 (MultiModalForceTranslateModels)，逗号分隔"
                description="命中其中任意 tag（不区分大小写、子串匹配）即把多模态强制翻译为文本，并禁用 base64 还原。"
              >
                <UiInput v-model="multiModalConfigForceTranslateText" type="text" placeholder="deepseek,glm" />
              </UiField>

              <p v-if="multiModalConfigPath" class="mm-meta">
                配置文件：<code>{{ multiModalConfigPath }}</code>
                <UiBadge v-if="multiModalConfigWatcher" class="mm-meta-tag" variant="success">热加载已启用</UiBadge>
              </p>
            </div>

            <footer class="mm-config-footer">
              <UiButton variant="outline" type="button" @click="closeMultiModalConfigModal" :disabled="isMultiModalConfigSaving">
                取消
              </UiButton>
              <UiButton type="button" @click="saveMultiModalConfig" :disabled="isMultiModalConfigSaving || isMultiModalConfigLoading">
                {{ isMultiModalConfigSaving ? '保存中…' : '保存配置' }}
              </UiButton>
            </footer>
          </div>
        </div>
      </template>
    </BaseModal>

    <BaseModal
      v-model="previewOpen"
      aria-label="媒体预览"
      @close="closePreview"
    >
      <template #default="{ overlayAttrs, panelAttrs, panelRef }">
        <div v-bind="overlayAttrs" class="preview-modal">
          <div :ref="panelRef" v-bind="panelAttrs" class="modal-content">
      <UiIconButton ref="modalCloseBtn" class="modal-close" type="button" label="关闭预览" @click="closePreview">
        <span class="material-symbols-outlined">close</span>
      </UiIconButton>
      <img v-if="previewType === 'image'" :src="previewDataUrl" alt="放大预览图" />
      <video v-else controls :src="previewDataUrl"></video>
          </div>
        </div>
      </template>
    </BaseModal>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { mediaCacheApi, systemApi, type MediaCacheItem } from '@/api'
import type { MultiModalConfig } from '@/types/api.system'
import BaseModal from '@/components/ui/BaseModal.vue'
import UiBadge from '@/components/ui/UiBadge.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiCard from '@/components/ui/UiCard.vue'
import UiEmptyState from '@/components/ui/UiEmptyState.vue'
import UiField from '@/components/ui/UiField.vue'
import UiIconButton from '@/components/ui/UiIconButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiPageActions from '@/components/ui/UiPageActions.vue'
import UiTextarea from '@/components/ui/UiTextarea.vue'
import { askConfirm } from '@/platform/feedback/feedbackBus'
import { showMessage } from '@/utils'

const DEFAULT_MULTIMODAL_CONFIG: MultiModalConfig = {
  MultiModalModel: '',
  MultiModalPrompt: '',
  MediaInsertPrompt: '',
  MultiModalModelOutputMaxTokens: 50000,
  MultiModalModelContent: 250000,
  MultiModalModelThinkingBudget: 0,
  MultiModalModelAsynchronousLimit: 1,
  MultiModalForceTranslateModels: []
}

const DEFAULT_PAGE_SIZE = 20
const isDev = import.meta.env.DEV

interface MediaItem {
  hash: string
  description: string
  originalDescription: string
  timestamp: string
  mimeType: string
  isReidentifying: boolean
  isDeleting: boolean
  isSaving: boolean
  saveFeedback: 'idle' | 'saved'
}

// Large binary data and timer IDs kept outside Vue's reactive proxy
const dataUrlCache = new Map<string, string>()
const saveTimers = new Map<string, number>()

const mediaItems = ref<MediaItem[]>([])
const isLoading = ref(false)
const searchInput = ref('')
const currentSearch = ref('')
const currentPage = ref(1)
const totalPages = ref(1)
const totalItems = ref(0)
const pageSize = ref(DEFAULT_PAGE_SIZE)
const previewOpen = ref(false)
const previewDataUrl = ref('')
const previewType = ref<'image' | 'video'>('image')
const modalCloseBtn = ref<{ focus: () => void } | null>(null)

// ──────────── 多模态配置模态状态 ────────────
const multiModalConfigOpen = ref(false)
const isMultiModalConfigLoading = ref(false)
const isMultiModalConfigSaving = ref(false)
const multiModalConfigError = ref<string | null>(null)
const multiModalConfigPath = ref<string>('')
const multiModalConfigWatcher = ref<boolean>(false)
const multiModalConfigDraft = reactive<MultiModalConfig>({ ...DEFAULT_MULTIMODAL_CONFIG })
const multiModalConfigForceTranslateText = ref<string>('')

function applyMultiModalConfig(config: MultiModalConfig) {
  multiModalConfigDraft.MultiModalModel = config.MultiModalModel ?? ''
  multiModalConfigDraft.MultiModalPrompt = config.MultiModalPrompt ?? ''
  multiModalConfigDraft.MediaInsertPrompt = config.MediaInsertPrompt ?? ''
  multiModalConfigDraft.MultiModalModelOutputMaxTokens = Number(config.MultiModalModelOutputMaxTokens) || 0
  multiModalConfigDraft.MultiModalModelContent = Number(config.MultiModalModelContent) || 0
  multiModalConfigDraft.MultiModalModelThinkingBudget = Number(config.MultiModalModelThinkingBudget) || 0
  multiModalConfigDraft.MultiModalModelAsynchronousLimit = Math.max(1, Number(config.MultiModalModelAsynchronousLimit) || 1)
  multiModalConfigDraft.MultiModalForceTranslateModels = Array.isArray(config.MultiModalForceTranslateModels)
    ? [...config.MultiModalForceTranslateModels]
    : []
  multiModalConfigForceTranslateText.value = multiModalConfigDraft.MultiModalForceTranslateModels.join(',')
}

async function openMultiModalConfigModal() {
  multiModalConfigOpen.value = true
  isMultiModalConfigLoading.value = true
  multiModalConfigError.value = null
  try {
    const response = await systemApi.getMultiModalConfig({}, { showLoader: false, suppressErrorMessage: true })
    applyMultiModalConfig(response.config)
    multiModalConfigPath.value = response.path || ''
    multiModalConfigWatcher.value = !!response.watcherActive
    if (response.lastLoadError) {
      multiModalConfigError.value = `JSON 解析警告：${response.lastLoadError}`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    multiModalConfigError.value = `加载多模态配置失败：${message}`
  } finally {
    isMultiModalConfigLoading.value = false
  }
}

function closeMultiModalConfigModal() {
  if (isMultiModalConfigSaving.value) return
  multiModalConfigOpen.value = false
}

function parseForceTranslateInput(raw: string): string[] {
  return raw
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => item !== '')
}

async function saveMultiModalConfig() {
  if (isMultiModalConfigSaving.value) return
  isMultiModalConfigSaving.value = true
  try {
    const payload: Partial<MultiModalConfig> = {
      MultiModalModel: multiModalConfigDraft.MultiModalModel,
      MultiModalPrompt: multiModalConfigDraft.MultiModalPrompt,
      MediaInsertPrompt: multiModalConfigDraft.MediaInsertPrompt,
      MultiModalModelOutputMaxTokens: Number(multiModalConfigDraft.MultiModalModelOutputMaxTokens) || 0,
      MultiModalModelContent: Number(multiModalConfigDraft.MultiModalModelContent) || 0,
      MultiModalModelThinkingBudget: Number(multiModalConfigDraft.MultiModalModelThinkingBudget) || 0,
      MultiModalModelAsynchronousLimit: Math.max(1, Number(multiModalConfigDraft.MultiModalModelAsynchronousLimit) || 1),
      MultiModalForceTranslateModels: parseForceTranslateInput(multiModalConfigForceTranslateText.value)
    }
    const response = await systemApi.saveMultiModalConfig(payload, {}, { showLoader: false })
    applyMultiModalConfig(response.config)
    multiModalConfigPath.value = response.path || multiModalConfigPath.value
    multiModalConfigWatcher.value = !!response.watcherActive
    multiModalConfigError.value = null
    multiModalConfigOpen.value = false
    showMessage(response.message || '多模态配置已保存。', 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    multiModalConfigError.value = `保存失败：${message}`
    showMessage(`保存多模态配置失败：${message}`, 'error')
  } finally {
    isMultiModalConfigSaving.value = false
  }
}

let previouslyFocusedElement: HTMLElement | null = null

const paginationSummary = computed(() => `第 ${currentPage.value} / ${totalPages.value} 页 · 共 ${totalItems.value} 条`)
const emptyMessage = computed(() => (currentSearch.value ? '没有匹配的缓存条目。' : '暂无缓存条目。'))
const hasUnsavedChanges = computed(() =>
  mediaItems.value.some(item => item.description !== item.originalDescription)
)

function getDataUrl(hash: string): string {
  return dataUrlCache.get(hash) || ''
}

function normalizeMimeType(raw: string): string {
  if (!raw) return 'application/octet-stream'
  let mime = raw.trim()
  if (mime.startsWith('data:')) {
    mime = mime.slice(5)
  }
  const semicolonIdx = mime.indexOf(';')
  if (semicolonIdx > 0) {
    mime = mime.slice(0, semicolonIdx)
  }
  if (mime.endsWith(',')) {
    mime = mime.slice(0, -1)
  }
  return mime || 'application/octet-stream'
}

function guessMimeType(base64String: string): string {
  if (!base64String) return 'application/octet-stream'

  if (base64String.startsWith('data:')) {
    const mimeMatch = base64String.match(/^data:([^;]+);base64,/)
    return mimeMatch?.[1] || 'application/octet-stream'
  }

  if (base64String.startsWith('/9j/')) return 'image/jpeg'
  if (base64String.startsWith('iVBOR')) return 'image/png'
  if (base64String.startsWith('R0lGOD')) return 'image/gif'
  if (base64String.startsWith('UklGR')) return 'image/webp'
  return 'application/octet-stream'
}

function buildDataUrl(base64: string, mimeType: string): string {
  if (!base64) return ''
  if (base64.startsWith('data:')) return base64
  return `data:${mimeType};base64,${base64}`
}

function mediaKind(mimeType: string): 'image' | 'audio' | 'video' | 'unknown' {
  const normalized = normalizeMimeType(mimeType)
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('audio/')) return 'audio'
  if (normalized.startsWith('video/')) return 'video'
  return 'unknown'
}

function isItemBusy(item: MediaItem): boolean {
  return item.isReidentifying || item.isDeleting || item.isSaving
}

function isItemDirty(item: MediaItem): boolean {
  return item.description !== item.originalDescription
}

function saveButtonLabel(item: MediaItem): string {
  if (item.isSaving) return '保存中…'
  if (item.saveFeedback === 'saved') return '已保存'
  return '保存更改'
}

function clearSaveTimer(hash: string): void {
  const timer = saveTimers.get(hash)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    saveTimers.delete(hash)
  }
}

function scheduleSaveFeedbackReset(item: MediaItem): void {
  clearSaveTimer(item.hash)
  saveTimers.set(item.hash, window.setTimeout(() => {
    item.saveFeedback = 'idle'
    saveTimers.delete(item.hash)
  }, 2000))
}

function disposeAll(): void {
  for (const timer of saveTimers.values()) {
    window.clearTimeout(timer)
  }
  saveTimers.clear()
  dataUrlCache.clear()
}

function normalizeItem(entry: MediaCacheItem): MediaItem {
  const description = typeof entry.description === 'string' ? entry.description : ''
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : ''
  const base64 = typeof entry.base64 === 'string' ? entry.base64 : ''
  const rawMime = entry.mimeType || guessMimeType(base64)
  const mimeType = normalizeMimeType(rawMime)

  // Store large binary data outside reactive system
  dataUrlCache.set(entry.hash, buildDataUrl(base64, mimeType))

  return {
    hash: entry.hash,
    description,
    originalDescription: description,
    timestamp,
    mimeType,
    isReidentifying: false,
    isDeleting: false,
    isSaving: false,
    saveFeedback: 'idle'
  }
}

function updatePaginationState(total: number, pages: number, page: number, nextPageSize: number): void {
  totalItems.value = total
  totalPages.value = Math.max(pages, 1)
  currentPage.value = total > 0 ? Math.min(page, totalPages.value) : 1
  pageSize.value = nextPageSize || pageSize.value
}

async function confirmDiscardChanges(): Promise<boolean> {
  if (!hasUnsavedChanges.value) return true
  return askConfirm('有未保存的修改，确定要离开吗？未保存的内容将会丢失。')
}

async function loadMediaCache(page = currentPage.value) {
  isLoading.value = true
  try {
    const data = await mediaCacheApi.getCache({
      page,
      pageSize: pageSize.value,
      search: currentSearch.value || undefined
    })

    if (data.total > 0 && data.items.length === 0 && page > 1 && page > data.totalPages) {
      updatePaginationState(data.total, data.totalPages, data.totalPages, data.pageSize)
      await loadMediaCache(data.totalPages)
      return
    }

    for (const item of mediaItems.value) clearSaveTimer(item.hash)
    dataUrlCache.clear()

    mediaItems.value = data.items.map(normalizeItem)
    updatePaginationState(data.total, data.totalPages, data.page, data.pageSize)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('加载多媒体缓存失败:', error)
    showMessage(`加载失败：${errorMessage}`, 'error')
  } finally {
    isLoading.value = false
  }
}

function refreshCurrentPage() {
  void loadMediaCache(currentPage.value)
}

async function applySearch() {
  if (!(await confirmDiscardChanges())) return
  currentSearch.value = searchInput.value
  currentPage.value = 1
  void loadMediaCache(1)
}

async function goToPreviousPage() {
  if (currentPage.value <= 1) return
  if (!(await confirmDiscardChanges())) return
  void loadMediaCache(currentPage.value - 1)
}

async function goToNextPage() {
  if (currentPage.value >= totalPages.value) return
  if (!(await confirmDiscardChanges())) return
  void loadMediaCache(currentPage.value + 1)
}

async function saveItem(item: MediaItem) {
  if (item.isSaving || !isItemDirty(item)) return

  item.isSaving = true
  item.saveFeedback = 'idle'
  clearSaveTimer(item.hash)

  try {
    const result = await mediaCacheApi.updateEntry(item.hash, item.description)
    item.originalDescription = item.description
    item.saveFeedback = 'saved'
    scheduleSaveFeedbackReset(item)
    showMessage(result.message || '条目已成功更新。', 'success')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('保存多媒体缓存条目失败:', error)
    showMessage(`保存失败：${errorMessage}`, 'error')
  } finally {
    item.isSaving = false
  }
}

async function removeItem(item: MediaItem) {
  if (
    item.isDeleting ||
    !(await askConfirm({
      message: '确定要删除这个媒体条目吗？',
      danger: true,
      confirmText: '删除',
    }))
  ) return

  item.isDeleting = true
  try {
    const result = await mediaCacheApi.deleteEntry(item.hash)
    clearSaveTimer(item.hash)
    dataUrlCache.delete(item.hash)

    mediaItems.value = mediaItems.value.filter(i => i.hash !== item.hash)
    totalItems.value = Math.max(totalItems.value - 1, 0)

    if (mediaItems.value.length === 0 && totalItems.value > 0) {
      await loadMediaCache(currentPage.value)
    } else {
      totalPages.value = Math.max(Math.ceil(totalItems.value / pageSize.value), 1)
      currentPage.value = totalItems.value === 0 ? 1 : Math.min(currentPage.value, totalPages.value)
    }

    showMessage(result.message || '缓存条目已删除。', 'success')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('删除多媒体缓存条目失败:', error)
    showMessage(`删除失败：${errorMessage}`, 'error')
  } finally {
    item.isDeleting = false
  }
}

async function reidentifyItem(item: MediaItem) {
  if (isItemBusy(item)) return

  item.isReidentifying = true
  try {
    const result = await mediaCacheApi.reidentify(item.hash)
    const nextDescription = result?.newDescription || ''

    item.description = nextDescription
    item.originalDescription = nextDescription
    item.timestamp = result?.newTimestamp || item.timestamp
    showMessage(result?.message || '媒体重新识别成功。', 'success')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('重新识别失败:', error)
    showMessage(`重新识别失败：${errorMessage}`, 'error')
  } finally {
    item.isReidentifying = false
  }
}

function openPreview(item: MediaItem) {
  const type = mediaKind(item.mimeType)
  const dataUrl = getDataUrl(item.hash)

  if ((type !== 'image' && type !== 'video') || !dataUrl) return

  previouslyFocusedElement = document.activeElement as HTMLElement | null
  previewDataUrl.value = dataUrl
  previewType.value = type
  previewOpen.value = true

  nextTick(() => {
    modalCloseBtn.value?.focus()
  })
}

function closePreview() {
  previewOpen.value = false
  previewDataUrl.value = ''

  if (previouslyFocusedElement) {
    previouslyFocusedElement.focus()
    previouslyFocusedElement = null
  }
}

async function loadTestData() {
  const { getMediaCacheFixtures } = await import('@/dev/media-cache-fixtures')
  const fixtures = getMediaCacheFixtures()

  for (const item of mediaItems.value) clearSaveTimer(item.hash)
  dataUrlCache.clear()

  mediaItems.value = fixtures.items.map(normalizeItem)
  updatePaginationState(fixtures.total, fixtures.totalPages, fixtures.page, fixtures.pageSize)
  showMessage('已加载测试数据', 'success')
}

onBeforeRouteLeave(async () => {
  if (!hasUnsavedChanges.value) return true
  const confirmed = await askConfirm('有未保存的修改，确定要离开吗？未保存的内容将会丢失。')
  if (!confirmed) return false
  return true
})

onMounted(() => {
  void loadMediaCache()
})

onUnmounted(() => {
  disposeAll()
})
</script>

<style scoped>
.media-cache-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: flex-start;
}

.page-header .description {
  margin: 0;
}

.page-header h2 {
  margin: 0;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.search-box {
  display: flex;
  gap: var(--space-2);
  flex: 1 1 320px;
}

.search-box :deep(.ui-input) {
  flex: 1;
  min-width: 0;
}

.pagination-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.pagination-summary {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  white-space: nowrap;
}
.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-4);
}

.media-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.media-card h3 {
  margin: 0;
  font-size: var(--font-size-body);
  color: var(--secondary-text);
}

.card-actions {
  position: absolute;
  right: 10px;
  top: 10px;
  display: flex;
  gap: 6px;
}

.card-actions :deep(.ui-icon-button) {
  width: 28px;
  height: 28px;
}

.card-actions :deep(.ui-icon-button.reidentify) {
  color: var(--success-color);
}

.card-actions :deep(.ui-icon-button.delete) {
  color: var(--danger-color);
}

.media-preview-wrap {
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.media-preview-button {
  border: 0;
  background: transparent;
  padding: 0;
  width: 100%;
  cursor: zoom-in;
}

.media-preview {
  width: 100%;
  max-height: 220px;
  object-fit: contain;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
}

.media-audio {
  width: 100%;
}

.unsupported-media {
  width: 100%;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--space-4);
  text-align: center;
  color: var(--secondary-text);
}

.media-preview-button:focus-visible,
.modal-close:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.hash-info {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  word-break: break-all;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
  padding: 8px;
}

.preview-modal {
  background: var(--overlay-backdrop-strong);
}

.modal-content {
  width: min(92vw, 1200px);
  height: min(88vh, 820px);
  display: flex;
  justify-content: center;
  align-items: center;
}

.modal-content img,
.modal-content video {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm);
}

.modal-close {
  position: absolute;
  top: 16px;
  right: 20px;
}

@media (max-width: 768px) {
  .page-header,
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .search-box,
  .pagination-controls {
    width: 100%;
  }

  .search-box :deep(.ui-button),
  .pagination-controls :deep(.ui-button) {
    flex: 1;
  }

  .media-grid {
    grid-template-columns: 1fr;
  }
}

/* ──────────── Multi-modal config modal ──────────── */
.mm-config-overlay {
  background: var(--overlay-backdrop-strong);
}

.mm-config-panel {
  width: min(720px, 94vw);
  max-height: 90vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-lg);
  position: relative;
}

.mm-config-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
}

.mm-config-header h3 {
  margin: 0;
}

.mm-config-header p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.mm-config-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.mm-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(160px, 1fr));
  gap: var(--space-3);
}

.mm-meta {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  margin: 0;
}

.mm-meta code {
  background: var(--input-bg);
  padding: 2px 6px;
  border-radius: 3px;
}

.mm-meta-tag {
  margin-left: 8px;
  vertical-align: middle;
}

.mm-config-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  border-top: 1px solid var(--border-color);
  padding-top: var(--space-3);
}

@media (max-width: 600px) {
  .mm-grid {
    grid-template-columns: 1fr;
  }
}
</style>
