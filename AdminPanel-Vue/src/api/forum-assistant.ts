import { HttpError } from "@/platform/http/errors";
import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export type ForumAssistantTaskType = "forum_patrol" | "custom_prompt";
export type ForumAssistantScheduleMode = "interval" | "manual" | "once" | "cron";

export interface ForumAssistantTaskSchedule {
  mode: ForumAssistantScheduleMode;
  intervalMinutes: number;
  runAt: string | null;
  cronValue: string | null;
  jitterSeconds: number;
}

export interface ForumAssistantTaskDispatch {
  channel: string;
  temporaryContact: boolean;
  injectTools: string[];
  maid: string;
  taskDelegation: boolean;
}

export interface ForumAssistantTaskPayload {
  promptTemplate: string;
  availablePlaceholders: string[];
  includeForumPostList?: boolean;
  forumListPlaceholder?: string;
  maxPosts?: number;
}

export interface ForumAssistantTaskRuntime {
  running: boolean;
  lastRunTime: string | null;
  lastFinishTime: string | null;
  lastResult: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runCount: number;
  successCount: number;
  errorCount: number;
  nextRunTime: string | null;
}

export interface ForumAssistantTask {
  id: string;
  name: string;
  type: ForumAssistantTaskType;
  enabled: boolean;
  schedule: ForumAssistantTaskSchedule;
  targets: {
    agents: string[];
  };
  dispatch: ForumAssistantTaskDispatch;
  payload: ForumAssistantTaskPayload;
  runtime: ForumAssistantTaskRuntime;
  meta: {
    createdAt: string | null;
    updatedAt: string | null;
  };
}

export interface ForumAssistantTaskTypeOption {
  type: string;
  label: string;
  description: string;
}

export interface ForumAssistantConfigData {
  globalEnabled: boolean;
  settings: {
    maxHistory: number;
  };
  tasks: ForumAssistantTask[];
}

export interface ForumAssistantConfigResponse {
  config: ForumAssistantConfigData;
  availableTaskTypes: ForumAssistantTaskTypeOption[];
  taskTemplates: Record<string, ForumAssistantTask>;
}

export interface ForumAssistantHistoryItem {
  id: string;
  taskId: string;
  taskName: string;
  type: string;
  triggerSource: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  status: string;
  agents: string[];
  message: string;
}

export interface ForumAssistantStatusTask {
  id: string;
  name: string;
  type: ForumAssistantTaskType;
  enabled: boolean;
  schedule: ForumAssistantTaskSchedule;
  runtime: ForumAssistantTaskRuntime;
  targets: {
    agents: string[];
  };
}

export interface ForumAssistantStatus {
  globalEnabled: boolean;
  activeTimerCount: number;
  activeTimers: string[];
  tasks: ForumAssistantStatusTask[];
  history: ForumAssistantHistoryItem[];
}

export interface ForumAssistantSaveConfigPayload {
  globalEnabled: boolean;
  settings: {
    maxHistory: number;
  };
  tasks: Array<{
    id?: string;
    name: string;
    type: string;
    enabled: boolean;
    schedule: ForumAssistantTaskSchedule;
    targets: {
      agents: string[];
    };
    dispatch: ForumAssistantTaskDispatch;
    payload: ForumAssistantTaskPayload;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asString(item).trim())
    .filter(Boolean);
}

function normalizeTaskType(value: unknown): ForumAssistantTaskType {
  return value === "custom_prompt" ? "custom_prompt" : "forum_patrol";
}

function normalizeScheduleMode(value: unknown): ForumAssistantScheduleMode {
  if (value === "manual" || value === "once" || value === "cron") {
    return value;
  }

  return "interval";
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (!isRecord(payload)) {
    return {} as T;
  }

  if (payload.success === false) {
    throw new HttpError(
      asString(payload.error) || asString(payload.message) || "Request failed"
    );
  }

  if ("data" in payload && payload.data !== undefined) {
    return payload.data as T;
  }

  return payload as T;
}

async function requestForumAssistant<T>(
  request: {
    url: string;
    method?: "GET" | "POST";
    body?: unknown;
  },
  uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
): Promise<T> {
  const payload = await requestWithUi<unknown>(
    {
      ...request,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    uiOptions
  );

  return unwrapEnvelope<T>(payload);
}

function normalizeSchedule(value: unknown): ForumAssistantTaskSchedule {
  const record = isRecord(value) ? value : {};

  return {
    mode: normalizeScheduleMode(record.mode),
    intervalMinutes: Math.max(asInteger(record.intervalMinutes, 60), 10),
    runAt: asNullableString(record.runAt),
    cronValue: asNullableString(record.cronValue),
    jitterSeconds: Math.max(asInteger(record.jitterSeconds, 0), 0),
  };
}

function normalizeDispatch(value: unknown): ForumAssistantTaskDispatch {
  const record = isRecord(value) ? value : {};
  const injectTools = asStringArray(record.injectTools);

  return {
    channel: asString(record.channel, "AgentAssistant") || "AgentAssistant",
    temporaryContact: record.temporaryContact !== false,
    injectTools: injectTools.length > 0 ? injectTools : ["VCPForum"],
    maid: asString(record.maid, "VCP系统") || "VCP系统",
    taskDelegation: record.taskDelegation === true,
  };
}

function normalizePayload(
  value: unknown,
  type: ForumAssistantTaskType
): ForumAssistantTaskPayload {
  const record = isRecord(value) ? value : {};
  const availablePlaceholders = asStringArray(record.availablePlaceholders);

  if (type === "custom_prompt") {
    return {
      promptTemplate: asString(record.promptTemplate),
      availablePlaceholders,
    };
  }

  return {
    promptTemplate: asString(record.promptTemplate),
    availablePlaceholders:
      availablePlaceholders.length > 0
        ? availablePlaceholders
        : ["{{forum_post_list}}"],
    includeForumPostList: record.includeForumPostList !== false,
    forumListPlaceholder:
      asString(record.forumListPlaceholder, "{{forum_post_list}}") ||
      "{{forum_post_list}}",
    maxPosts: Math.max(asInteger(record.maxPosts, 200), 1),
  };
}

function normalizeRuntime(value: unknown): ForumAssistantTaskRuntime {
  const record = isRecord(value) ? value : {};
  const lastDurationMs =
    record.lastDurationMs == null ? null : asInteger(record.lastDurationMs, 0);

  return {
    running: record.running === true,
    lastRunTime: asNullableString(record.lastRunTime),
    lastFinishTime: asNullableString(record.lastFinishTime),
    lastResult: asNullableString(record.lastResult),
    lastError: asNullableString(record.lastError),
    lastDurationMs,
    runCount: Math.max(asInteger(record.runCount, 0), 0),
    successCount: Math.max(asInteger(record.successCount, 0), 0),
    errorCount: Math.max(asInteger(record.errorCount, 0), 0),
    nextRunTime: asNullableString(record.nextRunTime),
  };
}

function normalizeTask(value: unknown): ForumAssistantTask {
  const record = isRecord(value) ? value : {};
  const targets = isRecord(record.targets) ? record.targets : {};
  const meta = isRecord(record.meta) ? record.meta : {};
  const type = normalizeTaskType(record.type);

  return {
    id: asString(record.id),
    name: asString(record.name),
    type,
    enabled: record.enabled !== false,
    schedule: normalizeSchedule(record.schedule),
    targets: {
      agents: asStringArray(targets.agents),
    },
    dispatch: normalizeDispatch(record.dispatch),
    payload: normalizePayload(record.payload, type),
    runtime: normalizeRuntime(record.runtime),
    meta: {
      createdAt: asNullableString(meta.createdAt),
      updatedAt: asNullableString(meta.updatedAt),
    },
  };
}

function normalizeTaskTypeOption(value: unknown): ForumAssistantTaskTypeOption | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = asString(value.type).trim();
  if (!type) {
    return null;
  }

  return {
    type,
    label: asString(value.label, type),
    description: asString(value.description),
  };
}

function normalizeConfigResponse(value: unknown): ForumAssistantConfigResponse {
  const record = isRecord(value) ? value : {};
  const config = isRecord(record.config) ? record.config : {};
  const settings = isRecord(config.settings) ? config.settings : {};
  const tasks = Array.isArray(config.tasks) ? config.tasks : [];
  const availableTaskTypes = Array.isArray(record.availableTaskTypes)
    ? record.availableTaskTypes
    : [];
  const taskTemplates = isRecord(record.taskTemplates) ? record.taskTemplates : {};

  const normalizedTaskTemplates = Object.fromEntries(
    Object.entries(taskTemplates)
      .filter(([, task]) => isRecord(task))
      .map(([key, task]) => [key, normalizeTask(task)])
  );

  return {
    config: {
      globalEnabled: config.globalEnabled === true,
      settings: {
        maxHistory: Math.max(asInteger(settings.maxHistory, 200), 20),
      },
      tasks: tasks.map((task) => normalizeTask(task)),
    },
    availableTaskTypes: availableTaskTypes
      .map((item) => normalizeTaskTypeOption(item))
      .filter((item): item is ForumAssistantTaskTypeOption => item !== null),
    taskTemplates: normalizedTaskTemplates,
  };
}

function normalizeStatusTask(value: unknown): ForumAssistantStatusTask {
  const task = normalizeTask(value);

  return {
    id: task.id,
    name: task.name,
    type: task.type,
    enabled: task.enabled,
    schedule: task.schedule,
    runtime: task.runtime,
    targets: task.targets,
  };
}

function normalizeHistoryItem(value: unknown): ForumAssistantHistoryItem | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: asString(value.id),
    taskId: asString(value.taskId),
    taskName: asString(value.taskName),
    type: asString(value.type),
    triggerSource: asString(value.triggerSource),
    startedAt: asNullableString(value.startedAt),
    finishedAt: asNullableString(value.finishedAt),
    durationMs: value.durationMs == null ? null : asInteger(value.durationMs, 0),
    status: asString(value.status),
    agents: asStringArray(value.agents),
    message: asString(value.message),
  };
}

function normalizeStatus(value: unknown): ForumAssistantStatus {
  const record = isRecord(value) ? value : {};
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const history = Array.isArray(record.history) ? record.history : [];

  return {
    globalEnabled: record.globalEnabled === true,
    activeTimerCount: Math.max(asInteger(record.activeTimerCount, 0), 0),
    activeTimers: asStringArray(record.activeTimers),
    tasks: tasks.map((task) => normalizeStatusTask(task)),
    history: history
      .map((item) => normalizeHistoryItem(item))
      .filter((item): item is ForumAssistantHistoryItem => item !== null),
  };
}

export const forumAssistantApi = {
  async getConfig(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ForumAssistantConfigResponse> {
    const response = await requestForumAssistant<unknown>(
      {
        url: "/admin_api/task-assistant/config",
        method: "GET",
      },
      uiOptions
    );

    return normalizeConfigResponse(response);
  },

  async saveConfig(
    payload: ForumAssistantSaveConfigPayload,
    uiOptions: RequestUiOptions = {}
  ): Promise<{ success: boolean; message: string }> {
    const response = await requestForumAssistant<unknown>(
      {
        url: "/admin_api/task-assistant/config",
        method: "POST",
        body: payload,
      },
      uiOptions
    );

    const record = isRecord(response) ? response : {};
    return {
      success: record.success !== false,
      message: asString(record.message, "任务派发中心配置已保存"),
    };
  },

  async getStatus(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ForumAssistantStatus> {
    const response = await requestForumAssistant<unknown>(
      {
        url: "/admin_api/task-assistant/status",
        method: "GET",
      },
      uiOptions
    );

    return normalizeStatus(response);
  },

  async triggerTask(
    taskId: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<{ success: boolean; message: string }> {
    const response = await requestForumAssistant<unknown>(
      {
        url: "/admin_api/task-assistant/trigger",
        method: "POST",
        body: { taskId },
      },
      uiOptions
    );

    const record = isRecord(response) ? response : {};
    return {
      success: record.success !== false,
      message: asString(record.message, "任务已触发"),
    };
  },
};
