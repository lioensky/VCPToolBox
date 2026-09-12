'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const knowledgeBaseManager = require('../KnowledgeBaseManager');
const associativeDiscovery = require('../modules/associativeDiscovery');

async function withMockedKnowledgeBase(run) {
    const original = {
        rootPath: knowledgeBaseManager.config.rootPath,
        db: knowledgeBaseManager.db,
        executeNativeRiverQuery:
            knowledgeBaseManager.executeNativeRiverQuery,
        getVectorByChunkId:
            knowledgeBaseManager.getVectorByChunkId
    };
    const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'vcp-associative-river-')
    );

    try {
        knowledgeBaseManager.config.rootPath = tempRoot;
        await run(tempRoot);
    } finally {
        knowledgeBaseManager.config.rootPath = original.rootPath;
        knowledgeBaseManager.db = original.db;
        knowledgeBaseManager.executeNativeRiverQuery =
            original.executeNativeRiverQuery;
        knowledgeBaseManager.getVectorByChunkId =
            original.getVectorByChunkId;
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

test(
    'associative discovery uses native RiverMemo and preserves file-level output',
    async () => {
        await withMockedKnowledgeBase(async tempRoot => {
            const sourceRelativePath = 'SourceDiary/source.md';
            const sourceAbsolutePath = path.join(
                tempRoot,
                sourceRelativePath
            );
            await fs.mkdir(path.dirname(sourceAbsolutePath), {
                recursive: true
            });
            await fs.writeFile(
                sourceAbsolutePath,
                '源文件正文\nTag: 项目, 回忆',
                'utf8'
            );

            const sourceVector = new Float32Array([1, 0, 0, 0]);
            let nativeCall = null;
            knowledgeBaseManager.db = {
                prepare(sql) {
                    if (sql.includes('SELECT id FROM files WHERE path')) {
                        return {
                            get(value) {
                                return value.replace(/\\/g, '/')
                                    === sourceRelativePath
                                    ? { id: 7 }
                                    : null;
                            }
                        };
                    }
                    if (sql.includes('SELECT id, vector FROM chunks')) {
                        return {
                            get() {
                                return {
                                    id: 71,
                                    vector: Buffer.from(
                                        sourceVector.buffer
                                    )
                                };
                            }
                        };
                    }
                    throw new Error(`Unexpected SQL: ${sql}`);
                }
            };
            knowledgeBaseManager.getVectorByChunkId = async id => {
                assert.equal(id, 71);
                return sourceVector;
            };
            knowledgeBaseManager.executeNativeRiverQuery =
                async (query, options) => {
                    nativeCall = { query, options };
                    return {
                        artifactSig: 'river-artifact',
                        queryId: 'river-query',
                        omega: {
                            omega: 0.74,
                            regime: 'dense'
                        },
                        diagnostics: {
                            nativeTopologyV3: {
                                jointUsed: true
                            }
                        },
                        results: [
                            {
                                chunkId: 1,
                                fullPath: sourceRelativePath,
                                sourceFile: sourceRelativePath,
                                text: '源文件自身',
                                score: 0.99
                            },
                            {
                                chunkId: 2,
                                fullPath: 'TargetDiary/related.md',
                                sourceFile:
                                    'TargetDiary/related.md',
                                text: '关联内容第一段',
                                score: 0.91,
                                matchedTags: ['项目'],
                                omega: 0.74,
                                riverRegime: 'dense',
                                role: 'structural_explanation',
                                topologyBonus: 0.06,
                                anchorBonus: 0.03
                            },
                            {
                                chunkId: 3,
                                fullPath: 'TargetDiary/related.md',
                                sourceFile:
                                    'TargetDiary/related.md',
                                text: '关联内容第二段',
                                score: 0.87,
                                matchedTags: ['回忆']
                            },
                            {
                                chunkId: 4,
                                fullPath: 'TargetDiary/other.md',
                                sourceFile:
                                    'TargetDiary/other.md',
                                text: '另一篇内容',
                                score: 0.72
                            }
                        ]
                    };
                };

            const result = await associativeDiscovery.discover({
                sourceFilePath: sourceRelativePath,
                k: 2,
                range: ['TargetDiary'],
                tagBoost: '0.6+'
            });

            assert(nativeCall, 'native RiverMemo must be called');
            assert.equal(nativeCall.query.text, '源文件正文\nTag: 项目, 回忆');
            assert.strictEqual(nativeCall.query.vector, sourceVector);
            assert.deepEqual(
                nativeCall.options.diaryNames,
                ['TargetDiary']
            );
            assert.equal(
                nativeCall.options.sourceObservationConfig.baseTagBoost,
                0.6
            );
            assert.equal(nativeCall.options.enabled, true);
            assert.equal(nativeCall.options.fallbackToLegacy, true);

            assert.equal(result.source, sourceRelativePath);
            assert.equal(result.results.length, 2);
            assert.equal(
                result.results[0].path,
                'TargetDiary/related.md'
            );
            assert.equal(result.results[0].name, 'related.md');
            assert.equal(result.results[0].score, 0.91);
            assert.equal(result.results[0].chunks.length, 2);
            assert.deepEqual(
                result.results[0].matchedTags.sort(),
                ['回忆', '项目'].sort()
            );
            assert.equal(result.results[0].riverMemo.omega, 0.74);
            assert.equal(
                result.results[0].riverMemo.role,
                'structural_explanation'
            );
            assert(
                result.results.every(
                    item => item.path !== sourceRelativePath
                ),
                'source file must be excluded'
            );

            assert.equal(
                result.metadata.engine,
                'RiverMemo Topology V3 [Rust/Rayon]'
            );
            assert.equal(
                result.metadata.nativeJointQueryUsed,
                true
            );
            assert.equal(result.metadata.artifactSig, 'river-artifact');
            assert.equal(result.metadata.omega, 0.74);
            assert.deepEqual(
                result.metadata.range,
                ['TargetDiary']
            );
        });
    }
);

test(
    'associative discovery enumerates indexed diaries for an empty range',
    async () => {
        await withMockedKnowledgeBase(async tempRoot => {
            const sourceRelativePath = 'SourceDiary/source.md';
            const sourceAbsolutePath = path.join(
                tempRoot,
                sourceRelativePath
            );
            await fs.mkdir(path.dirname(sourceAbsolutePath), {
                recursive: true
            });
            await fs.writeFile(sourceAbsolutePath, '源文件', 'utf8');

            let nativeOptions = null;
            knowledgeBaseManager.db = {
                prepare(sql) {
                    if (sql.includes('SELECT id FROM files WHERE path')) {
                        return {
                            get() {
                                return { id: 8 };
                            }
                        };
                    }
                    if (sql.includes('SELECT id, vector FROM chunks')) {
                        return {
                            get() {
                                return {
                                    id: 81,
                                    vector: Buffer.alloc(16)
                                };
                            }
                        };
                    }
                    if (
                        sql.includes(
                            'SELECT DISTINCT diary_name FROM files'
                        )
                    ) {
                        return {
                            all() {
                                return [
                                    { diary_name: 'AlphaDiary' },
                                    { diary_name: 'BetaDiary' }
                                ];
                            }
                        };
                    }
                    throw new Error(`Unexpected SQL: ${sql}`);
                }
            };
            knowledgeBaseManager.getVectorByChunkId =
                async () => new Float32Array([1, 0, 0, 0]);
            knowledgeBaseManager.executeNativeRiverQuery =
                async (_query, options) => {
                    nativeOptions = options;
                    return {
                        results: [],
                        diagnostics: {
                            nativeTopologyV3: {
                                jointUsed: true
                            }
                        }
                    };
                };

            const result = await associativeDiscovery.discover({
                sourceFilePath: sourceRelativePath,
                k: 10,
                range: []
            });

            assert.deepEqual(
                nativeOptions.diaryNames,
                ['AlphaDiary', 'BetaDiary']
            );
            assert.equal(result.metadata.range, 'All');
            assert.equal(result.results.length, 0);
        });
    }
);