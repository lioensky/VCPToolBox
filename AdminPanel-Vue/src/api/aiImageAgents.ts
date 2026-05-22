import type { HttpRequest } from "@/platform/http/httpClient";
import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";

export interface AiImageDryRunRequest {
  pipelineId: string;
  taskId: string;
  plan: Record<string, unknown>;
}

export interface AiImageDryRunResult {
  ok: boolean;
  mode: string;
  status: string;
  state: Record<string, unknown> | null;
  safety: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
  error: string | null;
}

export interface AiImageExecuteImage {
  stepIndex?: number;
  plugin?: string;
  prompt?: string;
  url?: string;
  path?: string;
  filename?: string;
}

export interface AiImageExecuteResponse {
  ok: boolean;
  mode?: string;
  result?: {
    ok?: boolean;
    status?: string;
    mode?: string;
    images?: AiImageExecuteImage[];
    errors?: string[];
    audit?: unknown;
    state?: unknown;
    safety?: unknown;
    error?: string;
  };
  error?: string;
  message?: string;
}

function buildDryRunRequest(
  body: AiImageDryRunRequest,
  requestContext: HttpRequestContext = {}
): HttpRequest {
  return {
    url: "/admin_api/ai-image-agents/dry-run",
    method: "POST",
    body,
    ...requestContext,
  };
}

function buildExecuteRequest(
  body: {
    pipelineId: string;
    taskId: string;
    plan: unknown;
    dryRun: false;
    confirm: true;
    operator: string;
  },
  requestContext: HttpRequestContext = {}
): HttpRequest {
  return {
    url: "/admin_api/ai-image-agents/execute",
    method: "POST",
    body,
    ...requestContext,
  };
}

export const aiImageAgentsApi = {
  async dryRun(
    body: AiImageDryRunRequest,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<AiImageDryRunResult> {
    return requestWithUi<AiImageDryRunResult>(
      buildDryRunRequest(body, requestContext),
      uiOptions
    );
  },

  async execute(
    pipelineId: string,
    taskId: string,
    plan: unknown,
    operator: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<AiImageExecuteResponse> {
    return requestWithUi<AiImageExecuteResponse>(
      buildExecuteRequest(
        {
          pipelineId,
          taskId,
          plan,
          dryRun: false as const,
          confirm: true as const,
          operator,
        },
        requestContext
      ),
      uiOptions
    );
  },
};
