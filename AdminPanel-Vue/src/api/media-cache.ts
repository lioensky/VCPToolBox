import type { PaginatedResponse, PaginationParams } from "@/types/api.common";
import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = {
  showLoader: false,
  suppressErrorMessage: true,
};

const DEFAULT_WRITE_UI_OPTIONS: RequestUiOptions = {
  showLoader: false,
  suppressErrorMessage: true,
};

export interface MediaCacheItem {
  hash: string
  base64: string
  description?: string
  timestamp?: string
  mimeType?: string
}

export interface MediaCacheQuery extends PaginationParams {
  search?: string
}

export interface MediaCacheMutationResponse {
  message?: string
}

export interface MediaCacheReidentifyResponse {
  message?: string
  newDescription?: string
  newTimestamp?: string
}

export const mediaCacheApi = {
  async getCache(
    query: MediaCacheQuery = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<PaginatedResponse<MediaCacheItem>> {
    return requestWithUi(
      {
        url: "/admin_api/multimodal-cache",
        query: {
          page: query.page,
          pageSize: query.pageSize,
          search: query.search,
        },
      },
      uiOptions
    );
  },

  async updateEntry(
    hash: string,
    description: string,
    uiOptions: RequestUiOptions = DEFAULT_WRITE_UI_OPTIONS
  ): Promise<MediaCacheMutationResponse> {
    return requestWithUi(
      {
        url: "/admin_api/multimodal-cache/update",
        method: "POST",
        body: { hash, description },
      },
      uiOptions
    );
  },

  async deleteEntry(
    hash: string,
    uiOptions: RequestUiOptions = DEFAULT_WRITE_UI_OPTIONS
  ): Promise<MediaCacheMutationResponse> {
    return requestWithUi(
      {
        url: `/admin_api/multimodal-cache/${encodeURIComponent(hash)}`,
        method: "DELETE",
      },
      uiOptions
    );
  },

  async reidentify(
    hash: string,
    uiOptions: RequestUiOptions = DEFAULT_WRITE_UI_OPTIONS
  ): Promise<MediaCacheReidentifyResponse> {
    return requestWithUi(
      {
        url: "/admin_api/multimodal-cache/reidentify",
        method: "POST",
        body: { hash },
      },
      uiOptions
    );
  },
};
