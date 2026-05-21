export interface SystemCpuInfo {
  usage: number;
  cores?: number;
  model?: string;
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
}

export interface FinalContextBlockSummary {
  index: number;
  role: string;
  contentType: string;
  text: string;
  textLength: number;
  tokenCount: number;
  tokenMethod?: string;
  attachments: FinalContextAttachmentSummary[];
  attachmentCounts?: Record<string, number>;
  parts?: Array<Record<string, unknown>>;
}

export interface FinalContextSnapshot {
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
    totalTokenCount: number;
    tokenMethod?: string;
    roleCounts: Record<string, number>;
    blocks: FinalContextBlockSummary[];
  };
}

export interface FinalContextResponse {
  available: boolean;
  message?: string;
  snapshot?: FinalContextSnapshot;
}

export interface SystemMonitorResponse {
  system: SystemResources;
  pm2?: PM2Process[];
}
