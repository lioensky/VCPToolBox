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
  agents?: AgentAssistantConfigAgent[];
}

export interface SaveAgentAssistantConfigPayload {
  maxHistoryRounds: number;
  contextTtlHours: number;
  globalSystemPrompt: string;
  agents: AgentAssistantConfigAgent[];
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
