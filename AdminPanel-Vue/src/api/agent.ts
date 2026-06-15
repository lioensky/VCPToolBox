import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";
import type {
  AgentAssistantConfigResponse,
  AgentAssistantDelegationTask,
  AgentAssistantDelegationsResponse,
  CancelAgentAssistantDelegationResponse,
  AgentMapResponse,
  AgentScoreHistoryEntry,
  AgentScoreSummary,
  SaveAgentAssistantConfigPayload,
} from "@/types/api.agent";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };
export type {
  AgentAssistantConfigAgent,
  AgentAssistantConfigResponse,
  AgentAssistantDelegationTask,
  AgentAssistantDelegationsResponse,
  CancelAgentAssistantDelegationResponse,
  AgentInfo,
  AgentMapResponse,
  AgentScoreHistoryEntry,
  AgentScoreSummary,
  SaveAgentAssistantConfigPayload,
} from "@/types/api.agent";

interface AgentFilesResponse {
  files?: string[];
}

interface AgentScoreApiEntry {
  name?: string;
  totalPoints?: number;
  history?: AgentScoreHistoryEntry[];
}

export const agentApi = {
  async getAgentConfig(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<AgentAssistantConfigResponse> {
    return requestWithUi(
      {
        url: "/admin_api/agent-assistant/config",
        ...requestContext,
      },
      uiOptions
    );
  },

  async saveAgentConfig(
    config: SaveAgentAssistantConfigPayload,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/agent-assistant/config",
        method: "POST",
        body: config,
      },
      uiOptions
    );
  },

  async getAgentDelegations(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<AgentAssistantDelegationsResponse> {
    const response = await requestWithUi<{ data?: AgentAssistantDelegationsResponse } | AgentAssistantDelegationsResponse>(
      {
        url: "/admin_api/agent-assistant/delegations",
        ...requestContext,
      },
      uiOptions
    );
    if ("data" in response && response.data) {
      return response.data;
    }
    return response as AgentAssistantDelegationsResponse;
  },

  async getAgentDelegationDetail(
    delegationId: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<AgentAssistantDelegationTask | null> {
    const response = await requestWithUi<{ data?: AgentAssistantDelegationTask } | AgentAssistantDelegationTask>(
      {
        url: `/admin_api/agent-assistant/delegations/${encodeURIComponent(delegationId)}`,
        ...requestContext,
      },
      uiOptions
    );
    if ("data" in response && response.data) {
      return response.data;
    }
    return response as AgentAssistantDelegationTask;
  },

  async cancelAgentDelegation(
    delegationId: string,
    reason = "用户从管理面板请求取消。",
    uiOptions: RequestUiOptions = {}
  ): Promise<CancelAgentAssistantDelegationResponse> {
    return requestWithUi(
      {
        url: `/admin_api/agent-assistant/delegations/${encodeURIComponent(delegationId)}/cancel`,
        method: "POST",
        body: { reason },
      },
      uiOptions
    );
  },

  async getAgentMap(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<AgentMapResponse> {
    return requestWithUi(
      {
        url: "/admin_api/agents/map",
        ...requestContext,
      },
      uiOptions
    );
  },

  async saveAgentMap(
    agentMap: AgentMapResponse,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/agents/map",
        method: "POST",
        body: agentMap,
      },
      uiOptions
    );
  },

  async getAgentFiles(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string[]> {
    const response = await requestWithUi<AgentFilesResponse | string[]>(
      {
        url: "/admin_api/agents",
        ...requestContext,
      },
      uiOptions
    );
    if (Array.isArray(response)) {
      return response;
    }
    return response.files || [];
  },

  async getAgentFileContent(
    filename: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string> {
    const response = await requestWithUi<{ content?: string }>(
      {
        url: `/admin_api/agents/${encodeURIComponent(filename)}`,
        ...requestContext,
      },
      uiOptions
    );
    return response.content || "";
  },

  async saveAgentFile(
    filename: string,
    content: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `/admin_api/agents/${encodeURIComponent(filename)}`,
        method: "POST",
        body: { content },
      },
      uiOptions
    );
  },

  async createAgentFile(
    filename: string,
    folderPath?: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/agents/new-file",
        method: "POST",
        body: { fileName: filename, folderPath },
      },
      uiOptions
    );
  },

  async getAgentScores(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<AgentScoreSummary[]> {
    const response = await requestWithUi<Record<string, AgentScoreApiEntry>>(
      {
        url: "/admin_api/agent-assistant/scores",
        ...requestContext,
      },
      uiOptions
    );

    return Object.entries(response || {}).map(([baseName, entry]) => ({
      baseName,
      name: entry.name || baseName,
      totalPoints: entry.totalPoints || 0,
      history: Array.isArray(entry.history) ? entry.history : [],
    }));
  },
};

