<template>
  <section class="config-section active-section emoji-gallery-page">
    <header class="hero-card card">
      <div class="hero-copy">
        <span class="hero-kicker">Image Workspace</span>
        <div class="hero-title-row">
          <div>
            <h1>表情包画廊</h1>
            <p class="description">
              浏览并整理 `image` 目录中的表情包资源，支持检索、目录筛选、上传导入、分页浏览与大图预览。
            </p>
          </div>
          <div class="hero-badges" aria-live="polite">
            <span class="hero-badge">
              <strong>{{ matchedEmojiCount }}</strong>
              <span>命中</span>
            </span>
            <span class="hero-badge">
              <strong>{{ categories.length }}</strong>
              <span>目录</span>
            </span>
            <span class="hero-badge">
              <strong>{{ items.length }}</strong>
              <span>当前页</span>
            </span>
          </div>
        </div>
      </div>

      <div class="hero-toolbar">
        <div class="hero-search-group">
          <label class="search-field hero-search-field">
            <span class="material-symbols-outlined">search</span>
            <input
              v-model.trim="searchInput"
              type="search"
              aria-label="搜索表情包"
              placeholder="搜索文件名、路径或目录…"
              :disabled="isLoading"
              @keydown.enter.prevent="applySearch"
            />
          </label>

          <button
            type="button"
            class="btn-primary"
            :disabled="isLoading"
            @click="applySearch"
          >
            搜索
          </button>

          <button
            v-if="activeKeyword"
            type="button"
            class="btn-secondary"
            :disabled="isLoading"
            @click="clearSearch"
          >
            清空
          </button>
        </div>

        <div class="hero-toolbar-actions">
          <label class="page-size-control">
            <span>每页</span>
            <select
              v-model.number="pageSize"
              :disabled="isLoading"
              @change="handlePageSizeChange"
            >
              <option
                v-for="size in PAGE_SIZE_OPTIONS"
                :key="size"
                :value="size"
              >
                {{ size }}
              </option>
            </select>
          </label>

          <button
            type="button"
            class="btn-secondary"
            :disabled="isLoading"
            @click="refreshCurrentPage"
          >
            {{ isLoading && hasLoadedOnce ? "刷新中…" : "刷新" }}
          </button>

          <button
            type="button"
            class="btn-secondary"
            :disabled="isRebuildingList"
            @click="rebuildGeneratedEmojiLists"
          >
            {{ isRebuildingList ? "重建中…" : "重建列表" }}
          </button>

          <button
            type="button"
            class="btn-secondary"
            :disabled="isLoading || isUploading"
            @click="createCategory"
          >
            新建目录
          </button>
        </div>
      </div>

      <div class="hero-status-row">
        <p class="hero-status-tip">{{ refreshStateText }}</p>
        <div class="hero-filter-summary">
          <span class="filter-pill" :class="{ active: selectedCategory === '' }">
            {{ selectedCategory ? `目录：${selectedCategory}` : "全部目录" }}
          </span>
          <span v-if="activeKeyword" class="filter-pill active">
            关键词：{{ activeKeyword }}
          </span>
          <span class="filter-pill">{{ paginationSummary }}</span>
        </div>
      </div>
    </header>

    <div class="gallery-workspace" :class="{ 'is-console-collapsed': consoleCollapsed }">
      <aside class="operations-column">
        <section
          class="operations-console card"
          :class="{ 'is-collapsed': consoleCollapsed }"
          :aria-label="consoleCollapsed ? '表情包操作台（已折叠）' : '表情包操作台'"
        >
          <template v-if="consoleCollapsed">
            <div class="console-rail">
              <button
                type="button"
                class="console-rail-toggle"
                aria-label="展开操作台"
                title="展开操作台"
                @click="toggleConsole"
              >
                <span class="material-symbols-outlined">left_panel_open</span>
              </button>
              <div class="console-rail-divider"></div>
              <button
                type="button"
                class="console-rail-icon"
                aria-label="刷新"
                title="刷新"
                :disabled="isLoading"
                @click="refreshCurrentPage"
              >
                <span class="material-symbols-outlined">refresh</span>
              </button>
              <button
                type="button"
                class="console-rail-icon"
                aria-label="新建目录"
                title="新建目录"
                :disabled="isLoading || isUploading"
                @click="createCategory"
              >
                <span class="material-symbols-outlined">create_new_folder</span>
              </button>
              <button
                type="button"
                class="console-rail-icon"
                :class="{ 'is-active': selectedCategory === '' }"
                aria-label="全部目录"
                title="全部目录"
                :disabled="isLoading"
                @click="selectCategory('')"
              >
                <span class="material-symbols-outlined">folder_copy</span>
              </button>
            </div>
          </template>
          <template v-else>
          <div class="operations-console__section">
            <div class="operations-console__header">
              <div>
                <span class="operations-console__label">Library Rail</span>
                <h3>目录导航</h3>
              </div>
              <button
                type="button"
                class="console-rail-toggle"
                aria-label="折叠操作台"
                title="折叠操作台"
                @click="toggleConsole"
              >
                <span class="material-symbols-outlined">left_panel_close</span>
              </button>
            </div>
            <p class="panel-hint">用目录快速缩小浏览范围，维护动作留在这里集中处理。</p>

            <div class="quick-actions">
              <button
                type="button"
                class="btn-secondary"
                :disabled="isLoading"
                @click="refreshCurrentPage"
              >
                刷新
              </button>

              <button
                type="button"
                class="btn-secondary"
                :disabled="isLoading || isUploading"
                @click="createCategory"
              >
                新建目录
              </button>
              <button
                type="button"
                class="btn-secondary"
                :disabled="isRebuildingList"
                @click="rebuildGeneratedEmojiLists"
              >
                重建列表
              </button>
            </div>

            <div class="rail-meta">
              <span>{{ matchedEmojiCount }} 项命中</span>
              <span>{{ totalEmojiCount }} 项总量</span>
            </div>
          </div>

          <div class="operations-console__section">
            <span class="operations-console__label">目录筛选</span>
            <h3>按目录过滤</h3>
            <p class="panel-hint">目录计数显示为“当前命中 / 总量”。</p>

            <div class="directory-list" aria-label="目录筛选">
              <button
                type="button"
                class="directory-pill"
                :class="{ active: selectedCategory === '' }"
                :disabled="isLoading"
                @click="selectCategory('')"
              >
                <span>全部目录</span>
                <span class="pill-count">{{ totalEmojiCount }}</span>
              </button>

              <button
                v-for="category in categories"
                :key="category.name"
                type="button"
                class="directory-pill"
                :class="{ active: selectedCategory === category.name }"
                :disabled="isLoading"
                @click="selectCategory(category.name)"
              >
                <span>{{ category.name }}</span>
                <span class="pill-count">
                  {{ category.matchedCount }} / {{ category.totalCount }}
                </span>
              </button>
            </div>

            <button
              v-if="selectedCategory && selectedCategory !== ROOT_CATEGORY_NAME"
              type="button"
              class="btn-danger btn-sm delete-category-btn"
              :disabled="isDeletingCategory || isLoading"
              @click="deleteSelectedCategory"
            >
              {{ isDeletingCategory ? "删除中…" : `删除目录 “${selectedCategory}”` }}
            </button>
          </div>
          </template>
        </section>
      </aside>

      <section class="content-column">
        <section class="upload-console card">
          <div class="upload-console__header">
            <span class="upload-console__label">本地上传</span>
            <h3>上传图片、文件夹或压缩包</h3>
            <p class="panel-hint">
              支持图片文件、文件夹与压缩包上传。若目录名以“表情包”结尾，可同步生成 EmojiListGenerator 列表。
            </p>
            <p
              v-if="uploadMode === 'files'"
              class="upload-target-tip"
            >
              图片文件将上传到：{{ effectiveUploadCategory }}
            </p>
            <p
              v-else-if="uploadMode === 'folder'"
              class="upload-target-tip"
            >
              文件夹模式：保留原始目录结构上传
            </p>
            <p
              v-else-if="uploadMode === 'archive'"
              class="upload-target-tip"
            >
              压缩包模式：解压后保留内部结构
            </p>
          </div>

          <AppCheckbox
            v-model="uploadSyncList"
            class="upload-sync-option"
            :disabled="isUploading"
          >
            上传后同步重建 generated_lists
          </AppCheckbox>

          <div class="upload-entry-actions">
            <button
              type="button"
              class="btn-secondary"
              :disabled="isUploading"
              @click="triggerFileSelect"
            >
              选择图片文件
            </button>

            <button
              type="button"
              class="btn-secondary"
              :disabled="isUploading"
              @click="triggerFolderSelect"
            >
              选择文件夹
            </button>

            <button
              type="button"
              class="btn-secondary"
              :disabled="isUploading"
              @click="triggerArchiveSelect"
            >
              选择压缩包
            </button>
          </div>

          <input
            ref="fileInputRef"
            class="upload-file-input"
            type="file"
            :accept="IMAGE_UPLOAD_ACCEPT"
            multiple
            @change="handleFileSelected"
          />

          <input
            ref="folderInputRef"
            class="upload-file-input"
            type="file"
            :accept="IMAGE_UPLOAD_ACCEPT"
            webkitdirectory
            directory
            multiple
            @change="handleFolderSelected"
          />

          <input
            ref="archiveInputRef"
            class="upload-file-input"
            type="file"
            :accept="ARCHIVE_UPLOAD_ACCEPT"
            @change="handleArchiveSelected"
          />

          <div v-if="selectedFiles.length > 0" class="upload-summary">
            <span>模式：{{ selectedUploadModeLabel }}</span>
            <span>文件：{{ selectedFiles.length }}</span>
            <span>总大小：{{ formatFileSize(selectedUploadTotalSize) }}</span>
          </div>

          <ul v-if="selectedFiles.length > 0" class="upload-file-list">
            <li
              v-for="(file, index) in selectedFiles"
              :key="`${file.name}-${file.lastModified}-${index}`"
              class="upload-file-item"
            >
              <div class="upload-file-copy">
                <span class="upload-file-name" :title="file.name">{{ file.name }}</span>
                <span
                  v-if="uploadMode === 'folder'"
                  class="upload-file-path"
                  :title="selectedRelativePaths[index]"
                >
                  {{ selectedRelativePaths[index] }}
                </span>
              </div>
              <span class="upload-file-meta">{{ formatFileSize(file.size) }}</span>
              <button
                type="button"
                class="upload-file-remove"
                :disabled="isUploading"
                @click="removeSelectedFile(index)"
              >
                移除
              </button>
            </li>
          </ul>

          <div class="upload-actions">
            <button
              type="button"
              class="btn-secondary"
              :disabled="isUploading || selectedFiles.length === 0"
              @click="clearSelectedFiles"
            >
              清空待上传
            </button>

            <button
              type="button"
              class="btn-primary"
              :disabled="isUploading || selectedFiles.length === 0"
              @click="uploadSelectedFiles"
            >
              {{ isUploading ? "上传中…" : `开始上传（${selectedFiles.length}）` }}
            </button>
          </div>

          <div v-if="lastRejectedItems.length > 0" class="upload-rejected">
            <button
              type="button"
              class="upload-rejected__toggle"
              @click="showRejectedList = !showRejectedList"
            >
              <span>
                最近一次校验有 {{ lastRejectedItems.length }} 个文件被过滤
              </span>
              <span>{{ showRejectedList ? "收起" : "展开" }}</span>
            </button>
            <ul v-if="showRejectedList" class="upload-rejected__list">
              <li
                v-for="(entry, index) in lastRejectedItems"
                :key="`${entry.fileName}-${index}`"
                class="upload-rejected__item"
              >
                <span class="upload-rejected__name" :title="entry.fileName">
                  {{ entry.fileName }}
                </span>
                <span class="upload-rejected__reason">{{ entry.reason }}</span>
              </li>
            </ul>
          </div>
        </section>

        <section class="overview-card card" aria-live="polite">
          <div class="content-header">
            <h3>
              {{ selectedCategory ? `${selectedCategory} · 表情包` : "全部目录 · 表情包" }}
            </h3>
            <p>{{ paginationSummary }}</p>
          </div>

          <section class="stats-strip">
            <span>当前命中 {{ matchedEmojiCount }} 项</span>
            <span>当前页 {{ items.length }} 项</span>
            <span>目录 {{ categories.length }} 个</span>
            <span v-if="cacheScannedAtText">索引时间：{{ cacheScannedAtText }}</span>
          </section>
        </section>

        <section v-if="showSkeletonGrid" class="emoji-grid emoji-grid--skeleton" aria-label="表情包加载中">
          <article
            v-for="index in skeletonCardCount"
            :key="`skeleton-${index}`"
            class="emoji-card emoji-card--skeleton"
            aria-hidden="true"
          >
            <div class="preview-shell preview-shell--skeleton"></div>
            <div class="emoji-meta">
              <div class="skeleton-line skeleton-line--title"></div>
              <div class="skeleton-line skeleton-line--meta"></div>
              <div class="skeleton-line skeleton-line--path"></div>
            </div>
            <div class="emoji-actions">
              <span class="skeleton-chip"></span>
              <span class="skeleton-chip"></span>
              <span class="skeleton-chip"></span>
            </div>
          </article>
        </section>

        <section v-else-if="items.length === 0" class="card empty-state emoji-empty-state">
          <span class="material-symbols-outlined">sentiment_dissatisfied</span>
          <h3>暂时没有结果</h3>
          <p>{{ emptyMessage }}</p>
        </section>

        <section v-else class="emoji-grid-shell">
          <div v-if="showRefreshingOverlay" class="grid-refresh-banner" role="status">
            <span class="material-symbols-outlined">sync</span>
            <span>正在刷新索引，当前结果会在请求完成后更新</span>
          </div>

          <section class="emoji-grid" aria-label="表情包列表">
          <article
            v-for="(item, index) in items"
            :key="item.relativePath"
            class="emoji-card"
            v-memo="[item.relativePath, deletingPaths.has(item.relativePath)]"
            :style="{ '--stagger-delay': `${Math.min(index, 24) * 22}ms` }"
          >
            <button
              type="button"
              class="preview-shell"
              :aria-label="`预览 ${item.name}`"
              @click="openPreview(item)"
            >
              <img
                v-lazy="item.thumbnailUrl"
                :alt="item.name"
                decoding="async"
                loading="lazy"
              />
            </button>

            <div class="emoji-meta">
              <div class="emoji-title-row">
                <h3 :title="item.name">{{ item.name }}</h3>
                <span class="format-badge">{{ item.extension.toUpperCase() }}</span>
              </div>

              <p class="emoji-category">{{ item.category }}</p>
              <p class="emoji-path" :title="item.relativePath">{{ item.relativePath }}</p>
            </div>

            <div class="emoji-actions">
              <button
                type="button"
                class="btn-secondary btn-sm"
                @click="copyRelativePath(item.relativePath)"
              >
                复制路径
              </button>

              <a
                class="btn-secondary btn-sm"
                :href="item.previewUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                新窗口
              </a>

              <button
                type="button"
                class="btn-danger btn-sm"
                :disabled="deletingPaths.has(item.relativePath)"
                @click="deleteEmojiItem(item)"
              >
                {{ deletingPaths.has(item.relativePath) ? "删除中…" : "删除" }}
              </button>
            </div>
          </article>
          </section>
        </section>

        <section class="pagination-controls">
          <button
            type="button"
            class="btn-secondary"
            :disabled="isLoading || currentPage <= 1"
            @click="goToPreviousPage"
          >
            上一页
          </button>

          <span class="pagination-summary">{{ paginationSummary }}</span>

          <button
            type="button"
            class="btn-secondary"
            :disabled="isLoading || currentPage >= totalPages"
            @click="goToNextPage"
          >
            下一页
          </button>
        </section>
      </section>
    </div>

    <BaseModal
      v-model="previewOpen"
      aria-label="表情包预览"
      @close="closePreview"
    >
      <template #default="{ overlayAttrs, panelAttrs, panelRef }">
        <div
          v-bind="overlayAttrs"
          class="preview-modal"
          @keydown="handlePreviewKeydown"
        >
          <div :ref="panelRef" v-bind="panelAttrs" class="preview-panel">
            <button
              type="button"
              class="modal-close"
              aria-label="关闭预览"
              @click="closePreview"
            >
              ×
            </button>

            <button
              type="button"
              class="preview-nav preview-nav--prev"
              aria-label="上一张"
              :disabled="!canPreviewPrev"
              @click="showPrevPreview"
            >
              ‹
            </button>

            <button
              type="button"
              class="preview-nav preview-nav--next"
              aria-label="下一张"
              :disabled="!canPreviewNext"
              @click="showNextPreview"
            >
              ›
            </button>

            <img
              v-if="previewItem"
              :src="previewItem.previewUrl"
              :alt="previewItem.name"
              class="preview-image"
            />

            <footer v-if="previewItem" class="preview-footer">
              <h3>{{ previewItem.name }}</h3>
              <p>{{ previewItem.relativePath }}</p>
              <span class="preview-counter" v-if="previewIndex >= 0">
                {{ previewIndex + 1 }} / {{ items.length }}（当前页）
              </span>
            </footer>
          </div>
        </div>
      </template>
    </BaseModal>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter, type LocationQueryRaw } from "vue-router";
import BaseModal from "@/components/ui/BaseModal.vue";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import { useConsoleCollapse } from "@/composables/useConsoleCollapse";
import { useLocalStorage } from "@/composables/useLocalStorage";
import {
  emojisApi,
  type EmojiGalleryData,
  type EmojiGalleryCategory,
  type EmojiGalleryItem,
  type EmojiUploadRejectedItem,
  type EmojiUploadResult,
} from "@/api";
import {
  buildEmojiGalleryRouteQuery,
  readEmojiGalleryRouteState,
} from "@/features/emoji-gallery/routeState";
import {
  ARCHIVE_UPLOAD_ACCEPT,
  formatFileSize,
  IMAGE_UPLOAD_ACCEPT,
  prepareUploadSelection,
  type UploadMode,
} from "@/features/emoji-gallery/uploadSelection";
import { isHttpError } from "@/platform/http/errors";
import { askConfirm, askInput } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";

const PAGE_SIZE_OPTIONS = [30, 60, 120, 180] as const;
const DEFAULT_PAGE_SIZE = 60;
const DEFAULT_UPLOAD_CATEGORY = "本地上传表情包";
const ROOT_CATEGORY_NAME = "根目录";

interface LoadGalleryOptions {
  forceRefresh?: boolean;
}

const router = useRouter();
const route = useRoute();
const initialRouteState = readEmojiGalleryRouteState(route.query, {
  defaultPageSize: DEFAULT_PAGE_SIZE,
  pageSizeOptions: PAGE_SIZE_OPTIONS,
});

const isLoading = ref(false);
const hasLoadedOnce = ref(false);
const searchInput = ref(initialRouteState.keyword);
const activeKeyword = ref(initialRouteState.keyword);
const selectedCategory = ref(initialRouteState.category);
const pageSize = ref<number>(initialRouteState.pageSize);
const currentPage = ref(initialRouteState.page);
const totalPages = ref(1);
const total = ref(0);
const categories = shallowRef<EmojiGalleryCategory[]>([]);
const items = shallowRef<EmojiGalleryItem[]>([]);
const itemsPathIndex = shallowRef<Map<string, number>>(new Map());
const galleryCache = ref<EmojiGalleryData["cache"] | null>(null);
const isSyncingRoute = ref(false);

watch(items, (newItems) => {
  itemsPathIndex.value = new Map(
    newItems.map((item, idx) => [item.relativePath, idx])
  );
});
const cacheScannedAt = ref<number | null>(null);

const previewOpen = ref(false);
const previewItem = ref<EmojiGalleryItem | null>(null);

const fileInputRef = ref<HTMLInputElement | null>(null);
const folderInputRef = ref<HTMLInputElement | null>(null);
const archiveInputRef = ref<HTMLInputElement | null>(null);
const selectedFiles = ref<File[]>([]);
const selectedRelativePaths = ref<string[]>([]);
const uploadMode = ref<UploadMode>("files");
const preferredUploadCategory = useLocalStorage(
  "emoji-gallery:preferred-upload-category",
  DEFAULT_UPLOAD_CATEGORY
);
const uploadSyncList = useLocalStorage("emoji-gallery:upload-sync-list", true);
const isUploading = ref(false);
const isRebuildingList = ref(false);
const deletingPaths = ref<Set<string>>(new Set());
const isDeletingCategory = ref(false);
const lastRejectedItems = ref<Array<{ fileName: string; reason: string }>>([]);
const showRejectedList = ref(false);

const { collapsed: consoleCollapsed, toggle: toggleConsole } = useConsoleCollapse(
  "emoji-gallery-console"
);

let currentLoadController: AbortController | null = null;

const totalEmojiCount = computed(() =>
  categories.value.reduce((sum, category) => sum + category.totalCount, 0)
);

const matchedEmojiCount = computed(() =>
  categories.value.reduce((sum, category) => sum + category.matchedCount, 0)
);

const previewIndex = computed(() => {
  if (!previewItem.value) {
    return -1;
  }
  const idx = itemsPathIndex.value.get(previewItem.value.relativePath);
  return idx ?? -1;
});

const canPreviewPrev = computed(
  () => previewIndex.value > 0 || (previewIndex.value === 0 && currentPage.value > 1)
);
const canPreviewNext = computed(() => {
  if (previewIndex.value < 0) return false;
  if (previewIndex.value < items.value.length - 1) return true;
  return currentPage.value < totalPages.value;
});

const paginationSummary = computed(
  () => `第 ${currentPage.value} / ${totalPages.value} 页 · 共 ${total.value} 项`
);
const skeletonCardCount = computed(() => Math.min(pageSize.value, 12));
const showSkeletonGrid = computed(() => isLoading.value && !hasLoadedOnce.value);
const showRefreshingOverlay = computed(() => isLoading.value && hasLoadedOnce.value);

const selectedUploadTotalSize = computed(() =>
  selectedFiles.value.reduce((sum, file) => sum + file.size, 0)
);

const effectiveUploadCategory = computed(() => {
  if (selectedCategory.value && selectedCategory.value !== ROOT_CATEGORY_NAME) {
    return selectedCategory.value;
  }

  return preferredUploadCategory.value;
});

const selectedUploadModeLabel = computed(() => {
  switch (uploadMode.value) {
    case "folder":
      return "文件夹";
    case "archive":
      return "压缩包";
    default:
      return "图片文件";
  }
});

const cacheScannedAtText = computed(() => {
  if (!cacheScannedAt.value) {
    return "";
  }

  return new Date(cacheScannedAt.value).toLocaleString("zh-CN", {
    hour12: false,
  });
});

const refreshStateText = computed(() => {
  if (!galleryCache.value?.refreshRequested) {
    return cacheScannedAtText.value
      ? `当前索引扫描时间：${cacheScannedAtText.value}`
      : "当前展示为已缓存索引结果";
  }

  if (galleryCache.value.refreshApplied) {
    return cacheScannedAtText.value
      ? `已从磁盘刷新索引：${cacheScannedAtText.value}`
      : "已从磁盘刷新索引";
  }

  const cooldownSeconds = Math.ceil((galleryCache.value.refreshCooldownMs ?? 5000) / 1000);
  return `刷新请求命中冷却窗口，已继续使用缓存结果（${cooldownSeconds} 秒内避免重复全量扫描）`;
});

const emptyMessage = computed(() => {
  if (activeKeyword.value && selectedCategory.value) {
    return "当前分类下没有匹配关键词的表情包。";
  }
  if (activeKeyword.value) {
    return "没有匹配关键词的表情包。";
  }
  if (selectedCategory.value) {
    return "该分类暂无可展示表情包。";
  }
  return "image 目录中未发现可展示的表情包文件。";
});

function normalizeGalleryItem(item: EmojiGalleryItem): EmojiGalleryItem {
  if (item.previewUrl && item.thumbnailUrl) {
    return item;
  }

  return {
    ...item,
    previewUrl: emojisApi.buildPreviewUrl(item.relativePath),
    thumbnailUrl: emojisApi.buildThumbnailUrl(item.relativePath),
  };
}

function sanitizeCategoryName(rawValue: string): string | null {
  const normalized = rawValue.trim();
  if (!normalized || normalized.length > 80) {
    return null;
  }

  if (/[\\/\0]/.test(normalized) || normalized.includes("..")) {
    return null;
  }

  return normalized;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function getRouteStateSnapshot(page = currentPage.value) {
  return {
    keyword: activeKeyword.value,
    category: selectedCategory.value,
    page,
    pageSize: pageSize.value,
  } as const;
}

async function syncRouteQuery(page = currentPage.value): Promise<void> {
    const nextState = getRouteStateSnapshot(page);
  const currentState = readEmojiGalleryRouteState(route.query, {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  });

  if (
    currentState.keyword === nextState.keyword &&
    currentState.category === nextState.category &&
    currentState.page === nextState.page &&
    currentState.pageSize === nextState.pageSize
  ) {
    return;
  }

  const mergedQuery: LocationQueryRaw = { ...route.query };
  delete mergedQuery.keyword;
  delete mergedQuery.category;
  delete mergedQuery.page;
  delete mergedQuery.pageSize;

  Object.assign(
    mergedQuery,
    buildEmojiGalleryRouteQuery(nextState, {
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    })
  );

  isSyncingRoute.value = true;
  try {
    await router.replace({ query: mergedQuery });
  } finally {
    isSyncingRoute.value = false;
  }
}

async function loadGallery(
  page = 1,
  options: LoadGalleryOptions = {}
): Promise<EmojiGalleryData | null> {
  const requestController = new AbortController();
  if (currentLoadController) {
    currentLoadController.abort();
  }
  currentLoadController = requestController;
  isLoading.value = true;

  try {
    const response = await emojisApi.getGallery({
      page,
      pageSize: pageSize.value,
      keyword: activeKeyword.value || undefined,
      category: selectedCategory.value || undefined,
      refresh: options.forceRefresh === true,
    }, undefined, {
      signal: requestController.signal,
    });

    categories.value = Array.isArray(response.categories)
      ? response.categories
      : [];
    items.value = Array.isArray(response.items)
      ? response.items.map(normalizeGalleryItem)
      : [];
    total.value = typeof response.total === "number" ? response.total : 0;
    currentPage.value = typeof response.page === "number" ? response.page : 1;
    totalPages.value =
      typeof response.totalPages === "number"
        ? Math.max(response.totalPages, 1)
        : 1;
    galleryCache.value = response.cache ?? null;
    cacheScannedAt.value =
      response.cache && typeof response.cache.scannedAt === "number"
        ? response.cache.scannedAt
        : null;
    hasLoadedOnce.value = true;

    await syncRouteQuery(currentPage.value);

    if (options.forceRefresh && response.cache?.refreshRequested && !response.cache.refreshApplied) {
      showMessage(refreshStateText.value, "warning");
    }

    return response;
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("[EmojiGallery] Failed to load gallery:", error);
      showMessage("加载表情包列表失败，请稍后重试", "error");
    }
    return null;
  } finally {
    if (currentLoadController === requestController) {
      currentLoadController = null;
      isLoading.value = false;
    }
  }
}

function applySearch(): void {
  const nextKeyword = searchInput.value.trim();
  if (nextKeyword === activeKeyword.value) {
    return;
  }
  activeKeyword.value = nextKeyword;
  void loadGallery(1);
}

function clearSearch(): void {
  searchInput.value = "";
  if (activeKeyword.value === "") {
    return;
  }
  activeKeyword.value = "";
  void loadGallery(1);
}

watch(searchInput, (nextValue) => {
  if (nextValue.trim() === "" && activeKeyword.value !== "") {
    activeKeyword.value = "";
    void loadGallery(1);
  }
});

watch(
  () => route.query,
  (query) => {
    if (isSyncingRoute.value) {
      return;
    }

    const nextRouteState = readEmojiGalleryRouteState(query, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      pageSizeOptions: PAGE_SIZE_OPTIONS,
    });
    const hasMeaningfulChange =
      nextRouteState.keyword !== activeKeyword.value ||
      nextRouteState.category !== selectedCategory.value ||
      nextRouteState.page !== currentPage.value ||
      nextRouteState.pageSize !== pageSize.value;

    if (!hasMeaningfulChange) {
      return;
    }

    searchInput.value = nextRouteState.keyword;
    activeKeyword.value = nextRouteState.keyword;
    selectedCategory.value = nextRouteState.category;
    pageSize.value = nextRouteState.pageSize;
    void loadGallery(nextRouteState.page);
  }
);

function selectCategory(categoryName: string): void {
  if (selectedCategory.value === categoryName) {
    return;
  }

  selectedCategory.value = categoryName;
  void loadGallery(1);
}

function handlePageSizeChange(): void {
  void loadGallery(1);
}

async function refreshCurrentPage(): Promise<void> {
  const response = await loadGallery(currentPage.value, { forceRefresh: true });
  if (response?.cache?.refreshRequested && response.cache.refreshApplied) {
    showMessage("已重新扫描 image 目录并刷新当前结果", "success");
  }
}

async function createCategory(): Promise<void> {
  const nextName = await askInput({
    title: "新建目录",
    message: "请输入 image 目录下的新分类目录名称。",
    placeholder: "例如：旅行表情包",
    initialValue: preferredUploadCategory.value,
    required: true,
    validate: (value) => {
      const normalized = sanitizeCategoryName(value);
      if (!normalized) {
        return "目录名不合法，请使用长度不超过 80 的普通目录名。";
      }
      return null;
    },
  });

  if (nextName === null) {
    return;
  }

  const sanitizedName = sanitizeCategoryName(nextName);
  if (!sanitizedName) {
    showMessage("目录名不合法，请检查后重试", "warning");
    return;
  }

  try {
    const result = await emojisApi.createCategory({ name: sanitizedName });
    preferredUploadCategory.value = result.name;
    selectedCategory.value = result.name;

    await loadGallery(1, { forceRefresh: true });

    showMessage(
      result.existed
        ? `目录已存在，已切换到：${result.name}`
        : `目录创建成功：${result.name}`,
      result.existed ? "warning" : "success"
    );
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("[EmojiGallery] Failed to create category:", error);
      showMessage("新建目录失败，请稍后重试", "error");
    }
  }
}

function goToPreviousPage(): Promise<EmojiGalleryData | null> {
  if (currentPage.value <= 1) {
    return Promise.resolve(null);
  }

  return loadGallery(currentPage.value - 1);
}

function goToNextPage(): Promise<EmojiGalleryData | null> {
  if (currentPage.value >= totalPages.value) {
    return Promise.resolve(null);
  }

  return loadGallery(currentPage.value + 1);
}

function openPreview(item: EmojiGalleryItem): void {
  previewItem.value = item;
  previewOpen.value = true;
}

function closePreview(): void {
  previewOpen.value = false;
}

function showPreviewAt(index: number): void {
  if (index < 0 || index >= items.value.length) {
    return;
  }
  previewItem.value = items.value[index];
}

function showPrevPreview(): void {
  if (previewIndex.value > 0) {
    showPreviewAt(previewIndex.value - 1);
    return;
  }

  if (currentPage.value <= 1) return;
  goToPreviousPage().then(() => {
    if (items.value.length > 0) {
      previewItem.value = items.value[items.value.length - 1];
    }
  });
}

function showNextPreview(): void {
  if (previewIndex.value < items.value.length - 1) {
    showPreviewAt(previewIndex.value + 1);
    return;
  }

  if (currentPage.value >= totalPages.value) return;
  goToNextPage().then(() => {
    if (items.value.length > 0) {
      previewItem.value = items.value[0];
    }
  });
}

function handlePreviewKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    showPrevPreview();
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    showNextPreview();
  }
}

async function deleteEmojiItem(item: EmojiGalleryItem): Promise<void> {
  if (deletingPaths.value.has(item.relativePath)) {
    return;
  }

  const confirmed = await askConfirm({
    title: "删除表情包",
    message: `确认删除 ${item.relativePath} 吗？删除后不可恢复。`,
    confirmText: "删除",
    cancelText: "取消",
    danger: true,
  });
  if (!confirmed) {
    return;
  }

  const nextDeletingPaths = new Set(deletingPaths.value);
  nextDeletingPaths.add(item.relativePath);
  deletingPaths.value = nextDeletingPaths;

  try {
    await emojisApi.deleteFile({
      path: item.relativePath,
      syncList: uploadSyncList.value,
    });

    if (previewItem.value?.relativePath === item.relativePath) {
      closePreview();
    }

    showMessage(`已删除：${item.name}`, "success");
    await loadGallery(currentPage.value, { forceRefresh: true });
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("[EmojiGallery] Failed to delete emoji:", error);
      showMessage("删除失败，请稍后重试", "error");
    }
  } finally {
    const cleanupPaths = new Set(deletingPaths.value);
    cleanupPaths.delete(item.relativePath);
    deletingPaths.value = cleanupPaths;
  }
}

async function deleteSelectedCategory(): Promise<void> {
  if (isDeletingCategory.value) {
    return;
  }

  const categoryName = selectedCategory.value;
  if (!categoryName || categoryName === ROOT_CATEGORY_NAME) {
    showMessage("请先选择一个具体目录再进行删除操作", "warning");
    return;
  }

  const firstConfirmed = await askConfirm({
    title: "删除目录",
    message: `将删除目录 ${categoryName} 及其中所有文件，此操作不可恢复。`,
    confirmText: "继续",
    cancelText: "取消",
    danger: true,
  });
  if (!firstConfirmed) {
    return;
  }

  const confirmInput = await askInput({
    title: "二次确认",
    message: `请输入完整目录名 "${categoryName}" 以确认删除。`,
    placeholder: categoryName,
    required: true,
    validate: (value) => {
      if (value.trim() !== categoryName) {
        return "输入的目录名不匹配";
      }
      return null;
    },
  });

  if (confirmInput === null) {
    return;
  }

  isDeletingCategory.value = true;
  try {
    await emojisApi.deleteCategory({
      name: categoryName,
      confirm: confirmInput.trim(),
      syncList: uploadSyncList.value,
    });

    showMessage(`目录已删除：${categoryName}`, "success");

    if (preferredUploadCategory.value === categoryName) {
      preferredUploadCategory.value = DEFAULT_UPLOAD_CATEGORY;
    }
    selectedCategory.value = "";

    await loadGallery(1, { forceRefresh: true });
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("[EmojiGallery] Failed to delete category:", error);
      showMessage("目录删除失败，请稍后重试", "error");
    }
  } finally {
    isDeletingCategory.value = false;
  }
}

function fallbackCopyText(value: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

async function copyRelativePath(relativePath: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(relativePath);
      showMessage("已复制表情包路径", "success");
      return;
    }

    if (fallbackCopyText(relativePath)) {
      showMessage("已复制表情包路径", "success");
      return;
    }

    showMessage("复制失败，请手动复制", "error");
  } catch {
    showMessage("复制失败，请检查浏览器权限", "error");
  }
}

function triggerFileSelect(): void {
  fileInputRef.value?.click();
}

function triggerFolderSelect(): void {
  folderInputRef.value?.click();
}

function triggerArchiveSelect(): void {
  archiveInputRef.value?.click();
}

function clearSelectedFiles(): void {
  selectedFiles.value = [];
  selectedRelativePaths.value = [];
  uploadMode.value = "files";
}

function removeSelectedFile(index: number): void {
  selectedFiles.value = selectedFiles.value.filter((_, itemIndex) => itemIndex !== index);
  selectedRelativePaths.value = selectedRelativePaths.value.filter(
    (_, itemIndex) => itemIndex !== index
  );

  if (selectedFiles.value.length === 0) {
    uploadMode.value = "files";
  }
}

function applyUploadSelection(
  files: File[],
  mode: UploadMode,
  relativePaths: string[]
): void {
  const selection = prepareUploadSelection(files, mode, relativePaths);

  if (selection.rejected.length > 0) {
    lastRejectedItems.value = selection.rejected.map((item) => ({
      fileName: item.fileName,
      reason: item.reason,
    }));
    showRejectedList.value = true;

    const rejectionMessage =
      selection.rejected.length === 1
        ? selection.rejected[0].reason
        : `已过滤 ${selection.rejected.length} 个不符合要求的文件，请展开查看原因`;
    showMessage(rejectionMessage, "warning");
  } else {
    lastRejectedItems.value = [];
    showRejectedList.value = false;
  }

  if (selection.resetSelection) {
    clearSelectedFiles();
    return;
  }

  selectedFiles.value = selection.acceptedFiles;
  selectedRelativePaths.value = selection.acceptedRelativePaths;
  uploadMode.value = selection.mode;
}

function handleFileSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const nextFiles = Array.from(input.files || []);
  input.value = "";

  const relativePaths = nextFiles.map((file) => file.name);
  applyUploadSelection(nextFiles, "files", relativePaths);
}

function handleFolderSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const nextFiles = Array.from(input.files || []);
  input.value = "";

  const relativePaths = nextFiles.map((file) => {
    const withRelativePath = file as File & { webkitRelativePath?: string };
    return withRelativePath.webkitRelativePath || file.name;
  });

  applyUploadSelection(nextFiles, "folder", relativePaths);
}

function handleArchiveSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const nextFiles = Array.from(input.files || []);
  input.value = "";

  if (nextFiles.length > 1) {
    showMessage("压缩包模式仅支持单文件上传", "warning");
  }

  applyUploadSelection(nextFiles.slice(0, 1), "archive", nextFiles.map((file) => file.name));
}

interface UploadContext {
  uploadMode: UploadMode;
  category: string | undefined;
}

function extractRejectedItemsFromUploadError(error: unknown): EmojiUploadRejectedItem[] {
  if (!isHttpError(error) || !error.details || typeof error.details !== "object") {
    return [];
  }

  const details = error.details as {
    data?: {
      rejected?: Array<Partial<EmojiUploadRejectedItem>>;
    };
  };

  if (!Array.isArray(details.data?.rejected)) {
    return [];
  }

  return details.data.rejected
    .filter(
      (item): item is EmojiUploadRejectedItem =>
        typeof item?.fileName === "string" && typeof item?.reason === "string"
    )
    .map((item) => ({
      fileName: item.fileName,
      reason: item.reason,
    }));
}

async function handleUploadResult(
  uploadResult: EmojiUploadResult,
  ctx: UploadContext
): Promise<void> {
  const summaryText = [
    `上传完成：成功 ${uploadResult.uploadedCount}`,
    `失败 ${uploadResult.rejectedCount}`,
  ];
  if (uploadResult.listSync?.enabled) {
    summaryText.push(`重建目录 ${uploadResult.listSync.generatedCount}`);
  }

  showMessage(
    summaryText.join("，"),
    uploadResult.rejectedCount > 0 ? "warning" : "success"
  );

  if (uploadResult.listSync?.warning) {
    showMessage(uploadResult.listSync.warning, "warning");
  }

  lastRejectedItems.value = Array.isArray(uploadResult.rejected)
    ? uploadResult.rejected
    : [];
  if (lastRejectedItems.value.length > 0) {
    showRejectedList.value = true;
  }

  clearSelectedFiles();

  const uploadedCategories = Array.isArray(uploadResult.categories)
    ? uploadResult.categories.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const resolvedCategory =
    uploadResult.category ||
    (ctx.uploadMode === "files" ? ctx.category : undefined) ||
    DEFAULT_UPLOAD_CATEGORY;

  if (ctx.uploadMode === "files") {
    preferredUploadCategory.value = resolvedCategory;
    if (
      ctx.category &&
      uploadResult.category &&
      uploadResult.category !== ctx.category
    ) {
      showMessage(`目标分类已自动修正为：${uploadResult.category}`, "warning");
    }
  }

  if (uploadResult.uploadedCount > 0) {
    if (ctx.uploadMode === "files" && resolvedCategory !== ROOT_CATEGORY_NAME) {
      selectedCategory.value = resolvedCategory;
    } else if (uploadedCategories.length === 1 && uploadedCategories[0] !== ROOT_CATEGORY_NAME) {
      selectedCategory.value = uploadedCategories[0];
    } else {
      selectedCategory.value = "";
      if (uploadedCategories.length > 1) {
        showMessage("本次导入包含多个目录，已切换到全部目录方便统一查看", "success");
      }
    }
  }

  await loadGallery(1, { forceRefresh: true });
}

async function uploadSelectedFiles(): Promise<void> {
  if (isUploading.value || selectedFiles.value.length === 0) {
    return;
  }

  isUploading.value = true;
  try {
    const currentUploadMode = uploadMode.value;
    const category =
      currentUploadMode === "files"
        ? effectiveUploadCategory.value.trim() || DEFAULT_UPLOAD_CATEGORY
        : undefined;

    const uploadResult = await emojisApi.uploadLocal(
      {
        files: selectedFiles.value,
        category,
        syncList: uploadSyncList.value,
        relPaths:
          currentUploadMode === "folder"
            ? selectedRelativePaths.value
            : undefined,
        uploadMode: currentUploadMode,
      },
      {
        showLoader: true,
        suppressErrorMessage: true,
      }
    );

    await handleUploadResult(uploadResult, {
      uploadMode: currentUploadMode,
      category,
    });
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("[EmojiGallery] Upload failed:", error);
      const rejectedItems = extractRejectedItemsFromUploadError(error);
      if (rejectedItems.length > 0) {
        lastRejectedItems.value = rejectedItems;
        showRejectedList.value = true;
        showMessage(
          `上传失败：${rejectedItems.length} 个文件被拒绝，请展开查看具体原因`,
          "warning"
        );
      } else if (error instanceof Error && error.message) {
        showMessage(error.message, "error");
      } else {
        showMessage("上传失败，请检查文件后重试", "error");
      }
    }
  } finally {
    isUploading.value = false;
  }
}

async function rebuildGeneratedEmojiLists(): Promise<void> {
  if (isRebuildingList.value) {
    return;
  }

  isRebuildingList.value = true;
  try {
    const rebuildResult = await emojisApi.rebuildListFiles();
    showMessage(`已重建 ${rebuildResult.generatedCount} 个表情包目录列表`, "success");
    await loadGallery(currentPage.value, { forceRefresh: true });
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("[EmojiGallery] Failed to rebuild emoji lists:", error);
      showMessage("重建列表失败，请稍后重试", "error");
    }
  } finally {
    isRebuildingList.value = false;
  }
}

onMounted(() => {
  void loadGallery(initialRouteState.page);
});

onUnmounted(() => {
  if (currentLoadController) {
    currentLoadController.abort();
    currentLoadController = null;
  }
});
</script>

<style scoped>
.emoji-gallery-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.hero-card {
  display: grid;
  gap: var(--space-md);
  padding: clamp(20px, 3vw, 28px);
  border-radius: calc(var(--radius-xl) + 4px);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 18%, var(--border-color));
  background:
    radial-gradient(circle at top right, color-mix(in srgb, var(--highlight-text) 16%, transparent), transparent 34%),
    linear-gradient(
      140deg,
      color-mix(in srgb, var(--secondary-bg) 92%, transparent),
      color-mix(in srgb, var(--surface-overlay-strong) 88%, transparent)
    );
  box-shadow: var(--shadow-overlay-soft);
}

.hero-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.hero-kicker {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.hero-title-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-md);
  align-items: flex-start;
}

.hero-title-row h1 {
  margin: 0;
  font-size: calc(var(--font-size-title) * 1.55);
  line-height: 1.08;
}

.hero-badges {
  display: grid;
  grid-template-columns: repeat(3, minmax(88px, 1fr));
  gap: var(--space-sm);
  min-width: min(100%, 320px);
}

.hero-badge {
  display: grid;
  gap: 2px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 16%, var(--border-color));
  background: color-mix(in srgb, var(--surface-overlay-soft) 76%, transparent);
}

.hero-badge strong {
  font-size: 1.05rem;
  line-height: 1;
}

.hero-badge span {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.hero-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-sm);
  align-items: center;
}

.hero-search-group,
.hero-toolbar-actions,
.hero-status-row,
.hero-filter-summary {
  display: flex;
  gap: var(--space-sm);
  align-items: center;
  flex-wrap: wrap;
}

.hero-search-group {
  min-width: 0;
}

.hero-search-field {
  min-width: min(100%, 380px);
}

.hero-toolbar-actions {
  justify-content: flex-end;
}

.hero-status-row {
  justify-content: space-between;
  align-items: flex-start;
}

.hero-status-tip {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.6;
}

.filter-pill {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 82%, transparent);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.filter-pill.active {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--highlight-text) 32%, transparent);
  background: color-mix(in srgb, var(--highlight-text) 18%, transparent);
}

.description {
  margin: 0;
  color: var(--secondary-text);
  white-space: normal;
  line-height: 1.65;
  max-width: 72ch;
}

.upload-console {
  display: grid;
  gap: var(--space-sm);
  padding: var(--space-md);
  border-radius: var(--radius-xl);
}

.upload-console__header {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.upload-console__header h3 {
  margin: 0;
  font-size: var(--font-size-title);
}

.upload-console__label,
.operations-console__label {
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.gallery-workspace {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  gap: var(--space-md);
  align-items: start;
}

.gallery-workspace.is-console-collapsed {
  grid-template-columns: 56px minmax(0, 1fr);
}

.operations-column {
  position: sticky;
  top: calc(var(--app-top-bar-height, 60px) + 20px);
}

.operations-console {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-md);
  border-radius: var(--radius-xl);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 14%, var(--border-color));
  transition: padding 0.2s ease;
}

.operations-console.is-collapsed {
  padding: var(--space-3) 0;
  gap: 0;
  align-items: center;
}

.operations-console__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}

.operations-console__header > div {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs, 4px);
}

.operations-console__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.operations-console__section + .operations-console__section {
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-color);
}

.operations-console__section h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
}

.page-size-control {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  color: var(--secondary-text);
}

.panel-hint {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.6;
}

.quick-actions,
.upload-entry-actions,
.upload-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
}

.rail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.rail-meta span {
  padding: 4px 9px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 75%, transparent);
}

.search-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.search-row > button {
  white-space: nowrap;
}

.search-field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 var(--space-sm);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--input-bg);
}

.search-field .material-symbols-outlined {
  color: var(--secondary-text);
  font-size: 1.2rem;
}

.search-field input {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--primary-text);
  padding: 10px 0;
}

.search-field input:focus:not(:focus-visible) {
  outline: none;
}

.page-size-control select {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--input-bg);
  color: var(--primary-text);
  padding: 8px 10px;
}

.directory-list {
  display: grid;
  gap: 8px;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 4px;
}

.directory-pill {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--border-color) 92%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 78%, transparent);
  color: var(--primary-text);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.directory-pill:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 40%, transparent);
}

.directory-pill.active {
  border-color: color-mix(in srgb, var(--highlight-text) 72%, transparent);
  background: color-mix(in srgb, var(--highlight-text) 20%, transparent);
}

.pill-count {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
}

.upload-target-tip {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.upload-sync-option {
  display: inline-flex;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.upload-sync-option :deep(.app-checkbox__label) {
  color: var(--secondary-text);
}

.upload-file-input {
  display: none;
}

.upload-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.upload-summary span {
  padding: 4px 10px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 85%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 75%, transparent);
}

.upload-file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.upload-file-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-sm);
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 70%, transparent);
}

.upload-file-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.upload-file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-helper);
}

.upload-file-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
}

.upload-file-meta {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.upload-file-remove {
  border: 1px solid color-mix(in srgb, var(--border-color) 85%, transparent);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--secondary-text);
  cursor: pointer;
  padding: 2px 8px;
}

.upload-file-remove:hover {
  color: var(--danger-color);
}

.content-column {
  display: grid;
  gap: var(--space-md);
  min-width: 0;
}

.overview-card {
  display: grid;
  gap: var(--space-sm);
  padding: var(--space-md);
}

.content-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-sm);
}

.content-header h3 {
  margin: 0;
  font-size: var(--font-size-title);
}

.content-header p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.stats-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.stats-strip span {
  padding: 5px 10px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 85%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 75%, transparent);
}

.emoji-empty-state {
  display: grid;
  gap: var(--space-xs);
  padding: clamp(28px, 5vw, 42px);
}

.emoji-grid-shell {
  position: relative;
}

.grid-refresh-banner {
  position: sticky;
  top: 0;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  margin-bottom: var(--space-sm);
  padding: 8px 12px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 26%, transparent);
  background: color-mix(in srgb, var(--highlight-text) 14%, var(--surface-overlay-soft));
  color: var(--primary-text);
  box-shadow: var(--shadow-overlay-soft);
}

.grid-refresh-banner .material-symbols-outlined {
  font-size: 1rem;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-md);
}

.emoji-grid--skeleton {
  pointer-events: none;
}

.emoji-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--secondary-bg) 88%, transparent),
      color-mix(in srgb, var(--surface-overlay-strong) 82%, transparent)
    );
  overflow: hidden;
  box-shadow: var(--shadow-overlay-soft);
  content-visibility: auto;
  contain-intrinsic-size: 320px;
  animation: emoji-card-enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--stagger-delay, 0ms);
}

.emoji-card--skeleton {
  overflow: hidden;
}

.preview-shell {
  border: none;
  padding: 0;
  margin: 0;
  cursor: zoom-in;
  background: color-mix(in srgb, var(--tertiary-bg) 86%, transparent);
  aspect-ratio: 1 / 1;
}

.preview-shell--skeleton {
  position: relative;
  overflow: hidden;
}

.preview-shell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-shell--skeleton::after,
.skeleton-line::after,
.skeleton-chip::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, white 18%, transparent),
    transparent
  );
  animation: emoji-skeleton-shimmer 1.4s ease-in-out infinite;
}

.skeleton-line,
.skeleton-chip {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--surface-overlay-soft) 88%, transparent);
}

.skeleton-line--title {
  height: 16px;
  width: 72%;
}

.skeleton-line--meta {
  height: 12px;
  width: 40%;
}

.skeleton-line--path {
  height: 12px;
  width: 88%;
}

.skeleton-chip {
  display: inline-flex;
  min-height: 30px;
}

.emoji-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 var(--space-sm);
}

.emoji-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-sm);
}

.emoji-title-row h3 {
  margin: 0;
  font-size: var(--font-size-body);
  line-height: 1.45;
  word-break: break-word;
}

.format-badge {
  flex-shrink: 0;
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
}

.emoji-category {
  margin: 0;
  color: var(--highlight-text);
  font-size: var(--font-size-helper);
}

.emoji-path {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  word-break: break-all;
}

.emoji-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-sm);
  padding: 0 var(--space-sm) var(--space-sm);
}

.emoji-actions a {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.pagination-controls {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: var(--space-md);
  flex-wrap: wrap;
}

.pagination-summary {
  color: var(--secondary-text);
}

.preview-modal {
  width: min(96vw, 1080px);
}

.preview-panel {
  position: relative;
  width: 100%;
  max-height: min(86vh, 920px);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-md);
  border-radius: var(--radius-xl);
  border: 1px solid var(--overlay-frost-border);
  background: color-mix(in srgb, var(--secondary-bg) 88%, transparent);
  box-shadow: var(--overlay-panel-shadow);
}

.modal-close {
  position: absolute;
  top: var(--space-sm);
  right: var(--space-sm);
  width: 34px;
  height: 34px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 85%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 80%, transparent);
  color: var(--primary-text);
  font-size: 1.2rem;
  cursor: pointer;
}

.preview-image {
  width: 100%;
  max-height: min(72vh, 760px);
  object-fit: contain;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--tertiary-bg) 82%, transparent);
}

.preview-footer h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
}

.preview-footer p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  word-break: break-all;
}

@keyframes emoji-card-enter {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.985);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes emoji-skeleton-shimmer {
  to {
    transform: translateX(100%);
  }
}

.btn-danger {
  border: 1px solid color-mix(in srgb, var(--danger-color, #ef4444) 60%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger-color, #ef4444) 12%, transparent);
  color: var(--danger-color, #ef4444);
  cursor: pointer;
  padding: 6px 10px;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger-color, #ef4444) 24%, transparent);
  border-color: color-mix(in srgb, var(--danger-color, #ef4444) 80%, transparent);
}

.btn-danger:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.btn-sm {
  font-size: var(--font-size-helper);
}

.delete-category-btn {
  margin-top: var(--space-sm);
  width: 100%;
}

.upload-rejected {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  margin-top: var(--space-sm);
}

.upload-rejected__toggle {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--danger-color, #ef4444) 40%, transparent);
  background: color-mix(in srgb, var(--danger-color, #ef4444) 10%, transparent);
  color: var(--danger-color, #ef4444);
  cursor: pointer;
  font-size: var(--font-size-helper);
}

.upload-rejected__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  border: 1px dashed color-mix(in srgb, var(--danger-color, #ef4444) 40%, transparent);
}

.upload-rejected__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-sm);
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
}

.upload-rejected__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-rejected__reason {
  color: var(--danger-color, #ef4444);
}

.preview-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.6rem;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 90%, transparent);
  color: var(--primary-text);
  cursor: pointer;
  z-index: 2;
}

.preview-nav:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.preview-nav--prev {
  left: calc(var(--space-sm) * -1);
}

.preview-nav--next {
  right: calc(var(--space-sm) * -1);
}

.preview-counter {
  display: inline-block;
  margin-top: 4px;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

@media (max-width: 1200px) {
  .hero-title-row,
  .hero-toolbar,
  .hero-status-row {
    grid-template-columns: 1fr;
    display: grid;
  }

  .hero-badges,
  .hero-toolbar-actions {
    min-width: 0;
    justify-content: flex-start;
  }

  .gallery-workspace {
    grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  }
}

@media (max-width: 1024px) {
  .gallery-workspace,
  .gallery-workspace.is-console-collapsed {
    grid-template-columns: 1fr;
  }

  .operations-column {
    position: static;
  }
}

@media (max-width: 768px) {
  .hero-card {
    padding: var(--space-md);
  }

  .hero-badges {
    grid-template-columns: 1fr;
  }

  .hero-search-group,
  .hero-toolbar-actions,
  .hero-filter-summary,
  .quick-actions,
  .upload-entry-actions,
  .upload-actions {
    display: grid;
    grid-template-columns: 1fr;
  }

  .hero-search-field {
    min-width: 0;
  }

  .upload-file-item {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "copy copy"
      "meta remove";
  }

  .upload-file-copy {
    grid-area: copy;
  }

  .upload-file-meta {
    grid-area: meta;
  }

  .upload-file-remove {
    grid-area: remove;
  }

  .emoji-grid {
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  }

  .emoji-actions {
    grid-template-columns: 1fr;
  }

  .preview-nav--prev {
    left: var(--space-xs);
  }

  .preview-nav--next {
    right: var(--space-xs);
  }

  .preview-panel {
    padding: var(--space-sm);
  }
}

@media (prefers-reduced-motion: reduce) {
  .emoji-card {
    animation: none;
  }

  .preview-shell--skeleton::after,
  .skeleton-line::after,
  .skeleton-chip::after {
    animation: none;
  }
}
</style>
