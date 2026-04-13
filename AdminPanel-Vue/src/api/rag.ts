import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export type ParamValue = number | number[] | Record<string, number>;
export type ParamGroup = Record<string, ParamValue>;
export type RagParams = Record<string, ParamGroup>;

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

