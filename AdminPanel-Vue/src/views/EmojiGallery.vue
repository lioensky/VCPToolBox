<template>
  <section class="config-section active-section emoji-gallery-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton
          variant="outline"
          :disabled="isLoading"
          @click="refreshCurrentPage"
        >
          {{ isLoading && hasLoadedOnce ? "刷新中…" : "刷新" }}
        </UiButton>

        <UiButton
          variant="outline"
          :disabled="isRebuildingList"
          @click="rebuildGeneratedEmojiLists"
        >
          {{ isRebuildingList ? "重建中…" : "重建列表" }}
        </UiButton>

        <UiButton
          :disabled="isLoading || isUploading"
          @click="createCategory"
        >
          新建目录
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="gallery-topbar">
      <div class="gallery-heading-panel">
        <div class="gallery-heading-copy">
          <span class="gallery-kicker">Image Workspace</span>
          <div>
            <h2>表情包画廊</h2>
            <p class="description">
              浏览并整理 `image` 目录中的表情包资源，支持检索、目录筛选、上传导入、分页浏览与大图预览。
            </p>
          </div>
        </div>

        <div class="gallery-toolbar">
          <label class="search-field gallery-search-field">
            <span class="material-symbols-outlined">search</span>
            <UiInput
              v-model.trim="searchInput"
              type="search"
              aria-label="搜索表情包"
              placeholder="搜索文件名、路径或目录…"
              :disabled="isLoading"
              @keydown.enter.prevent="applySearch"
            />
          </label>

          <UiButton
            variant="primary"
            :disabled="isLoading"
            @click="applySearch"
          >
            搜索
          </UiButton>

          <UiButton
            v-if="activeKeyword"
            variant="outline"
            :disabled="isLoading"
            @click="clearSearch"
          >
            清空
          </UiButton>

          <label class="page-size-control">
            <span>每页</span>
            <UiSelect
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
            </UiSelect>
          </label>
        </div>

        <div class="gallery-filter-summary">
          <span class="filter-pill" :class="{ active: selectedCategory === '' }">
            {{ selectedCategory ? `目录：${selectedCategory}` : "全部目录" }}
          </span>
          <span v-if="activeKeyword" class="filter-pill active">
            关键词：{{ activeKeyword }}
          </span>
          <span class="filter-pill">{{ paginationSummary }}</span>
        </div>
      </div>

      <aside class="gallery-summary-card" aria-live="polite">
        <div class="gallery-summary-grid">
          <span class="gallery-summary-item">
            <strong>{{ matchedEmojiCount }}</strong>
            <span>命中</span>
          </span>
          <span class="gallery-summary-item">
            <strong>{{ categories.length }}</strong>
            <span>目录</span>
          </span>
          <span class="gallery-summary-item">
            <strong>{{ items.length }}</strong>
            <span>当前页</span>
          </span>
        </div>
        <p>{{ refreshStateText }}</p>
      </aside>
    </header>

    <div class="gallery-workspace">
      <aside class="operations-column">
        <section class="operations-console" aria-label="表情包操作台">
          <div class="operations-console__section">
            <div class="quick-actions">
              <UiButton
                variant="outline"
                size="sm"
                :disabled="isLoading"
                @click="refreshCurrentPage"
              >
                刷新
              </UiButton>

              <UiButton
                variant="outline"
                size="sm"
                :disabled="isLoading || isUploading"
                @click="createCategory"
              >
                新建目录
              </UiButton>
              <UiButton
                variant="outline"
                size="sm"
                :disabled="isRebuildingList"
                @click="rebuildGeneratedEmojiLists"
              >
                重建列表
              </UiButton>
            </div>
          </div>

          <div class="operations-console__section">
            <UiSideConsoleNav
              label="操作台"
              :items="directoryNavItems"
              @item-click="handleDirectoryNavClick"
              @toggle="handleDirectoryNavClick"
            />

            <UiButton
              v-if="selectedCategory && selectedCategory !== ROOT_CATEGORY_NAME"
              variant="danger"
              size="sm"
              class="delete-category-btn"
              :disabled="isDeletingCategory || isLoading"
              @click="deleteSelectedCategory"
            >
              {{ isDeletingCategory ? "删除中…" : `删除目录 “${selectedCategory}”` }}
            </UiButton>
          </div>
        </section>
      </aside>

      <section class="content-column">
        <section class="upload-console">
          <div class="upload-console__header">
            <div class="upload-console__title">
              <span class="upload-console__label">本地上传</span>
              <h3>上传图片、文件夹或压缩包</h3>
            </div>
            <div class="upload-console__meta">
              <p class="panel-hint">
                支持图片文件、文件夹与压缩包上传。若目录名以“表情包”结尾，可同步生成 EmojiListGenerator 列表。
              </p>
              <p
                v-if="uploadMode === 'files'"
                class="upload-target-tip"
              >
                上传到：{{ effectiveUploadCategory }}
              </p>
              <p
                v-else-if="uploadMode === 'folder'"
                class="upload-target-tip"
              >
                保留文件夹原始目录结构
              </p>
              <p
                v-else-if="uploadMode === 'archive'"
                class="upload-target-tip"
              >
                解压后保留内部结构
              </p>
            </div>
          </div>

          <div class="upload-console__body">
            <AppCheckbox
              v-model="uploadSyncList"
              class="upload-sync-option"
              :disabled="isUploading"
            >
              上传后同步重建 generated_lists
            </AppCheckbox>

            <div class="upload-entry-actions">
              <UiButton
                variant="outline"
                :disabled="isUploading"
                @click="triggerFileSelect"
              >
                选择图片文件
              </UiButton>

              <UiButton
                variant="outline"
                :disabled="isUploading"
                @click="triggerFolderSelect"
              >
                选择文件夹
              </UiButton>

              <UiButton
                variant="outline"
                :disabled="isUploading"
                @click="triggerArchiveSelect"
              >
                选择压缩包
              </UiButton>
            </div>
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

          <div v-if="selectedFiles.length > 0" class="upload-queue">
            <div class="upload-summary">
              <span>模式：{{ selectedUploadModeLabel }}</span>
              <span>文件：{{ selectedFiles.length }}</span>
              <span>总大小：{{ formatFileSize(selectedUploadTotalSize) }}</span>
            </div>

            <ul class="upload-file-list">
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
                <UiButton
                  class="upload-file-remove"
                  variant="ghost"
                  size="sm"
                  :disabled="isUploading"
                  @click="removeSelectedFile(index)"
                >
                  移除
                </UiButton>
              </li>
            </ul>

            <div class="upload-actions">
              <UiButton
                variant="outline"
                :disabled="isUploading || selectedFiles.length === 0"
                @click="clearSelectedFiles"
              >
                清空待上传
              </UiButton>

              <UiButton
                variant="primary"
                :disabled="isUploading || selectedFiles.length === 0"
                @click="uploadSelectedFiles"
              >
                {{ isUploading ? "上传中…" : `开始上传（${selectedFiles.length}）` }}
              </UiButton>
            </div>
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

        <section class="overview-card" aria-live="polite">
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

        <section v-else-if="items.length === 0" class="empty-state emoji-empty-state">
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
              <UiBadge variant="outline" class="format-badge">{{ item.extension.toUpperCase() }}</UiBadge>
              </div>

              <p class="emoji-category">{{ item.category }}</p>
              <p class="emoji-path" :title="item.relativePath">{{ item.relativePath }}</p>
            </div>

            <div class="emoji-actions">
              <UiButton
                variant="outline"
                size="sm"
                @click="copyRelativePath(item.relativePath)"
              >
                复制路径
              </UiButton>

              <a
                class="emoji-link-button"
                :href="item.previewUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                新窗口
              </a>

              <UiButton
                variant="danger"
                size="sm"
                :disabled="deletingPaths.has(item.relativePath)"
                @click="deleteEmojiItem(item)"
              >
                {{ deletingPaths.has(item.relativePath) ? "删除中…" : "删除" }}
              </UiButton>
            </div>
          </article>
          </section>
        </section>

        <section class="pagination-controls">
          <UiButton
            variant="outline"
            :disabled="isLoading || currentPage <= 1"
            @click="goToPreviousPage"
          >
            上一页
          </UiButton>

          <span class="pagination-summary">{{ paginationSummary }}</span>

          <UiButton
            variant="outline"
            :disabled="isLoading || currentPage >= totalPages"
            @click="goToNextPage"
          >
            下一页
          </UiButton>
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
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiSideConsoleNav, {
  type UiSideConsoleNavItem,
} from "@/components/ui/UiSideConsoleNav.vue";
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

let currentLoadController: AbortController | null = null;

const totalEmojiCount = computed(() =>
  categories.value.reduce((sum, category) => sum + category.totalCount, 0)
);

const matchedEmojiCount = computed(() =>
  categories.value.reduce((sum, category) => sum + category.matchedCount, 0)
);

const directoryNavItems = computed<UiSideConsoleNavItem[]>(() => [
  {
    id: "",
    label: "全部目录",
    title: "全部目录",
    meta: String(totalEmojiCount.value),
    active: selectedCategory.value === "",
  },
  ...categories.value.map((category) => ({
    id: category.name,
    label: category.name,
    title: category.name,
    meta: `${category.matchedCount}/${category.totalCount}`,
    active: selectedCategory.value === category.name,
  })),
]);

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

function handleDirectoryNavClick(item: UiSideConsoleNavItem): void {
  selectCategory(item.id);
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
  gap: var(--space-4);
}

.gallery-topbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
  gap: var(--space-4);
  align-items: stretch;
}

.gallery-heading-panel,
.gallery-summary-card {
  border: 1px solid color-mix(in srgb, var(--border-color) 96%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 1.5%, transparent);
}

.gallery-heading-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.gallery-heading-copy {
  display: grid;
  gap: var(--space-1);
}

.gallery-kicker {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.gallery-heading-copy h2 {
  margin: 0;
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.gallery-toolbar,
.gallery-filter-summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.gallery-search-field {
  flex: 1 1 280px;
  max-width: 520px;
}

.gallery-summary-card {
  display: grid;
  align-content: space-between;
  gap: var(--space-3);
  padding: 14px 16px;
}

.gallery-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}

.gallery-summary-item {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.gallery-summary-item strong {
  color: var(--primary-text);
  font-size: var(--font-size-emphasis);
  line-height: 1.1;
}

.gallery-summary-item span,
.gallery-summary-card p {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.gallery-summary-card p {
  margin: 0;
  line-height: 1.45;
}

.filter-pill {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 88%, transparent);
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.filter-pill.active {
  color: var(--highlight-text);
  border-color: color-mix(in srgb, var(--highlight-text) 56%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 8%, transparent);
}

.description {
  margin: 0;
  color: var(--secondary-text);
  white-space: normal;
  font-size: var(--font-size-helper);
  line-height: 1.55;
  max-width: 72ch;
}

.upload-console {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 90%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 1.6%, transparent);
}

.upload-console__header {
  display: grid;
  grid-template-columns: minmax(170px, 0.34fr) minmax(0, 1fr);
  gap: var(--space-3);
  align-items: start;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
}

.upload-console__title,
.upload-console__meta {
  display: grid;
  gap: var(--space-xs);
}

.upload-console__header h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
  line-height: 1.4;
}

.upload-console__body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.upload-console__label,
.operations-console__label {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.gallery-workspace {
  display: grid;
  grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.operations-column {
  position: sticky;
  top: 0;
  align-self: start;
  max-height: calc(var(--app-viewport-height, 100vh) - var(--app-top-bar-height, 60px) - 22px);
  min-height: 0;
  overflow: hidden;
}

.operations-console {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  height: 100%;
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
  gap: var(--space-2);
}

.operations-console__section + .operations-console__section {
  min-height: 0;
  flex: 1;
  overflow: hidden;
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
  line-height: 1.55;
}

.quick-actions,
.upload-entry-actions,
.upload-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
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
}

.search-field .material-symbols-outlined {
  color: var(--secondary-text);
  font-size: 1.2rem;
}

.search-field :deep(.ui-input) {
  min-width: 0;
}

.upload-target-tip {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 500;
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

.upload-queue {
  display: grid;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 68%, transparent);
}

.upload-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.upload-summary span {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 85%, transparent);
  background: transparent;
}

.upload-file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
  max-height: 220px;
  overflow-y: auto;
}

.upload-file-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-sm);
  min-height: 34px;
  padding: 6px var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  background: transparent;
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
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 90%, transparent);
  border-radius: var(--radius-lg);
  background: transparent;
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
  min-height: 28px;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  background: transparent;
}

.emoji-empty-state {
  display: grid;
  gap: var(--space-xs);
  padding: clamp(28px, 5vw, 42px);
  border: 1px dashed color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 2%, transparent);
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
  min-height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--highlight-text) 26%, transparent);
  background: color-mix(in srgb, var(--highlight-text) 14%, var(--surface-overlay-soft));
  color: var(--primary-text);
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
  border: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
  background: color-mix(in srgb, var(--primary-text) 1.2%, transparent);
  overflow: hidden;
  content-visibility: auto;
  contain-intrinsic-size: 320px;
  animation: emoji-card-enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--stagger-delay, 0ms);
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.emoji-card:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 24%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 4%, transparent);
}

.emoji-card--skeleton {
  overflow: hidden;
}

.preview-shell {
  border: none;
  padding: 0;
  margin: 0;
  cursor: zoom-in;
  background: color-mix(in srgb, var(--primary-text) 2.5%, transparent);
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
  background: color-mix(in srgb, var(--primary-text) 5%, transparent);
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
  gap: 4px;
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
}

.emoji-category {
  margin: 0;
  color: var(--secondary-text);
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
  gap: var(--space-xs);
  padding: 0 var(--space-sm) var(--space-sm);
}

.emoji-link-button {
  height: 28px;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
  line-height: 1;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.emoji-link-button:hover {
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
  color: var(--primary-text);
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
  border: 1px solid color-mix(in srgb, var(--danger-color) 40%, transparent);
  background: color-mix(in srgb, var(--danger-color) 10%, transparent);
  color: var(--danger-color);
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
  border: 1px dashed color-mix(in srgb, var(--danger-color) 40%, transparent);
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
  color: var(--danger-color);
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
  .gallery-topbar {
    grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
  }

  .gallery-workspace {
    grid-template-columns: minmax(210px, 240px) minmax(0, 1fr);
  }
}

@media (max-width: 1024px) {
  .gallery-topbar,
  .gallery-workspace {
    grid-template-columns: 1fr;
  }

  .operations-column {
    position: static;
    max-height: none;
    overflow: visible;
  }
}

@media (max-width: 768px) {
  .gallery-heading-panel,
  .gallery-summary-card {
    padding: var(--space-3);
  }

  .gallery-summary-grid {
    grid-template-columns: 1fr;
  }

  .gallery-toolbar,
  .gallery-filter-summary,
  .quick-actions,
  .upload-entry-actions,
  .upload-actions {
    display: grid;
    grid-template-columns: 1fr;
  }

  .gallery-search-field {
    min-width: 0;
    max-width: none;
  }

  .upload-console__header {
    grid-template-columns: 1fr;
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
