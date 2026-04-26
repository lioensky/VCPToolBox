<template>
  <section class="config-section active-section emoji-gallery-page">
    <header class="page-heading">
      <p class="description">
        浏览 image 目录中的表情包资源，支持关键词检索、分类筛选、分页浏览与大图预览。
      </p>
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
                <span class="operations-console__label">操作台</span>
                <h3>检索与分页</h3>
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
            <p class="panel-hint">支持关键词检索、分页浏览与索引刷新。</p>

            <div class="quick-actions">
              <button
                type="button"
                class="btn-secondary"
                :disabled="isRebuildingList"
                @click="rebuildGeneratedEmojiLists"
              >
                {{ isRebuildingList ? "重建中…" : "重建表情包列表" }}
              </button>

              <button
                type="button"
                class="btn-secondary"
                :disabled="isLoading"
                @click="refreshCurrentPage"
              >
                {{ isLoading ? "刷新中…" : "刷新" }}
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

            <div class="search-row">
              <label class="search-field">
                <span class="material-symbols-outlined">search</span>
                <input
                  v-model.trim="searchInput"
                  type="search"
                  aria-label="搜索表情包"
                  placeholder="搜索文件名或路径…"
                  :disabled="isLoading"
                  @keydown.enter.prevent="applySearch"
                />
              </label>

              <button
                type="button"
                class="btn-secondary"
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
          </div>

          <div class="operations-console__section">
            <span class="operations-console__label">目录筛选</span>
            <h3>按目录过滤</h3>
            <p class="panel-hint">选择左侧目录可筛选右侧内容。</p>

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
                上次上传有 {{ lastRejectedItems.length }} 个文件被拒绝
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

        <p v-if="isLoading" class="status-tip">正在加载表情包列表…</p>
        <p v-else-if="items.length === 0" class="status-tip">{{ emptyMessage }}</p>

        <section v-else class="emoji-grid" aria-label="表情包列表">
          <article
            v-for="(item, index) in items"
            :key="item.relativePath"
            class="emoji-card"
            :style="{ '--stagger-delay': `${Math.min(index, 24) * 22}ms` }"
          >
            <button
              type="button"
              class="preview-shell"
              :aria-label="`预览 ${item.name}`"
              @click="openPreview(item)"
            >
              <img
                v-lazy="item.previewUrl"
                :alt="item.name"
                decoding="async"
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
import BaseModal from "@/components/ui/BaseModal.vue";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import { useConsoleCollapse } from "@/composables/useConsoleCollapse";
import { useLocalStorage } from "@/composables/useLocalStorage";
import {
  emojisApi,
  type EmojiGalleryCategory,
  type EmojiGalleryItem,
  type EmojiUploadRejectedItem,
  type EmojiUploadResult,
} from "@/api";
import { isHttpError } from "@/platform/http/errors";
import { askConfirm, askInput } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";

const PAGE_SIZE_OPTIONS = [30, 60, 120, 180] as const;
const IMAGE_UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.bmp";
const ARCHIVE_UPLOAD_ACCEPT = ".zip,.tar,.tar.gz,.tgz";
const MAX_UPLOAD_FILES = 40;
const MAX_UPLOAD_FILE_SIZE = 8 * 1024 * 1024;
const MAX_ARCHIVE_FILE_SIZE = 200 * 1024 * 1024;
const DEFAULT_UPLOAD_CATEGORY = "本地上传表情包";
const ROOT_CATEGORY_NAME = "根目录";
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);
const ALLOWED_ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".tar.gz",
  ".tgz",
]);

type UploadMode = "files" | "folder" | "archive";

interface LoadGalleryOptions {
  forceRefresh?: boolean;
}

const isLoading = ref(false);
const searchInput = ref("");
const activeKeyword = ref("");
const selectedCategory = ref("");
const pageSize = ref<number>(60);
const currentPage = ref(1);
const totalPages = ref(1);
const total = ref(0);
const categories = shallowRef<EmojiGalleryCategory[]>([]);
const items = shallowRef<EmojiGalleryItem[]>([]);
const itemsPathIndex = shallowRef<Map<string, number>>(new Map());

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
  if (item.previewUrl) {
    return item;
  }

  return {
    ...item,
    previewUrl: emojisApi.buildPreviewUrl(item.relativePath),
  };
}

function getFileExtension(fileName: string): string {
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName.endsWith(".tar.gz")) {
    return ".tar.gz";
  }

  const lastDotIndex = lowerFileName.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return "";
  }

  return lowerFileName.slice(lastDotIndex);
}

function normalizeRelativePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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

function validateUploadFile(file: File, mode: UploadMode): string | null {
  const extension = getFileExtension(file.name);

  if (mode === "archive") {
    if (!ALLOWED_ARCHIVE_EXTENSIONS.has(extension)) {
      return `不支持的压缩包格式：${extension || "unknown"}`;
    }

    if (file.size > MAX_ARCHIVE_FILE_SIZE) {
      return `压缩包超过大小限制（${Math.floor(MAX_ARCHIVE_FILE_SIZE / 1024 / 1024)}MB）：${file.name}`;
    }

    return null;
  }

  if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    return `不支持的文件格式：${extension || "unknown"}`;
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    return `文件超过大小限制（${Math.floor(MAX_UPLOAD_FILE_SIZE / 1024 / 1024)}MB）：${file.name}`;
  }

  return null;
}

async function loadGallery(page = 1, options: LoadGalleryOptions = {}): Promise<void> {
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
    cacheScannedAt.value =
      response.cache && typeof response.cache.scannedAt === "number"
        ? response.cache.scannedAt
        : null;
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("[EmojiGallery] Failed to load gallery:", error);
      showMessage("加载表情包列表失败，请稍后重试", "error");
    }
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

function refreshCurrentPage(): void {
  void loadGallery(currentPage.value, { forceRefresh: true });
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

function goToPreviousPage(): Promise<void> {
  if (currentPage.value <= 1) {
    return Promise.resolve();
  }

  return loadGallery(currentPage.value - 1);
}

function goToNextPage(): Promise<void> {
  if (currentPage.value >= totalPages.value) {
    return Promise.resolve();
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
  if (files.length === 0) {
    return;
  }

  const acceptedFiles: File[] = [];
  const acceptedRelativePaths: string[] = [];

  if (mode === "archive") {
    const archiveFile = files[0];
    const validateError = validateUploadFile(archiveFile, "archive");
    if (validateError) {
      showMessage(validateError, "warning");
      clearSelectedFiles();
      return;
    }

    selectedFiles.value = [archiveFile];
    selectedRelativePaths.value = [archiveFile.name];
    uploadMode.value = "archive";
    return;
  }

  const maxAllowed = files.length;
  if (files.length > MAX_UPLOAD_FILES) {
    showMessage(
      `单次上传最多 ${MAX_UPLOAD_FILES} 个文件，当前选择了 ${files.length} 个，请删减后再试`,
      "warning"
    );
    clearSelectedFiles();
    return;
  }

  const dedupeSet = new Set<string>();
  for (let index = 0; index < maxAllowed; index += 1) {
    const file = files[index];
    const relativePath = normalizeRelativePath(relativePaths[index] || file.name);
    const validateError = validateUploadFile(file, mode);
    if (validateError) {
      showMessage(validateError, "warning");
      continue;
    }

    const signature = `${relativePath}|${file.size}|${file.lastModified}`;
    if (dedupeSet.has(signature)) {
      continue;
    }

    dedupeSet.add(signature);
    acceptedFiles.push(file);
    acceptedRelativePaths.push(relativePath || file.name);
  }

  selectedFiles.value = acceptedFiles;
  selectedRelativePaths.value = acceptedRelativePaths;
  uploadMode.value = mode;
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
  void loadGallery(1);
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

.page-heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.description {
  margin: 0;
  color: var(--secondary-text);
  white-space: nowrap;
  line-height: 1.65;
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
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
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

.status-tip {
  padding: var(--space-md);
  border-radius: var(--radius-lg);
  border: 1px dashed color-mix(in srgb, var(--border-color) 88%, transparent);
  background: color-mix(in srgb, var(--surface-overlay-soft) 82%, transparent);
  color: var(--secondary-text);
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-md);
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
  animation: emoji-card-enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--stagger-delay, 0ms);
}

.preview-shell {
  border: none;
  padding: 0;
  margin: 0;
  cursor: zoom-in;
  background: color-mix(in srgb, var(--tertiary-bg) 86%, transparent);
  aspect-ratio: 1 / 1;
}

.preview-shell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
  .gallery-workspace {
    grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  }

  .description {
    white-space: normal;
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
  .quick-actions,
  .upload-entry-actions,
  .upload-actions {
    display: grid;
    grid-template-columns: 1fr;
  }

  .search-row {
    display: grid;
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
}
</style>
