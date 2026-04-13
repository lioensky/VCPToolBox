import type { HttpRequest } from "@/platform/http/httpClient";
import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";
import type { UserAuthCodeResponse } from "@/types/api.auth";
import type {
  PM2Process,
  PM2ProcessesResponse,
  RawSystemResourcesResponse,
  ServerLogQuery,
  ServerLogResponse,
  SystemResources,
} from "@/types/api.system";

export type { ServerLogQuery, ServerLogResponse } from "@/types/api.system";
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
};

