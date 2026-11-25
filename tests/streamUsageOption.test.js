'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyStreamUsageOption, rejectsStreamUsageOption, markStreamUsageUnsupported, resetStreamUsageChannels, withStreamUsage,
} = require('../modules/streamUsageOption');

const URL = 'https://upstream.invalid/v1/chat/completions';
const options = body => ({ method: 'POST', body: JSON.stringify(body) });
const bodyOf = result => JSON.parse(result.options.body);

test('streaming requests ask for usage unless disabled, already set, or not streaming', () => {
  resetStreamUsageChannels();
  delete process.env.UpstreamStreamIncludeUsage;
  const added = applyStreamUsageOption(URL, options({ model: 'm', stream: true }));
  assert.deepEqual(bodyOf(added).stream_options, { include_usage: true });
  assert.equal(added.key, `${URL}|m`);

  const own = applyStreamUsageOption(URL, options({ model: 'm', stream: true, stream_options: { include_usage: false } }));
  assert.equal(own.key, null);
  assert.deepEqual(bodyOf(own).stream_options, { include_usage: false });

  assert.equal(applyStreamUsageOption(URL, options({ model: 'm', stream: false })).key, null);

  process.env.UpstreamStreamIncludeUsage = 'false';
  assert.equal(applyStreamUsageOption(URL, options({ model: 'm', stream: true })).key, null);
  delete process.env.UpstreamStreamIncludeUsage;
});

test('a channel that rejected the option is remembered per upstream and model', () => {
  resetStreamUsageChannels();
  markStreamUsageUnsupported(`${URL}|m`);
  const skipped = applyStreamUsageOption(URL, options({ model: 'm', stream: true }));
  assert.equal(skipped.key, null);
  assert.equal(bodyOf(skipped).stream_options, undefined);
  assert.notEqual(applyStreamUsageOption(URL, options({ model: 'other', stream: true })).key, null);
});

test('only a 400 naming the option counts as a rejection', async () => {
  const response = (status, text) => ({ status, clone: () => ({ text: async () => text }) });
  assert.equal(await rejectsStreamUsageOption(response(400, '{"error":"Unrecognized request argument supplied: stream_options"}')), true);
  assert.equal(await rejectsStreamUsageOption(response(400, '{"error":"include_usage is not supported"}')), true);
  assert.equal(await rejectsStreamUsageOption(response(400, '{"error":"messages too long"}')), false);
  assert.equal(await rejectsStreamUsageOption(response(500, 'stream_options')), false);
});

test('a rejected option is dropped, resent once, and not sent to that channel again', async () => {
    resetStreamUsageChannels();
    const sent = [];
    const fetchUpstream = withStreamUsage(async (_url, options) => {
        const body = JSON.parse(options.body);
        sent.push(body);
        return body.stream_options
            ? { status: 400, clone: () => ({ text: async () => '{"error":{"message":"Unknown parameter: stream_options"}}' }), text: async () => '' }
            : { status: 200 };
    });
    const requestOptions = { body: JSON.stringify({ model: 'm', stream: true, messages: [] }) };
    assert.equal((await fetchUpstream('https://up.test', requestOptions, {})).status, 200);
    assert.deepEqual(sent.map(body => Boolean(body.stream_options)), [true, false]);
    assert.equal((await fetchUpstream('https://up.test', requestOptions, {})).status, 200);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].stream_options, undefined);
    resetStreamUsageChannels();
});
