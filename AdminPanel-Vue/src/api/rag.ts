import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export type ParamPrimitive = string | number | boolean | null;
export type ParamValue = ParamPrimitive | ParamValue[] | { [key: string]: ParamValue };
export type ParamGroup = Record<string, ParamValue>;
export type RagParams = Record<string, ParamGroup>;

export interface RagParamTheme {
  name: string;
  fileName: string;
}

export interface RagParamThemesResponse {
  themes?: RagParamTheme[];
}

export interface RagParamThemeApplyResponse {
  message?: string;
  theme?: RagParamTheme;
  params?: RagParams;
}

export interface RagParamThemeSaveResponse {
  message?: string;
  theme?: RagParamTheme;
}

export interface ActiveFullTrainingResult {
  taskId?: string;
  queued?: boolean;
  reason?: string;
  resetPendingNewTags?: number;
  threshold?: number;
  error?: string;
}

export interface ActiveFullTrainingResponse {
  success?: boolean;
  message?: string;
  result?: ActiveFullTrainingResult;
  error?: string;
}

export interface TagConsistencySummary {
  totalDatabaseFiles: number;
  scannedFiles: number;
  ignoredFiles: number;
  missingFiles: number;
  affectedFiles: number;
  relationsToAdd: number;
  relationsToRemove: number;
  positionsToUpdate: number;
  vectorsToCreate: number;
  vectorsToRemove: number;
  orphanTagsToRemove: number;
  finalTagCount: number;
}

export interface TagConsistencyFileDetail {
  path: string;
  status: "scanned" | "ignored" | "missing" | "outside-root";
  added: string[];
  removed: string[];
  positionUpdates: number;
}

export interface TagConsistencyPreview {
  token: string;
  digest: string;
  createdAt: number;
  expiresAt: number;
  summary: TagConsistencySummary;
  additions: string[];
  removals: string[];
  affectedFileDetails: TagConsistencyFileDetail[];
  detailTruncated: boolean;
  requiresConfirmation: boolean;
}

export interface TagConsistencyPreviewResponse {
  success?: boolean;
  preview?: TagConsistencyPreview;
  code?: string;
  error?: string;
}

export interface TagConsistencyApplyResult {
  applied: boolean;
  summary: TagConsistencySummary;
  waveAssetsStale: boolean;
  recommendedAction: "active-full-training";
  message: string;
}

export interface TagConsistencyApplyResponse {
  success?: boolean;
  result?: TagConsistencyApplyResult;
  code?: string;
  error?: string;
}

export interface SemanticGroupData {
  words?: string[];
  auto_learned?: string[];
  weight?: number;
}

export interface SemanticGroupsResponse {
  config?: Record<string, unknown>;
  groups?: Record<string, SemanticGroupData>;
}

export interface ThinkingChainConfig {
  clusters?: string[];
  kSequence?: number[];
}

export interface ThinkingChainsResponse {
  chains?: Record<string, ThinkingChainConfig | string[]>;
}

interface AvailableClustersResponse {
  clusters?: string[];
}

export const ragApi = {
  async getRagParams(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<RagParams> {
    return requestWithUi(
      {
        url: "/admin_api/rag-params",
      },
      uiOptions
    );
  },

  async saveRagParams(
    params: RagParams,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/rag-params",
        method: "POST",
        body: params,
      },
      uiOptions
    );
  },

  async previewTagConsistency(
    uiOptions: RequestUiOptions = {}
  ): Promise<TagConsistencyPreviewResponse> {
    return requestWithUi(
      {
        url: "/admin_api/rag-tag-consistency/preview",
        method: "POST",
      },
      uiOptions
    );
  },

  async applyTagConsistency(
    token: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<TagConsistencyApplyResponse> {
    return requestWithUi(
      {
        url: "/admin_api/rag-tag-consistency/apply",
        method: "POST",
        body: { token },
      },
      uiOptions
    );
  },

  async triggerActiveFullTraining(
    uiOptions: RequestUiOptions = {}
  ): Promise<ActiveFullTrainingResponse> {
    return requestWithUi(
      {
        url: "/admin_api/rag-active-full-training",
        method: "POST",
      },
      uiOptions
    );
  },

  async getRagParamThemes(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<RagParamTheme[]> {
    const response = await requestWithUi<RagParamThemesResponse>(
      {
        url: "/admin_api/rag-param-themes",
      },
      uiOptions
    );
    return response.themes || [];
  },

  async getRagParamTheme(
    themeName: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<RagParams> {
    return requestWithUi(
      {
        url: `/admin_api/rag-param-themes/${encodeURIComponent(themeName)}`,
      },
      uiOptions
    );
  },

  async saveRagParamTheme(
    themeName: string,
    params: RagParams,
    uiOptions: RequestUiOptions = {}
  ): Promise<RagParamThemeSaveResponse> {
    return requestWithUi(
      {
        url: `/admin_api/rag-param-themes/${encodeURIComponent(themeName)}`,
        method: "POST",
        body: params,
      },
      uiOptions
    );
  },

  async applyRagParamTheme(
    themeName: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<RagParamThemeApplyResponse> {
    return requestWithUi(
      {
        url: `/admin_api/rag-param-themes/${encodeURIComponent(themeName)}/apply`,
        method: "POST",
      },
      uiOptions
    );
  },

  async getSemanticGroups(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<SemanticGroupsResponse> {
    return requestWithUi(
      {
        url: "/admin_api/semantic-groups",
      },
      uiOptions
    );
  },

  async saveSemanticGroups(
    payload: SemanticGroupsResponse,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/semantic-groups",
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async getThinkingChains(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ThinkingChainsResponse> {
    return requestWithUi(
      {
        url: "/admin_api/thinking-chains",
      },
      uiOptions
    );
  },

  async saveThinkingChains(
    payload: ThinkingChainsResponse,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/thinking-chains",
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async getAvailableClusters(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string[]> {
    const response = await requestWithUi<AvailableClustersResponse>(
      {
        url: "/admin_api/available-clusters",
      },
      uiOptions
    );
    return response.clusters || [];
  },
};

