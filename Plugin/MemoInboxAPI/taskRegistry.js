function createTaskRegistry({ ttlMs = 24 * 60 * 60 * 1000, onTaskEvent = null } = {}) {
  const tasks = new Map();
  const taskSubscribers = new Map();
  const eventListeners = new Set();

  return {
    createTask({ taskId, type, status = 'accepted', progress = 0, message = '', result = null, error = null }) {
      const now = new Date().toISOString();
      const task = {
        taskId,
        type,
        status,
        progress,
        message,
        result,
        error,
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(taskId, task);
      emitTaskEvent(task);
      return task;
    },

    updateTask(taskId, patch = {}) {
      const current = tasks.get(taskId);
      if (!current) {
        throw new Error('TASK_NOT_FOUND');
      }

      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      tasks.set(taskId, next);
      emitTaskEvent(next);
      return next;
    },

    getTask(taskId) {
      return tasks.get(taskId) || null;
    },

    listTasks() {
      return Array.from(tasks.values());
    },

    subscribe(taskId, clientId) {
      const subscribers = taskSubscribers.get(taskId) || new Set();
      subscribers.add(clientId);
      taskSubscribers.set(taskId, subscribers);
    },

    unsubscribe(taskId, clientId) {
      const subscribers = taskSubscribers.get(taskId);
      if (!subscribers) {
        return;
      }

      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        taskSubscribers.delete(taskId);
      }
    },

    removeClientSubscriptions(clientId) {
      for (const [taskId, subscribers] of taskSubscribers.entries()) {
        subscribers.delete(clientId);
        if (subscribers.size === 0) {
          taskSubscribers.delete(taskId);
        }
      }
    },

    getSubscribers(taskId) {
      return new Set(taskSubscribers.get(taskId) || []);
    },

    cleanupExpiredTasks(now = Date.now()) {
      for (const [taskId, task] of tasks.entries()) {
        if (!isTerminalStatus(task.status)) {
          continue;
        }

        const updatedAt = Date.parse(task.updatedAt);
        if (Number.isNaN(updatedAt)) {
          continue;
        }

        if (now - updatedAt >= ttlMs) {
          tasks.delete(taskId);
          taskSubscribers.delete(taskId);
        }
      }
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  };

  function emitTaskEvent(task) {
    const event = {
      ...mapTaskToEvent(task),
      subscribers: Array.from(taskSubscribers.get(task.taskId) || []),
    };

    if (typeof onTaskEvent === 'function') {
      onTaskEvent(event);
    }

    for (const listener of eventListeners) {
      listener(event);
    }
  }
}

function isTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function mapTaskToEvent(task) {
  const typeMap = {
    accepted: 'memo_task_accepted',
    running: 'memo_task_progress',
    completed: 'memo_task_completed',
    failed: 'memo_task_failed',
    cancelled: 'memo_task_cancelled',
  };

  return {
    type: typeMap[task.status] || 'memo_task_progress',
    data: {
      taskId: task.taskId,
      taskType: task.type,
      status: task.status,
      progress: task.progress,
      message: task.message,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
  };
}

module.exports = {
  createTaskRegistry,
  isTerminalStatus,
  mapTaskToEvent,
};
