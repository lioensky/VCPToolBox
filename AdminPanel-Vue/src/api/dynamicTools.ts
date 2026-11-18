import { requestWithUi, type RequestUiOptions } from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface DynamicToolsSmallModelConfig {
  enabled: boolean;
  model: string;
  maxRetries: number;
  retryDelayMs: number;
  maxTokens: number;
  temperature: number;
}

export interface DynamicToolsCategoryRule {
  category: string;
  parent?: string;
  description: string;
  keywords: string[];
}

export interface DynamicToolsSummaryConfig {
  lightListTokenBudget: number;
  briefTokenBudget: number;
  minBriefTokenBudget: number;
}

export interface DynamicToolsClassificationConfig {
  maxCategories: number;
  embeddingThreshold: number;
  categoryRules: DynamicToolsCategoryRule[];
}

export interface DynamicToolsManualOverrides {
  excludedOriginKeys: string[];
  pinnedOriginKeys: string[];
  categoryAliases: Record<string, string>;
  descriptionOverrides: Record<
    string,
    {
      brief?: string;
      fullDescription?: string;
      categories?: string[];
      keywords?: string[];
    }
  >;
}

export interface DynamicToolsConfig {
  version: 2;
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
  summary: DynamicToolsSummaryConfig;
  classification: DynamicToolsClassificationConfig;
}

export type DynamicToolsConfigPatch = Partial<
  Omit<
    DynamicToolsConfig,
    | "smallModel"
    | "manualOverrides"
    | "summary"
    | "classification"
    | "placeholder"
  >
> & {
  smallModel?: Partial<DynamicToolsSmallModelConfig>;
  manualOverrides?: Partial<DynamicToolsManualOverrides>;
  summary?: Partial<DynamicToolsSummaryConfig>;
  classification?: Partial<DynamicToolsClassificationConfig>;
};

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
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS,
  ): Promise<DynamicToolsState> {
    return requestWithUi<DynamicToolsState>(
      {
        url: "/admin_api/dynamic-tools/state",
      },
      uiOptions,
    );
  },

  async getConfig(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS,
  ): Promise<DynamicToolsConfig> {
    const response = await requestWithUi<DynamicToolsConfigResponse>(
      {
        url: "/admin_api/dynamic-tools/config",
      },
      uiOptions,
    );
    return response.config;
  },

  async saveConfig(
    config: DynamicToolsConfigPatch,
    uiOptions: RequestUiOptions = {},
  ): Promise<DynamicToolsConfig> {
    const response = await requestWithUi<DynamicToolsConfigResponse>(
      {
        url: "/admin_api/dynamic-tools/config",
        method: "POST",
        body: config,
      },
      uiOptions,
    );
    return response.config;
  },

  async rebuild(
    mode: DynamicToolsRebuildMode,
    uiOptions: RequestUiOptions = {},
    options: { wait?: boolean } = {},
  ): Promise<DynamicToolsState> {
    const response = await requestWithUi<DynamicToolsStateResponse>(
      {
        url: "/admin_api/dynamic-tools/rebuild",
        method: "POST",
        body: {
          mode,
          wait: options.wait ?? true,
        },
      },
      uiOptions,
    );
    return response.state;
  },

  async updateOverride(
    payload: {
      originKey?: string;
      excluded?: boolean;
      pinned?: boolean;
      manualOverrides?: Partial<DynamicToolsManualOverrides>;
    },
    uiOptions: RequestUiOptions = {},
  ): Promise<DynamicToolsConfig> {
    const response = await requestWithUi<DynamicToolsConfigResponse>(
      {
        url: "/admin_api/dynamic-tools/override",
        method: "POST",
        body: payload,
      },
      uiOptions,
    );
    return response.config;
  },
};
