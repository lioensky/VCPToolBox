'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    stripVcpPrivateFields,
    isGoogleNativeUpstream,
    ALWAYS_STRIP,
    GOOGLE_STRICT_STRIP
} = require('../modules/handlers/upstreamBodySanitizer.js');

test('stripVcpPrivateFields 剔除 VCP 内部私有字段，且不修改原对象', () => {
    const original = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        requestId: 'req-12345',
        messageId: 'msg-67890',
        vcpchatExtensions: { foo: 'bar' },
        contextTokenLimit: 4096,
        id: 'engine-req-1',
        signal: {},
        clientIp: '127.0.0.1',
        forceShowVCP: false
    };

    const sanitized = stripVcpPrivateFields(original);

    // 返回新对象
    assert.notEqual(sanitized, original);

    // 私有字段被剥离
    for (const key of ALWAYS_STRIP) {
        assert.equal(sanitized[key], undefined, `字段 ${key} 应被剔除`);
        assert.ok(key in original, `原对象字段 ${key} 应保留不被修改`);
    }

    // 业务参数正常保留
    assert.equal(sanitized.model, 'gpt-4o');
    assert.equal(sanitized.stream, true);
    assert.deepEqual(sanitized.messages, [{ role: 'user', content: 'hello' }]);
});

test('stripVcpPrivateFields 对 Object.freeze 冻结对象安全，不抛出 TypeError', () => {
    const frozen = Object.freeze({
        model: 'gpt-4o',
        requestId: 'req-freeze',
        stream: false
    });

    assert.doesNotThrow(() => {
        const result = stripVcpPrivateFields(frozen);
        assert.equal(result.requestId, undefined);
        assert.equal(result.model, 'gpt-4o');
    });
});

test('非 Google 上游时保留 top_k 与 seed', () => {
    const prevApi = process.env.API_URL;
    const prevStrict = process.env.STRICT_UPSTREAM_SANITIZE;
    try {
        process.env.API_URL = 'https://api.openai.com';
        delete process.env.STRICT_UPSTREAM_SANITIZE;

        assert.equal(isGoogleNativeUpstream(), false);

        const body = {
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: 'hi' }],
            top_k: 50,
            seed: 42,
            requestId: 'req-123'
        };

        const sanitized = stripVcpPrivateFields(body);
        assert.equal(sanitized.requestId, undefined);
        assert.equal(sanitized.top_k, 50, '非 Google 上游应保留 top_k');
        assert.equal(sanitized.seed, 42, '非 Google 上游应保留 seed');
    } finally {
        if (prevApi !== undefined) process.env.API_URL = prevApi;
        else delete process.env.API_URL;
        if (prevStrict !== undefined) process.env.STRICT_UPSTREAM_SANITIZE = prevStrict;
        else delete process.env.STRICT_UPSTREAM_SANITIZE;
    }
});

test('Google 原生端点自动进入严格模式，剔除 top_k 与 seed', () => {
    const prevApi = process.env.API_URL;
    const prevStrict = process.env.STRICT_UPSTREAM_SANITIZE;
    try {
        process.env.API_URL = 'https://generativelanguage.googleapis.com';
        delete process.env.STRICT_UPSTREAM_SANITIZE;

        assert.equal(isGoogleNativeUpstream(), true);

        const body = {
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: 'hi' }],
            top_k: 40,
            seed: 1234,
            requestId: 'req-google'
        };

        const sanitized = stripVcpPrivateFields(body);
        assert.equal(sanitized.requestId, undefined);
        assert.equal(sanitized.top_k, undefined, 'Google 原生应剔除 top_k');
        assert.equal(sanitized.seed, undefined, 'Google 原生应剔除 seed');
        assert.equal(sanitized.model, 'gemini-2.5-flash');
    } finally {
        if (prevApi !== undefined) process.env.API_URL = prevApi;
        else delete process.env.API_URL;
        if (prevStrict !== undefined) process.env.STRICT_UPSTREAM_SANITIZE = prevStrict;
        else delete process.env.STRICT_UPSTREAM_SANITIZE;
    }
});

test('STRICT_UPSTREAM_SANITIZE 显式配置覆盖域名判断', () => {
    const prevApi = process.env.API_URL;
    const prevStrict = process.env.STRICT_UPSTREAM_SANITIZE;
    try {
        // 自定义域名反代 Google，强制开启严格模式
        process.env.API_URL = 'https://my-custom-proxy.example.com';
        process.env.STRICT_UPSTREAM_SANITIZE = 'true';
        assert.equal(isGoogleNativeUpstream(), true);
        assert.equal(stripVcpPrivateFields({ top_k: 20 }).top_k, undefined);

        // 原生 Google 域名，但挂了智能中转支持 top_k，强制关闭严格模式
        process.env.API_URL = 'https://generativelanguage.googleapis.com';
        process.env.STRICT_UPSTREAM_SANITIZE = 'false';
        assert.equal(isGoogleNativeUpstream(), false);
        assert.equal(stripVcpPrivateFields({ top_k: 20 }).top_k, 20);
    } finally {
        if (prevApi !== undefined) process.env.API_URL = prevApi;
        else delete process.env.API_URL;
        if (prevStrict !== undefined) process.env.STRICT_UPSTREAM_SANITIZE = prevStrict;
        else delete process.env.STRICT_UPSTREAM_SANITIZE;
    }
});

test('空输入、非对象、数组安全回退，不抛出异常', () => {
    assert.equal(stripVcpPrivateFields(null), null);
    assert.equal(stripVcpPrivateFields(undefined), undefined);
    assert.equal(stripVcpPrivateFields('string'), 'string');
    assert.equal(stripVcpPrivateFields(12345), 12345);
    const arr = [1, 2, 3];
    assert.equal(stripVcpPrivateFields(arr), arr);
});
