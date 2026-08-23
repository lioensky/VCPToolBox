import { requestWithUi, type RequestUiOptions } from "./requestWithUi";

const READ_OPTIONS: RequestUiOptions = { showLoader: false };

export type ChangeProposalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "applying"
  | "applied"
  | "failed"
  | "stale";

export interface ChangeProposalConfig {
  requireUserApproval: boolean;
}

export interface ChangeProposalDiff {
  unified?: string;
  additions?: number;
  deletions?: number;
  changedLines?: number;
}

export interface ChangeProposal {
  proposalId: string;
  sourcePlugin?: string;
  command?: string;
  agentName?: string;
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
  operationType?: string;
  path?: string;
  beforeExists?: boolean;
  beforeHash?: string | null;
  afterHash?: string;
  beforeSize?: number;
  afterSize?: number;
  encoding?: string;
  approvalMode?: "manual" | "auto";
  approvalSource?: string | null;
  status: ChangeProposalStatus;
  rejectionReason?: string;
  errorMessage?: string;
  result?: Record<string, unknown> | null;
  diff?: ChangeProposalDiff | null;
  beforeContent?: string;
  afterContent?: string;
  snapshotReadError?: string;
  archived?: boolean;
  archivedAt?: string | null;
}

interface ConfigResponse {
  config: ChangeProposalConfig;
}

interface ListResponse {
  proposals?: ChangeProposal[];
}

interface ProposalResponse {
  proposal: ChangeProposal;
  message?: string;
}

interface DeleteProposalResponse {
  result: {
    proposalId: string;
    status: "deleted";
  };
  message?: string;
}

export const changeProposalsApi = {
  async getConfig(
    uiOptions: RequestUiOptions = READ_OPTIONS
  ): Promise<ChangeProposalConfig> {
    const response = await requestWithUi<ConfigResponse>(
      { url: "/admin_api/change-proposals/config" },
      uiOptions
    );
    return response.config;
  },

  async saveConfig(
    config: ChangeProposalConfig,
    uiOptions: RequestUiOptions = {}
  ): Promise<ChangeProposalConfig> {
    const response = await requestWithUi<ConfigResponse>(
      {
        url: "/admin_api/change-proposals/config",
        method: "POST",
        body: { config },
      },
      uiOptions
    );
    return response.config;
  },

  async list(
    query: {
      status?: string;
      sourcePlugin?: string;
      search?: string;
      archived?: boolean | "all";
    } = {},
    uiOptions: RequestUiOptions = READ_OPTIONS
  ): Promise<ChangeProposal[]> {
    const params = new URLSearchParams();
    if (query.status && query.status !== "all") params.set("status", query.status);
    if (query.sourcePlugin && query.sourcePlugin !== "all") {
      params.set("sourcePlugin", query.sourcePlugin);
    }
    if (query.search) params.set("search", query.search);
    if (query.archived !== undefined && query.archived !== "all") {
      params.set("archived", query.archived ? "true" : "false");
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const response = await requestWithUi<ListResponse>(
      { url: `/admin_api/change-proposals${suffix}` },
      uiOptions
    );
    return Array.isArray(response.proposals) ? response.proposals : [];
  },

  async get(
    proposalId: string,
    uiOptions: RequestUiOptions = READ_OPTIONS
  ): Promise<ChangeProposal> {
    const response = await requestWithUi<ProposalResponse>(
      { url: `/admin_api/change-proposals/${encodeURIComponent(proposalId)}` },
      uiOptions
    );
    return response.proposal;
  },

  async approve(
    proposalId: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<ProposalResponse> {
    return requestWithUi<ProposalResponse>(
      {
        url: `/admin_api/change-proposals/${encodeURIComponent(proposalId)}/approve`,
        method: "POST",
        body: { reviewer: "admin" },
      },
      uiOptions
    );
  },

  async reject(
    proposalId: string,
    reason: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<ProposalResponse> {
    return requestWithUi<ProposalResponse>(
      {
        url: `/admin_api/change-proposals/${encodeURIComponent(proposalId)}/reject`,
        method: "POST",
        body: { reason, reviewer: "admin" },
      },
      uiOptions
    );
  },

  async delete(
    proposalId: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<DeleteProposalResponse> {
    return requestWithUi<DeleteProposalResponse>(
      {
        url: `/admin_api/change-proposals/${encodeURIComponent(proposalId)}`,
        method: "DELETE",
      },
      uiOptions
    );
  },

  async archive(
    proposalId: string,
    archived = true,
    uiOptions: RequestUiOptions = {}
  ): Promise<ProposalResponse> {
    return requestWithUi<ProposalResponse>(
      {
        url: `/admin_api/change-proposals/${encodeURIComponent(proposalId)}/archive`,
        method: "POST",
        body: { archived },
      },
      uiOptions
    );
  },
};
