import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface OpenHerPersonaAxisSubScore {
  similarity?: number;
  weight?: number;
}

export interface OpenHerPersonaAxisState {
  value: number;
  activation: number;
  sharpness: number;
  subAxes: Record<string, OpenHerPersonaAxisSubScore>;
}

export interface OpenHerPersonaAxisLayer {
  [axis: string]: OpenHerPersonaAxisState;
}

export interface OpenHerPersonaMood {
  positive: number;
  negative: number;
  arousal: number;
  tension: number;
  dominance: number;
  label: string;
}

export interface OpenHerPersonaTopAxis {
  axis: string;
  label: string;
  activation: number;
  sharpness: number;
}

export interface OpenHerPersonaLastObservation {
  at?: string | null;
  inputHash?: string | null;
  scores?: Record<string, OpenHerPersonaAxisState>;
  coupled?: Record<string, number>;
  mood?: OpenHerPersonaMood;
}

export interface OpenHerPersonaAgentSummary {
  agentKey: string;
  agentLabel: string;
  turnCount?: number;
  observationCount?: number;
  updatedAt: string | null;
  lastActiveAt?: string | null;
  lastObservedAt?: string | null;
}

export interface OpenHerPersonaState {
  agentKey: string;
  agentLabel: string;
  psyGender: number;
  cognitive: OpenHerPersonaAxisLayer;
  affective: OpenHerPersonaAxisLayer;
  drive: OpenHerPersonaAxisLayer;
  mood: OpenHerPersonaMood;
  observationCount: number;
  lastObservedAt?: string | null;
  lastInputHash?: string | null;
  lastObservation?: OpenHerPersonaLastObservation | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

export interface OpenHerPersonaPluginStatus {
  status: string;
  plugin: string;
  version: string;
  mode: "async_observer" | string;
  enabled: boolean;
  promptInjection: boolean;
  timeMetabolism: boolean;
  keywordHeuristic: boolean;
  provider: string;
  config: Record<string, boolean | number | string>;
  configPath: string;
  database: {
    available: boolean;
    path: string;
    schema: string;
  };
  queue: {
    agentKey: string;
    running: boolean;
    pending: number;
    maxSize: number;
  };
  agents: OpenHerPersonaAgentSummary[];
  state: OpenHerPersonaState | null;
  boundaries?: Record<string, boolean>;
}

export interface OpenHerPersonaAdminAgent {
  summary: OpenHerPersonaAgentSummary;
  status?: OpenHerPersonaPluginStatus;
  error?: string;
}

export interface OpenHerPersonaAdminStatus {
  status: "success" | "error";
  plugin: string;
  overview: {
    version?: string;
    enabled: boolean;
    hintEnabled?: boolean;
    observeOnly?: boolean;
    tickEnabled?: boolean;
    contextBridgeAvailable?: boolean;
    semanticContext?: null;
    activeAgent?: OpenHerPersonaAgentSummary | null;
    boundaries?: Record<string, boolean> | null;
  };
  agents: OpenHerPersonaAdminAgent[];
}

export interface OpenHerPersonaConfigSchemaEntry {
  type: "boolean" | "integer" | "number" | "select" | string;
  label: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export interface OpenHerPersonaConfigResponse {
  status: "success" | "error";
  plugin: string;
  path: string;
  schema: Record<string, OpenHerPersonaConfigSchemaEntry>;
  defaults: Record<string, boolean | number | string>;
  config: Record<string, boolean | number | string>;
  sourceOfTruth: "json" | string;
}

export const openHerPersonaApi = {
  async getStatus(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<OpenHerPersonaAdminStatus> {
    return requestWithUi(
      {
        url: "/admin_api/openher-persona/status",
        ...requestContext,
      },
      uiOptions
    );
  },

  async getConfig(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<OpenHerPersonaConfigResponse> {
    return requestWithUi(
      {
        url: "/admin_api/openher-persona/config",
        ...requestContext,
      },
      uiOptions
    );
  },

  async saveConfig(
    config: Record<string, boolean | number | string>,
    uiOptions: RequestUiOptions = {}
  ): Promise<OpenHerPersonaConfigResponse> {
    return requestWithUi(
      {
        url: "/admin_api/openher-persona/config",
        method: "POST",
        body: { config },
        timeoutMs: 35000,
      },
      uiOptions
    );
  },

  async tickAgent(
    agentKey: string,
    agentName: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<OpenHerPersonaPluginStatus> {
    return requestWithUi(
      {
        url: `/admin_api/openher-persona/${encodeURIComponent(agentKey)}/tick`,
        method: "POST",
        body: { agentName },
        timeoutMs: 35000,
      },
      uiOptions
    );
  },

  async resetAgent(
    agentKey: string,
    agentName: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<OpenHerPersonaPluginStatus> {
    return requestWithUi(
      {
        url: `/admin_api/openher-persona/${encodeURIComponent(agentKey)}/reset`,
        method: "POST",
        body: { agentName },
        timeoutMs: 35000,
      },
      uiOptions
    );
  },
};