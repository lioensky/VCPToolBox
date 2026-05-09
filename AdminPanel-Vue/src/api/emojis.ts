import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = {
  showLoader: false,
  suppressErrorMessage: false,
};

export interface EmojiGalleryItem {
  name: string;
  relativePath: string;
  category: string;
  extension: string;
  previewUrl: string;
  thumbnailUrl: string;
}

export interface EmojiGalleryCategory {
  name: string;
  totalCount: number;
  matchedCount: number;
}

export interface EmojiGalleryData {
  items: EmojiGalleryItem[];
  categories: EmojiGalleryCategory[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters?: {
    category?: string | null;
    keyword?: string | null;
  };
  cache?: {
    scannedAt?: number | null;
    expiresAt?: number | null;
    ttlMs?: number;
    refreshRequested?: boolean;
    refreshApplied?: boolean;
    refreshCooldownMs?: number;
  };
}

export interface EmojiGalleryQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  category?: string;
  refresh?: boolean;
}

export interface EmojiUploadItem extends EmojiGalleryItem {
  size: number;
}

export interface EmojiUploadRejectedItem {
  fileName: string;
  reason: string;
}

export interface EmojiUploadResult {
  category: string;
  categories?: string[];
  uploadedCount: number;
  rejectedCount: number;
  uploaded: EmojiUploadItem[];
  rejected: EmojiUploadRejectedItem[];
  listSync?: {
    enabled: boolean;
    generatedCount: number;
    packs: Array<{
      name: string;
      count: number;
      filePath: string;
    }>;
    warning: string | null;
  };
}

export interface EmojiUploadPayload {
  files: File[];
  category?: string;
  syncList?: boolean;
  relPaths?: string[];
  uploadMode?: "files" | "folder" | "archive";
}

export interface EmojiRebuildListResult {
  generatedCount: number;
  packs: Array<{
    name: string;
    count: number;
    filePath: string;
  }>;
}

export interface EmojiCreateCategoryResult {
  name: string;
  existed: boolean;
}

export interface EmojiDeleteFileResult {
  relativePath: string;
  listSync?: {
    enabled: boolean;
    generatedCount: number;
    warning?: string | null;
  } | null;
}

export interface EmojiDeleteCategoryResult {
  name: string;
  listSync?: {
    enabled: boolean;
    generatedCount: number;
    warning?: string | null;
  } | null;
}

interface EmojiGalleryEnvelope {
  success?: boolean;
  data?: EmojiGalleryData;
}

interface EmojiUploadEnvelope {
  success?: boolean;
  data?: EmojiUploadResult;
}

interface EmojiRebuildListEnvelope {
  success?: boolean;
  data?: EmojiRebuildListResult;
}

interface EmojiCreateCategoryEnvelope {
  success?: boolean;
  data?: EmojiCreateCategoryResult;
}

interface EmojiDeleteFileEnvelope {
  success?: boolean;
  data?: EmojiDeleteFileResult;
}

interface EmojiDeleteCategoryEnvelope {
  success?: boolean;
  data?: EmojiDeleteCategoryResult;
}

type EmojiRequestContext = Pick<HttpRequestContext, "signal">;

function normalizeGalleryData(response: EmojiGalleryEnvelope | EmojiGalleryData): EmojiGalleryData {
  const data =
    response &&
    typeof response === "object" &&
    "data" in response &&
    (response as EmojiGalleryEnvelope).data
      ? ((response as EmojiGalleryEnvelope).data as EmojiGalleryData)
      : (response as EmojiGalleryData);

  if (!data || typeof data !== "object") {
    return createFallbackGalleryData();
  }

  return {
    ...data,
    items: Array.isArray(data.items)
      ? data.items.map((item) => ({
          ...item,
          previewUrl: item.previewUrl || emojisApi.buildPreviewUrl(item.relativePath),
          thumbnailUrl:
            item.thumbnailUrl || emojisApi.buildThumbnailUrl(item.relativePath),
        }))
      : [],
  };
}

function createFallbackGalleryData(): EmojiGalleryData {
  return {
    items: [],
    categories: [],
    total: 0,
    page: 1,
    pageSize: 1,
    totalPages: 1,
    filters: {
      category: null,
      keyword: null,
    },
  };
}

export const emojisApi = {
  async getGallery(
    query: EmojiGalleryQuery = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS,
    context: EmojiRequestContext = {}
  ): Promise<EmojiGalleryData> {
    const response = await requestWithUi<EmojiGalleryEnvelope | EmojiGalleryData>(
      {
        url: "/admin_api/emojis/gallery",
        query: {
          page: query.page,
          pageSize: query.pageSize,
          keyword: query.keyword,
          category: query.category,
          refresh: query.refresh,
        },
        signal: context.signal,
      },
      uiOptions
    );

    const data = normalizeGalleryData(response);
    return data || createFallbackGalleryData();
  },

  buildPreviewUrl(relativePath: string): string {
    return `/admin_api/emojis/file?path=${encodeURIComponent(relativePath)}`;
  },

  buildThumbnailUrl(relativePath: string, size = 320): string {
    return `/admin_api/emojis/file?path=${encodeURIComponent(relativePath)}&variant=thumb&size=${size}`;
  },

  async uploadLocal(
    payload: EmojiUploadPayload,
    uiOptions: RequestUiOptions = {
      showLoader: true,
      suppressErrorMessage: false,
    }
  ): Promise<EmojiUploadResult> {
    const formData = new FormData();
    payload.files.forEach((file) => {
      formData.append("files", file);
    });

    if (Array.isArray(payload.relPaths) && payload.relPaths.length > 0) {
      formData.append("relPaths", JSON.stringify(payload.relPaths));
    }

    if (payload.uploadMode) {
      formData.append("uploadMode", payload.uploadMode);
    }

    if (payload.category && payload.category.trim()) {
      formData.append("category", payload.category.trim());
    }

    formData.append("syncList", payload.syncList === false ? "false" : "true");

    const response = await requestWithUi<EmojiUploadEnvelope | EmojiUploadResult, FormData>(
      {
        url: "/admin_api/emojis/upload",
        method: "POST",
        body: formData,
      },
      uiOptions
    );

    if (response && typeof response === "object" && "data" in response && response.data) {
      return response.data;
    }

    return response as EmojiUploadResult;
  },

  async rebuildListFiles(
    uiOptions: RequestUiOptions = {
      showLoader: true,
      suppressErrorMessage: false,
    }
  ): Promise<EmojiRebuildListResult> {
    const response = await requestWithUi<EmojiRebuildListEnvelope | EmojiRebuildListResult>(
      {
        url: "/admin_api/emojis/list/rebuild",
        method: "POST",
      },
      uiOptions
    );

    if (response && typeof response === "object" && "data" in response && response.data) {
      return response.data;
    }

    return response as EmojiRebuildListResult;
  },

  async createCategory(
    payload: { name: string },
    uiOptions: RequestUiOptions = {
      showLoader: true,
      suppressErrorMessage: false,
    }
  ): Promise<EmojiCreateCategoryResult> {
    const response = await requestWithUi<
      EmojiCreateCategoryEnvelope | EmojiCreateCategoryResult,
      { name: string }
    >(
      {
        url: "/admin_api/emojis/category/create",
        method: "POST",
        body: {
          name: payload.name,
        },
      },
      uiOptions
    );

    if (response && typeof response === "object" && "data" in response && response.data) {
      return response.data;
    }

    return response as EmojiCreateCategoryResult;
  },

  async deleteFile(
    payload: { path: string; syncList?: boolean },
    uiOptions: RequestUiOptions = {
      showLoader: true,
      suppressErrorMessage: false,
    }
  ): Promise<EmojiDeleteFileResult> {
    const response = await requestWithUi<
      EmojiDeleteFileEnvelope | EmojiDeleteFileResult,
      { path: string; syncList: boolean }
    >(
      {
        url: "/admin_api/emojis/file/delete",
        method: "POST",
        body: {
          path: payload.path,
          syncList: payload.syncList === true,
        },
      },
      uiOptions
    );

    if (response && typeof response === "object" && "data" in response && response.data) {
      return response.data;
    }

    return response as EmojiDeleteFileResult;
  },

  async deleteCategory(
    payload: { name: string; confirm: string; syncList?: boolean },
    uiOptions: RequestUiOptions = {
      showLoader: true,
      suppressErrorMessage: false,
    }
  ): Promise<EmojiDeleteCategoryResult> {
    const response = await requestWithUi<
      EmojiDeleteCategoryEnvelope | EmojiDeleteCategoryResult,
      { name: string; confirm: string; syncList: boolean }
    >(
      {
        url: "/admin_api/emojis/category/delete",
        method: "POST",
        body: {
          name: payload.name,
          confirm: payload.confirm,
          syncList: payload.syncList !== false,
        },
      },
      uiOptions
    );

    if (response && typeof response === "object" && "data" in response && response.data) {
      return response.data;
    }

    return response as EmojiDeleteCategoryResult;
  },
};
