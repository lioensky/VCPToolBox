'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ragDiaryPlugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');

test('RAG message copy-on-write clones only the messages that will be modified', () => {
    const largeHistoryPayload = {
        type: 'image_url',
        image_url: {
            url: `data:image/png;base64,${'A'.repeat(64 * 1024)}`
        }
    };
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'original user query' },
                largeHistoryPayload
            ]
        },
        {
            role: 'assistant',
            content: 'large unchanged history'
        },
        {
            role: 'system',
            content: 'prefix [[测试日记本]] suffix'
        }
    ];
    const originalSystemContent = messages[2].content;

    const cloned = ragDiaryPlugin._cloneMessagesAtIndices(messages, [2]);
    cloned[2].content = ragDiaryPlugin._replaceTextInContent(
        cloned[2].content,
        text => text.replace('[[测试日记本]]', '[召回的记忆]')
    );

    assert.notStrictEqual(cloned, messages);
    assert.strictEqual(
        cloned[0],
        messages[0],
        'unmodified user message should retain its original reference'
    );
    assert.strictEqual(
        cloned[1],
        messages[1],
        'unmodified assistant history should retain its original reference'
    );
    assert.notStrictEqual(
        cloned[2],
        messages[2],
        'the modified system message must be cloned'
    );
    assert.strictEqual(
        cloned[0].content[1],
        largeHistoryPayload,
        'large multimodal payload must not be copied'
    );
    assert.strictEqual(messages[2].content, originalSystemContent);
    assert.strictEqual(
        cloned[2].content,
        'prefix [召回的记忆] suffix',
        'memory replacement must still be written into the cloned system prompt'
    );
});

test('direct diary fast path also uses copy-on-write while injecting memory', async () => {
    const processor = ragDiaryPlugin.directDiaryTextProcessor;
    const originalProcessContent = processor.processContent;
    processor.processContent = async () => '[直接召回的记忆]';

    const messages = [
        { role: 'user', content: '真实用户输入' },
        { role: 'assistant', content: '不应复制的历史' },
        { role: 'system', content: 'prefix {{测试日记本}} suffix' }
    ];

    try {
        const result = await processor.tryProcessMessages(messages, {
            extractTextFromContent: content => String(content || ''),
            replaceTextInContent: (content, replacer) => replacer(content),
            isVirtualSystemUser: () => false,
            sanitizedUserInput: '真实用户输入',
            evaluateRoleValve: () => true
        });

        assert.strictEqual(result.processed, true);
        assert.strictEqual(result.messages[0], messages[0]);
        assert.strictEqual(result.messages[1], messages[1]);
        assert.notStrictEqual(result.messages[2], messages[2]);
        assert.strictEqual(messages[2].content, 'prefix {{测试日记本}} suffix');
        assert.strictEqual(result.messages[2].content, '[直接召回的记忆]');
    } finally {
        processor.processContent = originalProcessContent;
    }
});

test('RAG content replacement is immutable for structured content arrays', () => {
    const originalTextPart = {
        type: 'text',
        text: 'before [[测试日记本]] after'
    };
    const originalImagePart = {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAAA' }
    };
    const originalContent = [originalTextPart, originalImagePart];

    const replaced = ragDiaryPlugin._replaceTextInContent(
        originalContent,
        text => text.replace('[[测试日记本]]', '[记忆]')
    );

    assert.notStrictEqual(replaced, originalContent);
    assert.notStrictEqual(replaced[0], originalTextPart);
    assert.strictEqual(replaced[1], originalImagePart);
    assert.strictEqual(originalTextPart.text, 'before [[测试日记本]] after');
    assert.strictEqual(replaced[0].text, 'before [记忆] after');
});