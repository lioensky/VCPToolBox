import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface ToolCallRecordsConfig {
  enabled: boolean;
  retentionDays: number;
  autoCleanupEnabled: boolean;
  cleanupIntervalMinutes: number;
  maxQueryLimit: number;
  defaultQueryLimit: number;
  captureMultimodal: boolean;
  summarizeLargePayloadsInList: boolean;
  listPayloadPreviewChars: number;
  excludeTools: string[];
}

export interface ToolCallRecordsStoreStatus {
  initialized: boolean;
  enabled: boolean;
  configPath: string;
  dbPath: string;
  watcherActive: boolean;
  autoCleanupEnabled: boolean;
  retentionDays: number;
  cleanupIntervalMinutes: number;
  lastLoadError: string | null;
}

export interface ToolCallRecord {
  id: string;
  toolName: string;
  callerSignature: string | null;
  callerType: string | null;
  requestIp: string | null;
  sourceNode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  status: "running" | "success" | "failure" | string;
  success: boolean;
  callContent?: unknown;
  returnContent?: unknown;
  errorText: string | null;
  hasMultimodal: boolean;
}

export interface ToolCallRecordsQuery {
  id?: string;
  toolName?: string;
  callerSignature?: string;
  callerType?: string;
  status?: string;
  success?: string | boolean;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
  order?: "desc" | "asc";
  detail?: boolean;
}

export interface ToolCallRecordsStatusResponse {
  status: "success";
  store: ToolCallRecordsStoreStatus;
}

export interface ToolCallRecordsConfigResponse {
  status: "success";
  config: ToolCallRecordsConfig;
}

export interface ToolCallRecordsSaveConfigResponse {
  status: "success";
  message: string;
  config: ToolCallRecordsConfig;
}

export interface ToolCallRecordsListResponse {
  status: "success";
  total: number;
  limit: number;
  offset: number;
  records: ToolCallRecord[];
}

export interface ToolCallRecordDetailResponse {
  status: "success";
  record: ToolCallRecord;
}

export interface ToolCallRecordsCleanupResponse {
  status: "success";
  deleted: number;
  cutoff?: string;
  retentionDays?: number;
  skipped?: boolean;
  reason?: string;
  message: string;
}

export interface ToolCallRecordsClearResponse {
  status: "success";
  deleted: number;
  message: string;
}

function sanitizeQuery(query: ToolCallRecordsQuery): Record<string, string | number | boolean | undefined> {
  return {
    id: query.id?.trim() || undefined,
    toolName: query.toolName?.trim() || undefined,
    callerSignature: query.callerSignature?.trim() || undefined,
    callerType: query.callerType || undefined,
    status: query.status || undefined,
    success: query.success === "" ? undefined : query.success,
    from: query.from || undefined,
    to: query.to || undefined,
    search: query.search?.trim() || undefined,
    limit: query.limit,
    offset: query.offset,
    order: query.order,
    detail: query.detail,
  };
}

export const toolCallRecordsApi = {
  async getStatus(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ToolCallRecordsStoreStatus> {
    const response = await requestWithUi<ToolCallRecordsStatusResponse>(
      {
        url: "/admin_api/tool-call-records/status",
      },
      uiOptions
    );

    return response.store;
  },

  async getConfig(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ToolCallRecordsConfig> {
    const response = await requestWithUi<ToolCallRecordsConfigResponse>(
      {
        url: "/admin_api/tool-call-records/config",
      },
      uiOptions
    );

    return response.config;
  },

  async saveConfig(
    config: Partial<ToolCallRecordsConfig>,
    uiOptions: RequestUiOptions = {}
  ): Promise<ToolCallRecordsSaveConfigResponse> {
    return requestWithUi(
      {
        url: "/admin_api/tool-call-records/config",
        method: "POST",
        body: { config },
      },
      uiOptions
    );
  },

  async queryRecords(
    query: ToolCallRecordsQuery,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ToolCallRecordsListResponse> {
    return requestWithUi(
      {
        url: "/admin_api/tool-call-records",
        query: sanitizeQuery(query),
      },
      uiOptions
    );
  },

  async getRecord(
    id: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ToolCallRecord> {
    const response = await requestWithUi<ToolCallRecordDetailResponse>(
      {
        url: `/admin_api/tool-call-records/${encodeURIComponent(id)}`,
      },
      uiOptions
    );

    return response.record;
  },

  async cleanupExpired(
    uiOptions: RequestUiOptions = {}
  ): Promise<ToolCallRecordsCleanupResponse> {
    return requestWithUi(
      {
        url: "/admin_api/tool-call-records/cleanup-expired",
        method: "POST",
      },
      uiOptions
    );
  },

  async clearAll(
    uiOptions: RequestUiOptions = {}
  ): Promise<ToolCallRecordsClearResponse> {
    return requestWithUi(
      {
        url: "/admin_api/tool-call-records/clear-all",
        method: "POST",
        body: { confirm: true },
      },
      uiOptions
    );
  },
};