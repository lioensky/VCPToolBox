/**
 * Agent assistant and agent file management API types.
 */

export interface AgentAssistantConfigAgent {
  chineseName?: string;
  baseName?: string;
  modelId?: string;
  description?: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface AgentAssistantConfigResponse {
  globalSystemPrompt?: string;
  maxHistoryRounds?: number | string;
  contextTtlHours?: number | string;
  delegationMaxRounds?: number | string;
  delegationTimeout?: number | string;
  delegationSystemPrompt?: string;
  delegationHeartbeatPrompt?: string;
  agents?: AgentAssistantConfigAgent[];
}

export interface SaveAgentAssistantConfigPayload {
  maxHistoryRounds: number;
  contextTtlHours: number;
  globalSystemPrompt: string;
  delegationMaxRounds: number;
  delegationTimeout: number;
  delegationSystemPrompt: string;
  delegationHeartbeatPrompt: string;
  agents: AgentAssistantConfigAgent[];
}

export interface AgentAssistantDelegationTask {
  id: string;
  status: "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled" | string;
  agentName?: string;
  agentBaseName?: string;
  senderName?: string;
  currentRound?: number;
  maxRounds?: number;
  startTime?: number;
  updatedAt?: number;
  endTime?: number | null;
  elapsedMs?: number;
  taskPromptPreview?: string;
  lastResponsePreview?: string;
  lastHeartbeatDelaySeconds?: number;
  cancelRequested?: boolean;
  completionStatus?: string | null;
  finalReportPreview?: string;
  archivePath?: string | null;
}

export interface AgentAssistantDelegationsResponse {
  active: AgentAssistantDelegationTask[];
  recent: AgentAssistantDelegationTask[];
}

export interface CancelAgentAssistantDelegationResponse {
  success: boolean;
  message: string;
  task?: AgentAssistantDelegationTask;
}

export interface AgentMapResponse {
  [agentName: string]: string;
}

export interface AgentScoreHistoryEntry {
  pointsDelta?: number;
  reason?: string;
  time?: string;
}

export interface AgentScoreSummary {
  baseName: string;
  name: string;
  totalPoints: number;
  history: AgentScoreHistoryEntry[];
}

export type AgentInfo = AgentAssistantConfigAgent;
export type AgentConfigResponse = AgentAssistantConfigResponse;
