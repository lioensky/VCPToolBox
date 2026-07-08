export interface SystemCpuTemperatureInfo {
  value: number;
  unit?: string;
  source?: string;
  sensorId?: string;
  updatedAt?: string;
}

export interface SystemCpuInfo {
  usage: number;
  cores?: number;
  model?: string;
  temperature?: SystemCpuTemperatureInfo | null;
}

export interface SystemMemorySnapshot {
  used: number;
  total: number;
  free?: number;
}

export interface SystemMemoryInfo extends SystemMemorySnapshot {
  usage: number;
}

export interface NodeProcessMemoryInfo {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  [key: string]: number;
}

export interface NodeProcessInfo {
  pid: number;
  memory: NodeProcessMemoryInfo;
  uptime: number;
  version: string;
  platform: string;
  arch: string;
  cpu?: number;
}

export interface SystemDiskInfo {
  used: number;
  total: number;
  usage: number;
}

export interface SystemResources {
  cpu: SystemCpuInfo;
  memory: SystemMemoryInfo;
  nodeProcess: NodeProcessInfo;
  disk?: SystemDiskInfo;
}

export interface RawSystemResources {
  cpu: SystemCpuInfo;
  memory: SystemMemorySnapshot;
  nodeProcess: NodeProcessInfo;
}

export interface RawSystemResourcesResponse {
  success?: boolean;
  system: RawSystemResources;
}

export interface PM2Process {
  pid: number;
  name: string;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  errors?: number;
}

export interface PM2ProcessesResponse {
  success?: boolean;
  processes?: PM2Process[];
}

export interface IndexStatsInfo {
  available?: boolean;
  totalVectors: number;
  [key: string]: unknown;
}

export interface KnowledgeBaseDiaryIndexMemoryItem {
  name: string;
  stats: IndexStatsInfo;
  estimatedBytes: number;
  lastUsedAt: number | null;
  idleMs: number | null;
  dateIndexItems: number;
}

export interface KnowledgeBaseMemoryProfile {
  module: string;
  initialized: boolean;
  dimension: number;
  rootPath: string;
  storePath: string;
  dbHealthState: string;
  databaseCorruptionDetected: boolean;
  queues: {
    pendingFiles: number;
    pendingDeletes: number;
    saveTimers: number;
    isProcessing: boolean;
    isProcessingDeletes: boolean;
  };
  tagIndex: {
    stats: IndexStatsInfo;
    estimatedBytes: number;
  };
  diaryIndices: {
    loadedCount: number;
    trackedCount: number;
    idleTtlMs: number;
    estimatedBytes: number;
    items: KnowledgeBaseDiaryIndexMemoryItem[];
  };
  caches: {
    diaryNameVectorCount: number;
    diaryNameVectorEstimatedBytes: number;
    diaryDateIndexCount: number;
    diaryDateIndexEstimatedBytes: number;
  };
  tagMemo: {
    available: boolean;
    modelSig?: string | null;
    pairwiseSimilarities?: number;
    pairwiseEstimatedBytes?: number;
    cooccurrenceSources?: number;
    cooccurrenceEdges?: number;
    cooccurrenceEstimatedBytes?: number;
    intrinsicResiduals?: number;
    intrinsicEstimatedBytes?: number;
    matrixRebuilding?: boolean;
    derivedQueueLength?: number;
    estimatedBytes: number;
  };
  estimatedBytes: number;
  generatedAt: string;
  elapsedMs: number;
}

export interface TdbKnowledgeLibraryMemoryItem {
  name: string;
  path: string;
  openedAt: number | null;
  lastUsedAt: number | null;
  idleMs: number | null;
  busyCount: number;
  diskSize: number;
  estimatedBytes: number;
  stats?: unknown;
}

export interface TdbKnowledgeMemoryProfile {
  module: string;
  enabled: boolean;
  initialized: boolean;
  dimension: number;
  rootPath: string;
  storePath: string;
  syncMode: string;
  idleUnloadHours: number;
  queues: {
    pending: number;
    retry: number;
    processing: number;
    failed: number;
    isProcessing: boolean;
    isQueueWorkerRunning: boolean;
    libraryQueues: number;
    fileEventVersions: number;
    pendingFileVersions: number;
    [key: string]: number | boolean;
  };
  libraries: {
    openedCount: number;
    estimatedBytes: number;
    items: TdbKnowledgeLibraryMemoryItem[];
  };
  metaDb: {
    open: boolean;
    estimatedBytes: number;
  };
  estimatedBytes: number;
  generatedAt: string;
  elapsedMs: number;
}

export interface MemoryProfile {
  estimatedBytes: number;
  processMemory: NodeProcessMemoryInfo;
  knowledgeBase: KnowledgeBaseMemoryProfile;
  tdbKnowledge: TdbKnowledgeMemoryProfile;
  note: string;
  generatedAt: string;
}

export interface MemoryProfileResponse {
  success?: boolean;
  profile: MemoryProfile;
}

export interface ServerLogResponse {
  content?: string;
  offset?: number;
  path?: string;
  fileSize?: number;
  needFullReload?: boolean;
}

export interface ServerLogQuery {
  incremental?: boolean;
  offset?: number;
}

export interface FinalContextAttachmentSummary {
  type: string;
  mediaType: string;
  filename?: string;
  tokenCount?: number;
  tokenMethod?: string;
  byteLength?: number;
}

export interface FinalContextBlockSummary {
  index: number;
  role: string;
  contentType: string;
  text: string;
  textLength: number;
  textTokenCount?: number;
  attachmentTokenCount?: number;
  tokenCount: number;
  tokenMethod?: string;
  attachments: FinalContextAttachmentSummary[];
  attachmentCounts?: Record<string, number>;
  parts?: Array<Record<string, unknown>>;
}

export interface FinalContextSnapshot {
  id?: number;
  capturedAt: string;
  metadata: Record<string, unknown>;
  body: Record<string, unknown> & {
    model?: string;
    stream?: boolean;
    messages?: unknown[];
  };
  summary: {
    model: string | null;
    stream: boolean;
    messageCount: number;
    totalTextLength: number;
    totalTextTokenCount?: number;
    totalAttachmentTokenCount?: number;
    totalTokenCount: number;
    tokenMethod?: string;
    roleCounts: Record<string, number>;
    blocks: FinalContextBlockSummary[];
  };
}

export interface FinalContextListItem {
  id: number;
  capturedAt: string;
  metadata: Record<string, unknown>;
  summary: {
    model: string | null;
    stream: boolean;
    messageCount: number;
    totalTokenCount: number;
    totalTextTokenCount?: number;
    totalAttachmentTokenCount?: number;
    tokenMethod?: string | null;
    roleCounts: Record<string, number>;
  };
}

export interface FinalContextResponse {
  available: boolean;
  message?: string;
  snapshot?: FinalContextSnapshot;
  list?: FinalContextListItem[];
  maxSnapshots?: number;
}

export interface FinalContextListResponse {
  success?: boolean;
  list: FinalContextListItem[];
  maxSnapshots: number;
}

export interface MultiModalConfig {
  MultiModalModel: string;
  MultiModalPrompt: string;
  MediaInsertPrompt: string;
  MultiModalModelOutputMaxTokens: number;
  MultiModalModelContent: number;
  MultiModalModelThinkingBudget: number;
  MultiModalModelAsynchronousLimit: number;
  MultiModalForceTranslateModels: string[];
}

export interface MultiModalConfigResponse {
  success?: boolean;
  config: MultiModalConfig;
  path?: string;
  watcherActive?: boolean;
  lastLoadError?: string | null;
  message?: string;
}

export interface OneRingConfig {
  enabled: boolean;
  tailTagPlacement: 'inline' | 'system_user_block';
  maxContextBlocks: number;
  timeInsert: boolean;
}

export interface BridgeHijackConfig {
  port: number;
  upstreamUrl: string;
  upstreamKey: string;
  upstreamType: 'chat' | 'anthropic' | 'gemini';
  defaultModel: string;
  systemPrompt: string;
  hijackMode: 'off' | 'replace' | 'prepend' | 'append' | 'merge';
  modelMap: Record<string, string>;
  debugMode: boolean;
  defaultProfile: string;
}

export interface BridgeProfile {
  name: string;
  displayName: string;
  systemPrompt: string;
  hijackMode: 'off' | 'replace' | 'prepend' | 'append' | 'merge';
  modelOverride: string;
  description: string;
}

export interface BridgeProfilesResponse {
  success?: boolean;
  profiles: BridgeProfile[];
  activeDefault: string;
  profilesDir: string;
  count: number;
  message?: string;
}

export interface BridgeProfileResponse {
  success?: boolean;
  profile: BridgeProfile;
  created?: boolean;
  message?: string;
}

export interface BridgeProfileDeleteResponse {
  success?: boolean;
  message?: string;
}

export interface BridgeProfileActivateResponse {
  success?: boolean;
  activeDefault: string;
  message?: string;
}

export interface OneRingConfigResponse {
  success?: boolean;
  config: OneRingConfig;
  raw?: Record<string, unknown>;
  path?: string;
  message?: string;
}

export interface OneRingConfigSaveResponse {
  success?: boolean;
  config: OneRingConfig;
  path?: string;
  message?: string;
}

export interface BridgeHijackConfigResponse {
  success?: boolean;
  config: BridgeHijackConfig;
  path?: string;
  description?: Partial<Record<keyof BridgeHijackConfig, string>>;
  message?: string;
}

export interface BridgeHijackConfigSaveResponse {
  success?: boolean;
  config: BridgeHijackConfig;
  path?: string;
  description?: Partial<Record<keyof BridgeHijackConfig, string>>;
  message?: string;
}

export interface SystemMonitorResponse {
  system: SystemResources;
  pm2?: PM2Process[];
}

export interface NotificationsConnectionInfo {
  vcpKey: string;
  port: number;
  hostname: string;
  wsUrl: string;
}

export interface NotificationsConnectionResponse {
  success?: boolean;
  connection: NotificationsConnectionInfo;
  error?: string;
}
