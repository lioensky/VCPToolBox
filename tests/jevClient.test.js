'use strict';

/**
 * modules/jevClient.js 多 API Key 轮询离线测试（不发网络请求）
 * 运行：node --test tests/jevClient.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const { JevClient } = require('../modules/jevClient');

const STATE = { user_message: 'test' };
const QUESTIONS = {
    relevant: {
        type: 'noul',
        instructions: '判断是否相关'
    }
};

function successfulResponse() {
    return {
        data: {
            model: 'jev-test',
            answers: {
                relevant: { type: 'noul', noul: 1 }
            }
        }
    };
}

async function withMockedPost(mock, action) {
    const originalPost = axios.post;
    axios.post = mock;
    try {
        return await action();
    } finally {
        axios.post = originalPost;
    }
}

test('支持英文逗号、中文逗号和竖线，并清理空项及重复 Key', () => {
    const client = new JevClient({
        apiKey: ' key-a, key-b，key-c | key-a || ， ',
        provider: 'typesafe'
    });

    assert.equal(client.isConfigured(), true);
    assert.deepEqual(client.getStatus(), {
        configured: true,
        provider: 'typesafe',
        url: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-latest',
        apiKeyCount: 3,
        timeoutMs: 30000,
        maxRetries: 2,
        keepAlive: true,
        proxyEnabled: false
    });
});

test('空白及分隔符不构成有效配置', () => {
    const client = new JevClient({
        apiKey: ' , ， || ',
        provider: 'typesafe'
    });

    assert.equal(client.isConfigured(), false);
    assert.equal(client.getStatus().apiKeyCount, 0);
});

test('每次逻辑请求按 Key 顺序轮询并在末尾回绕', async () => {
    const client = new JevClient({
        apiKey: 'key-a，key-b|key-c',
        provider: 'typesafe',
        maxRetries: 0
    });
    const authorizationHeaders = [];

    await withMockedPost(
        async (_url, _body, options) => {
            authorizationHeaders.push(options.headers.Authorization);
            return successfulResponse();
        },
        async () => {
            await Promise.all([
                client.decide(STATE, QUESTIONS),
                client.decide(STATE, QUESTIONS),
                client.decide(STATE, QUESTIONS),
                client.decide(STATE, QUESTIONS)
            ]);
        }
    );

    assert.deepEqual(authorizationHeaders, [
        'Bearer key-a',
        'Bearer key-b',
        'Bearer key-c',
        'Bearer key-a'
    ]);
});

test('同一次逻辑请求的重试沿用原 Key，下一请求才轮到下一个 Key', async () => {
    const client = new JevClient({
        apiKey: 'key-a,key-b',
        provider: 'typesafe',
        maxRetries: 1,
        retryBaseDelayMs: 1
    });
    const authorizationHeaders = [];
    let callCount = 0;

    await withMockedPost(
        async (_url, _body, options) => {
            authorizationHeaders.push(options.headers.Authorization);
            callCount += 1;
            if (callCount === 1) {
                const error = new Error('temporary network failure');
                error.request = {};
                throw error;
            }
            return successfulResponse();
        },
        async () => {
            await client.decide(STATE, QUESTIONS);
            await client.decide(STATE, QUESTIONS);
        }
    );

    assert.deepEqual(authorizationHeaders, [
        'Bearer key-a',
        'Bearer key-a',
        'Bearer key-b'
    ]);
});

test('调用级 apiKey 覆盖同样支持多 Key 轮询', async () => {
    const client = new JevClient({
        apiKey: 'default-key',
        provider: 'typesafe',
        maxRetries: 0
    });
    const authorizationHeaders = [];

    await withMockedPost(
        async (_url, _body, options) => {
            authorizationHeaders.push(options.headers.Authorization);
            return successfulResponse();
        },
        async () => {
            await client.decide(STATE, QUESTIONS, { apiKey: 'override-a|override-b' });
            await client.decide(STATE, QUESTIONS, { apiKey: 'override-a|override-b' });
        }
    );

    assert.deepEqual(authorizationHeaders, [
        'Bearer override-a',
        'Bearer override-b'
    ]);
});

test('直连场景下默认启用 keepAlive 并复用 httpsAgent/httpAgent', async () => {
    const client = new JevClient({
        apiKey: 'test-key',
        provider: 'typesafe',
        maxRetries: 0
    });
    const capturedOptions = [];

    await withMockedPost(
        async (_url, _body, options) => {
            capturedOptions.push(options);
            return successfulResponse();
        },
        async () => {
            await client.decide(STATE, QUESTIONS);
            await client.decide(STATE, QUESTIONS);
        }
    );

    assert.equal(capturedOptions.length, 2);
    const firstOpt = capturedOptions[0];
    const secondOpt = capturedOptions[1];

    assert.equal(firstOpt.httpsAgent?.keepAlive, true);
    assert.equal(firstOpt.httpAgent?.keepAlive, true);
    // 验证连接池复用了同一个 Agent 实例
    assert.strictEqual(firstOpt.httpsAgent, secondOpt.httpsAgent);
    assert.strictEqual(firstOpt.httpAgent, secondOpt.httpAgent);
    client.destroy();
});

test('代理场景下注入 HttpsProxyAgent 并开启 keepAlive，设置 proxy 为 false', async () => {
    const client = new JevClient({
        apiKey: 'test-key',
        provider: 'typesafe',
        proxyUrl: 'http://127.0.0.1:7890',
        maxRetries: 0
    });
    const capturedOptions = [];

    await withMockedPost(
        async (_url, _body, options) => {
            capturedOptions.push(options);
            return successfulResponse();
        },
        async () => {
            await client.decide(STATE, QUESTIONS);
            await client.decide(STATE, QUESTIONS);
        }
    );

    assert.equal(capturedOptions.length, 2);
    const firstOpt = capturedOptions[0];
    const secondOpt = capturedOptions[1];

    assert.equal(firstOpt.proxy, false);
    assert.equal(firstOpt.httpsAgent?.keepAlive, true);
    // 代理场景复用同一个 ProxyAgent 实例
    assert.strictEqual(firstOpt.httpsAgent, secondOpt.httpsAgent);
    client.destroy();
});

test('支持显式禁用 keepAlive 配置', async () => {
    const client = new JevClient({
        apiKey: 'test-key',
        provider: 'typesafe',
        keepAlive: false,
        maxRetries: 0
    });

    assert.equal(client.getStatus().keepAlive, false);

    let capturedOption = null;
    await withMockedPost(
        async (_url, _body, options) => {
            capturedOption = options;
            return successfulResponse();
        },
        async () => {
            await client.decide(STATE, QUESTIONS);
        }
    );

    assert.equal(capturedOption.httpsAgent?.keepAlive, false);
    client.destroy();
});