import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export type DreamOperationAction = "approve" | "reject";

export interface DreamOperationSummary {
  type?: string;
  status?: string;
}

export interface DreamLogSummary {
  filename: string;
  agentName?: string;
  timestamp?: string;
  operationCount?: number;
  pendingCount?: number;
  operationSummary?: DreamOperationSummary[];
}

export interface RawDreamOperation {
  operationId?: string | number;
  id?: string | number;
  type?: string;
  status?: string;
  targetDiary?: string;
  sourceDiaries?: string[];
  sourceContents?: Record<string, string>;
  newContent?: string;
  insightContent?: string;
  targetContent?: string;
  referenceDiaries?: string[];
  reason?: string;
  reviewedAt?: string;
  suggestedMaid?: string;
  suggestedDate?: string;
  error?: string;
  result?: unknown;
}

export interface RawDreamDetail {
  agentName?: string;
  timestamp?: string;
  dreamNarrative?: string;
  operations?: RawDreamOperation[];
}

interface DreamLogsResponse {
  logs?: DreamLogSummary[];
}

export interface ReviewDreamOperationResponse {
  status?: string;
  message?: string;
  operation?: RawDreamOperation;
}

export const dreamApi = {
  async getDreamLogSummaries(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<DreamLogSummary[]> {
    const response = await requestWithUi<DreamLogsResponse>(
      {
        url: "/admin_api/dream-logs",
      },
      uiOptions
    );
    return Array.isArray(response.logs) ? response.logs : [];
  },

  async getDreamLogDetail(
    filename: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<RawDreamDetail> {
    return requestWithUi(
      {
        url: `/admin_api/dream-logs/${encodeURIComponent(filename)}`,
      },
      uiOptions
    );
  },

  async reviewDreamOperation(
    filename: string,
    operationId: string,
    action: DreamOperationAction,
    uiOptions: RequestUiOptions = {}
  ): Promise<ReviewDreamOperationResponse> {
    return requestWithUi(
      {
        url: `/admin_api/dream-logs/${encodeURIComponent(filename)}/operations/${encodeURIComponent(operationId)}`,
        method: "POST",
        body: { action },
      },
      uiOptions
    );
  },
};

