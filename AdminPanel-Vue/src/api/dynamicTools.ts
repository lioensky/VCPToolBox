import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface DynamicToolsSmallModelConfig {
  enabled: boolean;
  useMainConfig: boolean;
  endpoint: string;
  model: string;
}

export interface DynamicToolsManualOverrides {
  excludedOriginKeys: string[];
  pinnedOriginKeys: string[];
  categoryAliases: Record<string, string>;
}

export interface DynamicToolsConfig {
  enabled: boolean;
  placeholder: string;
  maxBriefListItems: number;
  maxExpandedPlugins: number;
  maxForcedCategoryPlugins: number;
  maxInjectionChars: number;
  classificationDebounceMs: number;
  classifierTimeoutMs: number;
  useRagEmbeddings: boolean;
  manualOverrides: DynamicToolsManualOverrides;
  smallModel: DynamicToolsSmallModelConfig;
}

export interface DynamicToolRecord {
  originKey: string;
  pluginName: string;
  displayName: string;
  originKind: "local" | "distributed" | string;
  originId: string;
  enabled: boolean;
  online: boolean;
  available: boolean;
  sourceHash: string;
  categories: string[];
  keywords: string[];
  brief: string;
  classifiedBy: string | null;
  classifiedAt: string | null;
  lastSeenAt: string | null;
  lastStatusChangeAt: string | null;
}

export interface DynamicToolsState {
  initialized: boolean;
  snapshotId: number;
  queueSize: number;
  isClassifying: boolean;
  lastError: string | null;
  config: DynamicToolsConfig;
  records: DynamicToolRecord[];
}

interface DynamicToolsConfigResponse {
  config: DynamicToolsConfig;
}

interface DynamicToolsStateResponse {
  state: DynamicToolsState;
}

export type DynamicToolsRebuildMode = "classification" | "catalog" | "all";

export const dynamicToolsApi = {
  async getState(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<DynamicToolsState> {
    return requestWithUi<DynamicToolsState>(
      {
        url: "/admin_api/dynamic-tools/state",
      },
      uiOptions
    );
  },

  async getConfig(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<DynamicToolsConfig> {
    const response = await requestWithUi<DynamicToolsConfigResponse>(
      {
        url: "/admin_api/dynamic-tools/config",
      },
      uiOptions
    );
    return response.config;
  },

  async saveConfig(
    config: Partial<DynamicToolsConfig>,
    uiOptions: RequestUiOptions = {}
  ): Promise<DynamicToolsConfig> {
    const response = await requestWithUi<DynamicToolsConfigResponse>(
      {
        url: "/admin_api/dynamic-tools/config",
        method: "POST",
        body: config,
      },
      uiOptions
    );
    return response.config;
  },

  async rebuild(
    mode: DynamicToolsRebuildMode,
    uiOptions: RequestUiOptions = {},
    options: { wait?: boolean } = {}
  ): Promise<DynamicToolsState> {
    const response = await requestWithUi<DynamicToolsStateResponse>(
      {
        url: "/admin_api/dynamic-tools/rebuild",
        method: "POST",
        body: {
          mode,
          wait: options.wait !== false,
        },
      },
      uiOptions
    );
    return response.state;
  },

  async updateOverride(
    payload: {
      originKey?: string;
      excluded?: boolean;
      pinned?: boolean;
      manualOverrides?: DynamicToolsManualOverrides;
    },
    uiOptions: RequestUiOptions = {}
  ): Promise<DynamicToolsConfig> {
    const response = await requestWithUi<DynamicToolsConfigResponse>(
      {
        url: "/admin_api/dynamic-tools/override",
        method: "POST",
        body: payload,
      },
      uiOptions
    );
    return response.config;
  },
};
