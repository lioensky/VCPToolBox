"use strict";

// TicktickManager - VCP hybridservice plugin
// 同时提供滴答清单/滴答365同步调用与静态任务快照注入能力。

const fs = require("fs");
const path = require("path");

const IS_STATIC_REFRESH_CLI = process.argv
  .slice(2)
  .includes("--static-refresh");

function createFallbackPluginManager() {
  return { staticPlaceholderValues: new Map() };
}

function loadPluginManager() {
  const candidates = [
    path.resolve(__dirname, "Plugin.js"),
    path.resolve(__dirname, "..", "Plugin.js"),
    path.resolve(__dirname, "..", "..", "Plugin.js"),
    path.resolve(process.cwd(), "Plugin.js"),
    path.resolve(process.cwd(), "..", "Plugin.js"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      return require(candidate);
    } catch (error) {
      console.warn(
        `[TicktickManager] 无法加载 ${candidate}：${error.message || error}`
      );
    }
  }

  return createFallbackPluginManager();
}

let pluginManager = IS_STATIC_REFRESH_CLI
  ? createFallbackPluginManager()
  : loadPluginManager();

const PLUGIN_NAME = "TicktickManager";
const STATIC_CRON_PROXY_NAME = `${PLUGIN_NAME}StaticCron`;
const PLACEHOLDER = "{{VCPTicktickTasks}}";
const CONFIG_ENV_FILENAME = "config.env";
const STATIC_DOC_FILENAME = "ticktick_static.md";
const STATIC_DOC_PATH = path.join(__dirname, STATIC_DOC_FILENAME);
const CONFIG_ENV_PATH = path.join(__dirname, CONFIG_ENV_FILENAME);
const DEFAULT_BASE_URL = "https://api.ticktick.com/open/v1";
const DEFAULT_STATIC_REFRESH_CRON = "* * * * *";
const DEFAULT_STATIC_REFRESH_COMMAND =
  "node TicktickManager.js --static-refresh";
const MAX_PROJECT_FETCH_CONCURRENCY = 3;
const VALID_PRIORITIES = new Set([0, 1, 3, 5]);
const WRITE_COMMANDS = new Set([
  "create_task",
  "batch_create_tasks",
  "create_subtask",
  "update_task",
  "complete_task",
  "delete_task",
]);

let pluginConfig = {};
let debugMode = false;
let runningAsStaticCli = IS_STATIC_REFRESH_CLI;
let ticktickClient = null;
let refreshLock = null;
let pendingRefreshAfterCurrent = false;
let snapshotCache = null;
let permissionContextCache = null;
let clientSignature = "";

function debugLog(...args) {
  if (debugMode) {
    const logger = runningAsStaticCli ? console.error : console.log;
    logger(`[${PLUGIN_NAME}]`, ...args);
  }
}

class PluginError extends Error {
  constructor(code, message, hint = "", details = undefined) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

class TickTickClient {
  constructor(runtimeConfig) {
    this.applyConfig(runtimeConfig);
  }

  applyConfig(runtimeConfig) {
    this.baseUrl = trimTrailingSlash(runtimeConfig.baseUrl || DEFAULT_BASE_URL);
    this.accessToken = runtimeConfig.accessToken || "";
  }

  async request(method, endpoint, data = undefined) {
    ensureFetchAvailable();
    await this.ensureAuthenticated();
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "TicktickManager-VCP/1.0",
    };
    const fetchOptions = { method, headers };
    if (data !== undefined && method !== "GET" && method !== "DELETE") {
      fetchOptions.body = JSON.stringify(data);
    }

    debugLog(`${method} ${endpoint}`);
    const response = await globalThis.fetch(url, fetchOptions);
    const text = await response.text();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        parsed = { raw: text };
      }
    }

    if (isAccessTokenAuthFailure(response.status, parsed)) {
      throw createAccessTokenError(
        response.status === 401
          ? "TICKTICK_ACCESS_TOKEN 无效或已过期，滴答清单 OpenAPI 拒绝访问。"
          : "TICKTICK_ACCESS_TOKEN 可能无效，滴答清单 OpenAPI 返回鉴权失败。",
        {
          method,
          endpoint,
          status: response.status,
          response: parsed,
        }
      );
    }

    if (!response.ok) {
      const apiMessage =
        parsed && (parsed.error || parsed.message || parsed.raw);
      const message = apiMessage
        ? `滴答清单 OpenAPI 请求失败：HTTP ${response.status} - ${apiMessage}`
        : `滴答清单 OpenAPI 请求失败：HTTP ${response.status}`;
      throw new PluginError(
        "API_ERROR",
        message,
        "请检查 TICKTICK_ACCESS_TOKEN、baseurl、项目/任务 ID 以及滴答清单接口权限。",
        {
          method,
          endpoint,
          status: response.status,
          response: parsed,
        }
      );
    }
    return parsed;
  }

  async ensureAuthenticated() {
    if (this.accessToken) {
      return;
    }
    throw createAccessTokenError(
      "缺少 TICKTICK_ACCESS_TOKEN，无法调用滴答清单 OpenAPI。"
    );
  }

  getProjects() {
    return this.request("GET", "/project");
  }

  getProject(projectId) {
    return this.request("GET", `/project/${encodeURIComponent(projectId)}`);
  }

  getProjectWithData(projectId) {
    return this.request(
      "GET",
      `/project/${encodeURIComponent(projectId)}/data`
    );
  }

  getTask(projectId, taskId) {
    return this.request(
      "GET",
      `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(
        taskId
      )}`
    );
  }

  createTask(payload) {
    return this.request("POST", "/task", payload);
  }

  updateTask(taskId, payload) {
    return this.request("POST", `/task/${encodeURIComponent(taskId)}`, payload);
  }

  completeTask(projectId, taskId) {
    return this.request(
      "POST",
      `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(
        taskId
      )}/complete`
    );
  }

  deleteTask(projectId, taskId) {
    return this.request(
      "DELETE",
      `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(
        taskId
      )}`
    );
  }

  createSubtask(payload) {
    return this.createTask(payload);
  }
}
function initialize(config = {}) {
  pluginConfig = config || {};
  bindRuntimePluginManager(pluginConfig);
  const runtimeConfig = loadRuntimeConfig();
  debugMode = toBoolean(runtimeConfig.debugMode, false);
  ensureClient(runtimeConfig);

  debugLog("Initializing hybrid plugin...");
  setStaticPlaceholder(
    "TicktickManager 正在等待 VCP cron 刷新滴答清单任务快照..."
  );

  const cronProxyRegistered = registerStaticCronProxy(runtimeConfig);
  if (cronProxyRegistered) {
    debugLog(
      "Registered VCP static cron proxy; snapshot polling will be driven by VCP refreshIntervalCron."
    );
    return;
  }

  debugLog(
    "VCP static cron proxy is unavailable; falling back to one startup refresh only."
  );
  refreshStaticSnapshot({ reason: "initialize_fallback" }).catch((error) => {
    const markdown = buildErrorMarkdown(error);
    writeStaticDocumentSafely(markdown);
    setStaticPlaceholder(markdown);
    console.error(
      `[${PLUGIN_NAME}] 初始化静态快照失败:`,
      error.message || error
    );
  });
}

function registerRoutes(app, config, projectBasePath) {
  debugLog(
    "registerRoutes called; TicktickManager does not expose HTTP routes.",
    Boolean(app),
    Boolean(config),
    projectBasePath || ""
  );
}

function registerStaticCronProxy(runtimeConfig = {}) {
  if (
    !pluginManager ||
    !pluginManager.plugins ||
    typeof pluginManager.plugins.get !== "function" ||
    typeof pluginManager.plugins.set !== "function"
  ) {
    return false;
  }

  const hybridManifest = pluginManager.plugins.get(PLUGIN_NAME);
  if (!hybridManifest) {
    return false;
  }

  const existingProxy = pluginManager.plugins.get(STATIC_CRON_PROXY_NAME) || {};
  const proxyManifest = {
    ...existingProxy,
    name: STATIC_CRON_PROXY_NAME,
    displayName: `${hybridManifest.displayName || PLUGIN_NAME}（静态刷新）`,
    version: hybridManifest.version || "1.0.0",
    description:
      "TicktickManager 的 VCP cron 静态刷新代理：定时请求滴答清单 OpenAPI，写入 ticktick_static.md，并将 Markdown 输出给 {{VCPTicktickTasks}}。",
    pluginType: "static",
    entryPoint: {
      command: resolveStaticRefreshCommand(hybridManifest),
    },
    communication: {
      protocol: "stdio",
      timeout:
        (hybridManifest.communication &&
          hybridManifest.communication.timeout) ||
        60000,
    },
    capabilities: {
      systemPromptPlaceholders: [
        {
          placeholder: PLACEHOLDER,
          description:
            "提供滴答清单白名单项目的任务快照，按项目、任务、子任务结构呈现，并标注权限、重要性、紧急性和四象限。",
          isDynamic: true,
        },
      ],
      invocationCommands: [],
    },
    refreshIntervalCron: resolveStaticRefreshCron(
      hybridManifest,
      runtimeConfig
    ),
    basePath: hybridManifest.basePath || __dirname,
    configSchema: hybridManifest.configSchema || {},
    configSchemaDescriptions: hybridManifest.configSchemaDescriptions || {},
    defaults: hybridManifest.defaults || {},
    pluginSpecificEnvConfig: hybridManifest.pluginSpecificEnvConfig || {},
    syntheticOwner: PLUGIN_NAME,
  };

  pluginManager.plugins.set(STATIC_CRON_PROXY_NAME, proxyManifest);
  return true;
}

function resolveStaticRefreshCommand(hybridManifest) {
  return (
    (hybridManifest &&
      hybridManifest.entryPoint &&
      (hybridManifest.entryPoint.staticCommand ||
        hybridManifest.entryPoint.command)) ||
    DEFAULT_STATIC_REFRESH_COMMAND
  );
}

function resolveStaticRefreshCron(hybridManifest, runtimeConfig = {}) {
  if (hybridManifest && hybridManifest.refreshIntervalCron) {
    return hybridManifest.refreshIntervalCron;
  }
  return secondsToCron(runtimeConfig.staticRefreshIntervalSeconds);
}

async function processToolCall(params = {}) {
  const command = String(
    firstDefined(params, ["command", "action"]) || ""
  ).trim();
  if (!command) {
    return buildFailure(
      "",
      new PluginError(
        "VALIDATION_ERROR",
        "缺少 command 参数。",
        "请提供 create_task、search_tasks 等命令名。"
      )
    );
  }

  try {
    ensureClient(loadRuntimeConfig());
    switch (command) {
      case "create_task":
        return await handleCreateTask(command, params);
      case "batch_create_tasks":
        return await handleBatchCreateTasks(command, params);
      case "create_subtask":
        return await handleCreateSubtask(command, params);
      case "update_task":
        return await handleUpdateTask(command, params);
      case "complete_task":
        return await handleCompleteTask(command, params);
      case "delete_task":
        return await handleDeleteTask(command, params);
      case "search_tasks":
        return await handleSearchTasks(command, params);
      case "get_project":
        return await handleGetProject(command, params);
      case "get_task":
        return await handleGetTask(command, params);
      default:
        throw new PluginError(
          "UNKNOWN_COMMAND",
          `未知命令：${command}`,
          "可用命令：create_task、batch_create_tasks、create_subtask、update_task、complete_task、delete_task、search_tasks、get_project、get_task。"
        );
    }
  } catch (error) {
    updateStaticAuthPromptIfNeeded(error);
    return buildFailure(command, error);
  }
}

function shutdown() {
  debugLog("Shutting down...");
}

async function handleCreateTask(command, params) {
  const title = requiredString(params, ["title"], "title");
  const projectRef = requiredString(
    params,
    ["project_id", "projectId", "project"],
    "project_id"
  );
  const projectAccess = await resolveProjectForAction(projectRef, "create");
  const payload = buildTaskPayload(params, {
    projectId: projectAccess.project.id,
    requireTitle: true,
    titleOverride: title,
  });

  const task = await ticktickClient.createTask(payload);
  const refresh = await refreshAfterWrite([projectAccess.project.id]);
  return buildSuccess(
    command,
    refresh.static_refreshed
      ? "任务创建成功，静态快照已刷新。"
      : "任务创建成功，但静态快照刷新失败。",
    {
      task,
      project: publicProject(projectAccess.project),
      permission: projectAccess.permissionLabel,
    },
    refresh
  );
}

async function handleBatchCreateTasks(command, params) {
  const tasks = parseBatchTasks(params);
  if (tasks.length === 0) {
    throw new PluginError(
      "VALIDATION_ERROR",
      "批量创建任务列表为空。",
      "请通过 tasks_json 或 tasks 传入 JSON 数组。"
    );
  }

  const validated = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const taskInput = tasks[index] || {};
    const title = requiredString(taskInput, ["title"], `tasks[${index}].title`);
    const projectRef = requiredString(
      taskInput,
      ["project_id", "projectId", "project"],
      `tasks[${index}].project_id`
    );
    const projectAccess = await resolveProjectForAction(projectRef, "create");
    const payload = buildTaskPayload(taskInput, {
      projectId: projectAccess.project.id,
      requireTitle: true,
      titleOverride: title,
    });
    validated.push({ index, payload, projectAccess });
  }

  const successes = [];
  const failures = [];
  for (const item of validated) {
    try {
      const task = await ticktickClient.createTask(item.payload);
      successes.push({
        index: item.index,
        task,
        project_id: item.projectAccess.project.id,
      });
    } catch (error) {
      failures.push({ index: item.index, error: normalizeErrorMessage(error) });
    }
  }

  const affectedProjectIds = [...new Set(successes.map((s) => s.project_id))];
  const refresh =
    successes.length > 0
      ? await refreshAfterWrite(affectedProjectIds)
      : buildNoRefreshResult();
  return buildSuccess(
    command,
    failures.length === 0
      ? "批量任务创建完成，静态快照已刷新。"
      : "批量任务创建部分成功，请查看失败明细。",
    {
      created_count: successes.length,
      failed_count: failures.length,
      successes,
      failures,
    },
    refresh
  );
}

async function handleCreateSubtask(command, params) {
  const subtaskTitle = requiredString(
    params,
    ["subtask_title", "title"],
    "subtask_title"
  );
  const parentTaskId = requiredString(
    params,
    ["parent_task_id", "parentTaskId", "parent_id", "parentId"],
    "parent_task_id"
  );
  const projectRef = requiredString(
    params,
    ["project_id", "projectId", "project"],
    "project_id"
  );
  const projectAccess = await resolveProjectForAction(projectRef, "create");

  const parentTask = await ticktickClient.getTask(
    projectAccess.project.id,
    parentTaskId
  );
  if (
    parentTask &&
    parentTask.projectId &&
    parentTask.projectId !== projectAccess.project.id
  ) {
    throw new PluginError(
      "PERMISSION_DENIED",
      "父任务不属于指定项目，拒绝创建子任务。",
      "请确认 parent_task_id 和 project_id 对应同一个白名单项目。"
    );
  }

  const payload = buildTaskPayload(params, {
    projectId: projectAccess.project.id,
    requireTitle: true,
    titleOverride: subtaskTitle,
    parentId: parentTaskId,
  });

  const subtask = await ticktickClient.createSubtask(payload);
  const refresh = await refreshAfterWrite([projectAccess.project.id]);
  return buildSuccess(
    command,
    refresh.static_refreshed
      ? "子任务创建成功，静态快照已刷新。"
      : "子任务创建成功，但静态快照刷新失败。",
    {
      subtask,
      parent_task_id: parentTaskId,
      project: publicProject(projectAccess.project),
      permission: projectAccess.permissionLabel,
    },
    refresh
  );
}

async function handleUpdateTask(command, params) {
  const taskId = requiredString(params, ["task_id", "taskId", "id"], "task_id");
  const projectRef = requiredString(
    params,
    ["project_id", "projectId", "project"],
    "project_id"
  );
  const projectAccess = await resolveProjectForAction(projectRef, "write");

  const existing = await ticktickClient.getTask(
    projectAccess.project.id,
    taskId
  );
  if (
    existing &&
    existing.projectId &&
    existing.projectId !== projectAccess.project.id
  ) {
    throw new PluginError(
      "PERMISSION_DENIED",
      "任务不属于指定项目，拒绝更新。",
      "请确认 task_id 和 project_id 对应同一个全权限项目。"
    );
  }

  const payload = buildTaskPayload(params, {
    projectId: projectAccess.project.id,
    taskId,
    includeId: true,
    requireAnyUpdateField: true,
  });

  const updated = await ticktickClient.updateTask(taskId, payload);
  const refresh = await refreshAfterWrite([projectAccess.project.id]);
  return buildSuccess(
    command,
    refresh.static_refreshed
      ? "任务更新成功，静态快照已刷新。"
      : "任务更新成功，但静态快照刷新失败。",
    {
      task: updated,
      project: publicProject(projectAccess.project),
      permission: projectAccess.permissionLabel,
    },
    refresh
  );
}

async function handleCompleteTask(command, params) {
  const projectRef = requiredString(
    params,
    ["project_id", "projectId", "project"],
    "project_id"
  );
  const taskId = requiredString(params, ["task_id", "taskId", "id"], "task_id");
  const projectAccess = await resolveProjectForAction(projectRef, "write");

  const result = await ticktickClient.completeTask(
    projectAccess.project.id,
    taskId
  );
  const refresh = await refreshAfterWrite([projectAccess.project.id]);
  return buildSuccess(
    command,
    refresh.static_refreshed
      ? "任务已完成，静态快照已刷新。"
      : "任务已完成，但静态快照刷新失败。",
    {
      result,
      task_id: taskId,
      project: publicProject(projectAccess.project),
      permission: projectAccess.permissionLabel,
    },
    refresh
  );
}

async function handleDeleteTask(command, params) {
  const projectRef = requiredString(
    params,
    ["project_id", "projectId", "project"],
    "project_id"
  );
  const taskId = requiredString(params, ["task_id", "taskId", "id"], "task_id");
  const projectAccess = await resolveProjectForAction(projectRef, "write");

  const result = await ticktickClient.deleteTask(
    projectAccess.project.id,
    taskId
  );
  const refresh = await refreshAfterWrite([projectAccess.project.id]);
  return buildSuccess(
    command,
    refresh.static_refreshed
      ? "任务已删除，静态快照已刷新。"
      : "任务已删除，但静态快照刷新失败。",
    {
      result,
      task_id: taskId,
      project: publicProject(projectAccess.project),
      permission: projectAccess.permissionLabel,
    },
    refresh
  );
}

async function handleSearchTasks(command, params) {
  const searchTerm = requiredString(
    params,
    ["search_term", "searchTerm", "query", "keyword"],
    "search_term"
  );
  const maxResults = toPositiveInteger(
    firstDefined(params, ["max_results", "maxResults"]),
    50,
    1,
    200
  );
  const includeCompleted = toBoolean(
    firstDefined(params, ["include_completed", "includeCompleted"]),
    false
  );
  const forceRefresh = toBoolean(
    firstDefined(params, ["force_refresh", "forceRefresh"]),
    false
  );

  if (forceRefresh || !snapshotCache) {
    await refreshStaticSnapshot({
      reason: "search_tasks",
      forceAfterCurrent: true,
    });
  }

  const snapshot = snapshotCache;
  if (!snapshot) {
    throw new PluginError(
      "STATIC_REFRESH_ERROR",
      "当前没有可搜索的静态快照。",
      "请检查鉴权和项目白名单配置，然后重试。"
    );
  }

  const results = searchSnapshot(snapshot, searchTerm, {
    includeCompleted,
    maxResults,
  });
  return buildSuccess(
    command,
    `搜索完成，命中 ${results.length} 条任务。`,
    {
      search_term: searchTerm,
      include_completed: includeCompleted,
      max_results: maxResults,
      refreshed_at: snapshot.refreshedAt,
      results,
    },
    {
      static_refreshed: forceRefresh,
      static_doc_path: STATIC_DOC_FILENAME,
      refreshed_at: snapshot.refreshedAt,
    }
  );
}

async function handleGetProject(command, params) {
  const projectRef = requiredString(
    params,
    ["project_id", "projectId", "project"],
    "project_id"
  );
  const includeTasks = toBoolean(
    firstDefined(params, ["include_tasks", "includeTasks"]),
    false
  );
  const projectAccess = await resolveProjectForAction(projectRef, "read");

  if (includeTasks) {
    const data = await ticktickClient.getProjectWithData(
      projectAccess.project.id
    );
    const projectSnapshot = normalizeProjectSnapshot(
      data,
      projectAccess.permissionEntry
    );
    return buildSuccess(command, "项目详情获取成功。", {
      project: publicProject(projectSnapshot.project),
      permission: projectAccess.permissionLabel,
      summary: projectSummary(projectSnapshot),
      tasks: projectSnapshot.tasks.map((task) =>
        taskToPublic(task, projectSnapshot)
      ),
    });
  }

  const project = await ticktickClient.getProject(projectAccess.project.id);
  return buildSuccess(command, "项目详情获取成功。", {
    project: publicProject({ ...projectAccess.project, ...project }),
    permission: projectAccess.permissionLabel,
  });
}

async function handleGetTask(command, params) {
  const projectRef = requiredString(
    params,
    ["project_id", "projectId", "project"],
    "project_id"
  );
  const taskId = requiredString(params, ["task_id", "taskId", "id"], "task_id");
  const projectAccess = await resolveProjectForAction(projectRef, "read");

  try {
    const projectData = await ticktickClient.getProjectWithData(
      projectAccess.project.id
    );
    const projectSnapshot = normalizeProjectSnapshot(
      projectData,
      projectAccess.permissionEntry
    );
    const task = projectSnapshot.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new PluginError(
        "VALIDATION_ERROR",
        "任务不存在，或任务已删除/不在当前项目数据中。",
        "请确认 task_id 是否属于该白名单项目。"
      );
    }
    return buildSuccess(command, "任务详情获取成功。", {
      task: taskToPublic(task, projectSnapshot, true),
      project: publicProject(projectSnapshot.project),
      permission: projectAccess.permissionLabel,
    });
  } catch (error) {
    if (error instanceof PluginError && error.code !== "VALIDATION_ERROR") {
      throw error;
    }
    const rawTask = await ticktickClient.getTask(
      projectAccess.project.id,
      taskId
    );
    if (isSoftDeleted(rawTask)) {
      throw new PluginError(
        "VALIDATION_ERROR",
        "任务已删除，不返回软删除数据。",
        "请刷新或确认任务 ID。"
      );
    }
    const task = normalizeTask(rawTask, projectAccess.project.id);
    return buildSuccess(command, "任务详情获取成功。", {
      task: taskToPublic(task, { childrenByParent: new Map() }, true),
      project: publicProject(projectAccess.project),
      permission: projectAccess.permissionLabel,
    });
  }
}

async function refreshAffectedProjects(projectIds) {
  if (!snapshotCache) {
    await refreshStaticSnapshot({ reason: "write", forceAfterCurrent: true });
    return;
  }

  const idSet = new Set(projectIds.filter(Boolean));
  if (idSet.size === 0) {
    return;
  }

  const context = await getPermissionContext(false);

  for (const projectId of idSet) {
    const permissionEntry = context.permissionByProjectId.get(projectId);
    if (!permissionEntry) {
      continue;
    }
    const project = permissionEntry.project;
    if (project.closed === true) {
      continue;
    }
    if (project.kind && String(project.kind).toUpperCase() !== "TASK") {
      continue;
    }
    try {
      const data = await ticktickClient.getProjectWithData(projectId);
      const newSnapshot = normalizeProjectSnapshot(data, permissionEntry);
      const existingIndex = snapshotCache.projects.findIndex(
        (s) => s.project.id === projectId
      );
      if (existingIndex >= 0) {
        snapshotCache.projects[existingIndex] = newSnapshot;
      } else {
        snapshotCache.projects.push(newSnapshot);
      }
    } catch (error) {
      if (isAccessTokenError(error)) {
        throw error;
      }
      debugLog(
        `refreshAffectedProjects 项目 ${projectId} 拉取失败：${
          error.message || error
        }`
      );
    }
  }

  snapshotCache.refreshedAt = nowIso();
  snapshotCache.localRefreshedAt = formatLocalTimestamp(new Date());
  snapshotCache.markdown = generateStaticMarkdown(snapshotCache);
  writeStaticDocument(snapshotCache.markdown);
  const injectedContent = fs.readFileSync(STATIC_DOC_PATH, "utf8");
  setStaticPlaceholder(injectedContent);
  snapshotCache.markdown = injectedContent;
}

async function refreshAfterWrite(projectIds) {
  try {
    await refreshAffectedProjects(projectIds);
    return {
      static_refreshed: true,
      static_doc_path: STATIC_DOC_FILENAME,
      refreshed_at: snapshotCache ? snapshotCache.refreshedAt : nowIso(),
    };
  } catch (error) {
    console.error(
      `[${PLUGIN_NAME}] 写操作成功，但刷新静态快照失败:`,
      error.message || error
    );
    return {
      static_refreshed: false,
      static_doc_path: STATIC_DOC_FILENAME,
      refresh_error: normalizeErrorMessage(error),
      refreshed_at: snapshotCache ? snapshotCache.refreshedAt : null,
    };
  }
}

function buildNoRefreshResult() {
  return {
    static_refreshed: false,
    static_doc_path: STATIC_DOC_FILENAME,
    refreshed_at: snapshotCache ? snapshotCache.refreshedAt : null,
  };
}

async function refreshStaticSnapshot(options = {}) {
  if (refreshLock) {
    if (options.forceAfterCurrent) {
      pendingRefreshAfterCurrent = true;
    }
    const currentResult = await refreshLock;
    if (options.forceAfterCurrent && pendingRefreshAfterCurrent) {
      pendingRefreshAfterCurrent = false;
      return refreshStaticSnapshot({
        reason: options.reason || "queued_after_current",
      });
    }
    return currentResult;
  }

  refreshLock = doRefreshStaticSnapshot(options).finally(() => {
    refreshLock = null;
  });

  return refreshLock;
}

async function doRefreshStaticSnapshot(options = {}) {
  const refreshedAt = nowIso();
  debugLog(`Refreshing static snapshot, reason=${options.reason || "manual"}`);
  const context = await getPermissionContext(true);
  const whitelistIds = context.whitelistedProjectIds;
  const projectResults = await mapLimit(
    whitelistIds,
    MAX_PROJECT_FETCH_CONCURRENCY,
    async (projectId) => {
      const permissionEntry = context.permissionByProjectId.get(projectId);
      const project = permissionEntry.project;
      if (project.closed === true) {
        return { skipped: true, project_id: projectId, reason: "项目已关闭" };
      }
      if (project.kind && String(project.kind).toUpperCase() !== "TASK") {
        return {
          skipped: true,
          project_id: projectId,
          reason: `非任务项目 kind=${project.kind}`,
        };
      }

      try {
        const data = await ticktickClient.getProjectWithData(projectId);
        return {
          ok: true,
          snapshot: normalizeProjectSnapshot(data, permissionEntry),
        };
      } catch (error) {
        if (isAccessTokenError(error)) {
          throw error;
        }
        return {
          ok: false,
          project_id: projectId,
          project_name: project.name,
          error: normalizeErrorMessage(error),
        };
      }
    }
  );

  const projectSnapshots = [];
  const failedProjects = [];
  const skippedProjects = [];
  for (const result of projectResults) {
    if (result && result.ok) {
      projectSnapshots.push(result.snapshot);
    } else if (result && result.skipped) {
      skippedProjects.push(result);
    } else if (result) {
      failedProjects.push(result);
    }
  }

  const snapshot = {
    refreshedAt,
    localRefreshedAt: formatLocalTimestamp(new Date()),
    context,
    projects: projectSnapshots,
    failedProjects,
    skippedProjects,
    warnings: context.warnings.slice(),
    markdown: "",
  };
  snapshot.markdown = generateStaticMarkdown(snapshot);

  writeStaticDocument(snapshot.markdown);
  const injectedContent = fs.readFileSync(STATIC_DOC_PATH, "utf8");
  setStaticPlaceholder(injectedContent);
  snapshot.markdown = injectedContent;
  snapshotCache = snapshot;

  debugLog(
    `Static snapshot refreshed. projects=${projectSnapshots.length}, failed=${failedProjects.length}, skipped=${skippedProjects.length}`
  );
  return {
    success: true,
    refreshedAt,
    static_doc_path: STATIC_DOC_FILENAME,
    project_count: projectSnapshots.length,
    failed_project_count: failedProjects.length,
    skipped_project_count: skippedProjects.length,
  };
}

function normalizeProjectSnapshot(projectData, permissionEntry) {
  const project = {
    ...(permissionEntry.project || {}),
    ...((projectData && projectData.project) || {}),
  };
  const rawTasks = Array.isArray(projectData && projectData.tasks)
    ? projectData.tasks
    : [];
  const tasks = rawTasks
    .filter((task) => !isSoftDeleted(task))
    .map((task) => normalizeTask(task, project.id));

  const taskById = new Map();
  for (const task of tasks) {
    taskById.set(task.id, task);
  }

  const childrenByParent = new Map();
  for (const task of tasks) {
    if (task.parentId && taskById.has(task.parentId)) {
      if (!childrenByParent.has(task.parentId)) {
        childrenByParent.set(task.parentId, []);
      }
      childrenByParent.get(task.parentId).push(task);
    }
  }

  const topLevelTasks = tasks.filter(
    (task) => !task.parentId || !taskById.has(task.parentId)
  );
  const activeTasks = tasks.filter((task) => !task.completed);
  const activeTopLevelTasks = topLevelTasks.filter((task) => !task.completed);

  return {
    project,
    permission: permissionEntry.level,
    permissionLabel: permissionLabel(permissionEntry.level),
    tasks,
    topLevelTasks,
    activeTasks,
    activeTopLevelTasks,
    taskById,
    childrenByParent,
    columns: Array.isArray(projectData && projectData.columns)
      ? projectData.columns
      : [],
  };
}

function normalizeTask(rawTask, fallbackProjectId) {
  const status = normalizeInteger(rawTask.status, 0);
  const priority = normalizePriorityValue(rawTask.priority);
  const dueDate = valueToString(rawTask.dueDate);
  const startDate = valueToString(rawTask.startDate);
  const quadrant = computeQuadrant(priority, dueDate);
  const completed = status === 2;
  const items = Array.isArray(rawTask.items)
    ? rawTask.items
        .filter((item) => !isSoftDeleted(item))
        .map(normalizeChecklistItem)
    : [];

  return {
    raw: rawTask,
    id: valueToString(rawTask.id),
    projectId: valueToString(rawTask.projectId || fallbackProjectId),
    parentId: valueToString(rawTask.parentId),
    title: valueToString(rawTask.title) || "（无标题任务）",
    content: valueToString(rawTask.content),
    desc: valueToString(rawTask.desc),
    status,
    completed,
    completedTime: valueToString(rawTask.completedTime),
    priority,
    priorityLabel: priorityLabel(priority),
    startDate,
    dueDate,
    isAllDay: Boolean(rawTask.isAllDay),
    timeZone: valueToString(rawTask.timeZone),
    repeatFlag: valueToString(rawTask.repeatFlag),
    sortOrder: normalizeInteger(rawTask.sortOrder, 0),
    reminders: Array.isArray(rawTask.reminders) ? rawTask.reminders : [],
    items,
    quadrant,
  };
}

function normalizeChecklistItem(item) {
  const status = normalizeInteger(item.status, 0);
  return {
    raw: item,
    id: valueToString(item.id),
    title: valueToString(item.title) || "（无标题子任务）",
    status,
    completed: status === 1,
    completedTime: valueToString(item.completedTime),
    startDate: valueToString(item.startDate),
    isAllDay: Boolean(item.isAllDay),
    timeZone: valueToString(item.timeZone),
    sortOrder: normalizeInteger(item.sortOrder, 0),
  };
}

function generateStaticMarkdown(snapshot) {
  const stats = computeSnapshotStats(snapshot);
  const lines = [];
  lines.push("# TicktickManager 静态任务快照");
  lines.push("");
  lines.push(`更新时间：${snapshot.localRefreshedAt}`);
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push(
    `- 白名单项目数：${snapshot.context.whitelistedProjectIds.length}`
  );
  lines.push(`- 仅可创建任务项目数：${snapshot.context.createOnlyIds.length}`);
  lines.push(`- 全权限项目数：${snapshot.context.fullAccessIds.length}`);
  lines.push(`- 未完成任务数：${stats.activeTaskCount}`);
  lines.push(`- 第一象限 重要且紧急：${stats.quadrants.q1}`);
  lines.push(`- 第二象限 重要不紧急：${stats.quadrants.q2}`);
  lines.push(`- 第三象限 不重要但紧急：${stats.quadrants.q3}`);
  lines.push(`- 第四象限 不重要不紧急：${stats.quadrants.q4}`);

  if (snapshot.warnings.length > 0) {
    lines.push("");
    lines.push("### 配置警告");
    for (const warning of snapshot.warnings) {
      lines.push(`- ${sanitizeMarkdown(warning, 300)}`);
    }
  }

  if (snapshot.skippedProjects.length > 0) {
    lines.push("");
    lines.push("### 已跳过项目");
    for (const skipped of snapshot.skippedProjects) {
      lines.push(
        `- ${sanitizeMarkdown(skipped.project_id)}：${sanitizeMarkdown(
          skipped.reason
        )}`
      );
    }
  }

  if (snapshot.failedProjects.length > 0) {
    lines.push("");
    lines.push("### 拉取失败项目");
    for (const failed of snapshot.failedProjects) {
      lines.push(
        `- ${sanitizeMarkdown(
          failed.project_name || failed.project_id
        )}（${sanitizeMarkdown(failed.project_id)}）：${sanitizeMarkdown(
          failed.error,
          300
        )}`
      );
    }
  }

  if (snapshot.projects.length === 0) {
    lines.push("");
    lines.push("## 项目");
    lines.push("");
    lines.push(
      "当前没有可注入的白名单任务项目。请检查 config.env 的项目清单、token 和项目类型。"
    );
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  const sortedProjects = snapshot.projects
    .slice()
    .sort((a, b) => safeCompare(a.project.name, b.project.name));
  for (const projectSnapshot of sortedProjects) {
    appendProjectMarkdown(lines, projectSnapshot);
  }

  return `${lines.join("\n")}\n`;
}

function appendProjectMarkdown(lines, projectSnapshot) {
  const activeTasks = sortTasksForDisplay(projectSnapshot.activeTopLevelTasks);
  lines.push("");
  lines.push(
    `## 项目：${sanitizeMarkdown(
      projectSnapshot.project.name || "未命名项目",
      120
    )}`
  );
  lines.push("");
  lines.push(`- 项目ID：${sanitizeMarkdown(projectSnapshot.project.id)}`);
  lines.push(`- 权限：${projectSnapshot.permissionLabel}`);
  lines.push(
    `- 视图：${sanitizeMarkdown(projectSnapshot.project.viewMode || "unknown")}`
  );
  lines.push(`- 任务数：${projectSnapshot.activeTasks.length}`);
  lines.push("");
  lines.push("### 任务");
  lines.push("");

  if (activeTasks.length === 0) {
    lines.push("- （无未完成任务）");
    return;
  }

  for (const task of activeTasks) {
    appendTaskMarkdown(lines, task, projectSnapshot, "");
  }
}

function appendTaskMarkdown(lines, task, projectSnapshot, indent) {
  const checkbox = task.completed ? "[x]" : "[ ]";
  lines.push(`${indent}- ${checkbox} ${sanitizeMarkdown(task.title, 160)}`);
  lines.push(`${indent}  - task_id：${sanitizeMarkdown(task.id)}`);
  lines.push(`${indent}  - project_id：${sanitizeMarkdown(task.projectId)}`);
  if (task.parentId) {
    lines.push(`${indent}  - parent_id：${sanitizeMarkdown(task.parentId)}`);
  }
  lines.push(
    `${indent}  - 重要性：${task.quadrant.importance} priority=${task.priority} ${task.priorityLabel}`
  );
  lines.push(`${indent}  - 紧急性：${task.quadrant.urgencyReason}`);
  if (task.dueDate) {
    lines.push(`${indent}  - dueDate：${sanitizeMarkdown(task.dueDate)}`);
  }
  if (task.startDate) {
    lines.push(`${indent}  - startDate：${sanitizeMarkdown(task.startDate)}`);
  }
  if (task.content) {
    lines.push(
      `${indent}  - content 摘要：${sanitizeMarkdown(task.content, 300)}`
    );
  }
  if (task.desc) {
    lines.push(`${indent}  - desc 摘要：${sanitizeMarkdown(task.desc, 300)}`);
  }

  const childTasks = sortTasksForDisplay(
    (projectSnapshot.childrenByParent.get(task.id) || []).filter(
      (child) => !child.completed
    )
  );
  const checklistItems = task.items
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, 20);
  if (childTasks.length > 0 || checklistItems.length > 0) {
    const headingLevel = Math.min(4 + indent.length / 2, 6);
    lines.push(
      `${indent}  ${"#".repeat(headingLevel)} "${sanitizeMarkdown(
        task.title,
        60
      )}" 的子任务`
    );
    for (const child of childTasks) {
      appendTaskMarkdown(lines, child, projectSnapshot, indent + "  ");
    }
    for (const item of checklistItems) {
      const itemCheckbox = item.completed ? "[x]" : "[ ]";
      lines.push(
        `${indent}  - ${itemCheckbox} ${sanitizeMarkdown(item.title, 160)}`
      );
      lines.push(`${indent}    - item_id：${sanitizeMarkdown(item.id)}`);
      lines.push(
        `${indent}    - 状态：${item.completed ? "已完成" : "未完成"}`
      );
      if (item.startDate) {
        lines.push(
          `${indent}    - startDate：${sanitizeMarkdown(item.startDate)}`
        );
      }
    }
    if (task.items.length > 20) {
      lines.push(`${indent}  - ……清单项超过 20 条，已截断显示。`);
    }
  }
}

function computeSnapshotStats(snapshot) {
  const quadrants = { q1: 0, q2: 0, q3: 0, q4: 0 };
  let activeTaskCount = 0;
  for (const project of snapshot.projects) {
    for (const task of project.activeTasks) {
      activeTaskCount += 1;
      quadrants[task.quadrant.key] += 1;
    }
  }
  return { activeTaskCount, quadrants };
}

function searchSnapshot(snapshot, searchTerm, options) {
  const term = String(searchTerm).toLowerCase();
  const results = [];
  for (const project of snapshot.projects) {
    for (const task of project.tasks) {
      if (!options.includeCompleted && task.completed) {
        continue;
      }
      const matches = collectTaskMatches(task, term);
      if (matches.length === 0) {
        continue;
      }
      results.push({
        project_name: project.project.name,
        project_id: project.project.id,
        permission: project.permissionLabel,
        task_id: task.id,
        parent_task_id: task.parentId || undefined,
        title: task.title,
        completed: task.completed,
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate || undefined,
        quadrant: task.quadrant.label,
        matches,
      });
      if (results.length >= options.maxResults) {
        return results;
      }
    }
  }
  return results;
}

function collectTaskMatches(task, lowerTerm) {
  const fields = [
    ["title", task.title],
    ["content", task.content],
    ["desc", task.desc],
  ];
  for (const item of task.items) {
    fields.push([`items.${item.id || "unknown"}.title`, item.title]);
  }

  const matches = [];
  for (const [field, value] of fields) {
    const text = valueToString(value);
    if (!text) {
      continue;
    }
    const lower = text.toLowerCase();
    const index = lower.indexOf(lowerTerm);
    if (index >= 0) {
      matches.push({
        field,
        context: buildSearchContext(text, index, lowerTerm.length),
      });
    }
  }
  return matches;
}

function buildSearchContext(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return sanitizeMarkdown(`${prefix}${text.slice(start, end)}${suffix}`, 160);
}

async function getPermissionContext(force = false) {
  const runtimeConfig = loadRuntimeConfig();
  ensureClient(runtimeConfig);
  const signature = permissionSignature(runtimeConfig);
  if (
    !force &&
    permissionContextCache &&
    permissionContextCache.signature === signature
  ) {
    return permissionContextCache;
  }

  const createList = parseQuotedProjectList(
    runtimeConfig.createOnlyProjectsRaw,
    "TICKTICK_CREATE_ONLY_PROJECTS"
  );
  const fullList = parseQuotedProjectList(
    runtimeConfig.fullAccessProjectsRaw,
    "TICKTICK_FULL_ACCESS_PROJECTS"
  );
  const projects = await ticktickClient.getProjects();
  if (!Array.isArray(projects)) {
    throw new PluginError(
      "API_ERROR",
      "GET /project 返回值不是项目数组。",
      "请确认 baseurl 是否指向滴答清单 OpenAPI v1。",
      { projects }
    );
  }

  const projectById = new Map();
  const projectsByName = new Map();
  for (const project of projects) {
    if (!project || !project.id) {
      continue;
    }
    projectById.set(String(project.id), project);
    const name = valueToString(project.name);
    if (name) {
      if (!projectsByName.has(name)) {
        projectsByName.set(name, []);
      }
      projectsByName.get(name).push(project);
      // also index without leading emoji/symbol prefix
      const stripped = name.replace(/^[^\w\u4e00-\u9fff0-9]+/u, "");
      if (stripped && stripped !== name) {
        if (!projectsByName.has(stripped)) {
          projectsByName.set(stripped, []);
        }
        projectsByName.get(stripped).push(project);
      }
    }
  }

  const warnings = [...createList.warnings, ...fullList.warnings];
  const permissionByProjectId = new Map();
  const createOnlyIds = [];
  const fullAccessIds = [];
  const configuredInboxProjectId = runtimeConfig.inboxProjectId;

  for (const item of createList.items) {
    const project = await resolveConfiguredProjectItem(
      item,
      projectById,
      projectsByName,
      "TICKTICK_CREATE_ONLY_PROJECTS",
      warnings,
      configuredInboxProjectId
    );
    if (!project) {
      continue;
    }
    if (!permissionByProjectId.has(project.id)) {
      permissionByProjectId.set(project.id, {
        level: "create_only",
        project,
        configuredBy: item,
      });
      createOnlyIds.push(project.id);
    }
  }

  for (const item of fullList.items) {
    const project = await resolveConfiguredProjectItem(
      item,
      projectById,
      projectsByName,
      "TICKTICK_FULL_ACCESS_PROJECTS",
      warnings,
      configuredInboxProjectId
    );
    if (!project) {
      continue;
    }
    const previous = permissionByProjectId.get(project.id);
    if (previous && previous.level === "create_only") {
      warnings.push(
        `项目 ${
          project.name || project.id
        } 同时出现在仅创建和全权限清单中，已按全权限处理。`
      );
      const index = createOnlyIds.indexOf(project.id);
      if (index >= 0) {
        createOnlyIds.splice(index, 1);
      }
    }
    if (
      !permissionByProjectId.has(project.id) ||
      permissionByProjectId.get(project.id).level !== "full_access"
    ) {
      permissionByProjectId.set(project.id, {
        level: "full_access",
        project,
        configuredBy: item,
      });
      if (!fullAccessIds.includes(project.id)) {
        fullAccessIds.push(project.id);
      }
    }
  }

  const whitelistedProjectIds = [
    ...new Set([...createOnlyIds, ...fullAccessIds]),
  ];
  permissionContextCache = {
    signature,
    runtimeConfig,
    projects,
    projectById,
    projectsByName,
    permissionByProjectId,
    createOnlyIds,
    fullAccessIds,
    whitelistedProjectIds,
    warnings,
  };
  return permissionContextCache;
}

async function resolveProjectForAction(projectRef, action) {
  const context = await getPermissionContext(false);
  const ref = valueToString(projectRef).trim();
  if (!ref) {
    throw new PluginError(
      "VALIDATION_ERROR",
      "project_id 不能为空。",
      "请传入白名单项目 ID 或唯一项目名称。"
    );
  }

  let project = context.projectById.get(ref);
  if (!project) {
    const candidates = context.projectsByName.get(ref) || [];
    if (candidates.length > 1) {
      throw new PluginError(
        "CONFIG_ERROR",
        `项目名称“${ref}”存在重名，无法安全解析。`,
        "请改用项目 ID。"
      );
    }
    if (candidates.length === 1) {
      project = candidates[0];
    }
  }

  if (!project) {
    throw new PluginError(
      "PERMISSION_DENIED",
      `项目“${ref}”不存在或不在当前账号项目列表中。`,
      "请确认 project_id 是否正确，并且该项目已配置到白名单。"
    );
  }

  const permissionEntry = context.permissionByProjectId.get(project.id);
  if (!permissionEntry) {
    throw new PluginError(
      "PERMISSION_DENIED",
      `项目“${project.name || project.id}”不是白名单项目，拒绝读取或操作。`,
      "请将该项目 ID 或唯一名称加入 TICKTICK_CREATE_ONLY_PROJECTS 或 TICKTICK_FULL_ACCESS_PROJECTS。"
    );
  }

  if (action === "write" && permissionEntry.level !== "full_access") {
    throw new PluginError(
      "PERMISSION_DENIED",
      "权限不足：该项目仅允许创建任务，不能更新、完成或删除任务。",
      "请确认 project_id 是否属于 TICKTICK_FULL_ACCESS_PROJECTS。"
    );
  }

  if ((action === "create" || action === "write") && project.closed === true) {
    throw new PluginError(
      "PERMISSION_DENIED",
      "项目已关闭，拒绝写入任务。",
      "请改用未关闭的白名单任务项目。"
    );
  }

  if (
    (action === "create" || action === "write") &&
    project.kind &&
    String(project.kind).toUpperCase() !== "TASK"
  ) {
    throw new PluginError(
      "PERMISSION_DENIED",
      `项目 kind=${project.kind}，不是任务清单，拒绝写入任务。`,
      "请改用 kind=TASK 的项目。"
    );
  }

  return {
    project,
    permissionEntry,
    permission: permissionEntry.level,
    permissionLabel: permissionLabel(permissionEntry.level),
  };
}

async function resolveConfiguredProjectItem(
  item,
  projectById,
  projectsByName,
  configKey,
  warnings,
  configuredInboxProjectId
) {
  const normalizedItem = valueToString(item).trim();
  if (isInboxAliasProjectRef(normalizedItem)) {
    const inboxProjectId = valueToString(configuredInboxProjectId).trim();
    if (!isInboxRealProjectId(inboxProjectId)) {
      warnings.push(
        `${configKey} 中配置了“${normalizedItem}”，但未填写有效的 TICKTICK_INBOX_PROJECT_ID，已跳过该清单。`
      );
      return null;
    }
    const inboxProject = buildInboxProject(inboxProjectId);
    projectById.set(inboxProject.id, inboxProject);
    indexProjectAlias(projectsByName, normalizedItem, inboxProject);
    indexProjectAlias(projectsByName, "收集箱", inboxProject);
    indexProjectAlias(projectsByName, "inbox", inboxProject);
    return inboxProject;
  }

  if (isInboxRealProjectId(normalizedItem)) {
    const inboxProject =
      projectById.get(normalizedItem) || buildInboxProject(normalizedItem);
    projectById.set(inboxProject.id, inboxProject);
    indexProjectAlias(projectsByName, normalizedItem, inboxProject);
    indexProjectAlias(projectsByName, "收集箱", inboxProject);
    indexProjectAlias(projectsByName, "inbox", inboxProject);
    return inboxProject;
  }

  if (projectById.has(normalizedItem)) {
    return projectById.get(normalizedItem);
  }
  const candidates = projectsByName.get(normalizedItem) || [];
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new PluginError(
      "CONFIG_ERROR",
      `${configKey} 中的项目名称"${normalizedItem}"存在重名。`,
      "请在 config.env 中改用项目 ID。"
    );
  }
  warnings.push(
    `${configKey} 中的项目"${normalizedItem}"未在滴答清单项目列表中找到，已跳过。`
  );
  return null;
}

function isInboxAliasProjectRef(value) {
  const text = valueToString(value).trim().toLowerCase();
  return text === "inbox" || text === "收集箱";
}

function isInboxRealProjectId(value) {
  return /^inbox\d+$/i.test(valueToString(value).trim());
}

function buildInboxProject(projectId) {
  return {
    id: projectId,
    name: "收集箱",
    kind: "TASK",
    viewMode: "list",
  };
}

function indexProjectAlias(projectsByName, alias, project) {
  const key = valueToString(alias).trim();
  if (!key) {
    return;
  }
  if (!projectsByName.has(key)) {
    projectsByName.set(key, []);
  }
  const bucket = projectsByName.get(key);
  if (!bucket.some((item) => item && item.id === project.id)) {
    bucket.push(project);
  }
}

function buildTaskPayload(params, options) {
  const payload = {};
  if (options.includeId) {
    payload.id = options.taskId;
  }

  payload.projectId = options.projectId;
  if (options.parentId) {
    payload.parentId = options.parentId;
  }

  const titleValue =
    options.titleOverride !== undefined
      ? options.titleOverride
      : firstDefined(params, ["title"]);
  if (options.requireTitle || titleValue !== undefined) {
    const title = valueToString(titleValue).trim();
    if (!title) {
      throw new PluginError(
        "VALIDATION_ERROR",
        "title 不能为空。",
        "请提供任务标题。"
      );
    }
    payload.title = title;
  }

  copyOptionalString(params, payload, ["content"], "content");
  copyOptionalString(params, payload, ["desc", "description"], "desc");
  copyOptionalDate(params, payload, ["start_date", "startDate"], "startDate");
  copyOptionalDate(params, payload, ["due_date", "dueDate"], "dueDate");
  copyOptionalString(params, payload, ["time_zone", "timeZone"], "timeZone");
  copyOptionalString(
    params,
    payload,
    ["repeat_flag", "repeatFlag"],
    "repeatFlag"
  );

  const isAllDayValue = firstDefined(params, ["is_all_day", "isAllDay"]);
  if (isAllDayValue !== undefined) {
    payload.isAllDay = toBooleanStrict(isAllDayValue, "is_all_day");
  }

  const priorityValue = firstDefined(params, ["priority"]);
  if (
    priorityValue !== undefined &&
    valueToString(priorityValue).trim() !== ""
  ) {
    payload.priority = parsePriority(priorityValue);
  }

  const remindersValue = firstDefined(params, ["reminders"]);
  if (
    remindersValue !== undefined &&
    valueToString(remindersValue).trim() !== ""
  ) {
    payload.reminders = parseJsonOrArray(remindersValue, "reminders", {
      allowSingleStringArray: true,
    });
  }

  const itemsValue = firstDefined(params, ["items"]);
  if (itemsValue !== undefined && valueToString(itemsValue).trim() !== "") {
    const items = parseJsonOrArray(itemsValue, "items");
    if (!Array.isArray(items)) {
      throw new PluginError(
        "VALIDATION_ERROR",
        "items 必须是数组。",
        "请传入 checklist items 的 JSON 数组。"
      );
    }
    payload.items = items;
  }

  const sortOrderValue = firstDefined(params, ["sort_order", "sortOrder"]);
  if (
    sortOrderValue !== undefined &&
    valueToString(sortOrderValue).trim() !== ""
  ) {
    payload.sortOrder = normalizeInteger(sortOrderValue, 0);
  }

  if (options.requireAnyUpdateField) {
    const updateFields = Object.keys(payload).filter(
      (key) => !["id", "projectId"].includes(key)
    );
    if (updateFields.length === 0) {
      throw new PluginError(
        "VALIDATION_ERROR",
        "没有提供任何可更新字段。",
        "请至少提供 title、content、desc、日期、priority、items 等字段之一。"
      );
    }
  }

  return payload;
}

function parseBatchTasks(params) {
  const raw = firstDefined(params, ["tasks_json", "tasksJson"]);
  if (raw !== undefined && valueToString(raw).trim() !== "") {
    const parsed = parseJsonOrArray(raw, "tasks_json");
    if (!Array.isArray(parsed)) {
      throw new PluginError(
        "VALIDATION_ERROR",
        "tasks_json 必须是 JSON 数组字符串。",
        '请传入形如 [{"title":"...","project_id":"..."}] 的数组。'
      );
    }
    return parsed;
  }

  const tasks = firstDefined(params, ["tasks"]);
  if (tasks === undefined || valueToString(tasks).trim() === "") {
    throw new PluginError(
      "VALIDATION_ERROR",
      "缺少批量任务参数。",
      "请提供 tasks_json 或 tasks。"
    );
  }

  const parsed = parseJsonOrArray(tasks, "tasks");
  if (!Array.isArray(parsed)) {
    throw new PluginError(
      "VALIDATION_ERROR",
      "tasks 必须是数组或 JSON 数组字符串。",
      "请传入任务对象数组。"
    );
  }
  return parsed;
}

function loadRuntimeConfig() {
  const envFile = readConfigEnv();
  const merged = mergeNonEmpty(envFile, process.env, pluginConfig);
  const baseUrl =
    cleanScalarValue(merged.TICKTICK_BASE_URL) || DEFAULT_BASE_URL;
  return {
    baseUrl,
    accessToken: cleanScalarValue(merged.TICKTICK_ACCESS_TOKEN),
    inboxProjectId: cleanScalarValue(
      firstDefined(merged, ["TICKTICK_INBOX_PROJECT_ID", "InboxProjectId"])
    ),
    createOnlyProjectsRaw: normalizeProjectListRaw(
      firstDefined(merged, [
        "TICKTICK_CREATE_ONLY_PROJECTS",
        "CreateOnlyProjects",
      ])
    ),
    fullAccessProjectsRaw: normalizeProjectListRaw(
      firstDefined(merged, [
        "TICKTICK_FULL_ACCESS_PROJECTS",
        "FullAccessProjects",
      ])
    ),
    debugMode: firstDefined(merged, ["DebugMode", "DEBUG_MODE"]),
    staticRefreshIntervalSeconds: toPositiveInteger(
      firstDefined(merged, [
        "StaticRefreshIntervalSeconds",
        "STATIC_REFRESH_INTERVAL_SECONDS",
      ]),
      60,
      1,
      86400
    ),
  };
}
function readConfigEnv() {
  if (!fs.existsSync(CONFIG_ENV_PATH)) {
    return {};
  }
  const content = fs.readFileSync(CONFIG_ENV_PATH, "utf8");
  return parseEnvContent(content);
}

function parseEnvContent(content) {
  const env = {};
  const lines = String(content || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = rawLine.indexOf("=");
    if (eqIndex < 0) {
      continue;
    }
    const key = rawLine.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }
    const value = stripCommentOutsideQuotes(rawLine.slice(eqIndex + 1).trim());
    env[key] = value;
  }
  return env;
}

function stripCommentOutsideQuotes(value) {
  let inQuote = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (
      char === "#" &&
      !inQuote &&
      (index === 0 || /\s/.test(value[index - 1]))
    ) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function mergeNonEmpty(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value === "string" && value.trim() === "") {
        if (!(key in merged)) {
          merged[key] = value;
        }
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function cleanScalarValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  let text = String(value).trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\"/g, '"').trim();
}

function normalizeProjectListRaw(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim().replace(/\\"/g, '"');
}

function parseQuotedProjectList(rawValue, configKey) {
  if (Array.isArray(rawValue)) {
    const items = [];
    const warnings = [];
    for (const value of rawValue) {
      const item = valueToString(value).trim();
      if (!item) {
        warnings.push(`${configKey} 中存在空项目项，已忽略。`);
        continue;
      }
      if (!items.includes(item)) {
        items.push(item);
      }
    }
    return { items, warnings };
  }

  let raw = valueToString(rawValue).trim();
  const warnings = [];
  if (!raw) {
    return { items: [], warnings };
  }

  raw = raw.replace(/\\"/g, '"');
  if (!raw.startsWith('"') && raw.includes('","')) {
    raw = `"${raw}`;
  }
  if (!raw.endsWith('"') && raw.includes('","')) {
    raw = `${raw}"`;
  }

  const items = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) {
      index += 1;
    }
    if (index >= raw.length) {
      break;
    }
    if (raw[index] !== '"') {
      throw new PluginError(
        "CONFIG_ERROR",
        `${configKey} 格式错误：每个项目项必须使用英文双引号包裹。`,
        `正确示例：${configKey}="收集箱","某个清单ID"`
      );
    }
    index += 1;
    let item = "";
    let closed = false;
    while (index < raw.length) {
      const char = raw[index];
      if (char === "\\" && raw[index + 1] === '"') {
        item += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        closed = true;
        index += 1;
        break;
      }
      item += char;
      index += 1;
    }
    if (!closed) {
      throw new PluginError(
        "CONFIG_ERROR",
        `${configKey} 格式错误：项目项缺少结束双引号。`,
        `正确示例：${configKey}="收集箱","某个清单ID"`
      );
    }

    const normalized = item.trim();
    if (!normalized) {
      warnings.push(`${configKey} 中存在空项目项，已忽略。`);
    } else if (!items.includes(normalized)) {
      items.push(normalized);
    } else {
      warnings.push(`${configKey} 中存在重复项目项“${normalized}”，已去重。`);
    }

    while (index < raw.length && /\s/.test(raw[index])) {
      index += 1;
    }
    if (index < raw.length) {
      if (raw[index] !== ",") {
        throw new PluginError(
          "CONFIG_ERROR",
          `${configKey} 格式错误：项目项之间必须使用英文逗号分隔。`,
          `正确示例：${configKey}="收集箱","某个清单ID"`
        );
      }
      index += 1;
    }
  }

  return { items, warnings };
}

function ensureClient(runtimeConfig) {
  const signature = JSON.stringify({
    baseUrl: runtimeConfig.baseUrl,
    accessToken: runtimeConfig.accessToken,
  });

  if (!ticktickClient) {
    ticktickClient = new TickTickClient(runtimeConfig);
    clientSignature = signature;
    return;
  }
  if (clientSignature !== signature) {
    ticktickClient.applyConfig(runtimeConfig);
    clientSignature = signature;
    permissionContextCache = null;
  }
}

function permissionSignature(runtimeConfig) {
  return JSON.stringify({
    baseUrl: runtimeConfig.baseUrl,
    createOnlyProjectsRaw: runtimeConfig.createOnlyProjectsRaw,
    fullAccessProjectsRaw: runtimeConfig.fullAccessProjectsRaw,
    inboxProjectId: runtimeConfig.inboxProjectId,
  });
}

function ensureFetchAvailable() {
  if (typeof globalThis.fetch !== "function") {
    throw new PluginError(
      "CONFIG_ERROR",
      "当前 Node.js 运行环境没有 globalThis.fetch。",
      "请使用 Node.js 18+ 运行 VCP，或后续为本插件补充 https 兼容层。"
    );
  }
}
function writeStaticDocument(markdown) {
  fs.writeFileSync(STATIC_DOC_PATH, markdown, "utf8");
}

function writeStaticDocumentSafely(markdown) {
  try {
    writeStaticDocument(markdown);
  } catch (error) {
    console.error(
      `[${PLUGIN_NAME}] 写入 ${STATIC_DOC_FILENAME} 失败:`,
      error.message || error
    );
  }
}

function bindRuntimePluginManager(config = {}) {
  const candidates = [
    config.pluginManager,
    config.PluginManager,
    config.vcpPluginManager,
    globalThis.pluginManager,
    globalThis.PluginManager,
    globalThis.VCPPluginManager,
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      candidate.staticPlaceholderValues &&
      typeof candidate.staticPlaceholderValues.set === "function"
    ) {
      pluginManager = candidate;
      return;
    }
  }
}

function getStaticPlaceholderStores() {
  const stores = [];
  const candidates = [
    pluginManager && pluginManager.staticPlaceholderValues,
    globalThis.staticPlaceholderValues,
    globalThis.vcpStaticPlaceholderValues,
    globalThis.pluginManager &&
      globalThis.pluginManager.staticPlaceholderValues,
    globalThis.PluginManager &&
      globalThis.PluginManager.staticPlaceholderValues,
  ];
  for (const store of candidates) {
    if (store && typeof store.set === "function" && !stores.includes(store)) {
      stores.push(store);
    }
  }
  if (stores.length === 0) {
    if (
      !pluginManager.staticPlaceholderValues ||
      typeof pluginManager.staticPlaceholderValues.set !== "function"
    ) {
      pluginManager.staticPlaceholderValues = new Map();
    }
    stores.push(pluginManager.staticPlaceholderValues);
  }
  return stores;
}

function setStaticPlaceholder(value) {
  for (const store of getStaticPlaceholderStores()) {
    const existing =
      typeof store.get === "function" ? store.get(PLACEHOLDER) : undefined;
    if (
      existing &&
      typeof existing === "object" &&
      Object.prototype.hasOwnProperty.call(existing, "value")
    ) {
      store.set(PLACEHOLDER, { value, serverId: existing.serverId || "local" });
    } else if (store === pluginManager.staticPlaceholderValues) {
      store.set(PLACEHOLDER, { value, serverId: "local" });
    } else {
      store.set(PLACEHOLDER, value);
    }
  }
}

function buildErrorMarkdown(error) {
  const normalized = normalizeError(error);
  if (isAccessTokenError(normalized)) {
    return buildAccessTokenPromptMarkdown(normalized);
  }
  return [
    "# TicktickManager 静态任务快照",
    "",
    `更新时间：${formatLocalTimestamp(new Date())}`,
    "",
    "## 快照刷新失败",
    "",
    `- 错误类型：${normalized.code}`,
    `- 错误信息：${sanitizeMarkdown(normalized.message, 500)}`,
    normalized.hint
      ? `- 处理建议：${sanitizeMarkdown(normalized.hint, 500)}`
      : "- 处理建议：请检查 config.env、网络和滴答清单 OpenAPI 状态。",
    "",
  ].join("\n");
}
function buildSuccess(command, message, data = {}, extra = {}) {
  return {
    success: true,
    command,
    message,
    data,
    static_refreshed: extra.static_refreshed || false,
    static_doc_path: extra.static_doc_path || STATIC_DOC_FILENAME,
    refreshed_at:
      extra.refreshed_at || (snapshotCache ? snapshotCache.refreshedAt : null),
    ...(extra.refresh_error ? { refresh_error: extra.refresh_error } : {}),
  };
}

function buildFailure(command, error) {
  const normalized = normalizeError(error);
  return {
    success: false,
    command,
    error_code: normalized.code,
    error: normalized.message,
    hint: normalized.hint,
    details: normalized.details,
  };
}

function normalizeError(error) {
  if (error instanceof PluginError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint || "",
      details: error.details,
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: error && error.message ? error.message : String(error),
    hint: "请查看 VCP 控制台日志获取更多上下文。",
    details: undefined,
  };
}

function normalizeErrorMessage(error) {
  return normalizeError(error).message;
}

function taskToPublic(task, projectSnapshot, includeRaw = false) {
  const children =
    projectSnapshot.childrenByParent &&
    projectSnapshot.childrenByParent.get(task.id)
      ? projectSnapshot.childrenByParent
          .get(task.id)
          .map((child) => taskToPublic(child, projectSnapshot, false))
      : [];
  return {
    projectId: task.projectId,
    parentId: task.parentId || undefined,
    title: task.title,
    content: task.content || undefined,
    desc: task.desc || undefined,
    status: task.status,
    completed: task.completed,
    completedTime: task.completedTime || undefined,
    priority: task.priority,
    priorityLabel: task.priorityLabel,
    startDate: task.startDate || undefined,
    dueDate: task.dueDate || undefined,
    isAllDay: task.isAllDay,
    timeZone: task.timeZone || undefined,
    repeatFlag: task.repeatFlag || undefined,
    reminders: task.reminders,
    quadrant: task.quadrant,
    checklist_items: Array.isArray(task.items)
      ? task.items.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          completed: item.completed,
          completedTime: item.completedTime || undefined,
          startDate: item.startDate || undefined,
          isAllDay: item.isAllDay,
          timeZone: item.timeZone || undefined,
        }))
      : [],
    child_tasks: children,
    ...(includeRaw ? { raw: task.raw } : {}),
  };
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    closed: project.closed,
    groupId: project.groupId,
    viewMode: project.viewMode,
    kind: project.kind,
    permission: project.permission,
  };
}

function projectSummary(projectSnapshot) {
  const quadrants = { q1: 0, q2: 0, q3: 0, q4: 0 };
  for (const task of projectSnapshot.activeTasks) {
    quadrants[task.quadrant.key] += 1;
  }
  return {
    task_count: projectSnapshot.tasks.length,
    active_task_count: projectSnapshot.activeTasks.length,
    active_top_level_task_count: projectSnapshot.activeTopLevelTasks.length,
    quadrants,
  };
}

function computeQuadrant(priority, dueDate) {
  const important = priority === 3 || priority === 5;
  const due = parseTickDate(dueDate);
  let urgent = false;
  let urgencyReason = "无到期时间";
  if (due) {
    const now = new Date();
    const diffMs = due.getTime() - now.getTime();
    if (diffMs < 0) {
      urgent = true;
      urgencyReason = "已过期";
    } else if (isSameLocalDate(due, now)) {
      urgent = true;
      urgencyReason = "今日到期";
    } else if (diffMs <= 48 * 60 * 60 * 1000) {
      urgent = true;
      urgencyReason = "未来 48 小时内到期";
    } else {
      urgencyReason = "超过 48 小时后到期";
    }
  }

  if (important && urgent) {
    return {
      key: "q1",
      label: "第一象限 重要且紧急",
      importance: "重要",
      urgent: true,
      urgencyReason,
    };
  }
  if (important && !urgent) {
    return {
      key: "q2",
      label: "第二象限 重要不紧急",
      importance: "重要",
      urgent: false,
      urgencyReason,
    };
  }
  if (!important && urgent) {
    return {
      key: "q3",
      label: "第三象限 不重要但紧急",
      importance: "不重要",
      urgent: true,
      urgencyReason,
    };
  }
  return {
    key: "q4",
    label: "第四象限 不重要不紧急",
    importance: "不重要",
    urgent: false,
    urgencyReason,
  };
}

function parseTickDate(value) {
  const text = valueToString(value).trim();
  if (!text) {
    return null;
  }
  const normalized = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function isSameLocalDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isSoftDeleted(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    isTruthy(value.deleted) ||
    isTruthy(value.isDeleted) ||
    isTruthy(value.trashed) ||
    isTruthy(value.inTrash)
  );
}

function isTruthy(value) {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "y", "deleted", "trash", "trashed"].includes(
      value.trim().toLowerCase()
    );
  }
  return false;
}

function sortTasksForDisplay(tasks) {
  return tasks.slice().sort((a, b) => {
    if (a.completed !== b.completed) {
      return a.completed ? 1 : -1;
    }
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    const aDue = parseTickDate(a.dueDate);
    const bDue = parseTickDate(b.dueDate);
    if (aDue && bDue && aDue.getTime() !== bDue.getTime()) {
      return aDue.getTime() - bDue.getTime();
    }
    if (aDue && !bDue) {
      return -1;
    }
    if (!aDue && bDue) {
      return 1;
    }
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return safeCompare(a.title, b.title);
  });
}

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iterator(items[currentIndex], currentIndex);
    }
  }
  const workers = [];
  const workerCount = Math.min(limit, items.length);
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function copyOptionalString(params, payload, names, targetName) {
  const value = firstDefined(params, names);
  if (value !== undefined) {
    payload[targetName] = valueToString(value);
  }
}

function copyOptionalDate(params, payload, names, targetName) {
  const value = firstDefined(params, names);
  if (value !== undefined && valueToString(value).trim() !== "") {
    const text = valueToString(value).trim();
    if (!parseTickDate(text)) {
      throw new PluginError(
        "VALIDATION_ERROR",
        `${names[0]} 日期格式无法解析。`,
        "建议使用 yyyy-MM-ddTHH:mm:ssZ，例如 2026-05-26T09:00:00+0800。"
      );
    }
    payload[targetName] = text;
  }
}

function parsePriority(value) {
  const priority = Number(value);
  if (!Number.isInteger(priority) || !VALID_PRIORITIES.has(priority)) {
    throw new PluginError(
      "VALIDATION_ERROR",
      "priority 只能是 0、1、3、5。",
      "0=None，1=Low，3=Medium，5=High。"
    );
  }
  return priority;
}

function normalizePriorityValue(value) {
  const priority = Number(value);
  return VALID_PRIORITIES.has(priority) ? priority : 0;
}

function priorityLabel(priority) {
  switch (priority) {
    case 5:
      return "High";
    case 3:
      return "Medium";
    case 1:
      return "Low";
    default:
      return "None";
  }
}

function permissionLabel(level) {
  return level === "full_access" ? "全权限" : "仅可创建任务";
}

function parseJsonOrArray(value, fieldName, options = {}) {
  if (Array.isArray(value) || (value && typeof value === "object")) {
    return value;
  }
  const text = valueToString(value).trim();
  if (!text) {
    return undefined;
  }
  if (
    options.allowSingleStringArray &&
    !text.startsWith("[") &&
    !text.startsWith("{")
  ) {
    return [text];
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PluginError(
      "VALIDATION_ERROR",
      `${fieldName} 不是合法 JSON。`,
      `请检查 ${fieldName} 的 JSON 格式。`
    );
  }
}

function requiredString(source, names, displayName) {
  const value = firstDefined(source, names);
  const text = valueToString(value).trim();
  if (!text) {
    throw new PluginError(
      "VALIDATION_ERROR",
      `缺少必需参数：${displayName}。`,
      `请提供 ${displayName}。`
    );
  }
  return text;
}

function firstDefined(source, names) {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  for (const name of names) {
    if (
      Object.prototype.hasOwnProperty.call(source, name) &&
      source[name] !== undefined
    ) {
      return source[name];
    }
  }
  return undefined;
}

function valueToString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function normalizeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toPositiveInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on", "是"].includes(text)) {
    return true;
  }
  if (["false", "0", "no", "n", "off", "否"].includes(text)) {
    return false;
  }
  return fallback;
}

function toBooleanStrict(value, fieldName) {
  const result = toBoolean(value, undefined);
  if (result === undefined) {
    throw new PluginError(
      "VALIDATION_ERROR",
      `${fieldName} 必须是布尔值。`,
      "请传入 true 或 false。"
    );
  }
  return result;
}

function sanitizeMarkdown(value, maxLength = 300) {
  let text = valueToString(value);
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = text.replace(
    /<<<\s*\[\s*TOOL_REQUEST\s*\]\s*>>>/gi,
    "＜＜＜[TOOL_REQUEST]＞＞＞"
  );
  text = text.replace(
    /<<<\s*\[\s*END_TOOL_REQUEST\s*\]\s*>>>/gi,
    "＜＜＜[END_TOOL_REQUEST]＞＞＞"
  );
  text = text.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }");
  text = text.replace(/vcp_fold/gi, "vcp_ fold");
  text = text.replace(/\r?\n/g, " / ");
  text = text.trim();
  if (maxLength > 0 && text.length > maxLength) {
    return `${text.slice(0, maxLength)}…`;
  }
  return text;
}

function safeCompare(a, b) {
  return valueToString(a).localeCompare(valueToString(b), "zh-CN");
}

function formatLocalTimestamp(date) {
  try {
    return `${date.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    })} Asia/Shanghai`;
  } catch (error) {
    return `${date.toISOString()} UTC`;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function secondsToCron(seconds) {
  const normalizedSeconds = toPositiveInteger(seconds, 60, 1, 86400);
  if (normalizedSeconds < 60) {
    return `*/${normalizedSeconds} * * * * *`;
  }
  if (normalizedSeconds % 3600 === 0) {
    const hours = normalizedSeconds / 3600;
    return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
  }
  if (normalizedSeconds % 60 === 0) {
    const minutes = normalizedSeconds / 60;
    return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`;
  }
  return DEFAULT_STATIC_REFRESH_CRON;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function createAccessTokenError(message, details = undefined) {
  return new PluginError(
    "AUTH_ERROR",
    message,
    "请让账号持有者使用插件根目录中的独立脚本或滴答清单官方方式获取新的 TICKTICK_ACCESS_TOKEN，填入 config.env 后重启 VCPToolBox；本插件不会自动获取或刷新 token。",
    sanitizeAuthErrorDetails(details)
  );
}

function sanitizeAuthErrorDetails(details) {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  return {
    method: details.method,
    endpoint: details.endpoint,
    status: details.status,
    auth_error: true,
  };
}

function isAccessTokenAuthFailure(status, parsed) {
  if (status === 401) {
    return true;
  }
  if (status !== 403) {
    return false;
  }
  const text = JSON.stringify(parsed || {}).toLowerCase();
  return /access[_ -]?token|bearer|unauthori[sz]ed|invalid[_ -]?token|expired|auth/.test(
    text
  );
}

function isAccessTokenError(errorOrNormalized) {
  const normalized =
    errorOrNormalized && errorOrNormalized.code
      ? errorOrNormalized
      : normalizeError(errorOrNormalized);
  if (normalized.code !== "AUTH_ERROR") {
    return false;
  }
  const text = `${normalized.message || ""} ${normalized.hint || ""}`;
  return /TICKTICK_ACCESS_TOKEN|access token/i.test(text);
}

function updateStaticAuthPromptIfNeeded(error) {
  if (!isAccessTokenError(error)) {
    return;
  }
  const markdown = buildAccessTokenPromptMarkdown(normalizeError(error));
  writeStaticDocumentSafely(markdown);
  setStaticPlaceholder(markdown);
}

function buildAccessTokenPromptMarkdown(error) {
  const normalized = error && error.code ? error : normalizeError(error);
  return [
    "# TicktickManager 静态任务快照",
    "",
    `更新时间：${formatLocalTimestamp(new Date())}`,
    "",
    "## 需要更新 TICKTICK_ACCESS_TOKEN",
    "",
    "当前 TicktickManager 无法访问滴答清单 OpenAPI。请主动提醒账号持有者：需要重新获取 TICKTICK_ACCESS_TOKEN，填入插件 config.env，然后重启 VCPToolBox。",
    "",
    "### 原因",
    "",
    `- 错误类型：${sanitizeMarkdown(normalized.code || "AUTH_ERROR")}`,
    `- 错误信息：${sanitizeMarkdown(
      normalized.message || "TICKTICK_ACCESS_TOKEN 缺失、错误或过期。",
      500
    )}`,
    "- 滴答清单当前政策不再提供刷新令牌，TICKTICK_ACCESS_TOKEN 有效期约半年。",
    "- 本插件不会在 VCPToolBox 运行环境中自动获取、刷新或写回 token。",
    "",
    "### 账号持有者需要执行",
    "",
    "1. 在插件根目录使用独立获取脚本，或按滴答清单官方方式获取新的 TICKTICK_ACCESS_TOKEN。",
    "2. 打开 TicktickManager 的 config.env，更新 TICKTICK_ACCESS_TOKEN。",
    "3. 不要再填写或依赖刷新令牌。",
    "4. 重启 VCPToolBox，让插件重新加载配置并由 VCP 静态注入机制刷新内容。",
    "",
    "在账号持有者完成以上步骤前，请不要继续调用 TicktickManager 的任务创建、更新、删除或读取功能。",
    "",
  ].join("\n");
}

function getStaticRefreshAuthError(runtimeConfig) {
  if (runtimeConfig && runtimeConfig.accessToken) {
    return null;
  }
  return createAccessTokenError(
    "缺少 TICKTICK_ACCESS_TOKEN，TicktickManager 静态刷新已跳过。"
  );
}

async function runStaticRefreshCli() {
  runningAsStaticCli = true;
  try {
    const runtimeConfig = loadRuntimeConfig();
    pluginConfig = { ...pluginConfig, ...runtimeConfig };
    debugMode = toBoolean(runtimeConfig.debugMode, false);

    const authError = getStaticRefreshAuthError(runtimeConfig);
    if (authError) {
      const markdown = buildErrorMarkdown(authError);
      writeStaticDocumentSafely(markdown);
      process.stdout.write(markdown.trimEnd());
      process.exitCode = 0;
      return;
    }

    ensureClient(runtimeConfig);
    await refreshStaticSnapshot({ reason: "vcp_cron" });
    const markdown = fs.readFileSync(STATIC_DOC_PATH, "utf8");
    process.stdout.write(markdown.trimEnd());
    process.exitCode = 0;
  } catch (error) {
    const markdown = buildErrorMarkdown(error);
    writeStaticDocumentSafely(markdown);
    process.stdout.write(markdown.trimEnd());
    if (!isAccessTokenError(error)) {
      console.error(
        `[${PLUGIN_NAME}] VCP cron 静态刷新失败:`,
        error && error.stack ? error.stack : error
      );
    }
    process.exitCode = 0;
  }
}

module.exports = {
  initialize,
  registerRoutes,
  processToolCall,
  shutdown,
  runStaticRefreshCli,
  __private: {
    parseQuotedProjectList,
    parseEnvContent,
    computeQuadrant,
    sanitizeMarkdown,
    refreshStaticSnapshot,
    registerStaticCronProxy,
    secondsToCron,
  },
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--static-refresh")) {
    runStaticRefreshCli().catch((error) => {
      const markdown = buildErrorMarkdown(error);
      writeStaticDocumentSafely(markdown);
      process.stdout.write(markdown.trimEnd());
      if (!isAccessTokenError(error)) {
        console.error(
          `[${PLUGIN_NAME}] VCP cron 静态刷新入口异常:`,
          error && error.stack ? error.stack : error
        );
      }
      process.exitCode = 0;
    });
  }
}
