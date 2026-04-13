import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";
import type {
  PluginInfo,
  PluginListResponse,
} from "@/types/api.plugin";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

const PLUGIN_LIST_CACHE_TTL_MS = 10 * 1000;

let pluginListCache: {
  data: PluginInfo[];
  expiresAt: number;
} | null = null;

let pluginListInflight: Promise<PluginInfo[]> | null = null;

function normalizePluginList(response: PluginListResponse | PluginInfo[]): PluginInfo[] {
  if (Array.isArray(response)) {
    return response;
  }
  return response.plugins || [];
}

function invalidatePluginListCache(): void {
  pluginListCache = null;
  pluginListInflight = null;
}

export const pluginApi = {
  async getPlugins(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<PluginInfo[]> {
    const now = Date.now();

    if (pluginListCache && pluginListCache.expiresAt > now) {
      return pluginListCache.data;
    }

    if (pluginListInflight) {
      return pluginListInflight;
    }

    pluginListInflight = requestWithUi<PluginListResponse | PluginInfo[]>(
      {
        url: "/admin_api/plugins",
      },
      uiOptions
    )
      .then((response) => {
        const data = normalizePluginList(response);
        pluginListCache = {
          data,
          expiresAt: Date.now() + PLUGIN_LIST_CACHE_TTL_MS,
        };
        return data;
      })
      .finally(() => {
        pluginListInflight = null;
      });

    return pluginListInflight;
  },

  async savePluginConfig(
    pluginName: string,
    content: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    try {
      await requestWithUi(
        {
          url: `/admin_api/plugins/${encodeURIComponent(pluginName)}/config`,
          method: "POST",
          body: { content },
        },
        uiOptions
      );
    } finally {
      invalidatePluginListCache();
    }
  },

  async togglePlugin(
    pluginName: string,
    enable: boolean,
    uiOptions: RequestUiOptions = {}
  ): Promise<{ success: boolean; message?: string }> {
    try {
      return await requestWithUi(
        {
          url: `/admin_api/plugins/${encodeURIComponent(pluginName)}/toggle`,
          method: "POST",
          body: { enable },
        },
        uiOptions
      );
    } finally {
      invalidatePluginListCache();
    }
  },

  async saveInvocationCommandDescription(
    pluginName: string,
    commandIdentifier: string,
    description: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `/admin_api/plugins/${encodeURIComponent(pluginName)}/commands/${encodeURIComponent(commandIdentifier)}/description`,
        method: "POST",
        body: { description },
      },
      uiOptions
    );
  },
};

