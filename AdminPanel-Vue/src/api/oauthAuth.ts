import type { HttpRequest } from "@/platform/http/httpClient";
import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";

export type OAuthProviderId = "codex_oauth" | "github_copilot";

export interface OAuthProviderInfo {
  id: OAuthProviderId;
  label: string;
  supportsRefresh: boolean;
}

export interface OAuthAccount {
  id: string;
  provider: OAuthProviderId;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
  tokenExpiresAt?: string | null;
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  metadata?: Record<string, unknown>;
}

export interface OAuthStatus {
  provider: OAuthProviderId;
  authenticated: boolean;
  defaultAccountId: string | null;
  accounts: OAuthAccount[];
}

export interface CodexResponsesProviderStatus {
  enabled: boolean;
  configuredProvider: string;
  accountId: string;
  upstreamBaseUrl?: string;
  clientVersion?: string;
  authenticated: boolean;
  defaultAccountId: string | null;
  configuredModelIds: string[];
  effectiveModelIds: string[];
  modelSource: "configured" | "built_in_fallback" | string;
  diagnostics?: CodexResponsesProviderDiagnostics;
}

export interface CodexResponsesProviderDiagnostics {
  generatedAt: string;
  checks: {
    providerEnabled: boolean;
    authenticated: boolean;
    accountConfigured: boolean;
    configuredAccountValid: boolean;
    hasEffectiveModels: boolean;
  };
  lastSmoke: CodexResponsesProviderSmokeSummary | null;
  recentTraces?: CodexOAuthTraceSummary[];
}

export interface CodexResponsesProviderSmokeSummary {
  checkedAt: string;
  ok: boolean;
  status: number;
  contentType: string;
  payloadKind: string;
  payloadKeys: string[];
  tokenExpiresAt?: string | null;
  errorCode: string | null;
  message: string;
}

export interface CodexOAuthTraceSummary {
  traceId: string;
  provider: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  ok: boolean | null;
  status: number | null;
  errorCode: string | null;
  message: string;
  metadata: {
    route?: string;
    method?: string;
    model?: string;
    stream?: boolean;
  };
  events: Array<{
    at: string;
    stage: string;
    status?: number;
    ok?: boolean;
    contentType?: string;
    model?: string;
    stream?: boolean;
    chunks?: number;
    timeoutMs?: number;
    transform?: string;
    errorName?: string;
    errorCode?: string;
    tokenExpiresAt?: string;
  }>;
}

export interface OAuthUpstreamSmokeResult {
  provider: OAuthProviderId;
  account: OAuthAccount;
  tokenExpiresAt?: string | null;
  upstream: {
    endpoint: string;
    status: number;
    ok: boolean;
    contentType: string;
    payload: {
      kind: string;
      keys: string[];
    };
  };
}

export interface OAuthLoginSession {
  sessionId: string;
  provider: OAuthProviderId;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type OAuthPollResult =
  | {
      status: "pending";
      retryAfterSeconds?: number;
    }
  | {
      status: "authenticated";
      account: OAuthAccount;
    };

interface ProvidersResponse {
  success: boolean;
  providers: OAuthProviderInfo[];
}

interface StatusResponse {
  success: boolean;
  status: OAuthStatus;
}

interface AccountsResponse {
  success: boolean;
  accounts: OAuthAccount[];
}

interface LoginStartResponse {
  success: boolean;
  login: OAuthLoginSession;
}

interface LoginPollResponse {
  success: boolean;
  result: OAuthPollResult;
}

interface ResponsesProviderStatusResponse {
  success: boolean;
  provider: CodexResponsesProviderStatus;
}

interface UpstreamSmokeResponse {
  success: boolean;
  smoke: OAuthUpstreamSmokeResult;
}

const API_BASE = "/admin_api/oauth-auth";

function request<TResponse, TBody = unknown>(
  httpRequest: HttpRequest<TBody>,
  uiOptions: RequestUiOptions = {}
): Promise<TResponse> {
  return requestWithUi<TResponse, TBody>(httpRequest, uiOptions);
}

export const oauthAuthApi = {
  async listProviders(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OAuthProviderInfo[]> {
    const response = await request<ProvidersResponse>(
      {
        url: `${API_BASE}/providers`,
        method: "GET",
        ...requestContext,
      },
      uiOptions
    );
    return response.providers;
  },

  async getStatus(
    provider: OAuthProviderId,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OAuthStatus> {
    const response = await request<StatusResponse>(
      {
        url: `${API_BASE}/${provider}/status`,
        method: "GET",
        ...requestContext,
      },
      uiOptions
    );
    return response.status;
  },

  async listAccounts(
    provider: OAuthProviderId,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OAuthAccount[]> {
    const response = await request<AccountsResponse>(
      {
        url: `${API_BASE}/${provider}/accounts`,
        method: "GET",
        ...requestContext,
      },
      uiOptions
    );
    return response.accounts;
  },

  async startLogin(
    provider: OAuthProviderId,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OAuthLoginSession> {
    const response = await request<LoginStartResponse>(
      {
        url: `${API_BASE}/${provider}/login/start`,
        method: "POST",
        ...requestContext,
      },
      uiOptions
    );
    return response.login;
  },

  async pollLogin(
    provider: OAuthProviderId,
    sessionId: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OAuthPollResult> {
    const response = await request<LoginPollResponse, { sessionId: string }>(
      {
        url: `${API_BASE}/${provider}/login/poll`,
        method: "POST",
        body: { sessionId },
        ...requestContext,
      },
      uiOptions
    );
    return response.result;
  },

  async setDefaultAccount(
    provider: OAuthProviderId,
    accountId: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OAuthAccount[]> {
    const response = await request<AccountsResponse>(
      {
        url: `${API_BASE}/${provider}/accounts/${encodeURIComponent(accountId)}/default`,
        method: "POST",
        ...requestContext,
      },
      uiOptions
    );
    return response.accounts;
  },

  async removeAccount(
    provider: OAuthProviderId,
    accountId: string,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OAuthAccount[]> {
    const response = await request<AccountsResponse>(
      {
        url: `${API_BASE}/${provider}/accounts/${encodeURIComponent(accountId)}`,
        method: "DELETE",
        ...requestContext,
      },
      uiOptions
    );
    return response.accounts;
  },

  async logout(
    provider: OAuthProviderId,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await request<{ success: boolean }>(
      {
        url: `${API_BASE}/${provider}/logout`,
        method: "POST",
        ...requestContext,
      },
      uiOptions
    );
  },

  async getCodexResponsesProviderStatus(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexResponsesProviderStatus> {
    const response = await request<ResponsesProviderStatusResponse>(
      {
        url: `${API_BASE}/codex_oauth/responses-provider/status`,
        method: "GET",
        ...requestContext,
      },
      uiOptions
    );
    return response.provider;
  },

  async enableCodexResponsesProvider(
    accountId?: string | null,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexResponsesProviderStatus> {
    const response = await request<ResponsesProviderStatusResponse, { accountId?: string }>(
      {
        url: `${API_BASE}/codex_oauth/responses-provider/enable`,
        method: "POST",
        body: accountId ? { accountId } : {},
        ...requestContext,
      },
      uiOptions
    );
    return response.provider;
  },

  async disableCodexResponsesProvider(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<CodexResponsesProviderStatus> {
    const response = await request<ResponsesProviderStatusResponse>(
      {
        url: `${API_BASE}/codex_oauth/responses-provider/disable`,
        method: "POST",
        ...requestContext,
      },
      uiOptions
    );
    return response.provider;
  },

  async smokeCodexUpstream(
    accountId?: string | null,
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = {}
  ): Promise<OAuthUpstreamSmokeResult> {
    const response = await request<UpstreamSmokeResponse, { accountId?: string }>(
      {
        url: `${API_BASE}/codex_oauth/upstream-smoke`,
        method: "POST",
        body: accountId ? { accountId } : {},
        ...requestContext,
      },
      uiOptions
    );
    return response.smoke;
  },
};
