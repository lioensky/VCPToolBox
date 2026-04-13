const { createMemoStore } = require('./memoStore.js');
const memoFormat = require('./memoFormat.js');
const { storeAttachments } = require('./attachmentStore.js');
const { buildRuntimeContext, ensureRuntimeDirectories } = require('./runtime.js');
const { createTaskRegistry, mapTaskToEvent } = require('./taskRegistry.js');
const { ERROR_CODES, memoError } = require('./errorCodes.js');
const { createReviewService } = require('./reviewService.js');
const { createImportService } = require('./importService.js');
const { createMaintenanceService } = require('./maintenanceService.js');

const state = {
  config: {},
  runtimeContext: null,
  wss: null,
  memoStore: null,
  taskRegistry: null,
  wsCleanup: null,
  reviewService: null,
  importService: null,
  maintenanceService: null,
  memoUploadMiddleware: null,
};

module.exports = {
  async initialize(config = {}, dependencies = {}) {
    state.config = config;
    state.runtimeContext = buildRuntimeContext({
      config,
      projectBasePath: config.PROJECT_BASE_PATH,
      pluginManager: dependencies.pluginManager || getPluginManager(),
    });
    await ensureRuntimeDirectories(state.runtimeContext);
    state.memoStore = createMemoStore({
      runtimeContext: state.runtimeContext,
      memoFormat,
    });
    state.taskRegistry = createTaskRegistry({
      ttlMs: getTaskTtlMs(config),
      onTaskEvent(event) {
        if (!state.wss) {
          return;
        }

        dispatchTaskEvent({
          wss: state.wss,
          taskRegistry: state.taskRegistry,
          event,
        });
      },
    });
    hydrateDerivedServices();
  },

  registerApiRoutes(router, config, projectBasePath, wss) {
    state.wss = wss || null;

    if (!state.runtimeContext) {
      state.runtimeContext = buildRuntimeContext({
        config: config || state.config,
        projectBasePath,
        pluginManager: getPluginManager(),
      });
    }

    if (!state.memoStore) {
      state.memoStore = createMemoStore({
        runtimeContext: state.runtimeContext,
        memoFormat,
      });
    }

    if (!state.taskRegistry) {
      state.taskRegistry = createTaskRegistry({
        ttlMs: getTaskTtlMs(config || state.config),
      });
    }

    hydrateDerivedServices();

    if (state.wss && !state.wsCleanup) {
      state.wsCleanup = registerMemoInboxWebSocket({
        wss: state.wss,
        taskRegistry: state.taskRegistry,
      });
    }

    router.get('/status', (req, res) => {
      res.json({
        status: 'ok',
        plugin: 'MemoInboxAPI',
        memoDiaryName: state.runtimeContext.memoDiaryName,
        imageServerKeyConfigured: Boolean(state.runtimeContext.imageServerKey),
      });
    });

    router.post('/memos', async (req, res) => {
      try {
        await runMemoUploadMiddleware(req, res);
        const parsedBody = normalizeMemoBody(req.body || {});

        if (typeof parsedBody.content !== 'string' || parsedBody.content.trim() === '') {
          return memoError(res, ERROR_CODES.INVALID_REQUEST, 'content is required', 400);
        }

        const memoId = memoFormat.createMemoId();

        const attachments = await collectMemoAttachments({
          req,
          body: parsedBody,
          runtimeContext: state.runtimeContext,
          memoId,
        });

        const created = await state.memoStore.create({
          memoId,
          content: parsedBody.content,
          source: parsedBody.source || 'api',
          tags: Array.isArray(parsedBody.tags) ? parsedBody.tags : null,
          attachments,
        });
        return res.status(201).json(created);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.get('/memos/:memoId', async (req, res) => {
      try {
        const memo = await state.memoStore.getById(req.params.memoId);
        return res.json(memo);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.patch('/memos/:memoId', async (req, res) => {
      try {
        await runMemoUploadMiddleware(req, res);
        const parsedBody = normalizeMemoBody(req.body || {});
        const hasFiles = Array.isArray(req.files) && req.files.length > 0;
        const hasPatchPayload =
          parsedBody.content !== undefined ||
          parsedBody.tags !== undefined ||
          parsedBody.keepAttachmentUrls !== undefined ||
          hasFiles;

        if (!hasPatchPayload) {
          return memoError(
            res,
            ERROR_CODES.INVALID_REQUEST,
            'content, tags, keepAttachmentUrls or files is required',
            400,
          );
        }

        const newAttachments = await collectMemoAttachments({
          req,
          body: parsedBody,
          runtimeContext: state.runtimeContext,
          memoId: req.params.memoId,
        });

        const memo = await state.memoStore.update(req.params.memoId, {
          content: parsedBody.content,
          tags: parsedBody.tags,
          keepAttachmentUrls: parsedBody.keepAttachmentUrls,
          newAttachments,
        });
        return res.json(memo);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.delete('/memos/:memoId', async (req, res) => {
      try {
        await state.memoStore.softDelete(req.params.memoId);
        return res.status(204).send();
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.post('/memos/:memoId/restore', async (req, res) => {
      try {
        await state.memoStore.restore(req.params.memoId);
        const memo = await state.memoStore.getById(req.params.memoId);
        return res.json(memo);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.delete('/memos/:memoId/purge', async (req, res) => {
      try {
        await state.memoStore.purge(req.params.memoId);
        return res.status(204).send();
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.get('/memos', async (req, res) => {
      try {
        const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 20;
        const cursor = req.query.cursor ? String(req.query.cursor) : null;
        const result = await state.memoStore.list({ limit, cursor });
        return res.json(result);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.get('/trash', async (req, res) => {
      try {
        const result = await state.memoStore.listTrash();
        return res.json(result);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.get('/search', async (req, res) => {
      try {
        const result = await state.reviewService.search({
          q: req.query.q || '',
          tag: req.query.tag || null,
          from: req.query.from || null,
          to: req.query.to || null,
          limit: req.query.limit ? Number.parseInt(req.query.limit, 10) : 20,
        });
        return res.json(result);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.get('/review/random', async (req, res) => {
      try {
        const result = await state.reviewService.random();
        return res.json(result);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.get('/review/daily', async (req, res) => {
      try {
        const result = await state.reviewService.daily();
        return res.json(result);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.post('/imports', async (req, res) => {
      try {
        const body = req.body || {};
        if (!Array.isArray(body.items)) {
          return memoError(res, ERROR_CODES.INVALID_REQUEST, 'items must be an array', 400);
        }

        const accepted = await state.importService.startImport({
          items: body.items,
          mode: body.mode || 'insert',
        });

        return res.status(202).json({
          taskId: accepted.taskId,
          status: accepted.status,
          statusUrl: accepted.statusUrl,
        });
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.get('/maintenance/status', async (req, res) => {
      try {
        const result = await state.maintenanceService.getStatus();
        return res.json(result);
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.post('/maintenance/reindex', async (req, res) => {
      try {
        const accepted = await state.maintenanceService.startReindex();
        return res.status(202).json({
          taskId: accepted.taskId,
          status: accepted.status,
          statusUrl: accepted.statusUrl,
        });
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.post('/maintenance/reconcile', async (req, res) => {
      try {
        const accepted = await state.maintenanceService.startReconcile();
        return res.status(202).json({
          taskId: accepted.taskId,
          status: accepted.status,
          statusUrl: accepted.statusUrl,
        });
      } catch (error) {
        return handleRouteError(res, error);
      }
    });

    router.get('/tasks/:taskId', async (req, res) => {
      const task = state.taskRegistry.getTask(req.params.taskId);
      if (!task) {
        return memoError(res, ERROR_CODES.TASK_NOT_FOUND, 'task not found', 404);
      }
      return res.json(task);
    });

    router.get('/tasks/:taskId/errors', async (req, res) => {
      const task = state.taskRegistry.getTask(req.params.taskId);
      if (!task) {
        return memoError(res, ERROR_CODES.TASK_NOT_FOUND, 'task not found', 404);
      }
      return res.json({ taskId: task.taskId, errors: task.error || [] });
    });

    router.post('/tasks/:taskId/cancel', async (req, res) => {
      try {
        const updated = state.taskRegistry.updateTask(req.params.taskId, {
          status: 'cancelled',
          message: 'cancel requested',
        });
        return res.json(updated);
      } catch (error) {
        if (error.message === 'TASK_NOT_FOUND') {
          return memoError(res, ERROR_CODES.TASK_NOT_FOUND, 'task not found', 404);
        }
        return handleRouteError(res, error);
      }
    });
  },

  async processToolCall(args = {}) {
    if (args.command === 'GetStatus') {
      return {
        status: 'ok',
        plugin: 'MemoInboxAPI',
        memoDiaryName: state.runtimeContext
          ? state.runtimeContext.memoDiaryName
          : getFallbackDiaryName(state.config),
      };
    }

    throw new Error(`Unknown command: ${args.command || 'undefined'}`);
  },

  async shutdown() {
    if (typeof state.wsCleanup === 'function') {
      state.wsCleanup();
    }
    state.wss = null;
    state.wsCleanup = null;
  },
};

function getFallbackDiaryName(config = {}) {
  return config.MemoDiaryName || 'MyMemos';
}

function getPluginManager() {
  try {
    return require('../../Plugin.js');
  } catch {
    return null;
  }
}

function getTaskTtlMs(config = {}) {
  const minutes = Number.parseInt(config.MemoTaskResultTtlMinutes, 10);
  const normalizedMinutes = Number.isInteger(minutes) && minutes > 0 ? minutes : 1440;
  return normalizedMinutes * 60 * 1000;
}

function handleRouteError(res, error) {
  if (error && error.message === 'MEMO_NOT_FOUND') {
    return memoError(res, ERROR_CODES.MEMO_NOT_FOUND, 'memo not found', 404);
  }
  if (error && error.message === 'TASK_NOT_FOUND') {
    return memoError(res, ERROR_CODES.TASK_NOT_FOUND, 'task not found', 404);
  }

  return memoError(
    res,
    ERROR_CODES.INTERNAL_ERROR,
    error && error.message ? error.message : 'internal error',
    500,
  );
}

function dispatchTaskEvent({ wss, taskRegistry, event }) {
  const taskId = event.data.taskId;
  const subscribers = taskRegistry.getSubscribers(taskId);
  if (subscribers.size === 0) {
    wss.broadcastToPluginClients('MemoInboxClient', event);
    return;
  }

  for (const clientId of subscribers) {
    wss.sendMessageToClient(clientId, event);
  }
}

function registerMemoInboxWebSocket({ wss, taskRegistry }) {
  const clientIds = new Set();
  const removeTaskListener = taskRegistry.onEvent((event) => {
    dispatchTaskEvent({
      wss,
      taskRegistry,
      event,
    });
  });

  wss.registerPluginClientType(/^\/vcp-memo-inbox\/VCP_Key=(.+)$/, 'MemoInboxClient', {
    onConnect(ws) {
      clientIds.add(ws.clientId);
    },
    onMessage(ws, message) {
      if (message.type === 'memo_subscribe_task' && message.data && message.data.taskId) {
        taskRegistry.subscribe(message.data.taskId, ws.clientId);
      }

      if (message.type === 'memo_unsubscribe_task' && message.data && message.data.taskId) {
        taskRegistry.unsubscribe(message.data.taskId, ws.clientId);
      }
    },
    onClose(ws) {
      clientIds.delete(ws.clientId);
      taskRegistry.removeClientSubscriptions(ws.clientId);
    },
  });

  return () => {
    removeTaskListener();
    for (const clientId of clientIds) {
      taskRegistry.removeClientSubscriptions(clientId);
    }
    clientIds.clear();
    wss.unregisterPluginClientType('MemoInboxClient');
  };
}

function hydrateDerivedServices() {
  if (!state.reviewService && state.memoStore) {
    state.reviewService = createReviewService({
      memoStore: state.memoStore,
    });
  }

  if (!state.importService && state.memoStore && state.taskRegistry) {
    state.importService = createImportService({
      memoStore: state.memoStore,
      taskRegistry: state.taskRegistry,
      concurrency: 1,
    });
  }

  if (!state.maintenanceService && state.memoStore && state.taskRegistry && state.runtimeContext) {
    state.maintenanceService = createMaintenanceService({
      memoStore: state.memoStore,
      taskRegistry: state.taskRegistry,
      runtimeContext: state.runtimeContext,
    });
  }
}

function getMemoUploadMiddleware() {
  if (state.memoUploadMiddleware) {
    return state.memoUploadMiddleware;
  }

  try {
    const multer = require('multer');
    state.memoUploadMiddleware = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 20 * 1024 * 1024,
        files: 10,
      },
    }).any();
  } catch {
    state.memoUploadMiddleware = null;
  }

  return state.memoUploadMiddleware;
}

function runMemoUploadMiddleware(req, res) {
  const contentType = String(req && req.headers && req.headers['content-type'] ? req.headers['content-type'] : '');
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return Promise.resolve();
  }

  const middleware = getMemoUploadMiddleware();
  if (!middleware) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function normalizeMemoBody(body) {
  const normalized = { ...body };
  normalized.tags = parseMaybeJsonArray(body.tags);
  normalized.keepAttachmentUrls = parseMaybeJsonArray(body.keepAttachmentUrls);
  normalized.imageUrls = parseMaybeJsonArray(body.imageUrls);
  normalized.imageBase64 = parseMaybeJsonArray(body.imageBase64);
  return normalized;
}

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

async function collectMemoAttachments({ req, body, runtimeContext, memoId }) {
  const inputs = [];

  for (const url of body.imageUrls || []) {
    inputs.push({ kind: 'url', value: url });
  }

  for (const base64Value of body.imageBase64 || []) {
    inputs.push({ kind: 'base64', value: base64Value });
  }

  for (const file of req.files || []) {
    inputs.push({
      kind: 'buffer',
      buffer: file.buffer,
      mimeType: file.mimetype,
    });
  }

  if (inputs.length === 0) {
    return [];
  }

  return storeAttachments({
    memoId,
    inputs,
    runtimeContext,
    now: new Date(),
  });
}

module.exports.registerMemoInboxWebSocket = registerMemoInboxWebSocket;
module.exports.__setTestState = function __setTestState(nextState = {}) {
  Object.assign(state, nextState);
};
