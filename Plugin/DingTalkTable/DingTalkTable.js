#!/usr/bin/env node
'use strict';

/**
 * DingTalkTable compatibility layer.
 *
 * Legacy DingTalkTable actions are forwarded to DingTalkCLI so AI-table access
 * goes through the shared dry-run and gray-stage policy gates.
 */

const path = require('path');
const { DingTalkCLIRuntime } = require('../DingTalkCLI/lib/runtime');

const CONFIG = {
  TABLE_UUID: process.env.DINGTALK_TABLE_UUID || '',
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai'
};

const WRITE_ACTIONS = new Set([
  'write_daily_report',
  'write_weekly_report',
  'add_record',
  'batch_add_records',
  'update_record',
  'delete_record'
]);

function createRuntime() {
  return new DingTalkCLIRuntime({
    basePath: path.join(__dirname, '..', 'DingTalkCLI')
  });
}

function getAction(request) {
  return String((request && request.action) || '').trim();
}

function getTableId(request) {
  return String((request && (request.table_id || request.table_uuid)) || CONFIG.TABLE_UUID || '').trim();
}

function getToolName(request) {
  return String((request && (request.tool || request.tool_name)) || '').trim();
}

function isWriteToolName(toolName) {
  return /\b(create|add|update|delete|remove|write|batch|append|upsert)\b/i.test(String(toolName || ''));
}

function getArguments(request) {
  const args = request && (request.arguments || request.args);
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function getDateString(date) {
  return date.toISOString().split('T')[0];
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

function buildTableArgs(request, payload = {}) {
  const tableId = getTableId(request);
  return {
    ...(tableId ? { table_id: tableId } : {}),
    ...payload
  };
}

function buildRecordPayload(request) {
  const data = request && request.data && typeof request.data === 'object' ? request.data : null;
  if (data) {
    return data;
  }

  const fields = request && request.fields && typeof request.fields === 'object' ? request.fields : null;
  if (fields) {
    return fields;
  }

  return null;
}

function buildExecuteRequest(request, tool, args, options = {}) {
  const action = getAction(request);
  const write = options.write === true || WRITE_ACTIONS.has(action);
  const apply = request && request.apply === true;
  const requestedDryRun = typeof (request && request.dry_run) === 'boolean' ? request.dry_run : write;

  return {
    action: 'execute_tool',
    request_id: request && request.request_id,
    product: 'aitable',
    tool,
    args,
    apply,
    dry_run: apply ? false : requestedDryRun,
    yes: request && request.yes === true,
    format: request && typeof request.format === 'string' ? request.format : 'json'
  };
}

function wrapRuntimeResponse(sourceAction, executeRequest, runtimeResponse) {
  const base = {
    deprecated: true,
    replacement: 'DingTalkCLI.execute_tool',
    sourceAction,
    forwarded: {
      product: executeRequest.product,
      tool: executeRequest.tool,
      apply: executeRequest.apply,
      dry_run: executeRequest.dry_run
    }
  };

  if (!runtimeResponse || runtimeResponse.status !== 'success') {
    return {
      status: 'error',
      ...base,
      error: runtimeResponse && runtimeResponse.error
        ? runtimeResponse.error
        : {
            category: 'upstream',
            reason: 'DingTalkCLI returned an empty or invalid response',
            hint: 'check DingTalkCLI runtime configuration'
          }
    };
  }

  return {
    status: 'success',
    ...base,
    result: runtimeResponse.result
  };
}

async function forwardExecute(request, runtime, tool, args, options = {}) {
  const executeRequest = buildExecuteRequest(request, tool, args, options);
  const runtimeResponse = await runtime.handleRequest(executeRequest);
  return wrapRuntimeResponse(getAction(request), executeRequest, runtimeResponse);
}

function requireString(value, name) {
  if (!value || typeof value !== 'string') {
    return { status: 'error', error: `缺少必需参数：${name}` };
  }
  return null;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'error', error: `缺少必需参数：${name}` };
  }
  return null;
}

async function handleRequest(request, options = {}) {
  const runtime = options.runtime || createRuntime();
  const action = getAction(request);

  switch (action) {
    case 'health_check':
      return runtime.handleRequest({ action: 'health_check', request_id: request && request.request_id });

    case 'list_tools':
      return runtime.handleRequest({ action: 'schema_list', request_id: request && request.request_id });

    case 'list_tables':
      return forwardExecute(request, runtime, 'table list', buildTableArgs(request), { write: false });

    case 'write_daily_report': {
      const missing = requireString(request && request.content, 'content（日报内容）');
      if (missing) return missing;

      const reportDate = request.report_date || getDateString(new Date());
      const data = {
        '日期': reportDate,
        '工作内容': request.content,
        '记录人': request.maid || 'AI',
        '类型': '日报'
      };

      return forwardExecute(
        request,
        runtime,
        'record create',
        buildTableArgs(request, { data }),
        { write: true }
      );
    }

    case 'write_weekly_report': {
      const missing = requireString(request && request.content, 'content（周报内容）');
      if (missing) return missing;

      const weekStart = request.week_start || getDateString(getWeekStart(new Date()));
      const data = {
        '周开始日期': weekStart,
        '周报摘要': request.summary || '',
        '详细内容': request.content,
        '记录人': request.maid || 'AI',
        '类型': '周报'
      };

      return forwardExecute(
        request,
        runtime,
        'record create',
        buildTableArgs(request, { data }),
        { write: true }
      );
    }

    case 'add_record': {
      const data = buildRecordPayload(request);
      const missing = requireObject(data, 'data 或 fields');
      if (missing) return missing;

      return forwardExecute(
        request,
        runtime,
        'record create',
        buildTableArgs(request, { data }),
        { write: true }
      );
    }

    case 'batch_add_records': {
      const records = request && Array.isArray(request.records) ? request.records : null;
      if (!records) {
        return { status: 'error', error: '缺少必需参数：records（数组）' };
      }

      return forwardExecute(
        request,
        runtime,
        'record batch create',
        buildTableArgs(request, { records }),
        { write: true }
      );
    }

    case 'update_record': {
      const recordId = String((request && (request.record_id || request.recordId)) || '').trim();
      const missingRecord = requireString(recordId, 'record_id');
      if (missingRecord) return missingRecord;

      const data = buildRecordPayload(request);
      const missingData = requireObject(data, 'data 或 fields');
      if (missingData) return missingData;

      return forwardExecute(
        request,
        runtime,
        'record update',
        buildTableArgs(request, { record_id: recordId, data }),
        { write: true }
      );
    }

    case 'delete_record': {
      const recordId = String((request && (request.record_id || request.recordId)) || '').trim();
      const missingRecord = requireString(recordId, 'record_id');
      if (missingRecord) return missingRecord;

      return forwardExecute(
        request,
        runtime,
        'record delete',
        buildTableArgs(request, { record_id: recordId }),
        { write: true }
      );
    }

    case 'get_record': {
      const recordId = String((request && (request.record_id || request.recordId)) || '').trim();
      const missingRecord = requireString(recordId, 'record_id');
      if (missingRecord) return missingRecord;

      return forwardExecute(
        request,
        runtime,
        'record get',
        buildTableArgs(request, { record_id: recordId }),
        { write: false }
      );
    }

    case 'call_mcp_tool':
    case 'invoke_tool': {
      const tool = getToolName(request);
      const missingTool = requireString(tool, 'tool_name');
      if (missingTool) return missingTool;

      return forwardExecute(
        request,
        runtime,
        tool.replace(/_/g, ' '),
        buildTableArgs(request, getArguments(request)),
        { write: isWriteToolName(tool) }
      );
    }

    default:
      return { status: 'error', error: `未知操作：${action}` };
  }
}

async function readStdinJson() {
  return new Promise((resolve, reject) => {
    let inputData = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      inputData += chunk;
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => {
      if (!inputData.trim()) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(inputData));
      } catch (error) {
        reject(new Error(`输入 JSON 解析失败：${error.message}`));
      }
    });
  });
}

async function main() {
  try {
    const request = await readStdinJson();
    if (!request) {
      process.stdout.write(`${JSON.stringify({ status: 'error', error: '无输入数据' })}\n`);
      return;
    }

    const response = await handleRequest(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'error', error: `处理请求失败：${error.message}` })}\n`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  handleRequest,
  buildExecuteRequest,
  getWeekStart,
  isWriteToolName
};
