function createImportService({ memoStore, taskRegistry, concurrency = 1 }) {
  return {
    async startImport({ items = [], mode = 'insert' }) {
      const taskId = `memo-task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      taskRegistry.createTask({
        taskId,
        type: 'memo_import',
        status: 'accepted',
        progress: 0,
        message: `mode=${mode}`,
        result: null,
        error: null,
      });

      const done = (async () => {
        try {
          const results = [];
          const failures = [];
          const total = items.length;

          taskRegistry.updateTask(taskId, {
            status: 'running',
            progress: 0,
            message: `processing ${total} items with concurrency=${concurrency}`,
          });

          for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            try {
              const created = await memoStore.create({
                content: item.content,
                tags: Array.isArray(item.tags) ? item.tags : null,
                source: 'import',
                attachments: [],
                createdAt: item.createdAt || new Date(),
              });
              results.push(created);
            } catch (error) {
              failures.push({
                index,
                externalId: item.externalId || null,
                error: error.message,
              });
            }

            const progress = total === 0 ? 100 : Math.round(((index + 1) / total) * 100);
            taskRegistry.updateTask(taskId, {
              status: 'running',
              progress,
              message: `processed ${index + 1}/${total}`,
              result: {
                imported: results.length,
                failed: failures.length,
              },
              error: failures.length > 0 ? failures : null,
            });
          }

          taskRegistry.updateTask(taskId, {
            status: 'completed',
            progress: 100,
            message: 'import completed',
            result: {
              imported: results.length,
              failed: failures.length,
              items: results,
            },
            error: failures.length > 0 ? failures : null,
          });
        } catch (error) {
          taskRegistry.updateTask(taskId, {
            status: 'failed',
            progress: 100,
            message: 'import failed',
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
    },
  };
}

module.exports = {
  createImportService,
};
