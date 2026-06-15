import type { HttpRequest } from "@/platform/http/httpClient";
import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";
import type { UserAuthCodeResponse } from "@/types/api.auth";
import type {
  BridgeHijackConfig,
  BridgeHijackConfigResponse,
  BridgeHijackConfigSaveResponse,
  BridgeProfile,
  BridgeProfileActivateResponse,
  BridgeProfileDeleteResponse,
  BridgeProfileResponse,
  BridgeProfilesResponse,
  FinalContextResponse,
  OneRingConfig,
  OneRingConfigResponse,
  OneRingConfigSaveResponse,
  PM2Process,
  PM2ProcessesResponse,
  RawSystemResourcesResponse,
  ServerLogQuery,
  ServerLogResponse,
  SystemResources,
} from "@/types/api.system";

export type { BridgeHijackConfig, BridgeHijackConfigResponse, BridgeHijackConfigSaveResponse, FinalContextResponse, OneRingConfig, OneRingConfigResponse, OneRingConfigSaveResponse, ServerLogQuery, ServerLogResponse } from "@/types/api.system";
export type { UserAuthCodeResponse } from "@/types/api.auth";

export type SystemResourcesResponse = SystemResources;
export type PM2ProcessInfo = PM2Process;

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

function createServerLogRequest(
  query: ServerLogQuery = {},
  requestContext: HttpRequestContext = {}
): HttpRequest {
  const normalizedOffset =
    typeof query.offset === "number" &&
    Number.isFinite(query.offset) &&
    query.offset >= 0
      ? Math.floor(query.offset)
      : undefined;

  return {
    url: "/admin_api/server-log",
    query: {
      incremental: query.incremental ? true : undefined,
      offset: normalizedOffset,
    },
    ...requestContext,
  };
}

async function fetchServerLog(
  query: ServerLogQuery,
  requestContext: HttpRequestContext = {},
  uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
): Promise<ServerLogResponse> {
  return requestWithUi<ServerLogResponse>(
    createServerLogRequest(query, requestContext),
    uiOptions
  );
}

function normalizeSystemResources(
  response: RawSystemResourcesResponse
): SystemResourcesResponse {
  const total = response.system.memory.total || 0;
  const used = response.system.memory.used || 0;

  return {
    cpu: response.system.cpu,
    memory: {
      ...response.system.memory,
      usage: total > 0 ? (used / total) * 100 : 0,
    },
    nodeProcess: response.system.nodeProcess,
  };
}

export const systemApi = {
  async getSystemResources(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<SystemResourcesResponse> {
    const response = await requestWithUi<RawSystemResourcesResponse>(
      {
        url: "/admin_api/system-monitor/system/resources",
        ...requestContext,
      },
      uiOptions
    );
    return normalizeSystemResources(response);
  },

  async getPM2Processes(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<PM2ProcessInfo[]> {
    const response = await requestWithUi<PM2ProcessesResponse>(
      {
        url: "/admin_api/system-monitor/pm2/processes",
        ...requestContext,
      },
      uiOptions
    );
    return response.processes ?? [];
  },

  async getUserAuthCode(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<UserAuthCodeResponse> {
    return requestWithUi(
      {
        url: "/admin_api/user-auth-code",
        ...requestContext,
      },
      uiOptions
    );
  },

  async getFinalContext(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<FinalContextResponse> {
    return requestWithUi<FinalContextResponse>(
      {
        url: "/admin_api/final-context",
        ...requestContext,
      },
      uiOptions
    );
  },

  async getOneRingConfig(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<OneRingConfigResponse> {
    return requestWithUi<OneRingConfigResponse>(
      {
        url: "/admin_api/onering-config",
        ...requestContext,
      },
      uiOptions
    );
  },

  async saveOneRingConfig(
    config: OneRingConfig,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OneRingConfigSaveResponse> {
    return requestWithUi<OneRingConfigSaveResponse>(
      {
        url: "/admin_api/onering-config",
        method: "PUT",
        body: config,
        ...requestContext,
      },
      uiOptions
    );
  },

  async getBridgeHijackConfig(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<BridgeHijackConfigResponse> {
    return requestWithUi<BridgeHijackConfigResponse>(
      {
        url: "/admin_api/bridge-config",
        ...requestContext,
      },
      uiOptions
    );
  },

  async saveBridgeHijackConfig(
    config: BridgeHijackConfig,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<BridgeHijackConfigSaveResponse> {
    return requestWithUi<BridgeHijackConfigSaveResponse>(
      {
        url: "/admin_api/bridge-config",
        method: "PUT",
        body: config,
        ...requestContext,
      },
      uiOptions
    );
  },

  async getServerLog(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ServerLogResponse> {
    return fetchServerLog({}, requestContext, uiOptions);
  },

  async getIncrementalServerLog(
    offset: number,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ServerLogResponse> {
    return fetchServerLog(
      {
        incremental: true,
        offset,
      },
      requestContext,
      uiOptions
    );
  },

  async restartServer(
    uiOptions: RequestUiOptions = {}
  ): Promise<{ message?: string }> {
    return requestWithUi(
      {
        url: "/admin_api/server/restart",
        method: "POST",
      },
      uiOptions
    );
  },

  async logout(
    uiOptions: RequestUiOptions = {}
  ): Promise<{ status?: string; message?: string }> {
    return requestWithUi(
      {
        url: "/admin_api/logout",
        method: "POST",
      },
      uiOptions
    );
  },

  // ─── Bridge Profiles ───────────────────────────────────────────────

  async getBridgeProfiles(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<BridgeProfilesResponse> {
    return requestWithUi<BridgeProfilesResponse>(
      {
        url: "/admin_api/bridge-profiles",
        ...requestContext,
      },
      uiOptions
    );
  },

  async getBridgeProfile(
    name: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<BridgeProfileResponse> {
    return requestWithUi<BridgeProfileResponse>(
      {
        url: `/admin_api/bridge-profiles/${encodeURIComponent(name)}`,
        ...requestContext,
      },
      uiOptions
    );
  },

  async saveBridgeProfile(
    name: string,
    data: Partial<BridgeProfile>,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<BridgeProfileResponse> {
    return requestWithUi<BridgeProfileResponse>(
      {
        url: `/admin_api/bridge-profiles/${encodeURIComponent(name)}`,
        method: "POST",
        body: data,
        ...requestContext,
      },
      uiOptions
    );
  },

  async deleteBridgeProfile(
    name: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<BridgeProfileDeleteResponse> {
    return requestWithUi<BridgeProfileDeleteResponse>(
      {
        url: `/admin_api/bridge-profiles/${encodeURIComponent(name)}`,
        method: "DELETE",
        ...requestContext,
      },
      uiOptions
    );
  },

  async activateBridgeProfile(
    name: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<BridgeProfileActivateResponse> {
    return requestWithUi<BridgeProfileActivateResponse>(
      {
        url: `/admin_api/bridge-profiles/${encodeURIComponent(name)}/activate`,
        method: "POST",
        ...requestContext,
      },
      uiOptions
    );
  },

  async deactivateBridgeProfile(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<BridgeProfileActivateResponse> {
    return requestWithUi<BridgeProfileActivateResponse>(
      {
        url: "/admin_api/bridge-profiles/deactivate",
        method: "POST",
        ...requestContext,
      },
      uiOptions
    );
  },
};

