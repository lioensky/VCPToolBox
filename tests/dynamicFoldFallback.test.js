'use strict';

/**
 * 动态折叠协议兜底与多 0.0 常驻块保留回归测试
 * 运行：node --test tests/dynamicFoldFallback.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildDynamicFoldObject } = require(path.join(__dirname, '..', 'modules', 'foldProtocol.js'));
const { resolveDynamicFoldProtocol } = require(path.join(__dirname, '..', 'modules', 'messageProcessor.js'));
const jevFoldFilter = require(path.join(__dirname, '..', 'modules', 'jevFoldFilter.js'));

function makeToolboxFoldFromDoc() {
    const doc = [
        '# VCP 文件管理与系统控制',
        '',
        '## 日常常驻',
        'FileOperator / LinuxShellExecutor 常驻入口说明',
        '',
        '[===vcp_fold:0.6::desc:创建写入追加修改文件===]',
        '',
        '## 文件管理',
        'FileOperator 详细参数说明',
        '',
        '[===vcp_fold:0.0::desc:使用DeepWiki调查GitHub仓库===]',
        '',
        '## DeepWiki 仓库调查',
        'DeepWikiVCP 参数说明',
        '',
        '[===vcp_fold:0.6::desc:打开VChat浏览器===]',
        '',
        '## VChat 浏览器',
        'LoomController 参数说明'
    ].join('\n');

    return buildDynamicFoldObject({
        content: doc,
        pluginDescription: '文件操作与系统控制工具箱',
        strategy: 'toolbox_block_similarity'
    });
}

function makeRagPlugin(embeddingFn) {
    return {
        getSingleEmbeddingCached: embeddingFn,
        _getWeightedAverageVector(vectors, weights) {
            const pairs = [];
            for (let i = 0; i < vectors.length; i += 1) {
                if (Array.isArray(vectors[i]) && vectors[i].length > 0) {
                    pairs.push({ vec: vectors[i], weight: weights[i] ?? 1 });
                }
            }
            if (pairs.length === 0) return null;
            const dim = pairs[0].vec.length;
            const out = new Array(dim).fill(0);
            let totalWeight = 0;
            for (const { vec, weight } of pairs) {
                totalWeight += weight;
                for (let d = 0; d < dim; d += 1) out[d] += vec[d] * weight;
            }
            if (totalWeight === 0) return null;
            return out.map(v => v / totalWeight);
        }
    };
}

test('toolbox_block_similarity 兜底保留全部 0.0 常驻块且不因倒序吞掉开头', async () => {
    const foldObj = makeToolboxFoldFromDoc();

    const cases = [
        {
            name: 'RAGDiaryPlugin 不可用',
            context: {
                pluginManager: { messagePreprocessors: new Map() },
                messages: [{ role: 'user', content: '你知道什么是vcp吗' }],
                DEBUG_MODE: false
            }
        },
        {
            name: '无 User 文本消息（如纯图片）',
            context: {
                pluginManager: {
                    messagePreprocessors: new Map([['RAGDiaryPlugin', makeRagPlugin(async () => [1, 0])]])
                },
                messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
                DEBUG_MODE: false
            }
        },
        {
            name: 'Embedding 返回空（模拟 429 限流导致 userVector 为空）',
            context: {
                pluginManager: {
                    messagePreprocessors: new Map([['RAGDiaryPlugin', makeRagPlugin(async () => null)]])
                },
                messages: [{ role: 'user', content: '你知道什么是vcp吗' }],
                DEBUG_MODE: false
            }
        },
        {
            name: '处理流程抛非 Abort 异常兜底',
            context: {
                pluginManager: {
                    messagePreprocessors: new Map([['RAGDiaryPlugin', makeRagPlugin(async () => { throw new Error('upstream 429'); })]])
                },
                messages: [{ role: 'user', content: '你知道什么是vcp吗' }],
                DEBUG_MODE: false
            }
        }
    ];

    for (const c of cases) {
        const result = await resolveDynamicFoldProtocol(foldObj, c.context, '{{VCPFileToolBox}}');
        const idxResident = result.indexOf('## 日常常驻');
        const idxDeepWiki = result.indexOf('## DeepWiki 仓库调查');
        assert.ok(idxResident !== -1, `${c.name}: 应保留开头日常常驻块`);
        assert.ok(idxDeepWiki !== -1, `${c.name}: 应保留 0.0 的 DeepWiki 块`);
        assert.ok(idxResident < idxDeepWiki, `${c.name}: 应保持原始文档顺序（日常常驻在前，DeepWiki 在后）`);
        assert.equal(result.includes('## 文件管理'), false, `${c.name}: 不应展开 0.6 块`);
        assert.equal(result.includes('## VChat 浏览器'), false, `${c.name}: 不应展开 0.6 块`);
        assert.match(result, /隐藏收纳了另外 2 个工具模块分组/, `${c.name}: 应提示隐藏了 2 个高阈值分组`);
    }
});

test('toolbox_block_similarity 正常向量路径下负相似度仍保留无 desc 开头常驻块与 0.0 块', async () => {
    const foldObj = makeToolboxFoldFromDoc();
    const ragPlugin = makeRagPlugin(async (text) => {
        if (String(text).includes('vcp')) return [1, 0];
        return [-0.5, 0.866]; // 与用户向量夹角钝角，cos < 0
    });

    const result = await resolveDynamicFoldProtocol(
        foldObj,
        {
            pluginManager: { messagePreprocessors: new Map([['RAGDiaryPlugin', ragPlugin]]) },
            messages: [{ role: 'user', content: '你知道什么是vcp吗' }],
            DEBUG_MODE: false
        },
        '{{VCPFileToolBox}}'
    );

    assert.ok(result.includes('## 日常常驻'), '即使 legacy 相似度为负，最小阈值 0.0 的开头常驻块也应保留');
    assert.equal(result.includes('## 文件管理'), false);
    assert.equal(result.includes('## DeepWiki 仓库调查'), false, '有 desc 的 0.0 块当 cos < 0 时按原阈值规则折叠');
    assert.match(result, /隐藏收纳了另外 3 个工具模块分组/);
});

test('toolbox_block_similarity 仅含正阈值块时兜底保留全部最低阈值块并按原序输出', async () => {
    const foldObj = {
        vcp_dynamic_fold: true,
        dynamic_fold_strategy: 'toolbox_block_similarity',
        plugin_description: '测试工具箱',
        fold_blocks: [
            { threshold: 0.3, description: '基础A', content: 'BLOCK_A_03' },
            { threshold: 0.7, description: '高级B', content: 'BLOCK_B_07' },
            { threshold: 0.3, description: '基础C', content: 'BLOCK_C_03' }
        ]
    };

    const result = await resolveDynamicFoldProtocol(
        foldObj,
        {
            pluginManager: { messagePreprocessors: new Map() },
            messages: [{ role: 'user', content: 'hello' }],
            DEBUG_MODE: false
        },
        '{{TestToolBox}}'
    );

    const idxA = result.indexOf('BLOCK_A_03');
    const idxC = result.indexOf('BLOCK_C_03');
    assert.ok(idxA !== -1 && idxC !== -1 && idxA < idxC);
    assert.equal(result.includes('BLOCK_B_07'), false);
    assert.match(result, /隐藏收纳了另外 1 个工具模块分组/);
});

test('toolbox_block_similarity 候选全被过滤导致为空时回退最低阈值集合且不重复计数', async () => {
    const foldObj = {
        vcp_dynamic_fold: true,
        dynamic_fold_strategy: 'toolbox_block_similarity',
        plugin_description: '测试工具箱',
        fold_blocks: [
            { threshold: 0.0, description: '基础A', content: 'FALLBACK_A' },
            { threshold: 0.6, description: '高级B', content: 'HIGH_B' }
        ]
    };

    const origIsEnabled = jevFoldFilter.isEnabled;
    const origFilterCandidates = jevFoldFilter.filterCandidates;
    jevFoldFilter.isEnabled = () => true;
    jevFoldFilter.filterCandidates = async () => ({
        applied: true,
        reason: 'low_intent',
        droppedIndices: [0],
        intent: 0.05
    });

    try {
        const ragPlugin = makeRagPlugin(async (text) => {
            if (String(text).includes('hello')) return [1, 0];
            if (String(text).includes('基础A')) return [1, 0];
            return [0, 1];
        });

        const result = await resolveDynamicFoldProtocol(
            foldObj,
            {
                pluginManager: { messagePreprocessors: new Map([['RAGDiaryPlugin', ragPlugin]]) },
                messages: [{ role: 'user', content: 'hello' }],
                DEBUG_MODE: false
            },
            '{{TestToolBox}}'
        );

        assert.ok(result.includes('FALLBACK_A'));
        assert.equal(result.includes('HIGH_B'), false);
        assert.match(result, /隐藏收纳了另外 1 个工具模块分组/);
    } finally {
        jevFoldFilter.isEnabled = origIsEnabled;
        jevFoldFilter.filterCandidates = origFilterCandidates;
    }
});

test('分级单块策略（非 toolbox_block_similarity）兜底优先取首个最低阈值块而非倒序末尾块', async () => {
    const foldObj = {
        vcp_dynamic_fold: true,
        plugin_description: '天气插件',
        fold_blocks: [
            { threshold: 0.0, content: 'FIRST_ZERO_BLOCK' },
            { threshold: 0.6, content: 'DETAIL_BLOCK' },
            { threshold: 0.0, content: 'SECOND_ZERO_BLOCK' }
        ]
    };

    const result = await resolveDynamicFoldProtocol(
        foldObj,
        {
            pluginManager: { messagePreprocessors: new Map() },
            messages: [{ role: 'user', content: 'hi' }],
            DEBUG_MODE: false
        },
        '{{VCPWeather}}'
    );

    assert.equal(result, 'FIRST_ZERO_BLOCK');
});

test('AbortError 仍正常向上抛出，不被兜底吞掉', async () => {
    const foldObj = makeToolboxFoldFromDoc();
    const controller = new AbortController();
    controller.abort();

    const ragPlugin = makeRagPlugin(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
    });

    await assert.rejects(
        () => resolveDynamicFoldProtocol(
            foldObj,
            {
                pluginManager: { messagePreprocessors: new Map([['RAGDiaryPlugin', ragPlugin]]) },
                messages: [{ role: 'user', content: 'hi' }],
                signal: controller.signal
            },
            '{{VCPFileToolBox}}'
        ),
        (err) => err && err.name === 'AbortError'
    );
});
