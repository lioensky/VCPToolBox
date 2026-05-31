const { test } = require('node:test');
const assert = require('node:assert/strict');

const dotenv = require('../modules/dotenvPatch.js');
const agentManager = require('../modules/agentManager.js');
const messageProcessor = require('../modules/messageProcessor.js');

test('dotenv patch parses keys with provider-special characters', () => {
    const parsed = dotenv.parse(Buffer.from([
        'API@provider#1%primary&enabled^flag+name-extra=value',
        'MODEL.alias: "line\\nnext"',
        'PLAIN_KEY=unchanged # comment'
    ].join('\n')));

    assert.equal(parsed['API@provider#1%primary&enabled^flag+name-extra'], 'value');
    assert.equal(parsed['MODEL.alias'], 'line\nnext');
    assert.equal(parsed.PLAIN_KEY, 'unchanged');
});

test('messageProcessor expands agent placeholders with provider-special characters', async () => {
    const alias = 'agent@provider#1%primary&enabled^flag+name-extra';
    const hadAgent = agentManager.agentMap.has(alias);
    const previousAgent = agentManager.agentMap.get(alias);
    const hadPrompt = agentManager.promptCache.has(alias);
    const previousPrompt = agentManager.promptCache.get(alias);

    try {
        agentManager.agentMap.set(alias, 'unused.txt');
        agentManager.promptCache.set(alias, 'patched prompt');

        const result = await messageProcessor.replaceAgentVariables(
            `before {{${alias}}} after`,
            null,
            'system',
            {
                DEBUG_MODE: false,
                detectors: [],
                superDetectors: [],
                cachedEmojiLists: new Map(),
                pluginManager: {
                    messagePreprocessors: new Map(),
                    getAllPlaceholderValues: () => new Map(),
                    getIndividualPluginDescriptions: () => new Map(),
                    getResolvedPluginConfigValue: () => null
                }
            }
        );

        assert.equal(result, 'before patched prompt after');
    } finally {
        if (hadAgent) {
            agentManager.agentMap.set(alias, previousAgent);
        } else {
            agentManager.agentMap.delete(alias);
        }

        if (hadPrompt) {
            agentManager.promptCache.set(alias, previousPrompt);
        } else {
            agentManager.promptCache.delete(alias);
        }
    }
});
