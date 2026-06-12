import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface OpenHerPersonaMap {
  [key: string]: number;
}

export interface OpenHerPersonaMood {
  valence: number;
  arousal: number;
  label: string;
}

export interface OpenHerPersonaExpression {
  mode: string;
  label: string;
  pace: string;
  intensity: number;
  emoji: boolean;
  silence: boolean;
  burst: boolean;
  burstSegments: [number, number];
  reason: string;
  modelChoice?: {
    mode?: string;
    pace?: string;
    intensity?: number;
    reason?: string;
    at?: string | null;
  } | null;
  updatedAt?: string | null;
}

export interface OpenHerPersonaPhase {
  name: "grounded" | "strained" | "eruption" | "cooling" | string;
  charge: number;
  enteredAt?: string | null;
  lastEruptionAt?: string | null;
  coolingTurns?: number;
}

export interface OpenHerPersonaTrendMap {
  frustration: OpenHerPersonaMap;
  signals: OpenHerPersonaMap;
}

export interface OpenHerPersonaAgentSummary {
  agentKey: string;
  agentLabel: string;
  turnCount: number;
  updatedAt: string | null;
  lastActiveAt: string | null;
}

export interface OpenHerPersonaState {
  agentKey: string;
  agentLabel: string;
  updatedAt?: string | null;
  lastTickAt?: string | null;
  lastActiveAt?: string | null;
  turnCount: number;
  lastTurnFingerprint?: string | null;
  frustration: OpenHerPersonaMap;
  signals: OpenHerPersonaMap;
  temperament: OpenHerPersonaMap;
  signalBias: OpenHerPersonaMap;
  metabolism: {
    growthGain: OpenHerPersonaMap;
    reliefGain: OpenHerPersonaMap;
  };
  phase: OpenHerPersonaPhase;
  mood: OpenHerPersonaMood;
  trends: OpenHerPersonaTrendMap;
  lastChange: OpenHerPersonaTrendMap;
  expression: OpenHerPersonaExpression;
  lastAppliedPersonaDelta?: {
    at?: string;
    impact?: string;
    downgradedFrom?: string | null;
    reason?: string | null;
    frustration_set?: OpenHerPersonaMap;
    frustration_delta?: OpenHerPersonaMap;
    signal_delta?: OpenHerPersonaMap;
  } | null;
  genome: {
    recurrentState: number[];
    lastContext: OpenHerPersonaMap;
  };
  topSignals: Array<{ key: string; label: string; value: number }>;
  topFrustration: Array<{ key: string; label: string; value: number }>;
  cooldown: {
    minutes?: number;
    lastImpulseAt?: string | null;
  };
}

export interface OpenHerPersonaPluginStatus {
  status: string;
  plugin: string;
  version: string;
  agent: OpenHerPersonaAgentSummary;
  agents: OpenHerPersonaAgentSummary[];
  enabled: boolean;
  hintEnabled: boolean;
  observeOnly: boolean;
  tickEnabled: boolean;
  contextBridgeAvailable: boolean;
  semanticContext: {
    enabled: boolean;
    weight: number;
    anchorsReady: boolean;
    provider: string;
  };
  state: OpenHerPersonaState;
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
    hintEnabled: boolean;
    observeOnly: boolean;
    tickEnabled: boolean;
    contextBridgeAvailable: boolean;
    semanticContext?: OpenHerPersonaPluginStatus["semanticContext"] | null;
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