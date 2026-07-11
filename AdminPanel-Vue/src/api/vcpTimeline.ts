import { requestWithUi, type HttpRequestContext, type RequestUiOptions } from './requestWithUi'

export interface VcpTimelineConfig {
  enabled: boolean
  defaultExpandK: number
  defaultThreshold: number
  model: string
  maxContextTokens: number
  maxOutputTokens: number
  maxConcurrentTasks: number
  publicFolderPrefixes: string[]
  ignoreFolders: string[]
  summaryPrompt: string
}

export interface VcpTimelineStatus {
  agentName: string
  kind: 'timeline' | 'summary' | null
  running: boolean
  phase: string
  phaseLabel: string
  completed: number
  total: number
  startedAt: string | null
  updatedAt: string | null
  finishedAt: string | null
  error: string | null
}

export interface VcpTimelineFile {
  month: string
  name: string
  content: string
}

export interface VcpTimelineAgentDetail {
  agentName: string
  summaries: Record<string, string>
  files: VcpTimelineFile[]
  status: VcpTimelineStatus
}

interface ConfigResponse {
  success: boolean
  config: VcpTimelineConfig
  message?: string
}

interface AgentsResponse {
  success: boolean
  agents: string[]
}

interface DetailResponse {
  success: boolean
  detail: VcpTimelineAgentDetail
}

interface StatusResponse {
  success: boolean
  status: VcpTimelineStatus
}

interface TaskResponse {
  success: boolean
  accepted: boolean
  status: VcpTimelineStatus
}

const quiet: RequestUiOptions = { showLoader: false }

export const vcpTimelineApi = {
  getConfig(context: HttpRequestContext = {}, ui: RequestUiOptions = quiet) {
    return requestWithUi<ConfigResponse>({ url: '/admin_api/vcp-timeline/config', ...context }, ui)
  },

  saveConfig(config: VcpTimelineConfig, context: HttpRequestContext = {}, ui: RequestUiOptions = {}) {
    return requestWithUi<ConfigResponse>({
      url: '/admin_api/vcp-timeline/config',
      method: 'PUT',
      body: config,
      ...context,
    }, ui)
  },

  listAgents(context: HttpRequestContext = {}, ui: RequestUiOptions = quiet) {
    return requestWithUi<AgentsResponse>({ url: '/admin_api/vcp-timeline/agents', ...context }, ui)
  },

  getAgent(agentName: string, context: HttpRequestContext = {}, ui: RequestUiOptions = quiet) {
    return requestWithUi<DetailResponse>({
      url: `/admin_api/vcp-timeline/agents/${encodeURIComponent(agentName)}`,
      ...context,
    }, ui)
  },

  getStatus(agentName: string, context: HttpRequestContext = {}, ui: RequestUiOptions = quiet) {
    return requestWithUi<StatusResponse>({
      url: `/admin_api/vcp-timeline/agents/${encodeURIComponent(agentName)}/status`,
      ...context,
    }, ui)
  },

  saveFile(agentName: string, month: string, content: string, context: HttpRequestContext = {}, ui: RequestUiOptions = {}) {
    return requestWithUi<{ success: boolean; message?: string }>({
      url: `/admin_api/vcp-timeline/agents/${encodeURIComponent(agentName)}/files/${encodeURIComponent(month)}`,
      method: 'PUT',
      body: { content },
      ...context,
    }, ui)
  },

  saveSummary(agentName: string, month: string, summary: string, context: HttpRequestContext = {}, ui: RequestUiOptions = {}) {
    return requestWithUi<{ success: boolean; summaries: Record<string, string>; message?: string }>({
      url: `/admin_api/vcp-timeline/agents/${encodeURIComponent(agentName)}/summaries/${encodeURIComponent(month)}`,
      method: 'PUT',
      body: { summary },
      ...context,
    }, ui)
  },

  generateTimelines(agentName: string, options: { startMonth?: string; endMonth?: string; overwrite?: boolean }, context: HttpRequestContext = {}, ui: RequestUiOptions = {}) {
    return requestWithUi<TaskResponse>({
      url: `/admin_api/vcp-timeline/agents/${encodeURIComponent(agentName)}/generate-timelines`,
      method: 'POST',
      body: options,
      ...context,
    }, ui)
  },

  generateSummaries(agentName: string, options: { overwrite?: boolean }, context: HttpRequestContext = {}, ui: RequestUiOptions = {}) {
    return requestWithUi<TaskResponse>({
      url: `/admin_api/vcp-timeline/agents/${encodeURIComponent(agentName)}/generate-summaries`,
      method: 'POST',
      body: options,
      ...context,
    }, ui)
  },
}