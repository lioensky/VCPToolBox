<template>
  <section class="config-section active-section forum-assistant-view">
    <p class="description">
      这里用于配置任务派发中心。你可以为一个或多个 Agent 预设任务，按间隔执行、一次性执行，
      或仅保留为手动触发任务。
    </p>

    <section class="card toolbar-card">
      <div class="toolbar-row">
        <label class="switch-row">
          <input v-model="globalEnabled" type="checkbox" />
          <span>启用任务派发中心</span>
        </label>

        <label class="field compact-field">
          <span>保留历史条数</span>
          <input v-model.number="maxHistory" type="number" min="20" step="1" />
        </label>
      </div>

      <div class="toolbar-actions">
        <button
          type="button"
          class="btn-secondary"
          :disabled="isLoading || isSaving"
          @click="refreshAll(true)"
        >
          {{ isLoading ? "刷新中…" : "刷新配置" }}
        </button>
        <button
          type="button"
          class="btn-success"
          :disabled="isLoading || isSaving"
          @click="saveConfig"
        >
          {{ isSaving ? "保存中…" : "保存任务配置" }}
        </button>
      </div>

      <p
        v-if="statusMessage"
        :class="['status-message', statusType]"
        role="status"
        aria-live="polite"
      >
        {{ statusMessage }}
      </p>
    </section>

    <section class="status-grid">
      <article class="card status-card">
        <div class="card-header">
          <h3 class="card-title">运行状态</h3>
        </div>

        <div class="status-metrics">
          <div class="metric">
            <span class="metric-label">当前状态</span>
            <span
              class="status-badge"
              :class="runtimeStatus?.globalEnabled ? 'status-enabled' : 'status-disabled'"
            >
              {{ runtimeStatus?.globalEnabled ? "运行中" : "已停止" }}
            </span>
          </div>
          <div class="metric">
            <span class="metric-label">任务总数</span>
            <strong>{{ taskDrafts.length }}</strong>
          </div>
          <div class="metric">
            <span class="metric-label">活跃定时器</span>
            <strong>{{ runtimeStatus?.activeTimerCount ?? 0 }}</strong>
          </div>
        </div>

        <p class="hint-text">
          手动触发不会覆盖当前编辑中的表单；保存后会重新从服务端拉取一次配置。
        </p>
      </article>

      <article class="card status-card">
        <div class="card-header">
          <h3 class="card-title">可用任务类型</h3>
        </div>

        <div class="task-type-list">
          <article
            v-for="taskType in resolvedTaskTypes"
            :key="taskType.type"
            class="task-type-item"
          >
            <strong>{{ taskType.label }}</strong>
            <p>{{ taskType.description || taskType.type }}</p>
          </article>
        </div>
      </article>
    </section>

    <section class="card composer-card">
      <div class="composer-head">
        <div>
          <h3 class="card-title">任务列表</h3>
          <p class="hint-text">先创建草稿，再继续填写目标 Agent、调度方式和提示词。</p>
        </div>

        <form class="composer-controls" aria-label="快速创建任务" @submit.prevent="addTask">
          <label class="field quick-create-field">
            <span>新任务名称</span>
            <input
              v-model.trim="newTaskName"
              type="text"
              name="newTaskName"
              placeholder="输入新任务名称"
              autocomplete="off"
            />
          </label>
          <label class="field quick-create-field">
            <span>任务类型</span>
            <select
              v-model="newTaskType"
              name="newTaskType"
              autocomplete="off"
            >
              <option
                v-for="taskType in resolvedTaskTypes"
                :key="taskType.type"
                :value="taskType.type"
              >
                {{ taskType.label }}
              </option>
            </select>
          </label>
          <div class="quick-create-actions">
            <button type="submit" class="btn-primary">
              添加任务
            </button>
          </div>
        </form>
      </div>

      <div v-if="taskDrafts.length === 0" class="empty-state">
        <span class="material-symbols-outlined">explore_off</span>
        <h3>还没有任务</h3>
        <p>先创建一个任务草稿，再填写目标 Agent 和提示词模板。</p>
      </div>

      <div v-else class="task-list">
        <article
          v-for="task in taskDrafts"
          :key="task.localKey"
          class="task-card"
        >
          <header class="task-card-header">
            <div>
              <h4>{{ task.name || "未命名任务" }}</h4>
              <p>{{ resolveTaskTypeLabel(task.type) }}</p>
            </div>

            <div class="task-card-actions">
              <button
                type="button"
                class="btn-secondary"
                :disabled="!task.id || isTaskTriggerPending(task.id)"
                :title="task.id ? '立即触发当前任务' : '请先保存任务再触发'"
                @click="triggerTask(task)"
              >
                {{
                  task.id && isTaskTriggerPending(task.id)
                    ? "执行中…"
                    : "立即执行"
                }}
              </button>
              <button
                type="button"
                class="btn-danger"
                @click="removeTask(task)"
              >
                移除
              </button>
            </div>
          </header>

          <div class="task-grid">
            <label class="field">
              <span>任务名称</span>
              <input v-model.trim="task.name" type="text" placeholder="例如：论坛巡航可可" />
            </label>

            <label class="field">
              <span>任务类型</span>
              <select v-model="task.type">
                <option
                  v-for="taskType in resolvedTaskTypes"
                  :key="taskType.type"
                  :value="taskType.type"
                >
                  {{ taskType.label }}
                </option>
              </select>
            </label>

            <label class="field">
              <span>目标 Agent</span>
              <div class="agent-input-wrapper">
                <input
                  v-model="task.targetAgentsText"
                  type="text"
                  placeholder="多个 Agent 用英文逗号分隔"
                  :list="`agent-suggestions-${task.localKey}`"
                  @input="updateRandomOptions(task)"
                />
                <select
                  class="agent-quick-select"
                  aria-label="目标 Agent 快速选择"
                  @change="handleAgentQuickSelect(task, $event)"
                >
                  <option value="">+ 快选</option>
                  <option
                    v-for="agent in availableAgents"
                    :key="agent.chineseName"
                    :value="agent.chineseName"
                  >
                    {{ agent.chineseName }}
                  </option>
                </select>
                <select
                  class="agent-random-select"
                  aria-label="随机执行人数"
                  :value="task.randomCount > 0 ? `random${task.randomCount}` : ''"
                  @change="handleRandomSelect(task, $event)"
                >
                  <option value="">随机选择</option>
                  <option
                    v-for="n in getDynamicRandomOptions(task)"
                    :key="n"
                    :value="`random${n}`"
                  >
                    随机 {{ n }} 人
                  </option>
                </select>
                <datalist :id="`agent-suggestions-${task.localKey}`">
                  <option
                    v-for="agent in availableAgents"
                    :key="agent.chineseName"
                    :value="agent.chineseName"
                  />
                </datalist>
              </div>
            </label>

            <label class="field">
              <span>请求发送者</span>
              <input v-model.trim="task.maid" type="text" placeholder="默认 VCP系统" />
            </label>

            <label class="field">
              <span>注入工具</span>
              <input
                v-model="task.injectToolsText"
                type="text"
                placeholder="例如：VCPForum"
              />
            </label>

            <label class="field">
              <span>调度方式</span>
              <select v-model="task.scheduleMode">
                <option value="interval">循环任务</option>
                <option value="cron">CRON 定时</option>
                <option value="manual">仅手动触发</option>
                <option value="once">一次性任务</option>
              </select>
            </label>

            <label class="field">
              <span>循环间隔（分钟）</span>
              <input
                v-model.number="task.intervalMinutes"
                type="number"
                min="10"
                step="1"
                :disabled="task.scheduleMode !== 'interval'"
              />
            </label>

            <label class="field">
              <span>CRON 表达式</span>
              <input
                v-model.trim="task.cronValue"
                type="text"
                placeholder="例如：0 0 * * * (每日凌晨)"
                :disabled="task.scheduleMode !== 'cron'"
              />
            </label>

            <label class="field">
              <span>一次性执行时间</span>
              <input
                v-model="task.runAtLocal"
                type="datetime-local"
                :disabled="task.scheduleMode !== 'once'"
              />
            </label>
          </div>

          <label class="switch-row section-switch">
            <input v-model="task.enabled" type="checkbox" />
            <span>启用该任务</span>
          </label>

          <label class="switch-row section-switch">
            <input v-model="task.taskDelegation" type="checkbox" />
            <span>异步高级委托</span>
          </label>

          <template v-if="task.type === 'forum_patrol'">
            <label class="switch-row section-switch">
              <input v-model="task.includeForumPostList" type="checkbox" />
              <span>执行前自动读取论坛帖子列表</span>
            </label>

            <div class="task-grid">
              <label class="field">
                <span>论坛列表占位符</span>
                <input
                  v-model.trim="task.forumListPlaceholder"
                  type="text"
                  placeholder="{{forum_post_list}}"
                />
              </label>

              <label class="field">
                <span>最大读取帖子数</span>
                <input
                  v-model.number="task.maxPosts"
                  type="number"
                  min="1"
                  step="1"
                />
              </label>
            </div>
          </template>

          <label class="field full-field">
            <span>提示词模板</span>
            <textarea
              v-model="task.promptTemplate"
              rows="8"
              placeholder="这里是任务的提示词模板"
            ></textarea>
          </label>

          <div class="placeholder-row">
            <span class="placeholder-label">可用占位符</span>
            <span
              v-for="placeholder in resolveTaskPlaceholders(task)"
              :key="`${task.localKey}-${placeholder}`"
              class="placeholder-chip"
            >
              {{ placeholder }}
            </span>
            <span v-if="resolveTaskPlaceholders(task).length === 0" class="placeholder-empty">
              当前任务没有额外占位符
            </span>
          </div>

          <div class="runtime-panel">
            <div class="runtime-state-row">
              <span
                class="status-badge"
                :class="task.runtime?.running ? 'status-running' : 'status-neutral'"
              >
                {{ task.runtime?.running ? "执行中" : "待机" }}
              </span>
              <span class="runtime-summary">
                成功 {{ task.runtime?.successCount ?? 0 }} 次 / 失败
                {{ task.runtime?.errorCount ?? 0 }} 次 / 总计
                {{ task.runtime?.runCount ?? 0 }} 次
              </span>
            </div>

            <div class="runtime-grid">
              <div class="runtime-item">
                <span>上次开始</span>
                <strong>{{ formatDateTime(task.runtime?.lastRunTime) }}</strong>
              </div>
              <div class="runtime-item">
                <span>上次完成</span>
                <strong>{{ formatDateTime(task.runtime?.lastFinishTime) }}</strong>
              </div>
              <div class="runtime-item">
                <span>下次运行</span>
                <strong>{{ formatDateTime(task.runtime?.nextRunTime) }}</strong>
              </div>
              <div class="runtime-item">
                <span>耗时</span>
                <strong>{{ formatDuration(task.runtime?.lastDurationMs) }}</strong>
              </div>
            </div>

            <p v-if="task.runtime?.lastResult" class="runtime-message">
              最近结果：{{ task.runtime.lastResult }}
            </p>
            <p v-if="task.runtime?.lastError" class="runtime-message error-text">
              最近错误：{{ task.runtime.lastError }}
            </p>
          </div>
        </article>
      </div>
    </section>

    <section class="card history-card">
      <div class="card-header">
        <h3 class="card-title">最近执行记录</h3>
      </div>

      <div v-if="historyItems.length === 0" class="history-empty">
        还没有执行记录。
      </div>

      <div v-else class="history-list">
        <article
          v-for="item in historyItems.slice(0, 8)"
          :key="item.id"
          class="history-item"
        >
          <div class="history-item-top">
            <strong>{{ item.taskName || item.taskId || "未知任务" }}</strong>
            <span
              class="status-badge"
              :class="item.status === 'error' ? 'status-disabled' : 'status-enabled'"
            >
              {{ item.status || "unknown" }}
            </span>
          </div>
          <p>{{ item.message || "无返回信息" }}</p>
          <div class="history-meta">
            <span>触发方式：{{ item.triggerSource || "unknown" }}</span>
            <span>完成时间：{{ formatDateTime(item.finishedAt) }}</span>
            <span>耗时：{{ formatDuration(item.durationMs) }}</span>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  forumAssistantApi,
  type ForumAssistantConfigResponse,
  type ForumAssistantHistoryItem,
  type ForumAssistantSaveConfigPayload,
  type ForumAssistantStatus,
  type ForumAssistantStatusTask,
  type ForumAssistantTask,
  type ForumAssistantTaskRuntime,
  type ForumAssistantTaskType,
  type ForumAssistantTaskTypeOption,
} from "@/api";
import { showMessage } from "@/utils";

type StatusType = "info" | "success" | "error";

interface ForumAssistantTaskDraft {
  localKey: string;
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  taskDelegation: boolean;
  targetAgentsText: string;
  randomCount: number;
  injectToolsText: string;
  maid: string;
  scheduleMode: string;
  intervalMinutes: number;
  cronValue: string;
  runAtLocal: string;
  promptTemplate: string;
  includeForumPostList: boolean;
  forumListPlaceholder: string;
  maxPosts: number;
  availablePlaceholders: string[];
  runtime: ForumAssistantTaskRuntime | null;
}

const DEFAULT_TASK_TYPES: ForumAssistantTaskTypeOption[] = [
  {
    type: "forum_patrol",
    label: "论坛帖子任务",
    description: "读取论坛帖子列表后，把内容注入提示词模板再派发给 Agent。",
  },
  {
    type: "custom_prompt",
    label: "通用提示词任务",
    description: "直接向目标 Agent 派发自定义提示词，不附带论坛帖子预读。",
  },
];

const globalEnabled = ref(false);
const maxHistory = ref(200);
const newTaskName = ref("");
const newTaskType = ref<string>("forum_patrol");
const availableTaskTypes = ref<ForumAssistantTaskTypeOption[]>([]);
const taskTemplates = ref<Record<string, ForumAssistantTask>>({});
const taskDrafts = ref<ForumAssistantTaskDraft[]>([]);
const runtimeStatus = ref<ForumAssistantStatus | null>(null);
const statusMessage = ref("");
const statusType = ref<StatusType>("info");
const isLoading = ref(false);
const isSaving = ref(false);
const pendingTriggerTaskIds = ref<string[]>([]);
const availableAgents = ref<Array<{ chineseName: string }>>([]);

const resolvedTaskTypes = computed(() =>
  availableTaskTypes.value.length > 0 ? availableTaskTypes.value : DEFAULT_TASK_TYPES
);
const historyItems = computed<ForumAssistantHistoryItem[]>(
  () => runtimeStatus.value?.history ?? []
);

function createDefaultRuntime(): ForumAssistantTaskRuntime {
  return {
    running: false,
    lastRunTime: null,
    lastFinishTime: null,
    lastResult: null,
    lastError: null,
    lastDurationMs: null,
    runCount: 0,
    successCount: 0,
    errorCount: 0,
    nextRunTime: null,
  };
}

function createLocalKey(id = ""): string {
  return id || `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function splitCommaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toDatetimeLocalValue(isoString: string | null | undefined): string {
  if (!isoString) {
    return "";
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function fromDatetimeLocalValue(value: string): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveTaskType(type: string): ForumAssistantTaskType {
  return type === "custom_prompt" ? "custom_prompt" : "forum_patrol";
}

function resolveTaskTypeLabel(type: string): string {
  const matched = resolvedTaskTypes.value.find((item) => item.type === type);
  return matched?.label || type;
}

function resolveTaskPlaceholders(task: ForumAssistantTaskDraft): string[] {
  if (resolveTaskType(task.type) === "forum_patrol") {
    return task.availablePlaceholders.length > 0
      ? task.availablePlaceholders
      : ["{{forum_post_list}}"];
  }

  return task.availablePlaceholders;
}

function buildFallbackTemplate(type: string): ForumAssistantTask {
  const resolvedType = resolveTaskType(type);

  if (resolvedType === "custom_prompt") {
    return {
      id: "",
      name: "新通用任务",
      type: "custom_prompt",
      enabled: true,
      schedule: {
        mode: "manual",
        intervalMinutes: 60,
        runAt: null,
        cronValue: null,
        jitterSeconds: 0,
      },
      targets: { agents: [] },
      dispatch: {
        channel: "AgentAssistant",
        temporaryContact: true,
        injectTools: ["VCPForum"],
        maid: "VCP系统",
        taskDelegation: false,
      },
      payload: {
        promptTemplate: "",
        availablePlaceholders: [],
      },
      runtime: createDefaultRuntime(),
      meta: {
        createdAt: null,
        updatedAt: null,
      },
    };
  }

  return {
    id: "",
    name: "新论坛帖子任务",
    type: "forum_patrol",
    enabled: true,
    schedule: {
      mode: "interval",
      intervalMinutes: 60,
      runAt: null,
      cronValue: null,
      jitterSeconds: 0,
    },
    targets: { agents: [] },
    dispatch: {
      channel: "AgentAssistant",
      temporaryContact: true,
      injectTools: ["VCPForum"],
      maid: "VCP系统",
      taskDelegation: false,
    },
    payload: {
      promptTemplate:
        "[论坛小助手] 现在是论坛时间，请先阅读帖子列表，再选择你感兴趣的主题互动。\n\n{{forum_post_list}}",
      availablePlaceholders: ["{{forum_post_list}}"],
      includeForumPostList: true,
      forumListPlaceholder: "{{forum_post_list}}",
      maxPosts: 200,
    },
    runtime: createDefaultRuntime(),
    meta: {
      createdAt: null,
      updatedAt: null,
    },
  };
}

function toTaskDraft(
  task: ForumAssistantTask,
  statusTask?: ForumAssistantStatusTask
): ForumAssistantTaskDraft {
  const taskType = resolveTaskType(task.type);
  const runtime = statusTask?.runtime ?? task.runtime ?? createDefaultRuntime();

  // 解析 randomN 标签
  const agents = task.targets.agents;
  const randomTag = agents.find(a => /^random(\d+)$/i.test(a));
  const randomCount = randomTag ? parseInt(randomTag.match(/random(\d+)/i)![1], 10) : 0;
  const realAgents = agents.filter(a => !/^random(\d+)$/i.test(a));

  return {
    localKey: createLocalKey(task.id),
    id: task.id,
    name: task.name,
    type: taskType,
    enabled: task.enabled,
    taskDelegation: task.dispatch.taskDelegation || false,
    targetAgentsText: realAgents.join(", "),
    randomCount,
    injectToolsText: task.dispatch.injectTools.join(", "),
    maid: task.dispatch.maid || "VCP系统",
    scheduleMode: task.schedule.mode,
    intervalMinutes: task.schedule.intervalMinutes,
    cronValue: task.schedule.cronValue || "",
    runAtLocal: toDatetimeLocalValue(task.schedule.runAt),
    promptTemplate: task.payload.promptTemplate,
    includeForumPostList: task.payload.includeForumPostList !== false,
    forumListPlaceholder:
      task.payload.forumListPlaceholder || "{{forum_post_list}}",
    maxPosts: task.payload.maxPosts ?? 200,
    availablePlaceholders: [...task.payload.availablePlaceholders],
    runtime,
  };
}

function mergeStatusIntoDrafts(
  drafts: ForumAssistantTaskDraft[],
  statusTasks: ForumAssistantStatusTask[]
): ForumAssistantTaskDraft[] {
  const statusMap = new Map(statusTasks.map((task) => [task.id, task]));

  return drafts.map((draft) => {
    const statusTask = draft.id ? statusMap.get(draft.id) : undefined;
    if (!statusTask) {
      return draft;
    }

    return {
      ...draft,
      runtime: statusTask.runtime,
    };
  });
}

function setStatus(message: string, type: StatusType): void {
  statusMessage.value = message;
  statusType.value = type;
}

function applyLoadedData(
  configResponse: ForumAssistantConfigResponse,
  status: ForumAssistantStatus
): void {
  const statusMap = new Map(status.tasks.map((task) => [task.id, task]));

  globalEnabled.value = configResponse.config.globalEnabled;
  maxHistory.value = configResponse.config.settings.maxHistory;
  availableTaskTypes.value = configResponse.availableTaskTypes;
  taskTemplates.value = configResponse.taskTemplates;
  taskDrafts.value = configResponse.config.tasks.map((task) =>
    toTaskDraft(task, statusMap.get(task.id))
  );
  runtimeStatus.value = status;

  if (!resolvedTaskTypes.value.some((item) => item.type === newTaskType.value)) {
    newTaskType.value = resolvedTaskTypes.value[0]?.type || "forum_patrol";
  }
}

async function refreshAll(showSuccessMessage = false): Promise<void> {
  isLoading.value = true;

  try {
    const [configResponse, status] = await Promise.all([
      forumAssistantApi.getConfig(),
      forumAssistantApi.getStatus(),
    ]);

    applyLoadedData(configResponse, status);
    
    // --- 获取可用 Agent 列表以供快选 ---
    try {
      const agentConfig = await fetch('/admin_api/agent-assistant/config').then(r => r.json());
      if (agentConfig && Array.isArray(agentConfig.agents)) {
        availableAgents.value = agentConfig.agents;
      }
    } catch (agentErr) {
      console.warn('[TaskAssistant] Failed to fetch agent list for suggestions:', agentErr);
    }
    // ---------------------------------
    
    setStatus("", "info");

    if (showSuccessMessage) {
      showMessage("任务派发中心配置已刷新", "success");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`加载失败：${message}`, "error");
    showMessage(`加载任务派发中心配置失败：${message}`, "error");
  } finally {
    isLoading.value = false;
  }
}

async function refreshStatusOnly(): Promise<void> {
  try {
    const status = await forumAssistantApi.getStatus();
    runtimeStatus.value = status;
    taskDrafts.value = mergeStatusIntoDrafts(taskDrafts.value, status.tasks);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`刷新任务状态失败：${message}`, "error");
  }
}

function addTask(): void {
  if (!newTaskName.value.trim()) {
    showMessage("请输入任务名称", "warning");
    return;
  }

  const template =
    taskTemplates.value[newTaskType.value] ?? buildFallbackTemplate(newTaskType.value);
  const draft = toTaskDraft(
    {
      ...template,
      id: "",
      name: newTaskName.value.trim(),
      runtime: createDefaultRuntime(),
      meta: {
        createdAt: null,
        updatedAt: null,
      },
    },
    undefined
  );

  taskDrafts.value = [...taskDrafts.value, draft];
  newTaskName.value = "";
  showMessage(`已添加任务草稿：${draft.name}`, "success");
}

function handleAgentQuickSelect(task: ForumAssistantTaskDraft, event: Event): void {
  const select = event.target as HTMLSelectElement;
  const val = select.value;
  if (!val) return;

  const current = task.targetAgentsText.trim();
  if (current) {
    const agents = current.split(',').map(s => s.trim()).filter(Boolean);
    if (!agents.includes(val)) {
      agents.push(val);
      task.targetAgentsText = agents.join(', ');
    }
  } else {
    task.targetAgentsText = val;
  }

  select.value = '';
}

function getDynamicRandomOptions(task: ForumAssistantTaskDraft): number[] {
  const agents = task.targetAgentsText
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(a => !/^random(\d+)$/i.test(a));
  
  const count = Math.min(agents.length, 30);
  return Array.from({ length: count }, (_, i) => i + 1);
}

function handleRandomSelect(task: ForumAssistantTaskDraft, event: Event): void {
  const select = event.target as HTMLSelectElement;
  const val = select.value;
  
  let agents = task.targetAgentsText
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  
  agents = agents.filter(a => !/^random(\d+)$/i.test(a));
  
  if (val) {
    const match = val.match(/^random(\d+)$/i);
    if (match) {
      task.randomCount = parseInt(match[1], 10);
      agents.push(val);
    }
  } else {
    task.randomCount = 0;
  }
  
  task.targetAgentsText = agents.join(', ');
  select.value = '';
}

function updateRandomOptions(task: ForumAssistantTaskDraft): void {
  let agents = task.targetAgentsText
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  
  const hasRandom = agents.some(a => /^random(\d+)$/i.test(a));
  const realAgents = agents.filter(a => !/^random(\d+)$/i.test(a));
  
  if (hasRandom && realAgents.length < task.randomCount) {
    agents = realAgents;
    task.randomCount = 0;
    task.targetAgentsText = agents.join(', ');
  }
}

function removeTask(task: ForumAssistantTaskDraft): void {
  const taskName = task.name.trim() || "未命名任务";
  if (!window.confirm(`确定移除任务 "${taskName}" 吗？`)) {
    return;
  }

  taskDrafts.value = taskDrafts.value.filter(
    (item) => item.localKey !== task.localKey
  );
}

function isTaskTriggerPending(taskId: string): boolean {
  return pendingTriggerTaskIds.value.includes(taskId);
}

async function triggerTask(task: ForumAssistantTaskDraft): Promise<void> {
  if (!task.id) {
    showMessage("请先保存任务，再执行手动触发", "warning");
    return;
  }

  pendingTriggerTaskIds.value = [...pendingTriggerTaskIds.value, task.id];

  try {
    const result = await forumAssistantApi.triggerTask(task.id, {
      loadingKey: `forum-assistant.trigger.${task.id}`,
    });
    showMessage(result.message || `已触发任务：${task.name}`, "success");
    await refreshStatusOnly();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`触发任务失败：${message}`, "error");
  } finally {
    pendingTriggerTaskIds.value = pendingTriggerTaskIds.value.filter(
      (item) => item !== task.id
    );
  }
}

function buildTaskPayload(
  draft: ForumAssistantTaskDraft
): ForumAssistantSaveConfigPayload["tasks"][number] {
  const taskType = resolveTaskType(draft.type);
  const scheduleMode =
    draft.scheduleMode === "manual" || draft.scheduleMode === "once" || draft.scheduleMode === "cron"
      ? draft.scheduleMode
      : "interval";

  const payload =
    taskType === "forum_patrol"
      ? {
          promptTemplate: draft.promptTemplate,
          availablePlaceholders: ["{{forum_post_list}}"],
          includeForumPostList: draft.includeForumPostList,
          forumListPlaceholder:
            draft.forumListPlaceholder.trim() || "{{forum_post_list}}",
          maxPosts: Math.max(Math.trunc(draft.maxPosts || 0) || 200, 1),
        }
      : {
          promptTemplate: draft.promptTemplate,
          availablePlaceholders: [],
        };

  // 构建 agents 数组，如果有 randomCount 则添加 randomN 标签
  const agents = splitCommaSeparated(draft.targetAgentsText);
  if (draft.randomCount > 0) {
    agents.push(`random${draft.randomCount}`);
  }

  return {
    id: draft.id || undefined,
    name: draft.name.trim(),
    type: taskType,
    enabled: draft.enabled,
    schedule: {
      mode: scheduleMode,
      intervalMinutes: Math.max(
        Math.trunc(draft.intervalMinutes || 0) || 60,
        10
      ),
      cronValue: scheduleMode === "cron" ? draft.cronValue.trim() || null : null,
      runAt:
        scheduleMode === "once" ? fromDatetimeLocalValue(draft.runAtLocal) : null,
      jitterSeconds: 0,
    },
    targets: {
      agents,
    },
    dispatch: {
      channel: "AgentAssistant",
      temporaryContact: true,
      injectTools: splitCommaSeparated(draft.injectToolsText),
      maid: draft.maid.trim() || "VCP系统",
      taskDelegation: draft.taskDelegation,
    },
    payload,
  };
}

async function saveConfig(): Promise<void> {
  isSaving.value = true;

  try {
    const payload: ForumAssistantSaveConfigPayload = {
      globalEnabled: globalEnabled.value,
      settings: {
        maxHistory: Math.max(Math.trunc(maxHistory.value || 0) || 200, 20),
      },
      tasks: taskDrafts.value.map((task) => buildTaskPayload(task)),
    };

    const result = await forumAssistantApi.saveConfig(payload, {
      loadingKey: "forum-assistant.save",
    });

    await refreshAll(false);
    setStatus(result.message, "success");
    showMessage(result.message, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`保存失败：${message}`, "error");
    showMessage(`保存任务派发中心配置失败：${message}`, "error");
  } finally {
    isSaving.value = false;
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "未记录";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未记录";
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
  });
}

function formatDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "未记录";
  }

  if (value < 1000) {
    return `${value} ms`;
  }

  return `${(value / 1000).toFixed(2)} s`;
}

onMounted(async () => {
  await refreshAll(false);
});
</script>

<style scoped>
.forum-assistant-view {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.toolbar-card,
.status-card,
.composer-card,
.history-card {
  padding: var(--space-5);
}

.toolbar-row,
.toolbar-actions,
.composer-head,
.composer-controls,
.status-metrics,
.task-card-header,
.task-card-actions,
.runtime-state-row,
.history-item-top,
.history-meta {
  display: flex;
  gap: 12px;
}

.toolbar-row,
.composer-head,
.task-card-header,
.history-item-top {
  align-items: center;
  justify-content: space-between;
}

.toolbar-actions,
.composer-controls,
.task-card-actions {
  flex-wrap: wrap;
}

.switch-row {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field span {
  font-weight: 600;
  color: var(--primary-text);
}

.field input,
.field select,
.field textarea,
.composer-controls input,
.composer-controls select {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--input-bg);
  color: var(--primary-text);
}

.compact-field {
  min-width: 180px;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 20px;
}

.status-metrics {
  flex-wrap: wrap;
  margin-top: 12px;
}

.metric {
  min-width: 120px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metric-label,
.hint-text {
  color: var(--secondary-text);
}

.card-title {
  margin: 0;
}

.task-type-list,
.task-list,
.history-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.task-type-item {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--secondary-bg) 80%, transparent);
}

.task-type-item strong {
  display: block;
  margin-bottom: 6px;
}

.task-type-item p,
.history-item p {
  margin: 0;
  color: var(--secondary-text);
}

.composer-head {
  margin-bottom: var(--space-5);
}

.composer-controls {
  flex: 1;
  justify-content: flex-end;
  align-items: flex-end;
}

.composer-controls input {
  max-width: 240px;
}

.composer-controls select {
  max-width: 220px;
}

.quick-create-field {
  min-width: 220px;
  max-width: 280px;
}

.quick-create-field > span {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.quick-create-field input,
.quick-create-field select {
  max-width: none;
}

.quick-create-actions {
  display: flex;
  align-items: flex-end;
}

.empty-state,
.history-empty {
  padding: var(--space-6) var(--space-5);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-xl);
  text-align: center;
  color: var(--secondary-text);
}

.empty-state h3 {
  margin: var(--space-3) 0 var(--space-2);
  color: var(--primary-text);
}

.task-card {
  padding: var(--space-4);
  border-radius: 18px;
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--secondary-bg) 86%, transparent);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.task-card-header h4 {
  margin: 0 0 6px;
}

.task-card-header p {
  margin: 0;
  color: var(--secondary-text);
}

.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 20px;
}

.full-field {
  width: 100%;
}

.section-switch {
  margin-top: -4px;
}

.placeholder-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.placeholder-label {
  font-weight: 600;
  color: var(--secondary-text);
}

.placeholder-chip {
  padding: 6px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--button-bg) 18%, transparent);
  color: var(--primary-text);
  font-family: monospace;
}

.placeholder-empty {
  color: var(--secondary-text);
}

.runtime-panel {
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--tertiary-bg) 78%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
}

.runtime-state-row {
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}

.runtime-summary {
  color: var(--secondary-text);
}

.runtime-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}

.runtime-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.runtime-item span {
  color: var(--secondary-text);
}

.runtime-message {
  margin: 12px 0 0;
}

.history-item {
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--secondary-bg) 88%, transparent);
}

.history-meta {
  flex-wrap: wrap;
  margin-top: 10px;
  color: var(--secondary-text);
}

.status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: var(--font-size-helper);
  font-weight: 700;
}

.status-enabled {
  background: var(--success-bg);
  color: var(--success-text);
}

.status-disabled {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.status-neutral {
  background: color-mix(in srgb, var(--border-color) 32%, transparent);
  color: var(--secondary-text);
}

.status-running {
  background: var(--info-bg);
  color: var(--info-text);
}

.error-text {
  color: var(--danger-text);
}

.agent-input-wrapper {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.agent-input-wrapper input {
  flex: 1;
  min-width: 120px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--input-bg);
  color: var(--primary-text);
}

.agent-quick-select,
.agent-random-select {
  flex-shrink: 0;
  width: auto;
  min-width: 100px;
  max-width: 140px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--input-bg);
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  cursor: pointer;
}

.agent-quick-select:hover,
.agent-random-select:hover {
  border-color: var(--primary-color);
}

@media (max-width: 900px) {
  .toolbar-row,
  .composer-head,
  .task-card-header {
    flex-direction: column;
    align-items: stretch;
  }

  .composer-controls {
    justify-content: stretch;
  }

  .composer-controls input,
  .composer-controls select {
    max-width: none;
  }

  .quick-create-field {
    min-width: 0;
    max-width: none;
  }

  .quick-create-actions .btn-primary {
    width: 100%;
  }

  .runtime-state-row {
    align-items: flex-start;
  }
}
</style>
