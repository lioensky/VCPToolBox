import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const API_BASE_URL = "/admin_api/semantic-router";
const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface SemanticRouterRoute {
  name?: string;
  model: string;
  description: string;
  failoverPool?: boolean;
  enabled?: boolean;
}

export interface SemanticRouterPreset {
  displayName?: string;
  defaultModel: string;
  fallbackModels?: string[];
  matchThreshold?: number;
  contextWeights?: number[];
  routes: SemanticRouterRoute[];
}

export interface SemanticRouterConfig {
  enabled: boolean;
  autoModelName: string;
  defaultPreset: string;
  matchThreshold: number;
  contextWeights: number[];
  presets: Record<string, SemanticRouterPreset>;
}

export interface SemanticRouterVirtualModel {
  id: string;
  object: string;
  owned_by: string;
  display_name?: string;
}

export interface SemanticRouterConfigResponse {
  config: SemanticRouterConfig;
  normalizedConfig: SemanticRouterConfig;
  virtualModels: SemanticRouterVirtualModel[];
  path: string;
  localPath?: string;
  hasLocalConfig?: boolean;
  usesLocalConfig?: boolean;
  localConfigError?: {
    name?: string;
    message?: string;
  } | null;
}

export interface SemanticRouterSaveResponse {
  success: boolean;
  message: string;
  config: SemanticRouterConfig;
  virtualModels: SemanticRouterVirtualModel[];
  path?: string;
}

export interface SemanticRouterUpstreamModel {
  id: string;
  object?: string;
  owned_by?: string;
  upstreamId?: string;
  redirected?: boolean;
  redirectOnly?: boolean;
  [key: string]: unknown;
}

export interface SemanticRouterUpstreamModelsResponse {
  models: SemanticRouterUpstreamModel[];
  redirectEnabled: boolean;
  redirectRules: Record<string, string>;
  source?: string;
  warning?: string;
}

export interface SemanticRouterPreviewRequest {
  requestedModel?: string;
  presetName?: string;
  userText?: string;
  assistantText?: string;
  messages?: unknown[];
}

export interface SemanticRouterRankedRoute {
  name?: string;
  model: string;
  description: string;
  failoverPool?: boolean;
  similarity: number;
}

export interface SemanticRouterPlan {
  active: boolean;
  requestedModel: string;
  presetName: string | null;
  selectedModel: string;
  candidates: string[];
  match: SemanticRouterRankedRoute | null;
  rankedRoutes?: SemanticRouterRankedRoute[];
  reason: string;
}

export interface SemanticRouterPreviewResponse {
  plan: SemanticRouterPlan;
  rankedRoutes: SemanticRouterRankedRoute[];
  candidates: string[];
  selectedModel: string | null;
}

export const semanticRouterApi = {
  async getConfig(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<SemanticRouterConfigResponse> {
    return requestWithUi(
      {
        url: `${API_BASE_URL}/config`,
      },
      uiOptions
    );
  },

  async saveConfig(
    config: SemanticRouterConfig,
    uiOptions: RequestUiOptions = {}
  ): Promise<SemanticRouterSaveResponse> {
    return requestWithUi(
      {
        url: `${API_BASE_URL}/config`,
        method: "PUT",
        body: { config },
        timeoutMs: 30000,
      },
      uiOptions
    );
  },

  async getUpstreamModels(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<SemanticRouterUpstreamModelsResponse> {
    return requestWithUi(
      {
        url: `${API_BASE_URL}/upstream-models`,
        timeoutMs: 30000,
      },
      uiOptions
    );
  },

  async preview(
    payload: SemanticRouterPreviewRequest,
    uiOptions: RequestUiOptions = {}
  ): Promise<SemanticRouterPreviewResponse> {
    return requestWithUi(
      {
        url: `${API_BASE_URL}/preview`,
        method: "POST",
        body: payload,
        timeoutMs: 60000,
      },
      uiOptions
    );
  },
};
