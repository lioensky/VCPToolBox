import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface CodexMemoryOverviewQuery {
  auditWindow?: number;
  limit?: number;
}

export interface CodexMemoryPaths {
  auditLogPath: string;
  recallLogPath: string;
  processDiaryPath: string;
  knowledgeDiaryPath: string;
}

export interface CodexMemoryWriteSummary {
  sampleSize: number;
  accepted: number;
  rejected: number;
  processAccepted: number;
  knowledgeAccepted: number;
  processRejected: number;
  knowledgeRejected: number;
  blockedDirectWrites: number;
  sensitiveRejected: number;
  latestAcceptedAt: string | null;
  latestRejectedAt: string | null;
}

export interface CodexMemoryAuditEntry {
  timestamp: string | null;
  decision: string;
  target: "process" | "knowledge" | string | null;
  title: string | null;
  memoryId: string | null;
  reason: string;
  filePath: string | null;
  agentAlias: string | null;
  agentId: string | null;
}

export interface CodexMemoryReasonBucket {
  reason: string;
  count: number;
}

export interface CodexMemoryRecentFile {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
}

export interface CodexMemoryLink {
  memoryId: string | null;
  title: string;
  target: "process" | "knowledge" | string | null;
  filePath: string | null;
  writtenAt: string | null;
  recallCount: number;
  cacheRecallCount: number;
  lastRecallAt: string | null;
  lastTopScore: number | null;
}

export interface CodexAdaptiveConfig {
  enabled: boolean;
  targetHitRate: number;
  minWritesBeforeAdjust: number;
  lowScoreThreshold: number;
  maxThresholdDrop: number;
  maxTagWeightBoost: number;
  maxKBoost: number;
  maxTruncationBoost: number;
  thresholdDropScale: number;
  tagWeightBoostScale: number;
  truncationBoostScale: number;
  scoreThresholdScale: number;
  scoreTagWeightScale: number;
  scoreTruncationScale: number;
  kBoostStep: number;
  tagContributionLimit: number;
  profileWindow: number;
  profileBytes: number;
}

export interface CodexAdaptiveDiaryProfile {
  dbName: string;
  target: "process" | "knowledge" | string;
  enabled: boolean;
  writeCount: number;
  totalHits: number;
  snippetHits: number;
  fullTextHits: number;
  directHits: number;
  cacheHits: number;
  avgTopScore: number | null;
  hitRate: number;
  thresholdDelta: number;
  tagWeightDelta: number;
  kDelta: number;
  truncationDelta: number;
  lowScorePenalty: number;
  lastWriteAt: string | null;
  lastHitAt: string | null;
  status: "disabled" | "warming" | "steady" | "boosted" | string;
  reasons: string[];
}

export interface CodexAdaptiveTagContribution {
  dbName: string;
  target: "process" | "knowledge" | string;
  tag: string;
  hitCount: number;
  matchedHitCount: number;
  coreHitCount: number;
  cacheHits: number;
  avgTopScore: number | null;
  latestHitAt: string | null;
  uniqueMemoryCount: number;
}

export interface CodexAdaptiveTagContributionByDiary {
  dbName: string;
  target: "process" | "knowledge" | string;
  tags: CodexAdaptiveTagContribution[];
}

export interface CodexAdaptiveState {
  config: CodexAdaptiveConfig;
  profiles: CodexAdaptiveDiaryProfile[];
  tagContribution: {
    flat: CodexAdaptiveTagContribution[];
    byDiary: CodexAdaptiveTagContributionByDiary[];
  };
  paths: {
    recallLogPath: string;
    writeLogPath: string;
  };
}

export interface CodexMemoryRecallSummary {
  sampleSize: number;
  totalHits: number;
  processHits: number;
  knowledgeHits: number;
  snippetHits: number;
  fullTextHits: number;
  directHits: number;
  cacheHits: number;
  latestHitAt: string | null;
  latestProcessHitAt: string | null;
  latestKnowledgeHitAt: string | null;
}

export interface CodexMemoryRecallEntry {
  timestamp: string | null;
  dbName: string | null;
  target: "process" | "knowledge" | string | null;
  recallType: string;
  resultCount: number;
  topScore: number | null;
  topMemoryId: string | null;
  topMatchedTags: string[];
  matchedTags: string[];
  coreTags: string[];
  topSourceFile: string | null;
  memoryIds: string[];
  fromCache: boolean;
  sourceKinds: string[];
  sourceFiles: string[];
}

export interface CodexMemoryRecallState {
  available: boolean;
  status: "enabled" | "active" | string;
  message: string;
  summary: CodexMemoryRecallSummary;
  recent: CodexMemoryRecallEntry[];
}

export interface CodexMemoryOverview {
  paths: CodexMemoryPaths;
  summary: CodexMemoryWriteSummary;
  recentAudit: CodexMemoryAuditEntry[];
  rejectionReasons: CodexMemoryReasonBucket[];
  recentFiles: {
    process: CodexMemoryRecentFile[];
    knowledge: CodexMemoryRecentFile[];
  };
  memoryLinks: CodexMemoryLink[];
  adaptive: CodexAdaptiveState;
  recall: CodexMemoryRecallState;
}

function toOverviewQuery(
  query: CodexMemoryOverviewQuery
): Record<string, string | number | boolean | undefined> {
  return {
    auditWindow: query.auditWindow,
    limit: query.limit,
  };
}

export const codexMemoryApi = {
  async getOverview(
    query: CodexMemoryOverviewQuery = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<CodexMemoryOverview> {
    return requestWithUi<CodexMemoryOverview>(
      {
        url: "/admin_api/codex-memory/overview",
        query: toOverviewQuery(query),
      },
      uiOptions
    );
  },
};
