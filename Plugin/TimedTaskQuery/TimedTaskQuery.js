#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');

function createResponse(status, result, error) {
  const payload = { status };
  if (result !== undefined) payload.result = result;
  if (error !== undefined) payload.error = error;
  process.stdout.write(JSON.stringify(payload));
}

function sanitizeTaskId(value) {
  const taskId = String(value || '').trim();
  if (!taskId) return '';
  if (!/^[a-zA-Z0-9_.-]+$/.test(taskId)) return '';
  return taskId;
}

async function readJsonIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isCancelAction(args) {
  const action = String(args.action || args.command || args.operation || '').trim().toLowerCase();
  return action === 'cancel' ||
    action === 'delete' ||
    action === 'remove' ||
    action === '取消' ||
    String(args.cancel || '').trim().toLowerCase() === 'true';
}

async function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let args = {};
  const input = chunks.join('').trim();
  if (input) {
    try {
      args = JSON.parse(input);
    } catch (error) {
      createResponse('error', undefined, `TimedTaskQuery 参数不是有效 JSON: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const taskId = sanitizeTaskId(args.task_id || args.taskId || args.id);
  if (!taskId) {
    createResponse('error', undefined, "缺少有效的 task_id。task_id 只能包含字母、数字、下划线、点和连字符。");
    process.exitCode = 1;
    return;
  }

  const projectBasePath = process.env.PROJECT_BASE_PATH || path.resolve(__dirname, '..', '..');
  const resultFilePath = path.join(projectBasePath, 'VCPTimedResults', `${taskId}.json`);
  const pendingFilePath = path.join(projectBasePath, 'VCPTimedContacts', `${taskId}.json`);

  try {
    const shouldCancel = isCancelAction(args);

    if (shouldCancel) {
      const resultData = await readJsonIfExists(resultFilePath);
      if (resultData) {
        createResponse('success', {
          queryStatus: 'completed',
          cancelStatus: 'not_cancelled',
          taskId,
          resultFile: resultFilePath,
          message: `任务 ${taskId} 已经执行完成，不能取消。`,
          data: resultData
        });
        return;
      }

      const pendingData = await readJsonIfExists(pendingFilePath);
      if (pendingData) {
        const removed = await removeFileIfExists(pendingFilePath);
        createResponse('success', {
          queryStatus: removed ? 'cancelled' : 'not_found',
          cancelStatus: removed ? 'cancelled' : 'not_found',
          taskId,
          cancelledFile: pendingFilePath,
          scheduledLocalTime: pendingData.scheduledLocalTime || null,
          toolName: pendingData.tool_call?.tool_name || null,
          requestor: pendingData.requestor || null,
          message: removed
            ? `任务 ${taskId} 已取消。调度器会在文件删除事件中同步取消内存中的定时 Job。`
            : `任务 ${taskId} 的待执行文件已不存在，可能已被执行、取消或清理。`
        });
        return;
      }

      createResponse('success', {
        queryStatus: 'not_found',
        cancelStatus: 'not_found',
        taskId,
        message: `未找到任务 ${taskId} 的待执行记录，无法取消。可能 ID 错误、任务已执行，或已被取消。`
      });
      return;
    }

    const resultData = await readJsonIfExists(resultFilePath);
    if (resultData) {
      createResponse('success', {
        queryStatus: 'completed',
        taskId,
        resultFile: resultFilePath,
        data: resultData
      });
      return;
    }

    const pendingData = await readJsonIfExists(pendingFilePath);
    if (pendingData) {
      createResponse('success', {
        queryStatus: 'pending',
        taskId,
        pendingFile: pendingFilePath,
        scheduledLocalTime: pendingData.scheduledLocalTime || null,
        toolName: pendingData.tool_call?.tool_name || null,
        requestor: pendingData.requestor || null,
        message: `任务 ${taskId} 尚未执行或尚未完成。`
      });
      return;
    }

    createResponse('success', {
      queryStatus: 'not_found',
      taskId,
      message: `未找到任务 ${taskId} 的待执行记录或执行结果。可能 ID 错误，或任务结果目录被清理。`
    });
  } catch (error) {
    createResponse('error', undefined, `查询任务 ${taskId} 时出错: ${error.message}`);
    process.exitCode = 1;
  }
}

main();