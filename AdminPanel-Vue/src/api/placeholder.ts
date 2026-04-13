import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";
import type { Placeholder } from '@/features/placeholder-viewer/types'

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

interface PlaceholderListResponse {
  data?: {
    list?: Placeholder[]
  }
}

interface PlaceholderDetailResponse {
  data?: {
    value?: string
  }
}

export const placeholderApi = {
  async getPlaceholders(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<Placeholder[]> {
    const response = await requestWithUi<PlaceholderListResponse>(
      {
        url: "/admin_api/placeholders",
      },
      uiOptions
    );

    return response.data?.list || [];
  },

  async getPlaceholderDetail(
    type: string,
    name: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string | null> {
    const response = await requestWithUi<PlaceholderDetailResponse>(
      {
        url: "/admin_api/placeholders/detail",
        query: {
          type,
          name,
        },
      },
      uiOptions
    );

    return response.data?.value != null ? String(response.data.value) : null;
  },
};

