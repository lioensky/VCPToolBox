<template>
  <section class="config-section active-section media-cache-page">
    <div class="page-header">
      <div>
        <p class="description">编辑多媒体缓存记录，支持搜索、分页、重新识别与预览。</p>
      </div>
      <div class="header-actions">
        <button class="btn-secondary" type="button" @click="refreshCurrentPage" :disabled="isLoading">
          刷新
        </button>
      </div>
    </div>

    <div class="toolbar">
      <div class="search-box">
        <input
          v-model.trim="searchInput"
          type="search"
          placeholder="搜索媒体描述…"
          :disabled="isLoading"
          @keydown.enter.prevent="applySearch"
        >
        <button class="btn-secondary" type="button" @click="applySearch" :disabled="isLoading">
          搜索
        </button>
      </div>

      <div class="pagination-controls">
        <button class="btn-secondary" type="button" @click="goToPreviousPage" :disabled="isLoading || currentPage <= 1">
          上一页
        </button>
        <span class="pagination-summary">{{ paginationSummary }}</span>
        <button
          class="btn-secondary"
          type="button"
          @click="goToNextPage"
          :disabled="isLoading || currentPage >= totalPages"
        >
          下一页
        </button>
      </div>
    </div>

    <p v-if="isLoading" class="status-tip">正在加载多媒体缓存数据…</p>
    <p v-else-if="mediaItems.length === 0" class="status-tip">{{ emptyMessage }}</p>

    <div v-else class="media-grid">
      <article v-for="item in mediaItems" :key="item.hash" class="media-card">
        <div class="card-actions">
        <button
          class="icon-btn reidentify"
          type="button"
          :disabled="isItemBusy(item)"
          :aria-label="item.isReidentifying ? '正在重新识别' : '重新识别媒体描述'"
          @click="reidentifyItem(item)"
        >
            {{ item.isReidentifying ? '…' : '↻' }}
          </button>
          <button
            class="icon-btn delete"
            type="button"
            :disabled="isItemBusy(item)"
            aria-label="删除条目"
            @click="removeItem(item)"
          >
            {{ item.isDeleting ? '…' : '×' }}
          </button>
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
              v-lazy="toDataUrl(item)"
              alt="媒体预览"
              class="media-preview"
            >
            <video
              v-else
              :src="toDataUrl(item)"
              class="media-preview"
              preload="metadata"
              muted
            ></video>
          </button>

          <audio
            v-else-if="mediaKind(item.mimeType) === 'audio'"
            :src="toDataUrl(item)"
            controls
            preload="metadata"
            class="media-audio"
          ></audio>

          <div v-else class="unsupported-media">
            <p>不支持的媒体类型</p>
            <span>{{ item.mimeType }}</span>
          </div>
        </div>

        <label class="desc-label" :for="`desc-${item.hash}`">媒体描述:</label>
        <textarea
          :id="`desc-${item.hash}`"
          v-model="item.description"
          rows="4"
          :disabled="item.isDeleting || item.isSaving"
          placeholder="请输入媒体描述…"
        ></textarea>

        <button class="btn-success" style="width: 100%;" type="button" :disabled="isItemBusy(item)" @click="saveItem(item)">
          {{ saveButtonLabel(item) }}
        </button>

        <div class="hash-info">Hash (部分): {{ item.hash.slice(0, 30) }}{{ item.hash.length > 30 ? '…' : '' }}</div>
      </article>
    </div>

    <div
      v-if="previewOpen"
      class="preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label="媒体预览"
      @click.self="closePreview"
    >
      <button class="modal-close" type="button" aria-label="关闭预览" @click="closePreview">×</button>
      <div class="modal-content">
        <img v-if="previewType === 'image'" :src="previewDataUrl" alt="放大预览图" />
        <video v-else controls autoplay :src="previewDataUrl"></video>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { mediaCacheApi, type MediaCacheItem } from '@/api'
import { showMessage } from '@/utils'

const DEFAULT_PAGE_SIZE = 20

interface MediaItem {
  hash: string
  base64: string
  description: string
  originalDescription: string
  timestamp: string
  mimeType: string
  isReidentifying: boolean
  isDeleting: boolean
  isSaving: boolean
  saveFeedback: 'idle' | 'saved'
  saveResetTimer: number | null
}

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

const paginationSummary = computed(() => `第 ${currentPage.value} / ${totalPages.value} 页 · 共 ${totalItems.value} 条`)
const emptyMessage = computed(() => (currentSearch.value ? '没有匹配的缓存条目。' : '暂无缓存条目。'))

function normalizeMimeType(raw: string): string {
  if (!raw) return 'application/octet-stream'
  let mime = raw.trim()
  // 去除 "data:" 前缀（如 "data:image/jpeg;" → "image/jpeg"）
  if (mime.startsWith('data:')) {
    mime = mime.slice(5)
  }
  // 去除尾部分号和 base64 标记（如 "image/jpeg;base64," → "image/jpeg"）
  const semicolonIdx = mime.indexOf(';')
  if (semicolonIdx > 0) {
    mime = mime.slice(0, semicolonIdx)
  }
  // 去除尾部逗号
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

function mediaKind(mimeType: string): 'image' | 'audio' | 'video' | 'unknown' {
  const normalized = normalizeMimeType(mimeType)
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('audio/')) return 'audio'
  if (normalized.startsWith('video/')) return 'video'
  return 'unknown'
}

function toDataUrl(item: MediaItem): string {
  if (!item.base64) {
    return ''
  }

  if (item.base64.startsWith('data:')) {
    return item.base64
  }

  return `data:${item.mimeType};base64,${item.base64}`
}

function isItemBusy(item: MediaItem): boolean {
  return item.isReidentifying || item.isDeleting || item.isSaving
}

function saveButtonLabel(item: MediaItem): string {
  if (item.isSaving) {
    return '保存中…'
  }

  if (item.saveFeedback === 'saved') {
    return '已保存'
  }

  return '保存更改'
}

function clearSaveResetTimer(item: MediaItem): void {
  if (item.saveResetTimer !== null) {
    window.clearTimeout(item.saveResetTimer)
    item.saveResetTimer = null
  }
}

function scheduleSaveFeedbackReset(item: MediaItem): void {
  clearSaveResetTimer(item)
  item.saveResetTimer = window.setTimeout(() => {
    item.saveFeedback = 'idle'
    item.saveResetTimer = null
  }, 2000)
}

function disposeMediaItems(items: MediaItem[] = mediaItems.value): void {
  items.forEach((item) => clearSaveResetTimer(item))
}

function normalizeItem(entry: MediaCacheItem): MediaItem {
  const description = typeof entry.description === 'string' ? entry.description : ''
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : ''
  const base64 = typeof entry.base64 === 'string' ? entry.base64 : ''
  const rawMime = entry.mimeType || guessMimeType(base64)

  return {
    hash: entry.hash,
    base64,
    description,
    originalDescription: description,
    timestamp,
    mimeType: normalizeMimeType(rawMime),
    isReidentifying: false,
    isDeleting: false,
    isSaving: false,
    saveFeedback: 'idle',
    saveResetTimer: null
  }
}

function updatePaginationState(total: number, pages: number, page: number, nextPageSize: number): void {
  totalItems.value = total
  totalPages.value = Math.max(pages, 1)
  currentPage.value = total > 0 ? Math.min(page, totalPages.value) : 1
  pageSize.value = nextPageSize || pageSize.value
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

    disposeMediaItems()
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

function applySearch() {
  currentSearch.value = searchInput.value
  currentPage.value = 1
  void loadMediaCache(1)
}

function goToPreviousPage() {
  if (currentPage.value <= 1) {
    return
  }

  void loadMediaCache(currentPage.value - 1)
}

function goToNextPage() {
  if (currentPage.value >= totalPages.value) {
    return
  }

  void loadMediaCache(currentPage.value + 1)
}

async function saveItem(item: MediaItem) {
  if (item.isSaving) {
    return
  }

  item.isSaving = true
  item.saveFeedback = 'idle'
  clearSaveResetTimer(item)

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
  if (item.isDeleting || !confirm('确定要删除这个媒体条目吗？')) {
    return
  }

  item.isDeleting = true
  try {
    const result = await mediaCacheApi.deleteEntry(item.hash)
    clearSaveResetTimer(item)

    mediaItems.value = mediaItems.value.filter((currentItem) => currentItem.hash !== item.hash)
    totalItems.value = Math.max(totalItems.value - 1, 0)
    totalPages.value = Math.max(Math.ceil(totalItems.value / pageSize.value), 1)
    currentPage.value = totalItems.value === 0 ? 1 : Math.min(currentPage.value, totalPages.value)

    if (mediaItems.value.length === 0 && totalItems.value > 0) {
      await loadMediaCache(currentPage.value)
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
  if (isItemBusy(item)) {
    return
  }

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
  const dataUrl = toDataUrl(item)

  if ((type !== 'image' && type !== 'video') || !dataUrl) {
    return
  }

  previewDataUrl.value = dataUrl
  previewType.value = type
  previewOpen.value = true
  document.body.style.overflow = 'hidden'
}

function closePreview() {
  previewOpen.value = false
  previewDataUrl.value = ''
  document.body.style.overflow = ''
}

function handleEsc(event: KeyboardEvent) {
  if (event.key === 'Escape' && previewOpen.value) {
    closePreview()
  }
}

onMounted(() => {
  void loadMediaCache()
  document.addEventListener('keydown', handleEsc)
})

onUnmounted(() => {
  disposeMediaItems()
  document.removeEventListener('keydown', handleEsc)
  document.body.style.overflow = ''
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

.page-header h2 {
  margin: 0;
}

.header-actions {
  display: flex;
  gap: var(--space-3);
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
  gap: var(--space-3);
  flex: 1 1 320px;
}

.search-box input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border-color);
  background: var(--input-bg);
  color: var(--primary-text);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
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
.status-tip {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-4);
}

.media-card {
  position: relative;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  background: var(--tertiary-bg);
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

.icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: none;
  color: var(--on-accent-text);
  cursor: pointer;
}

.icon-btn.reidentify {
  background: var(--success-color);
}

.icon-btn.delete {
  background: var(--danger-color);
}

.icon-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
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

.desc-label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

textarea {
  width: 100%;
  min-height: 96px;
  border: 1px solid var(--border-color);
  background: var(--input-bg);
  color: var(--primary-text);
  border-radius: var(--radius-sm);
  padding: 10px;
  resize: vertical;
}

.search-box input:focus-visible,
textarea:focus-visible,
.media-preview-button:focus-visible,
.icon-btn:focus-visible,
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
  position: fixed;
  inset: 0;
  background: var(--overlay-backdrop-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
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
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--overlay-frost-border);
  background: var(--overlay-frost-bg);
  color: var(--on-accent-text);
  font-size: var(--font-size-icon-modal-close);
  line-height: 1;
  cursor: pointer;
}

@media (max-width: 768px) {
  .page-header,
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .header-actions,
  .search-box,
  .pagination-controls {
    width: 100%;
  }

  .header-actions button,
  .search-box button,
  .pagination-controls button {
    flex: 1;
  }

  .media-grid {
    grid-template-columns: 1fr;
  }
}
</style>
