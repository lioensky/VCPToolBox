import type { HttpRequest } from "@/platform/http/httpClient";
import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";

export type CodexImagegenStatus =
  | "pending"
  | "claimed"
  | "artifact_ready"
  | "done"
  | "failed"
  | "cancelled";

export interface CodexImagegenRequest {
  protocol?: string;
  request_id: string;
  parent_request_id?: string;
  created_at?: string;
  completed_at?: string;
  failed_at?: string;
  cancelled_at?: string;
  status: CodexImagegenStatus;
  directory_status?: CodexImagegenStatus;
  status_mismatch?: {
    directory_status: CodexImagegenStatus;
    file_status: string;
  };
  source?: string;
  mode?: "generate" | string;
  prompt?: string;
  options?: {
    size?: string;
    quality?: string;
    output_format?: string;
  };
  return?: {
    preferred?: string;
    target_dir?: string;
  };
  attempt?: number;
  idempotency_key?: string;
  claimed_by?: string;
  claimed_at?: string;
  claim_expires_at?: string;
  phase?: string;
  result?: {
    generated_by?: string;
    local_files?: string[];
    manual_save_required?: boolean;
    registered_by?: string;
    note?: string;
  };
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

export interface CodexImagegenCreateRequest {
  prompt: string;
  request_id?: string;
  idempotency_key?: string;
  mode?: "generate";
  options?: {
    size?: string;
    quality?: string;
    output_format?: string;
  };
  negative_prompt?: string;
  user_note?: string;
}

interface SingleRequestResponse {
  success: boolean;
  request: CodexImagegenRequest;
}

interface ListRequestsResponse {
  success: boolean;
  requests: CodexImagegenRequest[];
}

const API_BASE = "/admin_api/codex-imagegen/requests";

function request<TResponse, TBody = unknown>(
  httpRequest: HttpRequest<TBody>,
  uiOptions: RequestUiOptions = {}
): Promise<TResponse> {
  return requestWithUi<TResponse, TBody>(httpRequest, uiOptions);
}

export const codexImagegenRelayApi = {
  async createRequest(
    body: CodexImagegenCreateRequest,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexImagegenRequest> {
    const response = await request<SingleRequestResponse, CodexImagegenCreateRequest>(
      {
        url: API_BASE,
        method: "POST",
        body,
        ...requestContext,
      },
      uiOptions
    );
    return response.request;
  },

  async listRequests(
    params: { status?: CodexImagegenStatus | "all"; limit?: number } = {},
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexImagegenRequest[]> {
    const query: Record<string, string | number | undefined> = {
      limit: params.limit,
      status: params.status && params.status !== "all" ? params.status : undefined,
    };
    const response = await request<ListRequestsResponse>(
      {
        url: API_BASE,
        method: "GET",
        query,
        ...requestContext,
      },
      uiOptions
    );
    return response.requests;
  },

  async getRequest(
    requestId: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexImagegenRequest> {
    const response = await request<SingleRequestResponse>(
      {
        url: `${API_BASE}/${encodeURIComponent(requestId)}`,
        method: "GET",
        ...requestContext,
      },
      uiOptions
    );
    return response.request;
  },

  async cancelRequest(
    requestId: string,
    reason = "",
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexImagegenRequest> {
    const response = await request<SingleRequestResponse, { reason?: string }>(
      {
        url: `${API_BASE}/${encodeURIComponent(requestId)}/cancel`,
        method: "POST",
        body: { reason },
        ...requestContext,
      },
      uiOptions
    );
    return response.request;
  },

  async retryRequest(
    requestId: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexImagegenRequest> {
    const response = await request<SingleRequestResponse>(
      {
        url: `${API_BASE}/${encodeURIComponent(requestId)}/retry`,
        method: "POST",
        ...requestContext,
      },
      uiOptions
    );
    return response.request;
  },

  async markSaved(
    requestId: string,
    localFiles: string[],
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexImagegenRequest> {
    const response = await request<SingleRequestResponse, { local_files: string[] }>(
      {
        url: `${API_BASE}/${encodeURIComponent(requestId)}/mark-saved`,
        method: "POST",
        body: { local_files: localFiles },
        ...requestContext,
      },
      uiOptions
    );
    return response.request;
  },

  async failStaleClaim(
    requestId: string,
    message = "",
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexImagegenRequest> {
    const response = await request<SingleRequestResponse, { message?: string }>(
      {
        url: `${API_BASE}/${encodeURIComponent(requestId)}/fail-stale-claim`,
        method: "POST",
        body: { message },
        ...requestContext,
      },
      uiOptions
    );
    return response.request;
  },
};

