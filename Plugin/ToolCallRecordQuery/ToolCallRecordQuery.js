#!/usr/bin/env node
const toolCallRecordStore = require('../../modules/toolCallRecordStore');
const {
  formatQueryReport,
  formatDetailReport
} = require('./toolCallRecordReportFormatter');

function parseInput(raw) {
  if (!raw || !raw.trim()) return {};
  return JSON.parse(raw);
}

function normalizeBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', '成功', '是'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', '失败', '否'].includes(normalized)) return false;
  return undefined;
}

function buildQuery(args) {
  return {
    id: args.id || args.recordId || args.record_id,
    toolName: args.toolName || args.tool_name || args.tool,
    callerSignature: args.callerSignature || args.caller || args.maid || args.valet,
    callerType: args.callerType || args.caller_type,
    status: args.status,
    success: normalizeBoolean(args.success),
    from: args.from || args.startTime || args.start_time || args.startedAfter,
    to: args.to || args.endTime || args.end_time || args.startedBefore,
    search: args.search || args.keyword || args.q,
    limit: args.limit,
    offset: args.offset,
    order: args.order,
    detail: args.detail === true || String(args.detail || '').toLowerCase() === 'true'
  };
}

function wantsJsonOutput(args = {}) {
  return String(args.format || args.output || '').trim().toLowerCase() === 'json';
}

function buildFormatterOptions(args = {}) {
  return {
    migrateMultimodal: args.migrateMultimodal !== false && args.migrate_multimodal !== false,
    includeRaw: args.includeRaw === true || args.include_raw === true || String(args.includeRaw || args.include_raw || '').toLowerCase() === 'true',
    maxTextChars: args.maxTextChars || args.max_text_chars,
    maxJsonChars: args.maxJsonChars || args.max_json_chars,
    maxRecords: args.maxRecords || args.max_records || args.limit
  };
}

function runStoreOperationQuietly(operation) {
  const originalLog = console.log;
  console.log = (...args) => {
    console.error(...args);
  };

  try {
    return operation();
  } finally {
    console.log = originalLog;
  }
}

async function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  try {
    const args = parseInput(chunks.join(''));
    runStoreOperationQuietly(() => toolCallRecordStore.initialize());

    const id = args.id || args.recordId || args.record_id;
    if (id && (args.mode === 'detail' || args.detail === true || args.detail === 'true')) {
      const record = runStoreOperationQuietly(() => toolCallRecordStore.getRecordById(id));
      if (!record) {
        console.log(JSON.stringify({
          status: 'success',
          result: {
            content: [{ type: 'text', text: `未找到工具调用记录: ${id}` }],
            query: { id },
            record: null
          }
        }));
        return;
      }

      if (wantsJsonOutput(args)) {
        console.log(JSON.stringify({
          status: 'success',
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'success', record }, null, 2)
            }],
            record
          }
        }));
        return;
      }

      const report = formatDetailReport(record, buildFormatterOptions(args));
      console.log(JSON.stringify({
        status: 'success',
        result: {
          content: [{ type: 'text', text: report.markdown }],
          record: report.record,
          assets: report.assets
        }
      }));
      return;
    }

    const query = buildQuery(args);
    const result = runStoreOperationQuietly(() => toolCallRecordStore.queryRecords(query));

    if (wantsJsonOutput(args)) {
      const text = JSON.stringify(result, null, 2);
      console.log(JSON.stringify({
        status: 'success',
        result: {
          content: [{ type: 'text', text }],
          query,
          ...result
        }
      }));
      return;
    }

    const report = formatQueryReport(result, query, buildFormatterOptions(args));
    console.log(JSON.stringify({
      status: 'success',
      result: {
        content: [{ type: 'text', text: report.markdown }],
        query,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        records: report.records,
        assets: report.assets
      }
    }));
  } catch (error) {
    console.log(JSON.stringify({
      status: 'error',
      error: `ToolCallRecordQuery Error: ${error.message}`
    }));
    process.exitCode = 1;
  } finally {
    toolCallRecordStore.shutdown();
  }
}

main();