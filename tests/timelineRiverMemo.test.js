'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ragDiaryPlugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');
const timeline = require('../Plugin/VCPTimeLine/VCPTimeLine.js');

test('ContextBridge retrieveDiary uses native RiverMemo with an explicit diary scope', async () => {
    const originalVectorDBManager = ragDiaryPlugin.vectorDBManager;
    let nativeCall = null;
    let searchCalls = 0;

    ragDiaryPlugin.vectorDBManager = {
        async search() {
            searchCalls++;
            return [];
        },
        async executeNativeRiverQuery(query, options) {
            nativeCall = { query, options };
            return {
                artifactSig: 'timeline-artifact',
                queryId: 'timeline-query',
                omega: { omega: 0.72, regime: 'dense' },
                queryTags: { matchedTags: ['时间线'] },
                results: [{
                    chunkId: 101,
                    fullPath: 'NovaTimeline/2026-08.md',
                    text: '八月时间线',
                    score: 0.91
                }],
                diagnostics: {
                    nativeTopologyV3: {
                        jointUsed: true
                    }
                }
            };
        }
    };

    try {
        const bridge = ragDiaryPlugin.getContextBridge();
        const queryVector = new Float32Array([1, 0, 0, 0]);
        const retrieval = await bridge.retrieveDiary({
            diaryNames: 'NovaTimeline',
            queryVector,
            queryText: '回忆八月发生的事情',
            k: 8,
            candidateK: 120,
            riverMemo: true,
            tagMemo: true
        });

        assert.equal(bridge.version, '1.2');
        assert.equal(searchCalls, 0, 'native success must not execute the JS search fallback');
        assert(nativeCall, 'native RiverMemo must be invoked');
        assert.equal(nativeCall.query.text, '回忆八月发生的事情');
        assert.strictEqual(nativeCall.query.vector, queryVector);
        assert.equal(nativeCall.options.diaryNames, 'NovaTimeline');
        assert.equal(nativeCall.options.topK, 8);
        assert.equal(nativeCall.options.candidateK, 120);
        assert.equal(nativeCall.options.enabled, true);
        assert.equal(nativeCall.options.fallbackToLegacy, true);
        assert.equal(retrieval.results[0].chunkId, 101);
        assert.equal(retrieval.meta.riverMemoUsed, true);
        assert.equal(retrieval.meta.nativeJointQueryUsed, true);
        assert.equal(retrieval.meta.artifactSig, 'timeline-artifact');
        assert.equal(retrieval.meta.omega, 0.72);
        assert.deepEqual(retrieval.meta.matchedTags, ['时间线']);
    } finally {
        ragDiaryPlugin.vectorDBManager = originalVectorDBManager;
    }
});

test('ContextBridge retrieveDiary falls back to KNN when RiverMemo and TagMemo are unavailable', async () => {
    const originalVectorDBManager = ragDiaryPlugin.vectorDBManager;
    let searchCall = null;

    ragDiaryPlugin.vectorDBManager = {
        async executeNativeRiverQuery() {
            throw new Error('native artifact is warming up');
        },
        async search(...args) {
            searchCall = args;
            return [{
                chunkId: 202,
                fullPath: 'NovaTimeline/2026-07.md',
                text: '七月时间线',
                score: 0.81
            }];
        }
    };

    try {
        const bridge = ragDiaryPlugin.getContextBridge();
        const retrieval = await bridge.retrieveDiary({
            diaryNames: 'NovaTimeline',
            queryVector: new Float32Array([0, 1, 0, 0]),
            queryText: '七月',
            k: 5,
            riverMemo: true,
            tagMemo: true
        });

        assert(searchCall, 'KNN fallback must execute after native failure');
        assert.equal(searchCall[0], 'NovaTimeline');
        assert.equal(searchCall[2], 5);
        assert.equal(retrieval.results[0].chunkId, 202);
        assert.equal(retrieval.meta.riverMemoUsed, false);
        assert.equal(retrieval.meta.tagMemoUsed, false);
        assert.match(retrieval.meta.fallbackReason, /rivermemo-failed/);
        assert.match(retrieval.meta.fallbackReason, /tagmemo-unavailable/);
    } finally {
        ragDiaryPlugin.vectorDBManager = originalVectorDBManager;
    }
});

test('VCPTimeLine requests RiverMemo and expands the best matching complete months', async () => {
    const originalContextBridge = timeline.contextBridge;
    const originalConfig = timeline.config;
    const originalReadSummaryStore = timeline.readSummaryStore;
    const originalListTimelineFiles = timeline.listTimelineFiles;
    const originalGetTimelineDir = timeline.getTimelineDir;
    let retrievalOptions = null;

    timeline.config = {
        ...originalConfig,
        defaultExpandK: 2,
        defaultThreshold: 0.5
    };
    timeline.contextBridge = {
        async retrieveDiary(options) {
            retrievalOptions = options;
            return {
                results: [
                    {
                        chunkId: 1,
                        fullPath: 'NovaTimeline/2026-08.md',
                        score: 0.74
                    },
                    {
                        chunkId: 2,
                        sourceFile: 'NovaTimeline/2026-08.md',
                        score: 0.92
                    },
                    {
                        chunkId: 3,
                        fullPath: 'NovaTimeline/2026-07.md',
                        score: 0.83
                    },
                    {
                        chunkId: 4,
                        fullPath: 'NovaTimeline/2026-06.md',
                        score: 0.40
                    }
                ],
                meta: {
                    riverMemoUsed: true,
                    nativeJointQueryUsed: true
                }
            };
        }
    };
    timeline.readSummaryStore = async () => ({
        Nova: {
            '2026-07': '七月摘要',
            '2026-08': '八月摘要'
        }
    });
    timeline.listTimelineFiles = async () => [
        {
            month: '2026-06',
            name: '2026-06.md',
            fullPath: 'ignored/2026-06.md',
            content: '六月完整时间线'
        },
        {
            month: '2026-07',
            name: '2026-07.md',
            fullPath: 'ignored/2026-07.md',
            content: '七月完整时间线'
        },
        {
            month: '2026-08',
            name: '2026-08.md',
            fullPath: 'ignored/2026-08.md',
            content: '八月完整时间线'
        }
    ];
    timeline.getTimelineDir = () => 'root/NovaTimeline';

    try {
        const output = await timeline.buildInjection(
            'Nova',
            {
                queryVector: new Float32Array([1, 0, 0, 0]),
                userText: '八月的项目进展',
                aiText: '此前谈到了七月'
            },
            2,
            0.5
        );

        assert(retrievalOptions, 'Timeline must use the structured retrieval bridge');
        assert.equal(retrievalOptions.diaryNames, 'NovaTimeline');
        assert.equal(retrievalOptions.riverMemo, true);
        assert.equal(retrievalOptions.tagMemo, true);
        assert.equal(retrievalOptions.geodesicRerank, true);
        assert.equal(retrievalOptions.k, 20);
        assert.equal(retrievalOptions.candidateK, 100);
        assert.equal(retrievalOptions.queryText, '八月的项目进展\n此前谈到了七月');

        assert.match(output, /Rust 原生 RiverMemo 联合检索/);
        assert.match(output, /2026-08（相关度 0\.9200）/);
        assert.match(output, /八月完整时间线/);
        assert.match(output, /2026-07（相关度 0\.8300）/);
        assert.match(output, /七月完整时间线/);
        assert.doesNotMatch(output, /六月完整时间线/);
        assert(
            output.indexOf('2026-08（相关度 0.9200）')
                < output.indexOf('2026-07（相关度 0.8300）'),
            'complete months must be ordered by their best RiverMemo chunk score'
        );
    } finally {
        timeline.contextBridge = originalContextBridge;
        timeline.config = originalConfig;
        timeline.readSummaryStore = originalReadSummaryStore;
        timeline.listTimelineFiles = originalListTimelineFiles;
        timeline.getTimelineDir = originalGetTimelineDir;
    }
});