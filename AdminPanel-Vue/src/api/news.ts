import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";
import type { NewsItem, NewsResponse } from "@/types/api.news";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };
export type { NewsItem, NewsResponse } from "@/types/api.news";

export const newsApi = {
  async getNews(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<NewsItem[]> {
    const response = await requestWithUi<NewsResponse>(
      {
        url: "/admin_api/dailyhot",
        ...requestContext,
      },
      uiOptions
    );
    return response.data || [];
  },

  async getGroupedNews(
    limitPerSource = 2,
    totalLimit = 10,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<NewsItem[]> {
    const allNews = await this.getNews(requestContext, uiOptions);
    const grouped: Record<string, NewsItem[]> = {};

    for (const item of allNews) {
      const source = item.source || "Other";
      if (!grouped[source]) {
        grouped[source] = [];
      }
      if (grouped[source].length < limitPerSource) {
        grouped[source].push(item);
      }
    }

    return Object.values(grouped).flat().slice(0, totalLimit);
  },
};

