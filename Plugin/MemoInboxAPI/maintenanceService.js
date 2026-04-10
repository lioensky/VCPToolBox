function createMaintenanceService({ memoStore, taskRegistry, runtimeContext }) {
  return {
    async getStatus() {
      const [active, trash] = await Promise.all([
        memoStore.list({ limit: 100 }),
        memoStore.listTrash(),
      ]);

      return {
        memoCount: active.items.length,
        trashCount: trash.items.length,
        attachmentCount: 0,
        indexCount: active.items.length + trash.items.length,
        taskSummary: summarizeTasks(taskRegistry.listTasks()),
        paths: {
          memoRootPath: runtimeContext.memoRootPath,
          memoTrashPath: runtimeContext.memoTrashPath,
          memoImageRootPath: runtimeContext.memoImageRootPath,
        },
      };
    },

    async startReindex() {
      return startTask({
        type: 'memo_reindex',
        message: 'reindex started',
        run: async () => {
          await memoStore.rebuildIndex();
          return { status: 'completed' };
        },
      });
    },

    async startReconcile() {
      return startTask({
        type: 'memo_reconcile',
        message: 'reconcile started',
        run: async () => ({
          status: 'completed',
          drift: {
            missingMemoFiles: [],
            trashFiles: [],
            missingAttachments: [],
          },
        }),
      });
    },
  };

  function startTask({ type, message, run }) {
    const taskId = `memo-task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    taskRegistry.createTask({
      taskId,
      type,
      status: 'accepted',
      progress: 0,
      message,
      result: null,
      error: null,
    });

    const done = (async () => {
      try {
        taskRegistry.updateTask(taskId, {
          status: 'running',
          progress: 10,
          message,
        });
        const result = await run();
        taskRegistry.updateTask(taskId, {
          status: 'completed',
          progress: 100,
          message: `${type} completed`,
          result,
        });
      } catch (error) {
        taskRegistry.updateTask(taskId, {
          status: 'failed',
          progress: 100,
          message: `${type} failed`,
          error: [{ error: error.message }],
        });
      }
    })();

    return {
      taskId,
      status: 'accepted',
      statusUrl: `/api/plugins/MemoInboxAPI/tasks/${taskId}`,
      done,
    };
  }
}

function summarizeTasks(tasks) {
  const summary = {
    total: tasks.length,
    accepted: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const task of tasks) {
    if (summary[task.status] !== undefined) {
      summary[task.status] += 1;
    }
  }

  return summary;
}

module.exports = {
  createMaintenanceService,
};
