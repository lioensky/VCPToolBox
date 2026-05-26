const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleRequest,
  buildExecuteRequest
} = require('../Plugin/DingTalkTable/DingTalkTable');

function createMockRuntime(calls, responseFactory) {
  return {
    async handleRequest(request) {
      calls.push(request);
      if (responseFactory) {
        return responseFactory(request);
      }
      return {
        status: 'success',
        result: {
          product: request.product,
          tool: request.tool,
          dry_run: request.dry_run,
          apply: request.apply,
          args: request.args
        }
      };
    }
  };
}

test('write_daily_report forwards to DingTalkCLI record create as dry-run by default', async () => {
  const calls = [];
  const runtime = createMockRuntime(calls);

  const response = await handleRequest({
    action: 'write_daily_report',
    table_uuid: 'table-1',
    report_date: '2026-05-26',
    content: 'daily content',
    maid: 'Nova'
  }, { runtime });

  assert.equal(response.status, 'success');
  assert.equal(response.replacement, 'DingTalkCLI.execute_tool');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'execute_tool');
  assert.equal(calls[0].product, 'aitable');
  assert.equal(calls[0].tool, 'record create');
  assert.equal(calls[0].apply, false);
  assert.equal(calls[0].dry_run, true);
  assert.deepEqual(calls[0].args, {
    table_id: 'table-1',
    data: {
      '日期': '2026-05-26',
      '工作内容': 'daily content',
      '记录人': 'Nova',
      '类型': '日报'
    }
  });
});

test('write actions preserve DingTalkCLI security errors without real execution', async () => {
  const calls = [];
  const runtime = createMockRuntime(calls, () => ({
    status: 'error',
    error: {
      category: 'security',
      reason: 'write operation blocked in gray stage: query_only',
      hint: 'query-only stage allows read tools only'
    }
  }));

  const response = await handleRequest({
    action: 'add_record',
    table_uuid: 'table-1',
    data: { title: 'x' },
    apply: true
  }, { runtime });

  assert.equal(response.status, 'error');
  assert.equal(response.error.category, 'security');
  assert.equal(response.forwarded.apply, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'record create');
});

test('read actions do not force dry-run', async () => {
  const calls = [];
  const runtime = createMockRuntime(calls);

  const response = await handleRequest({
    action: 'get_record',
    table_uuid: 'table-1',
    record_id: 'rec-1'
  }, { runtime });

  assert.equal(response.status, 'success');
  assert.equal(calls[0].tool, 'record get');
  assert.equal(calls[0].dry_run, false);
  assert.deepEqual(calls[0].args, {
    table_id: 'table-1',
    record_id: 'rec-1'
  });
});

test('add_record requires explicit data or fields payload', async () => {
  const calls = [];
  const runtime = createMockRuntime(calls);

  const response = await handleRequest({
    action: 'add_record',
    table_uuid: 'table-1'
  }, { runtime });

  assert.equal(response.status, 'error');
  assert.match(response.error, /data/);
  assert.equal(calls.length, 0);
});

test('call_mcp_tool is converted to DingTalkCLI execute_tool', async () => {
  const calls = [];
  const runtime = createMockRuntime(calls);

  const response = await handleRequest({
    action: 'call_mcp_tool',
    table_uuid: 'table-1',
    tool_name: 'record create',
    arguments: { data: { field1: 'value1' } }
  }, { runtime });

  assert.equal(response.status, 'success');
  assert.equal(calls[0].product, 'aitable');
  assert.equal(calls[0].tool, 'record create');
  assert.equal(calls[0].dry_run, true);
  assert.deepEqual(calls[0].args, {
    table_id: 'table-1',
    data: { field1: 'value1' }
  });
});

test('buildExecuteRequest treats explicit apply as non-dry-run request', () => {
  const executeRequest = buildExecuteRequest({
    action: 'delete_record',
    apply: true
  }, 'record delete', { record_id: 'rec-1' }, { write: true });

  assert.equal(executeRequest.apply, true);
  assert.equal(executeRequest.dry_run, false);
});
