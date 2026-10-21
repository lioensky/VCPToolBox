'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classifyModelId,
    stripModelNamespace,
    filterModelList
} = require('../modules/modelCatalog.js');

// 用真实的上游模型名做样本（Google 兼容层 + OpenAI 命名混着来）
const SAMPLE_MODELS = [
    'models/gemini-2.5-pro',
    'models/gemini-flash-latest',
    'models/gemini-3.1-flash-lite',
    'models/gemma-4-31b-it',
    'models/gemini-2.5-flash-image',
    'models/gemini-3.1-flash-image',
    'models/gemini-nano-banana-2.1',
    'models/gemini-2.5-flash-preview-tts',
    'models/gemini-2.5-flash-native-audio-latest',
    'models/gemini-3.5-transcribe',
    'models/gemini-3.8-live',
    'models/gemini-3.1-flash-live-preview',
    'models/lyria-3-pro-preview',
    'models/veo-3.1-generate-preview',
    'models/gemini-embedding-001',
    'models/aqa',
    'models/deep-research-pro-preview-12-2025',
    'models/gemini-robotics-er-2-preview',
    'gpt-4o',
    'o3',
    'gpt-image-1',
    'dall-e-3',
    'gpt-4o-mini-tts',
    'whisper-1',
    'text-embedding-3-large',
    'sora-2',
    'gpt-4o-realtime-preview',
    'omni-moderation-latest'
];

function buildList() {
    return {
        object: 'list',
        data: SAMPLE_MODELS.map(id => ({ id, object: 'model', owned_by: 'upstream' }))
    };
}

test('classifyModelId 把非对话模型分到正确类别', () => {
    const cases = {
        'models/gemini-2.5-pro': 'chat',
        'gpt-4o': 'chat',
        'o3': 'chat',
        'models/gemini-2.5-flash-image': 'image',
        'models/gemini-nano-banana-2.1': 'image',
        'gpt-image-1': 'image',
        'dall-e-3': 'image',
        'models/gemini-2.5-flash-preview-tts': 'speech',
        'gpt-4o-mini-tts': 'speech',
        'whisper-1': 'speech',
        'models/gemini-2.5-flash-native-audio-latest': 'speech',
        'models/gemini-3.8-live': 'live',
        'gpt-4o-realtime-preview': 'live',
        'models/lyria-3-pro-preview': 'music',
        'models/veo-3.1-generate-preview': 'video',
        'sora-2': 'video',
        'models/gemini-embedding-001': 'embedding',
        'text-embedding-3-large': 'embedding',
        'models/aqa': 'other',
        'models/gemini-robotics-er-2-preview': 'other',
        'models/deep-research-pro-preview-12-2025': 'other',
        'omni-moderation-latest': 'other'
    };

    for (const [id, expected] of Object.entries(cases)) {
        assert.equal(classifyModelId(id), expected, `${id} 应归到 ${expected}`);
    }
});

test('lyria-realtime 归 music 而不是 live（规则顺序）', () => {
    assert.equal(classifyModelId('models/lyria-realtime-exp'), 'music');
});

test('stripModelNamespace 只去掉开头的一段 models/', () => {
    assert.equal(stripModelNamespace('models/gemini-2.5-pro'), 'gemini-2.5-pro');
    assert.equal(stripModelNamespace('gemini-2.5-pro'), 'gemini-2.5-pro');
    assert.equal(stripModelNamespace('models/'), '');
});

test('未设置 MODEL_LIST_MODE 时默认全量透传（保持上游原有行为）', () => {
    const previous = process.env.MODEL_LIST_MODE;
    try {
        delete process.env.MODEL_LIST_MODE;
        const result = filterModelList(buildList(), {});
        assert.equal(result.data.length, SAMPLE_MODELS.length);
    } finally {
        if (previous !== undefined) process.env.MODEL_LIST_MODE = previous;
    }
});

test('MODEL_LIST_MODE=chat 时只返回对话模型，且去掉 models/ 前缀', () => {
    const previous = process.env.MODEL_LIST_MODE;
    try {
        process.env.MODEL_LIST_MODE = 'chat';
        const result = filterModelList(buildList(), {});
        assert.ok(result.data.length > 0);
        assert.ok(result.data.every(model => model.vcp_category === 'chat'));
        assert.ok(result.data.every(model => !model.id.startsWith('models/')));
        assert.ok(result.data.some(model => model.id === 'gemini-2.5-pro'));
        assert.ok(!result.data.some(model => model.id.includes('image')));
    } finally {
        if (previous === undefined) delete process.env.MODEL_LIST_MODE;
        else process.env.MODEL_LIST_MODE = previous;
    }
});

test('?category=image 只返回生图模型', () => {
    const result = filterModelList(buildList(), { category: 'image' });
    const ids = result.data.map(model => model.id).sort();
    assert.deepEqual(ids, ['dall-e-3', 'gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gpt-image-1']);
});

test('?category=all 全量返回，且每个模型都带分类', () => {
    const result = filterModelList(buildList(), { category: 'all' });
    assert.equal(result.data.length, SAMPLE_MODELS.length);
    assert.ok(result.data.every(model => typeof model.vcp_category === 'string'));
});

test('MODEL_LIST_HIDE 支持裸名与 models/ 前缀两种写法', () => {
    const previous = process.env.MODEL_LIST_HIDE;
    try {
        process.env.MODEL_LIST_HIDE = 'models/gemini-2.5-pro';
        assert.ok(!filterModelList(buildList(), {}).data.some(model => model.id === 'gemini-2.5-pro'));

        process.env.MODEL_LIST_HIDE = 'gemini-2.5-pro';
        assert.ok(!filterModelList(buildList(), {}).data.some(model => model.id === 'gemini-2.5-pro'));
    } finally {
        if (previous === undefined) delete process.env.MODEL_LIST_HIDE;
        else process.env.MODEL_LIST_HIDE = previous;
    }
});

test('MODEL_LIST_SHOW 能把非对话模型强制放回聊天列表', () => {
    const previousMode = process.env.MODEL_LIST_MODE;
    const previousShow = process.env.MODEL_LIST_SHOW;
    try {
        process.env.MODEL_LIST_MODE = 'chat';
        process.env.MODEL_LIST_SHOW = 'gemini-3.1-flash-image';
        const result = filterModelList(buildList(), {});
        assert.ok(result.data.some(model => model.id === 'gemini-3.1-flash-image'));
        // 其它生图模型仍然被挡在外面
        assert.ok(!result.data.some(model => model.id === 'dall-e-3'));
    } finally {
        if (previousMode === undefined) delete process.env.MODEL_LIST_MODE;
        else process.env.MODEL_LIST_MODE = previousMode;
        if (previousShow === undefined) delete process.env.MODEL_LIST_SHOW;
        else process.env.MODEL_LIST_SHOW = previousShow;
    }
});

test('模型缺少 id 时被丢弃，不抛异常', () => {
    const result = filterModelList({ object: 'list', data: [{ object: 'model' }, null, { id: 'gpt-4o' }] }, {});
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].id, 'gpt-4o');
});

test('非法输入返回空列表而不是崩溃', () => {
    assert.deepEqual(filterModelList(null, {}).data, []);
    assert.deepEqual(filterModelList({ object: 'list' }, {}).data, []);
});
