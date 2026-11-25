const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MetaThinkingManager = require('../Plugin/RAGDiaryPlugin/MetaThinkingManager');

// Geometry/cache unit tests use a reader stub over their own fixtures.
// Real N-API storage is exercised separately on a disposable database.
function fixtureStarReader(dbPath, epaMean) {
    return {
        dbPath,
        async readMetaStarPool(diaries, knownFingerprint) {
            const Database = require('better-sqlite3');
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                const rows = db.prepare(`
                    SELECT c.id AS chunkId, c.file_id AS fileId, c.vector_version AS vectorVersion,
                           c.content AS text, c.vector, f.diary_name AS diaryName, f.path AS sourceFile
                    FROM chunks c JOIN files f ON f.id = c.file_id
                    WHERE f.diary_name IN (${diaries.map(() => '?').join(',')}) ORDER BY c.id
                `).all(...diaries);
                const fingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify(rows)).digest('hex');
                const mean = epaMean && Buffer.from(epaMean.buffer, epaMean.byteOffset, epaMean.byteLength).toString('base64');
                return knownFingerprint === fingerprint ? { fingerprint } : { fingerprint, rows, epaMean: mean };
            } finally {
                db.close();
            }
        }
    };
}

function unit(arr) {
    let normSq = 0;
    for (const v of arr) normSq += v * v;
    const inv = 1 / Math.sqrt(normSq);
    return Float32Array.from(arr, v => v * inv);
}

test('global manifold transform attenuates meanAxis alignment and preserves orthogonal components', () => {
    const mtm = new MetaThinkingManager({});
    const meanAxis = unit([1, 0, 0, 0]);
    const manifold = { meanAxis, beta: 0.7 };
    const orig = unit([0.6, 0.5, -0.4, 0.48]);
    const inGlobal = mtm._v3ToGlobalSpace(orig, manifold);
    assert.ok(inGlobal);
    // 沿 meanAxis 分量被 (1 - beta) 压缩，正交分量相对比例保持不变
    assert.ok(mtm._v3Dot(inGlobal, meanAxis) < mtm._v3Dot(orig, meanAxis));
    const ratioOrig = orig[1] / orig[2];
    const ratioGlobal = inGlobal[1] / inGlobal[2];
    assert.ok(Math.abs(ratioOrig - ratioGlobal) < 1e-5, `orthogonal component ratio drifted: ${ratioOrig} vs ${ratioGlobal}`);
    // 组合投影 _v3ToStarVector 与分步调用等价
    const starAxis = unit([0, 1, 0, 0]);
    const combined = mtm._v3ToStarVector(orig, manifold, starAxis, 0.85);
    const stepByStep = mtm._v3ToStarSpace(inGlobal, starAxis, 0.85);
    assert.ok(mtm._v3Dot(combined, stepByStep) > 0.999999);
});

test('star-pool dual-layer centering expands narrow cone around zero', () => {
    const mtm = new MetaThinkingManager({});
    // 4 stars crammed into a narrow positive cone around axis e0
    const rawStars = [
        unit([0.9, 0.3, 0.0, 0.0]),
        unit([0.9, -0.3, 0.0, 0.0]),
        unit([0.9, 0.0, 0.3, 0.0]),
        unit([0.9, 0.0, -0.3, 0.0])
    ];
    const meanAxis = mtm._v3WeightedCentroid(rawStars.map(v => ({ vector: v, weight: 1 })));
    const zStars = rawStars.map(v => mtm._v3ToStarSpace(v, meanAxis, 0.85));
    // Before centering, pair (0,1) had high positive cosine (~0.8); after centering it flips negative!
    const cosBefore = mtm._v3Dot(rawStars[0], rawStars[1]);
    const cosAfter = mtm._v3Dot(zStars[0], zStars[1]);
    assert.ok(cosBefore > 0.75, `expected narrow cone cosBefore > 0.75, got ${cosBefore}`);
    assert.ok(cosAfter < -0.3, `expected centered opposite stars cosAfter < -0.3, got ${cosAfter}`);
});

test('2D non-negative cone projection distinguishes positive cone from negative hemisphere', () => {
    const mtm = new MetaThinkingManager({});
    const u1 = unit([1, 0, 0]);
    const u2 = unit([0, 1, 0]);
    const coneNorm = (vec) => Math.sqrt(mtm._v3ConeProjSq2(mtm._v3Dot(vec, u1), mtm._v3Dot(vec, u2), mtm._v3Dot(u1, u2)));
    // Inside positive cone: norm = 1
    assert.ok(Math.abs(coneNorm(unit([0.6, 0.8, 0])) - 1.0) < 1e-6);
    // Pure negative quadrant: non-negative cone projection must be 0 (unlike unsigned plane!)
    assert.equal(coneNorm(unit([-0.6, -0.8, 0])), 0);
    // Orthogonal to both: 0
    assert.equal(coneNorm(unit([0, 0, 1])), 0);
    // Mixed (+u1, -u2): projects onto ray u1 only -> cos(vec, u1)
    const mixed = unit([0.6, -0.8, 0]);
    assert.ok(Math.abs(coneNorm(mixed) - 0.6) < 1e-6);
});

test('Fisher-Tippett exact EVT parameters & scale-aware Rayleigh biteTorque / chi2 clearance scale cleanly with pool size', () => {
    const mtm = new MetaThinkingManager({});
    const ft716 = mtm._v3FisherTippettParams(716);
    const ft10k = mtm._v3FisherTippettParams(10000);
    assert.ok(Math.abs(ft716.tau - Math.sqrt(2 * Math.log(716))) < 1e-9);
    assert.ok(ft716.bN > 2.95 && ft716.bN < 3.10, `expected exact b_716 ≈ 3.017, got ${ft716.bN}`);
    assert.ok(ft10k.bN > ft716.bN && (ft10k.bN / ft10k.tau) > (ft716.bN / ft716.tau), 'exact Fisher-Tippett b_N/tau grows properly with N');

    // Retired dead-code methods must remain removed
    assert.equal(mtm._v3ComputeWavefrontInterference, undefined);
    assert.equal(mtm._v3ComputeThermostat, undefined);
});

test('time-flow axis is purely geometric and text-agnostic (zero regex dependency)', () => {
    const mtm = new MetaThinkingManager({});
    const z1 = unit([1, 0, 0, 0]);
    const aiVec = unit([0.8, 0.6, 0, 0]);
    const nearVec = unit([0.7, 0.7, 0.1, 0]);
    const pivotVec = unit([0.2, 0.1, 0.9, 0.35]);
    const farVec = unit([0, 0, 0.9, 0.4]);

    // Exact same vectors with completely different text must produce identical geometric result!
    const advA = mtm._v3TimeFlowAxis('不对，重来推翻！', nearVec, aiVec, nearVec, nearVec, z1, null);
    const advB = mtm._v3TimeFlowAxis('不错，继续展开！', nearVec, aiVec, nearVec, nearVec, z1, null);
    assert.equal(advA.mode, 'advance');
    assert.equal(advB.mode, 'advance');
    assert.equal(advA.shift, 0);
    assert.ok(mtm._v3Dot(advA.vector, advB.vector) > 0.999999, 'text keywords must not alter geometric time-flow');
    assert.ok(Math.abs(mtm._v3Dot(advA.vector, aiVec)) < 1e-5, 'advance must extract exact orthogonal net delta');

    const piv = mtm._v3TimeFlowAxis('任意文本', pivotVec, aiVec, pivotVec, pivotVec, z1, null);
    assert.equal(piv.mode, 'pivot');
    assert.ok(piv.shift >= 0 && piv.shift < 0.6);

    const ortho = mtm._v3TimeFlowAxis('任意文本', farVec, aiVec, farVec, farVec, z1, null);
    assert.equal(ortho.mode, 'orthogonal');
    assert.ok(ortho.shift >= 0.5);
    assert.ok(mtm._v3Dot(ortho.vector, farVec) > 0.999999, 'orthogonal new vector must remain intact');
});

test('processMetaThinkingV3 invokes executeNativeRiverQuery once and integrates personal diary bridge', async () => {
    let riverCalls = 0;
    const broadcasts = [];

    // 6 orthogonal-ish synthetic stars + 1 real diary chunk (#999) aligned with StarE
    const vectors = new Map([
        [1, unit([0.92, 0.35, 0.05, 0.05, 0.05, 0.05])], // StarA (primary)
        [2, unit([0.85, 0.48, 0.08, 0.05, 0.05, 0.05])], // StarA_Mirror (near mirror of StarA)
        [3, unit([0.20, 0.92, 0.25, 0.05, 0.05, 0.05])], // StarB (strong orthogonal tension)
        [4, unit([0.05, 0.10, 0.95, 0.10, 0.10, 0.10])], // StarC
        [5, unit([0.05, 0.10, 0.10, 0.95, 0.10, 0.10])], // StarD
        [6, unit([0.05, 0.10, 0.10, 0.10, 0.96, 0.05])], // StarE (aligned with awakened diary #999!)
        [999, unit([0.05, 0.08, 0.08, 0.08, 0.97, 0.05])] // Awakened personal diary chunk
    ]);

    const starDocs = [
        { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '星甲.md', text: '星甲正文', score: 0.91, topologyV3: { regime: 'dense', differentiaScore: 0.8 } },
        { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '星甲镜像.md', text: '星甲镜像正文', score: 0.89, topologyV3: { regime: 'dense', differentiaScore: 0.7 } },
        { chunkId: 3, diaryName: '希夷星池簇', sourceFile: '星乙.md', text: '星乙正文', score: 0.62, topologyV3: { regime: 'dense', differentiaScore: 0.75 } },
        { chunkId: 4, diaryName: '希夷星池簇', sourceFile: '星丙.md', text: '星丙正文', score: 0.45, topologyV3: { regime: 'dense' } },
        { chunkId: 5, diaryName: '希夷星池簇', sourceFile: '星丁.md', text: '星丁正文', score: 0.44, topologyV3: { regime: 'dense' } },
        { chunkId: 6, diaryName: '希夷星池簇', sourceFile: '星戊.md', text: '星戊正文', score: 0.43, topologyV3: { regime: 'dense' } }
    ];

    const mockRag = {
        vectorDBManager: {
            async executeNativeRiverQuery() {
                riverCalls++;
                return { results: starDocs, diagnostics: { degraded: false } };
            },
            async getVectorByChunkId(id) {
                return vectors.get(id) || null;
            }
        },
        pushVcpInfo(info) {
            broadcasts.push(info);
        }
    };

    const mtm = new MetaThinkingManager(mockRag);
    const queryVec = unit([0.75, 0.62, 0.12, 0.05, 0.08, 0.05]);
    const formula = await mtm.processMetaThinkingV3(
        '希夷星池簇',
        queryVec,
        '这是一个关于系统架构与约束的深度讨论',
        null,
        '系统架构讨论',
        false,
        {
            getActiveDiaryChunks: async () => [
                { chunkId: 999, diaryName: '我的日常', score: 0.88 },
                { chunkId: 1, diaryName: '希夷星池簇', score: 0.99 } // must be filtered out of diary bridge!
            ]
        }
    );

    assert.equal(riverCalls, 1, 'V3.3 must execute only 1 native RiverMemo query (no Step 2/3 redundant queries)');
    assert.match(formula, /^\$\$势陷\[∂.+ (?:∧|⋈) ∇.+\]_φ ↦ 思奇 σ_∞\(.+ ⊖ φ \| ℳ\)(?: ∥ ⊘\(r_⊥(?: ≫ 0)?\))? →_\{τ,x\} \?\$\$$/);

    assert.equal(broadcasts.length, 1);
    const info = broadcasts[0];
    assert.equal(info.version, 'v3.8-pure-tensor');
    assert.equal(info.diaryBridgeSource, 'active-diaries');
    assert.equal(info.diaryBridgeCount, 1);
    assert.equal(info.stars.length, 3);
    const names = info.stars.map(s => s.name);
    assert.equal(new Set(names).size, 3, 'all 3 trinity stars must be distinct');
    assert.equal(names[0], '星甲');
    assert.notEqual(names[1], '星甲镜像', 'anti-mirror clearance must suppress near-duplicate mirror star');
    assert.equal(names[2], '星戊', 'awakened personal diary bridge must steer slingshot star toward 星戊');
});

function singleStarReader() {
    const row = {
        chunkId: 1, fileId: 1, vectorVersion: 1, sourceFile: '星甲.md',
        diaryName: '希夷星池簇', text: '星甲', vector: Buffer.from(unit([1, 0, 0, 0]).buffer)
    };
    return {
        dbPath: path.join(require('node:os').tmpdir(), 'vcp-meta-unit-star-pool.sqlite'),
        async readMetaStarPool() { return { fingerprint: 'single-star', rows: [row] }; }
    };
}
test('real local VectorStore read-only smoke test for V3.1 star-pool cache and latency', async (t) => {
    const dbPath = path.join(__dirname, '..', 'VectorStore', 'knowledge_base.sqlite');
    if (!fs.existsSync(dbPath)) {
        t.skip('local VectorStore/knowledge_base.sqlite not present');
        return;
    }
    const hasStars = new (require('better-sqlite3'))(dbPath, { readonly: true, fileMustExist: true });
    let isStarScopePresent;
    try {
        isStarScopePresent = hasStars.prepare(`
            SELECT 1 FROM chunks c JOIN files f ON c.file_id = f.id
            WHERE f.diary_name = ? AND length(c.vector) > 0 LIMIT 1
        `).get('希夷星池簇');
    } finally {
        hasStars.close();
    }
    if (!isStarScopePresent) return t.skip('local VectorStore does not contain the smoke test star scope');
    const storePath = path.dirname(dbPath);
    const mockVdb = { ...fixtureStarReader(dbPath), config: { storePath } };
    const mtm = new MetaThinkingManager({ vectorDBManager: mockVdb });
    const manifold = mtm._v3LoadGlobalManifold(mockVdb);
    if (!manifold) {
        t.skip('no .vcpwc snapshot present');
        return;
    }

    const pool1 = await mtm._v3LoadStarPoolCache(mockVdb, ['希夷星池簇'], manifold);
    assert.ok(pool1 && pool1.stars.length > 0, 'star pool cache should load stars from real DB');
    assert.ok(pool1.starMeanAxis && pool1.starMeanAxis.length === manifold.meanAxis.length);

    // Second call must hit cache (exact same object reference)
    const tCache0 = Date.now();
    const pool2 = await mtm._v3LoadStarPoolCache(mockVdb, ['希夷星池簇'], manifold);
    const cacheMs = Date.now() - tCache0;
    assert.strictEqual(pool1, pool2, 'second load must hit in-memory star pool cache');
    assert.ok(cacheMs < 50, `cache check should be fast, got ${cacheMs}ms`);

    // End-to-end processMetaThinkingV3 with cached pool (mocking only Step 1 native query)
    const sampleStar = pool1.stars[0];
    const queryVec = sampleStar.raw;
    let calls = 0;
    const infos = [];
    mtm.ragPlugin = {
        vectorDBManager: {
            ...mockVdb,
            async executeNativeRiverQuery() {
                calls++;
                return {
                    results: pool1.stars.slice(0, 12).map((s, idx) => ({
                        chunkId: s.chunkId,
                        diaryName: s.diaryName,
                        sourceFile: s.sourceFile,
                        text: s.text,
                        score: 0.9 - idx * 0.02,
                        topologyV3: { regime: 'dense', differentiaScore: 0.5 }
                    })),
                    diagnostics: { degraded: false }
                };
            },
            async getVectorByChunkId(id) {
                return pool1.byChunkId.get(id)?.raw || null;
            }
        },
        pushVcpInfo(info) { infos.push(info); }
    };

    const t0 = Date.now();
    const formula = await mtm.processMetaThinkingV3(
        '希夷星池簇', queryVec, '测试真实星池三体求解', null, '测试', false, {}
    );
    const elapsed = Date.now() - t0;
    assert.equal(calls, 1);
    assert.ok(formula.startsWith('$$势陷'));
    assert.equal(infos.length, 1);
    assert.equal(infos[0].starPoolSize, pool1.stars.length);
    assert.ok(elapsed < 100, `V3.2 cached solve should be <100ms, got ${elapsed}ms`);
});

test('3D non-negative cone marginal gain returns 0 for redundant basis and exact gain for orthogonal axis', () => {
    const mtm = new MetaThinkingManager({});
    const u1 = unit([1, 0, 0, 0]);
    const u2 = unit([0, 1, 0, 0]);
    const target = unit([0.6, 0.6, 0.5291502622, 0]); // norm=1, z-component ≈ 0.52915
    // Candidate lying inside cone(u1, u2) must produce ~0 marginal gain (FP32 rounding tolerance)
    const redundant = unit([0.7, 0.7, 0, 0]);
    const redundantGain = mtm._v3ConeMarginalGain(target, [u1, u2], redundant);
    assert.ok(redundantGain < 1e-4, `expected ~0 marginal gain for redundant vector, got ${redundantGain}`);
    // Pure orthogonal candidate e3 must capture exact z-component amplitude (~0.52915)
    const novel = unit([0, 0, 1, 0]);
    const gain = mtm._v3ConeMarginalGain(target, [u1, u2], novel);
    assert.ok(Math.abs(gain - 0.5291502622) < 1e-5, `expected ~0.52915, got ${gain}`);
    // Candidate opposite to target's z-component must yield 0 (non-negative cone!)
    const opposite = unit([0, 0, -1, 0]);
    assert.equal(mtm._v3ConeMarginalGain(target, [u1, u2], opposite), 0);
});

test('pure-geometric primary candidate calibration suppresses static background carryover without name matching', () => {
    const mtm = new MetaThinkingManager({});
    const zBg = unit([1, 0, 0, 0]);
    const zUser = unit([0, 1, 0, 0]);
    const zVectors = new Map([
        [10, unit([0.95, 0.20, 0, 0])], // High on old background zBg, weak on current zUser
        [20, unit([0.10, 0.98, 0, 0])]  // Strong on current zUser, low on old background
    ]);
    const starPool = {
        byChunkId: new Map([
            [10, { z: zVectors.get(10) }],
            [20, { z: zVectors.get(20) }]
        ])
    };
    const candidates = [
        { chunkId: 10, sourceFile: '背景惯性星.md', score: 0.72 },
        { chunkId: 20, sourceFile: '当下本征星.md', score: 0.65 }
    ];
    const calibrated = mtm._v3CalibratePrimaryCandidates(
        candidates, zUser, zBg, starPool, new Map(), v => v
    );
    assert.ok(calibrated[1].score > calibrated[0].score, 'star aligned with current zUser must overtake background-carryover star');
});

test('Rayleigh scale-aware biteTorque peaks at starNeighborScale and attenuates overly-close near-duplicate stars', () => {
    const mtm = new MetaThinkingManager({});
    const dim = 16;
    const basis = (idx) => { const v = new Float32Array(dim); v[idx] = 1; return v; };
    const z1 = basis(0);
    const z2 = basis(1);
    const eject = basis(2);
    // Sweet-spot candidate aligned ≈ 0.375 with ejectImpulse vs too-close candidate aligned ≈ 0.85 with ejectImpulse
    const sweetRaw = new Float32Array(dim);
    sweetRaw[2] = 0.375;
    sweetRaw[3] = Math.sqrt(1 - 0.375 * 0.375);
    const sweetVec = unit(sweetRaw);
    const tooCloseRaw = new Float32Array(dim);
    tooCloseRaw[2] = 0.85;
    tooCloseRaw[4] = Math.sqrt(1 - 0.85 * 0.85);
    const tooCloseVec = unit(tooCloseRaw);
    const vectors = new Map([[1, z1], [2, z2], [3, sweetVec], [4, tooCloseVec]]);
    const pool = { orthTopScale: 0.375, pairStdCos: 0.0892, gumbelBN: 3.017, tauExtremeZ: 3.626, stars: new Array(716) };
    const items = [
        { chunkId: 1, sourceFile: '主星.md', score: 0.9 },
        { chunkId: 2, sourceFile: '对偶.md', score: 0.8 },
        { chunkId: 3, sourceFile: '甜点星.md', score: 0.5 },
        { chunkId: 4, sourceFile: '贴脸星.md', score: 0.5 }
    ];
    const selected = mtm._selectV3TrinityStars(items, {
        lockedPrimary: { item: items[0], starName: '主星', slot: 'primary' },
        lockedConjugate: { item: items[1], starName: '对偶', slot: 'conjugate' },
        ejectImpulseZ: eject,
        starPool: pool,
        vectorByChunkId: vectors
    });
    assert.equal(selected[2].starName, '甜点星', 'Rayleigh biteTorque must peak at starNeighborScale and reject overly-close p=0.85 candidate');
});

test('V5 Tag-space bridge fallback consumes Tag vectors cleanly without L1 SQL fetches', async () => {
    const mtm = new MetaThinkingManager({});
    const tagMap = new Map([
        ['RiverMemo_V5', unit([0, 0, 1, 0])]
    ]);
    const mockVdb = {
        async getTagVectorByName(name) {
            return tagMap.get(name) || null;
        }
    };

    // No passive diaries -> falls back to V5 matchedTags Tag-space bridge, stripping z1 & zPrevAi on topic-jump
    const z1 = unit([1, 0, 0, 0]);
    const z2 = unit([0, 1, 0, 0]);
    const bridge = await mtm._v3BuildDiaryBridge(
        mockVdb, [], ['希夷星池簇'], null, null, 0.85, z1, z2, null, new Map(),
        { matchedTags: ['RiverMemo_V5'], timeFlowMode: 'topic-jump', zPrevAi: unit([1, 0, 0, 0]) }
    );
    assert.equal(bridge.source, 'v5-tag-bridge');
    assert.equal(bridge.count, 1);
    assert.ok(mtm._v3Dot(bridge.vector, unit([0, 0, 1, 0])) > 0.999);
});

test('4-step spherical diffusion kinematics (rho4, R4) detects slow tight-basin spirals while keeping monotonic progression zero-FP', () => {
    const mtm = new MetaThinkingManager({});
    const pool = { nnStepMed: 1.1184, pairStdCos: 0.0892, tauExtremeZ: 3.6259, gumbelBN: 3.0172, pairMeanCos: 0 };
    const dim = 16;
    const z0 = new Float32Array(dim); z0[0] = 1;
    const oA = new Float32Array(dim); oA[1] = 1;
    const oB = new Float32Array(dim); oB[2] = 1;
    // 1) Slow tight-basin 4-step spiral (100 deg/step at radius 0.36 -> R3≈0.83 > 0.5, but R4≈0.14 < 0.5 & rho4≈0.358 <= halfStep/√2)
    const rad = 0.36;
    const base = Math.sqrt(1 - rad * rad);
    const ang = (100 * Math.PI) / 180;
    const sp = [0, 1, 2, 3].map(k => {
        const v = new Float32Array(dim);
        v[0] = base; v[1] = rad * Math.cos(k * ang); v[2] = rad * Math.sin(k * ang);
        return unit(v);
    });
    const kinSpiral4 = mtm._v3ComputeAgentKinematics([sp[0], sp[1], sp[2]], sp[3], null, null, 0.85, { starPool: pool });
    assert.ok(kinSpiral4.diffusionRatio4 < 0.5 && kinSpiral4.basinRadiusK <= (0.5 * pool.nnStepMed) / Math.SQRT2);
    assert.equal(kinSpiral4.stagnant, true, '4-step tight-basin slow spiral must be detected cleanly');
    assert.ok(kinSpiral4.mEndo >= 0.5);

    // 2) 4-step monotonic geodesic progression (step cos=0.89): R4 ≈ 2.58 >> 1 -> NOT stagnant
    const th = Math.acos(0.89);
    const mono = [0, 1, 2, 3].map(k => {
        const v = new Float32Array(dim);
        v[0] = Math.cos(k * th); v[1] = Math.sin(k * th);
        return unit(v);
    });
    const kinMono4 = mtm._v3ComputeAgentKinematics([mono[0], mono[1], mono[2]], mono[3], null, null, 0.85, { starPool: pool });
    assert.ok(kinMono4.diffusionRatio4 > 2.0);
    assert.equal(kinMono4.stagnant, false, '4-step monotonic geodesic progression must never trigger stagnation');
    assert.equal(kinMono4.mEndo, 0, 'non-stagnant progression must emit zero noise mEndo');
});

test('isMetaThinkingV3Message & findLastRealUserMessage survive shallow/JSON cloning when non-enumerable flag is lost', () => {
    const { isMetaThinkingV3Message, findLastRealUserMessage } = require('../modules/messageProcessor');
    const formula = '$$势陷[∂共晶点 ∧ ∇伴随文本]_φ ↦ 思奇 σ_∞(回声反语 ⊖ φ) →_{τ,x} ?$$';
    const injected = { role: 'user', content: formula };
    Object.defineProperty(injected, '__vcpMetaThinkingV3__', {
        value: true,
        enumerable: false,
        configurable: true
    });

    const shallowCloned = { ...injected };
    const jsonCloned = JSON.parse(JSON.stringify(injected));
    assert.equal(shallowCloned.__vcpMetaThinkingV3__, undefined);
    assert.equal(jsonCloned.__vcpMetaThinkingV3__, undefined);
    assert.equal(isMetaThinkingV3Message(injected), true);
    assert.equal(isMetaThinkingV3Message(shallowCloned), true);
    assert.equal(isMetaThinkingV3Message(jsonCloned), true);

    // 多行叠加的 V3 公式也能识别，但混入普通用户文字不能误判
    assert.equal(isMetaThinkingV3Message({ role: 'user', content: `${formula}\n$$思奇 σ_∞(孤星 ⊖ φ) →_{τ,x} ?$$` }), true);
    assert.equal(isMetaThinkingV3Message({ role: 'user', content: `帮我解释一下 ${formula}` }), false);
    assert.equal(isMetaThinkingV3Message({ role: 'assistant', content: formula }), false);

    // 紧贴真实用户发言正上方时，即使标记丢失也不被误识别为最后真实用户发言
    const messages = [
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: '上一轮回答' },
        jsonCloned,
        { role: 'user', content: '本轮真实问题' }
    ];
    const lastReal = findLastRealUserMessage(messages);
    assert.equal(lastReal.index, 3);
    assert.equal(lastReal.sanitizedContent, '本轮真实问题');

    // 若公式恰好出现在末尾（如中间步骤异常），仍能向前跳过公式找到真正用户发言
    const trailing = [
        { role: 'user', content: '本轮真实问题' },
        shallowCloned
    ];
    const found = findLastRealUserMessage(trailing);
    assert.equal(found.index, 0);
    assert.equal(found.sanitizedContent, '本轮真实问题');
});

test('V3 placeholder regex supports lowercase v3 and version suffixes without hijacking legacy chains', () => {
    const legacyRe = /\[\[VCP元思考(?![vV]3(?:\.\d+)?(?=$|[:\]\s]))([^\]]*?)\]\]/g;
    const v3Re = /\[\[VCP元思考[vV]3(?:\.\d+)?(?=$|[:\]\s])([^\]]*?)\]\]/g;

    const sample = [
        '[[VCP元思考]]',
        '[[VCP元思考:daima::Group]]',
        '[[VCP元思考:V3CustomChain]]',
        '[[VCP元思考V3]]',
        '[[VCP元思考v3::Group]]',
        '[[VCP元思考V3.2]]',
        '[[VCP元思考V3.2:星池A|星池B::Group]]'
    ].join('\n');

    const legacyMatches = [...sample.matchAll(legacyRe)].map(m => m[0]);
    const v3Matches = [...sample.matchAll(v3Re)].map(m => ({ full: m[0], rest: m[1] }));

    assert.deepEqual(legacyMatches, [
        '[[VCP元思考]]',
        '[[VCP元思考:daima::Group]]',
        '[[VCP元思考:V3CustomChain]]'
    ]);
    assert.deepEqual(v3Matches, [
        { full: '[[VCP元思考V3]]', rest: '' },
        { full: '[[VCP元思考v3::Group]]', rest: '::Group' },
        { full: '[[VCP元思考V3.2]]', rest: '' },
        { full: '[[VCP元思考V3.2:星池A|星池B::Group]]', rest: ':星池A|星池B::Group' }
    ]);
});

test('multi-chunk star card aggregates all chunk vectors in starPool and populates vectorCache for every chunkId', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Database = require('better-sqlite3');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-v3-multichunk-'));
    const dbPath = path.join(tmpDir, 'mc.sqlite');
    const db = new Database(dbPath);
    const vecBuf = (arr) => Buffer.from(unit(arr).buffer);
    try {
        db.exec(`
            CREATE TABLE files (id INTEGER PRIMARY KEY, diary_name TEXT, path TEXT, updated_at INTEGER);
            CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, content TEXT, vector BLOB, vector_version INTEGER);
            CREATE TABLE kbm_runtime_meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
        `);
        db.prepare("INSERT INTO files (id, diary_name, path, updated_at) VALUES (1, '希夷星池簇', '星甲.md', 100)").run();
        db.prepare("INSERT INTO files (id, diary_name, path, updated_at) VALUES (2, '希夷星池簇', '星乙.md', 100)").run();
        db.prepare("INSERT INTO chunks (id, file_id, content, vector, vector_version) VALUES (1001, 1, '星甲一段', ?, 1)").run(vecBuf([1, 0, 0, 0]));
        db.prepare("INSERT INTO chunks (id, file_id, content, vector, vector_version) VALUES (1002, 1, '星甲二段', ?, 1)").run(vecBuf([0, 1, 0, 0]));
        db.prepare("INSERT INTO chunks (id, file_id, content, vector, vector_version) VALUES (2001, 2, '星乙', ?, 1)").run(vecBuf([0, 0, 1, 0]));
    } finally {
        db.close();
    }
    try {
        const mtm = new MetaThinkingManager({});
        const pool = await mtm._v3LoadStarPoolCache(fixtureStarReader(dbPath), ['希夷星池簇'], null, { ttlMs: 0 });
        assert.equal(pool.stars.length, 2, 'multi-chunk star must deduplicate to 1 star entry');
        const starA = pool.byStarName.get('星甲');
        assert.equal(starA.chunks.length, 2, 'starA must retain both chunks');
        assert.ok(pool.byChunkId.has(1001) && pool.byChunkId.has(1002), 'byChunkId must index every chunk of a multi-chunk star');
        // Aggregated raw vector must reflect both chunk 1 (dim 0) and chunk 2 (dim 1) equally (~0.707, ~0.707)
        assert.ok(Math.abs(starA.raw[0] - Math.SQRT1_2) < 1e-4 && Math.abs(starA.raw[1] - Math.SQRT1_2) < 1e-4);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('star-pool TTL serves repeated calls without a second native read', async () => {
    const vdb = singleStarReader();
    let reads = 0;
    const read = vdb.readMetaStarPool;
    vdb.readMetaStarPool = async () => {
        reads++;
        return read();
    };
    const mtm = new MetaThinkingManager({});
    const scope = ['希夷星池簇'];
    const first = await mtm._v3LoadStarPoolCache(vdb, scope, null, { ttlMs: 60_000 });
    assert.ok(first?.stars.length);
    for (let i = 0; i < 20; i++) {
        assert.strictEqual(await mtm._v3LoadStarPoolCache(vdb, scope, null, { ttlMs: 60_000 }), first);
    }
    assert.equal(reads, 1);
});

test('diary bridge uses exact 2D orthonormal-basis projection and suppresses zero-novelty / noisy residuals', async () => {
    const mtm = new MetaThinkingManager({});
    // Non-orthogonal basis (cos(z1, z2) = 0.6, ~53 deg) — sequential GS would leak z1 back!
    const z1 = unit([1, 0, 0, 0]);
    const z2 = unit([0.6, 0.8, 0, 0]);

    // Case 1: Genuine novel component along e2 (index 2)
    const novelDiary = unit([0.5, 0.5, 0.70710678, 0]);
    const orthoNovel = mtm._v3OrthogonalizePlane(novelDiary, z1, z2, 0.12);
    assert.ok(orthoNovel.vector, 'genuine novel diary must survive orthogonalization');
    assert.ok(Math.abs(mtm._v3Dot(orthoNovel.vector, z1)) < 1e-6, 'must have zero leakage onto z1');
    assert.ok(Math.abs(mtm._v3Dot(orthoNovel.vector, z2)) < 1e-6, 'must have zero leakage onto z2');
    assert.ok(Math.abs(orthoNovel.novelty - 0.70710678) < 1e-4, `expected novelty ~0.707, got ${orthoNovel.novelty}`);

    // Case 2: 100% lying inside span(z1, z2) -> must NOT fall back to original unstripped vector!
    const inPlaneDiary = unit([0.8, 0.6, 0, 0]);
    const vecCache = new Map([[701, inPlaneDiary], [702, unit([0.8, 0.6, 0.01, 0])]]);
    const bridgeSaturated = await mtm._v3BuildDiaryBridge(
        {}, [{ chunkId: 701, diaryName: '我的日常', score: 0.9 }], ['希夷星池簇'],
        null, null, 0.85, z1, z2, null, vecCache
    );
    assert.equal(bridgeSaturated.vector, null, '100% in-plane diary must return null, never original vector');
    assert.equal(bridgeSaturated.source, 'active-diaries-saturated');
    assert.ok(bridgeSaturated.novelty < 1e-5);

    // Case 3: Tiny 1% noise tail outside span(z1, z2) -> must NOT amplify into fake unit signal!
    const bridgeNoise = await mtm._v3BuildDiaryBridge(
        {}, [{ chunkId: 702, diaryName: '我的日常', score: 0.9 }], ['希夷星池簇'],
        null, null, 0.85, z1, z2, null, vecCache
    );
    assert.equal(bridgeNoise.vector, null, 'sub-threshold noise residual must be suppressed');
    assert.equal(bridgeNoise.source, 'active-diaries-saturated');
    assert.ok(bridgeNoise.novelty < 0.02);
});

test('Sense groundedPrimary obeys background-inertia calibration and cannot hijack current-turn star', async () => {
    const vectors = new Map([
        [1, unit([0.98, 0.15, 0.05, 0.05, 0.05])], // 旧轨星: aligned with prevAi (e0)
        [2, unit([0.10, 0.98, 0.05, 0.05, 0.05])], // 本轮新星: aligned with current user (e1)
        [3, unit([0.05, 0.10, 0.98, 0.05, 0.05])], // 对偶候选
        [4, unit([0.05, 0.05, 0.10, 0.98, 0.05])]  // 抛飞候选
    ]);
    const docs = [
        { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '旧轨星.md', text: '旧轨星', score: 0.74 },
        { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '本轮新星.md', text: '本轮新星', score: 0.69 },
        { chunkId: 3, diaryName: '希夷星池簇', sourceFile: '对偶星.md', text: '对偶星', score: 0.45 },
        { chunkId: 4, diaryName: '希夷星池簇', sourceFile: '抛飞星.md', text: '抛飞星', score: 0.40 }
    ];
    const broadcasts = [];
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            async executeNativeRiverQuery() {
                return { results: docs, diagnostics: { degraded: false } };
            },
            async getVectorByChunkId(id) {
                return vectors.get(id) || null;
            },
            async planRiverThinking(_prepared, stages) {
                // Sense tries to ground onto 旧轨星 (#1)
                const oldHit = stages[0].candidates.find(c => c.chunkId === 1);
                return { stages: [{ results: [{ ...oldHit, riverThinking: { route: 'sense-bridge' } }] }] };
            }
        },
        pushVcpInfo(info) { broadcasts.push(info); }
    });

    const userVec = unit([0, 1, 0, 0, 0]);
    const prevAiVec = unit([1, 0, 0, 0, 0]);
    const mixedQuery = unit([0.4, 0.9, 0, 0, 0]);
    const formula = await mtm.processMetaThinkingV3(
        '希夷星池簇', mixedQuery, '本轮全新话题', '上轮旧话题', '新话题', false,
        {
            getObservation: async () => ({ enhancedVector: prevAiVec }),
            userVector: userVec,
            aiVector: prevAiVec
        }
    );
    assert.ok(formula.startsWith('$$势陷[∂本轮新星'), `expected 本轮新星 to win after calibration, got ${formula}`);
    assert.equal(broadcasts[0]?.star1Source, 'rivermemo-v5.2-shared');
});

test('small star pools (<=3 stars) respect primary ranking and combined two-step novelty threshold', async () => {
    const mtm = new MetaThinkingManager({});
    // Pool has exactly 3 stars, in ascending ID order, where the 3rd star has the highest primary score
    const vectors = new Map([
        [1, unit([0, 1, 0, 0])],
        [2, unit([0, 0, 1, 0])],
        [3, unit([1, 0, 0, 0])]
    ]);
    const smallPool = [
        { chunkId: 1, sourceFile: '星一.md', score: 0.2 },
        { chunkId: 2, sourceFile: '星二.md', score: 0.5 },
        { chunkId: 3, sourceFile: '星三.md', score: 0.95 }
    ];
    const firstTwo = mtm._selectV3TrinityStars(smallPool, {
        onlyFirstTwo: true,
        vectorByChunkId: vectors,
        zQuery: unit([0.7, 0.7, 0, 0]),
        tensionTangentZ: unit([0, 1, 0, 0])
    });
    assert.equal(firstTwo.length, 2, 'onlyFirstTwo must return 2 stars even for 3-star pool');
    assert.equal(firstTwo[0].starName, '星三', 'highest-score star must be primary in 3-star pool');
    assert.equal(firstTwo[1].starName, '星一', 'tension-aligned star must be conjugate in 3-star pool');

    // Combined two-step novelty threshold: prevSurvive ≈ 0.30, ortho.novelty ≈ 0.25 -> total ≈ 0.075 < 0.12
    const zPrevAi = unit([1, 0, 0, 0]);
    const z1 = unit([0, 1, 0, 0]);
    const z2 = unit([0, 0, 1, 0]);
    // Vector has 0.954 on zPrevAi (survive ≈ 0.30), and within that surviving 0.30 only 0.075 is along e3
    const weakCombo = unit([0.9539392, 0.2904738, 0, 0.075]);
    const vecCache = new Map([[801, weakCombo]]);
    const bridge = await mtm._v3BuildDiaryBridge(
        {}, [{ chunkId: 801, diaryName: '我的日常', score: 0.9 }], ['希夷星池簇'],
        null, null, 0.85, z1, z2, null, vecCache,
        { zPrevAi, timeFlowShift: 1.0, minNovelty: 0.12 }
    );
    assert.equal(bridge.vector, null, 'combined two-step totalNovelty < minNovelty must saturate to null');
    assert.equal(bridge.source, 'active-diaries-saturated');
    assert.ok(bridge.novelty < 0.12, `expected total novelty < 0.12, got ${bridge.novelty}`);
});

test('strict IIA prevents irrelevant decoy from flipping Star 3 winner or score', () => {
    const mtm = new MetaThinkingManager({});
    // IIA check: injecting a high-diary-aligned decoy inside cone(z1,z2) must not flip existing star3 ranking
    const z1 = unit([1, 0, 0, 0, 0]);
    const z2 = unit([0, 1, 0, 0, 0]);
    const diaryZ = unit([0, 0, 1, 0, 0]);
    const vectors = new Map([
        [1, z1],
        [2, z2],
        [3, unit([0, 0, 0.25, 0.9682, 0])],
        [4, unit([0, 0, 0.05, 0.20, 0.9785])],
        [5, unit([0.75, 0, 0.6614, 0, 0])]
    ]);
    const baseItems = [
        { chunkId: 1, sourceFile: '主星.md', score: 0.9 },
        { chunkId: 2, sourceFile: '对偶.md', score: 0.8 },
        { chunkId: 3, sourceFile: '候选甲.md', score: 0.5 },
        { chunkId: 4, sourceFile: '候选乙.md', score: 0.5 }
    ];
    const commonOpts = {
        lockedPrimary: { item: baseItems[0], starName: '主星', slot: 'primary' },
        lockedConjugate: { item: baseItems[1], starName: '对偶', slot: 'conjugate' },
        ejectImpulseZ: unit([0, 0, 0, 0.2, 0.9798]),
        diaryBridgeZ: diaryZ,
        diaryBridgeNovelty: 1.0,
        vectorByChunkId: vectors
    };
    const before = mtm._selectV3TrinityStars(baseItems, commonOpts);
    const after = mtm._selectV3TrinityStars([...baseItems, { chunkId: 5, sourceFile: '干扰星.md', score: 0.1 }], commonOpts);
    assert.equal(after[2].starName, before[2].starName, 'irrelevant decoy must not flip existing star3 winner');
    assert.ok(Math.abs(after[2].slingshotScore - before[2].slingshotScore) < 1e-9, 'winner score must remain bit-stable under IIA');
});

test('2x2 Gram plane orthogonalization is symmetric under axis swap, handles near-collinear axes, and honors bridgeEpsilon', async () => {
    const mtm = new MetaThinkingManager({});
    // 群友最小反例: z1=(1,0,0), z2=(0.6,0.8,0), d=(0,1,0) 全在同一平面，且换序后结果严格一致
    const z1 = unit([1, 0, 0, 0]);
    const z2 = unit([0.6, 0.8, 0, 0]);
    const dInPlane = unit([0, 1, 0, 0]);
    assert.equal(mtm._v3OrthogonalizePlane(dInPlane, z1, z2, 0).vector, null);
    assert.equal(mtm._v3OrthogonalizePlane(dInPlane, z2, z1, 0).vector, null);

    // 平面外向量换序严格一致
    const dOut = unit([0.3, 0.4, 0.7, 0.5]);
    const o12 = mtm._v3OrthogonalizePlane(dOut, z1, z2, 0);
    const o21 = mtm._v3OrthogonalizePlane(dOut, z2, z1, 0);
    assert.ok(mtm._v3Dot(o12.vector, o21.vector) > 0.9999999);
    assert.ok(Math.abs(o12.novelty - o21.novelty) < 1e-6);

    // 近反平行（近共线）对称角平分线换序严格一致
    const p1 = unit([1, 0.0002, 0, 0]);
    const p2 = unit([-1, 0.0002, 0, 0]);
    const dp = unit([0.5, 0.5, 0.7, 0]);
    const c12 = mtm._v3OrthogonalizePlane(dp, p1, p2, 0);
    const c21 = mtm._v3OrthogonalizePlane(dp, p2, p1, 0);
    assert.ok(c12.vector && c21.vector);
    assert.ok(mtm._v3Dot(c12.vector, c21.vector) > 0.9999999);

    // bridgeEpsilon=0 可显式放行小残差，而默认 0.12 抑制 5% 微噪
    const tinyOut = unit([0.8, 0.6, 0.05, 0]);
    const vecCache = new Map([[901, tinyOut]]);
    const bDefault = await mtm._v3BuildDiaryBridge(
        {}, [{ chunkId: 901, diaryName: '我的日常', score: 0.9 }], ['希夷星池簇'],
        null, null, 0.85, z1, z2, null, vecCache
    );
    const bEpsZero = await mtm._v3BuildDiaryBridge(
        {}, [{ chunkId: 901, diaryName: '我的日常', score: 0.9 }], ['希夷星池簇'],
        null, null, 0.85, z1, z2, null, vecCache, { bridgeEpsilon: 0 }
    );
    assert.equal(bDefault.vector, null);
    assert.ok(bEpsZero.vector && Math.abs(mtm._v3Dot(bEpsZero.vector, unit([0, 0, 1, 0])) - 1) < 1e-5);
});

test('user-sent raw V3 formula is preserved as real user message while injected V3 block is skipped', () => {
    const { findLastRealUserMessage } = require('../modules/messageProcessor');
    const formula = '$$势陷[∂共晶点 ∧ ∇伴随文本]_φ ↦ 思奇 σ_∞(回声反语 ⊖ φ) →_{τ,x} ?$$';

    // 用户在单轮对话中自己直接复制发送了一行纯公式（无 __vcpMetaThinkingV3__ 标记）
    const singleTurnUserFormula = [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: formula }
    ];
    const foundSingle = findLastRealUserMessage(singleTurnUserFormula);
    assert.equal(foundSingle.index, 1, 'user-sent raw V3 formula must not be hidden when it is the only user message');
    assert.equal(foundSingle.sanitizedContent, formula);

    // 若服务端已在该用户纯公式正上方注入了带 __vcpMetaThinkingV3__ 标记的 V3 块，仍应准确命中下方的用户消息
    const injected = { role: 'user', content: '$$势陷[∂星甲 ∧ ∇星乙]_φ ↦ 思奇 σ_∞(星丙 ⊖ φ) →_{τ,x} ?$$' };
    Object.defineProperty(injected, '__vcpMetaThinkingV3__', {
        value: true,
        enumerable: false,
        configurable: true
    });
    const afterInjection = [
        { role: 'system', content: '系统提示' },
        injected,
        { role: 'user', content: formula }
    ];
    const foundAfter = findLastRealUserMessage(afterInjection);
    assert.equal(foundAfter.index, 2, 'must skip server-injected V3 block and return the user message at index 2');
});

test('Turn-1 cold-start C3 escape symmetrically repels primary star z1 when zPrevAiRef is null', () => {
    const mtm = new MetaThinkingManager({});
    const dim = 8;
    const basis = (idx) => { const v = new Float32Array(dim); v[idx] = 1; return v; };
    const z1 = basis(0);
    const z2 = basis(1);
    const eject = unit([0.1, 0.1, 0.99, 0, 0, 0, 0, 0]);
    // Both candidates have identical eject alignment, but candNearZ1 has positive z1 overlap while candFarZ1 is orthogonal to z1
    const nearZ1 = unit([0.28, 0, 0.35, 0.893, 0, 0, 0, 0]);
    const farZ1 = unit([0, 0, 0.35, 0, 0.9367, 0, 0, 0]);
    const vectors = new Map([[1, z1], [2, z2], [3, nearZ1], [4, farZ1]]);
    const items = [
        { chunkId: 1, sourceFile: '主星.md', score: 0.9 },
        { chunkId: 2, sourceFile: '对偶.md', score: 0.8 },
        { chunkId: 3, sourceFile: '近主星.md', score: 0.5 },
        { chunkId: 4, sourceFile: '远主星.md', score: 0.5 }
    ];
    const selected = mtm._selectV3TrinityStars(items, {
        lockedPrimary: { item: items[0], starName: '主星', slot: 'primary' },
        lockedConjugate: { item: items[1], starName: '对偶', slot: 'conjugate' },
        ejectImpulseZ: eject,
        vectorByChunkId: vectors,
        modeM: 0.85,
        useV37Modality: true,
        zPrevAiRef: null
    });
    assert.equal(selected[2].starName, '远主星', 'Turn-1 C3 escape (zPrevAiRef=null) must symmetrically repel z1-aligned candidate');
});

test('OneRing keeps prepended DB history above V3 block and preserves standalone user-sent V3 formula', () => {
    const oneRing = require('../Plugin/OneRing/OneRing');
    const formula = '$$势陷[∂星甲 ∧ ∇星乙]_φ ↦ 思奇 σ_∞(星丙 ⊖ φ) →_{τ,x} ?$$';

    // Case 1: 新对话中 RAGDiaryPlugin 已在 lastUser 正上方注入 V3，OneRing prepend 历史 DB 消息时必须插在 V3 上方
    const injectedV3 = { role: 'user', content: formula };
    Object.defineProperty(injectedV3, '__vcpMetaThinkingV3__', {
        value: true,
        enumerable: false,
        configurable: true
    });
    const originalMessages = [
        { role: 'system', content: 'sys' },
        injectedV3,
        { role: 'user', content: '本轮用户新问题' }
    ];
    const view = oneRing._buildOneRingWorkingView(originalMessages);
    assert.equal(view.workingMessages.length, 2, 'injected V3 must be stripped from working view');
    const dbHistoryMsg = { role: 'user', content: '跨端历史消息' };
    Object.defineProperty(dbHistoryMsg, '__oneRingInjectedFromDb', {
        value: true,
        enumerable: false,
        configurable: true
    });
    // 模拟 prepend：历史 DB 消息排在 workingMessages[1] (本轮用户新问题) 之前
    const processed = [view.workingMessages[0], dbHistoryMsg, view.workingMessages[1]];
    const restored = oneRing._restoreWorkingViewToOriginalMessages(originalMessages, processed, view);
    assert.deepEqual(
        restored.map(m => m.content),
        ['sys', '跨端历史消息', formula, '本轮用户新问题'],
        'prepended DB history must land before V3 so V3 stays directly above last real user message'
    );

    // Case 2: 用户自己把纯公式直接复制发出来（没有 __vcpMetaThinkingV3__ 且是最后一条 user），OneRing 不得丢弃
    const userSentFormulaMsgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: formula }
    ];
    const userView = oneRing._buildOneRingWorkingView(userSentFormulaMsgs);
    assert.equal(
        userView.workingMessages.length,
        2,
        'standalone user-sent raw V3 formula must remain in OneRing working view'
    );
});

test('RAGDiaryPlugin V3 splice does not mutate original input messages when attaching V7 multimodal media', async () => {
    const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
    const ContextVectorManager = require('../Plugin/RAGDiaryPlugin/ContextVectorManager');

    // 验证 ContextVectorManager 只排除显式 V3 注入块，不排除用户自己发送的纯公式
    const cvm = new ContextVectorManager({ _stripHtml: t => t, _stripEmoji: t => t, _stripToolMarkers: t => t });
    const formula = '$$势陷[∂星甲 ∧ ∇星乙]_φ ↦ 思奇 σ_∞(星丙 ⊖ φ) →_{τ,x} ?$$';
    const userMsg = { role: 'user', content: formula };
    const injectedV3 = { role: 'user', content: formula };
    Object.defineProperty(injectedV3, '__vcpMetaThinkingV3__', { value: true, enumerable: false, configurable: true });
    assert.equal(cvm._isVirtualSystemUser(userMsg), false);
    assert.equal(cvm._isVirtualSystemUser(injectedV3), true);

    assert.ok(rag);
});

test('V3 replaces a system placeholder in place without touching historical formulas or user content', async () => {
    const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

    const rag = new ragSingleton.constructor();
    rag.contextVectorManager = { updateContext: async () => {}, segmentContext: () => [] };
    rag.timeParser = { parse: () => [] };
    rag.ragParams = { RAGDiaryPlugin: {} };
    rag.getSingleEmbeddingCached = async () => unit([1, 0, 0, 0]);
    rag._calculateDynamicParams = async () => ({ k: 3, tagWeight: 0.15, tagTruncationRatio: 0.5, metrics: {} });
    const formula = '$$势陷[∂新星甲 ∧ ∇新星乙]_φ ↦ 思奇 σ_∞(新星丙 ⊖ φ) →_{τ,x} ?$$';
    rag.metaThinkingManager = { processMetaThinkingV3: async () => formula };

    const oldFormula = '$$势陷[∂旧星甲 ∧ ∇旧星乙]_φ ↦ 思奇 σ_∞(旧星丙 ⊖ φ) →_{τ,x} ?$$';
    const messages = [
        { role: 'system', content: '系统设定\n公式：[[VCP元思考V3]]；正文' },
        { role: 'user', content: oldFormula },
        { role: 'assistant', content: '这是上一轮的解释。' },
        { role: 'user', content: '这一轮讨论新话题' }
    ];

    const out = await rag._processMessagesWithMemoScope(messages, {});
    assert.deepEqual(out, [
        { role: 'system', content: `系统设定\n公式：${formula}；正文` },
        ...messages.slice(1)
    ]);
    assert.equal(messages[0].content, '系统设定\n公式：[[VCP元思考V3]]；正文');
    assert.deepEqual(await rag._processMessagesWithMemoScope(JSON.parse(JSON.stringify(out)), {}), out);

    rag.metaThinkingManager.processMetaThinkingV3 = async () => '';
    const empty = await rag._processMessagesWithMemoScope([
        { role: 'system', content: '第一行\r\n  [[VCP元思考V3]]  \r\n行内 [[VCP元思考V3]] 后缀\r\n下一行' },
        ...messages.slice(1)
    ], {});
    assert.equal(empty[0].content, '第一行\r\n行内  后缀\r\n下一行');
});

test('hybrid 《《diary》》 outer cache hit replays v3ActiveDiaryChunks to V3 diary bridge', async () => {
    const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

    const rag = new ragSingleton.constructor();
    const cacheStore = new Map();
    rag.queryCacheEnabled = true;
    rag.cacheManager = {
        generateKey: (obj) => JSON.stringify(obj),
        get: (_ns, k) => cacheStore.get(k) || null,
        set: (_ns, k, v) => cacheStore.set(k, v)
    };
    rag.ragConfig = { '我的日常': { threshold: 0.3 } };
    rag._getDiarySimilarityCached = async () => ({ finalSimilarity: 0.9 });
    rag._evaluateRoleValve = () => true;
    let ragPlaceholderCalls = 0;
    rag._processRAGPlaceholder = async (opts) => {
        ragPlaceholderCalls++;
        const chunk = { chunkId: 777, diaryName: '我的日常', score: 0.88 };
        opts.requestCache.v3ActiveDiaryChunks.push(chunk);
        opts.v3DiaryChunksOut?.push(chunk);
        return '[我的日常召回内容]';
    };

    const runOnce = async () => {
        const requestCache = rag._createRequestCache();
        const content = await rag._processSingleSystemMessage(
            '记忆:《《我的日常日记本》》',
            unit([1, 0, 0, 0]),
            '测试混合缓存回灌',
            null,
            '测试',
            3,
            [],
            new Set(),
            false,
            0.15,
            0.5,
            {},
            [],
            new Set(),
            [],
            [],
            [],
            false,
            requestCache
        );
        return { content, chunks: requestCache.v3ActiveDiaryChunks };
    };

    const r1 = await runOnce();
    const r2 = await runOnce();
    assert.equal(ragPlaceholderCalls, 1, 'second hybrid call must hit outer cache');
    assert.equal(r1.content, '记忆:[我的日常召回内容]');
    assert.equal(r2.content, '记忆:[我的日常召回内容]');
    assert.equal(r1.chunks.length, 1);
    assert.equal(r2.chunks.length, 1, 'outer hybrid cache hit must replay v3ActiveDiaryChunks');
    assert.equal(r2.chunks[0].chunkId, 777);
});

test('ContextVectorManager skips JSON-cloned injected V3 blocks while preserving standalone user-sent formulas', async () => {
    const ContextVectorManager = require('../Plugin/RAGDiaryPlugin/ContextVectorManager');
    const formula = '$$势陷[∂星甲 ∧ ∇星乙]_φ ↦ 思奇 σ_∞(星丙 ⊖ φ) →_{τ,x} ?$$';
    const embeddedTexts = [];
    const cvm = new ContextVectorManager({
        _stripHtml: t => t,
        _stripEmoji: t => t,
        _stripToolMarkers: t => t,
        sanitizeForEmbedding: t => t,
        _getEmbeddingFromCacheOnly: (text) => {
            embeddedTexts.push(text);
            return text.includes('第一轮') ? unit([1, 0, 0, 0]) : unit([0, 1, 0, 0]);
        },
        _findFuzzyEmbeddingFromCache: () => null
    });

    // 场景 1: JSON 深拷贝后失标的 V3 注入块紧贴真实用户消息上方 -> 必须识别为虚拟系统块，不得入历史向量与分段
    const clonedMsgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'user', content: formula }, // 失标注入块
        { role: 'user', content: '第二轮真实问题' }
    ];
    assert.equal(cvm._isVirtualSystemUser(clonedMsgs[3], clonedMsgs, 3), true);
    await cvm.updateContext(clonedMsgs, { allowApi: false });
    assert.equal(cvm.historyUserVectors.length, 1, 'cloned V3 block above real user must not enter historyUserVectors');
    assert.ok(!embeddedTexts.some(t => t.includes('势陷')), 'cloned V3 formula must never be queried for embedding');
    const segments = cvm.segmentContext(clonedMsgs);
    assert.ok(!segments.some(s => String(s.text || '').includes('势陷')), 'cloned V3 formula must not enter context segments');

    // 场景 2: 用户在第 1 轮自己单独发送的纯公式（后接 assistant）-> 仍视为真实历史发言
    const userFormulaTurn = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: formula },
        { role: 'assistant', content: '公式解析' },
        { role: 'user', content: '继续追问' }
    ];
    assert.equal(cvm._isVirtualSystemUser(userFormulaTurn[1], userFormulaTurn, 1), false);
});

test('vector-less candidate cannot hijack Star 2 or Star 3 via raw score scale mismatch', () => {
    const mtm = new MetaThinkingManager({});
    const vecs = new Map([
        [1, unit([1, 0, 0, 0])],
        [3, unit([0, 1, 0, 0])],
        [4, unit([0, 0, 1, 0])]
        // chunkId 2 intentionally missing from vecs!
    ]);
    const candidates = [
        { chunkId: 1, sourceFile: '主星.md', score: 0.95 },
        { chunkId: 2, sourceFile: '缺向量高分星.md', score: 0.94 },
        { chunkId: 3, sourceFile: '正交对偶星.md', score: 0.30 },
        { chunkId: 4, sourceFile: '抛飞思奇星.md', score: 0.25 }
    ];
    const selected = mtm._selectV3TrinityStars(candidates, {
        vectorByChunkId: vecs,
        zQuery: unit([0.7, 0.7, 0, 0]),
        tensionTangentZ: unit([0, 1, 0, 0]),
        ejectImpulseZ: unit([0, 0, 1, 0])
    });
    assert.equal(selected.length, 3);
    assert.equal(selected[0].starName, '主星');
    assert.equal(selected[1].starName, '正交对偶星', 'vector-less candidate must not hijack Star 2');
    assert.equal(selected[2].starName, '抛飞思奇星', 'vector-less candidate must not hijack Star 3');
});

test('empty Step 1 query falls back to in-memory starPool cosine ranking instead of starPool.stars[0]', async () => {
    const s1 = { chunkId: 101, fileId: 1, diaryName: '希夷星池簇', sourceFile: '无关首星.md', text: 'A', raw: unit([1, 0, 0, 0]), x: unit([1, 0, 0, 0]), z: unit([1, 0, 0, 0]), radius: 0.5 };
    const s2 = { chunkId: 102, fileId: 2, diaryName: '希夷星池簇', sourceFile: '命中目标星.md', text: 'B', raw: unit([0, 1, 0, 0]), x: unit([0, 1, 0, 0]), z: unit([0, 1, 0, 0]), radius: 0.5 };
    const s3 = { chunkId: 103, fileId: 3, diaryName: '希夷星池簇', sourceFile: '辅助星.md', text: 'C', raw: unit([0, 0, 1, 0]), x: unit([0, 0, 1, 0]), z: unit([0, 0, 1, 0]), radius: 0.5 };
    const starPool = {
        stars: [s1, s2, s3],
        byChunkId: new Map([[101, s1], [102, s2], [103, s3]]),
        byStarName: new Map([[s1.starName, s1], [s2.starName, s2], [s3.starName, s3]]),
        bySlot: new Map(),
        starSlots: new Set(),
        starMeanAxis: null,
        betaStar: 0.85
    };
    const broadcasts = [];
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            async executeNativeRiverQuery() {
                return { results: [], diagnostics: { degraded: true } };
            }
        },
        pushVcpInfo: (info) => broadcasts.push(info)
    });
    mtm._v3LoadGlobalManifold = () => null;
    mtm._v3LoadStarPoolCache = () => starPool;

    const formula = await mtm.processMetaThinkingV3(
        '希夷星池簇', unit([0, 1, 0, 0]), '精准匹配第二颗星', null, '测试', false, {}
    );
    assert.ok(formula.includes('∂命中目标星'), `expected Star 1 to be 命中目标星, got ${formula}`);
    assert.equal(broadcasts[0]?.star1Source, 'star-pool-cosine-fallback');
});

test('ChatCompletionHandler.refreshRagBlocksIfNeeded skips injected V3 formula when finding originalUserQuery', async () => {
    const ChatCompletionHandler = require('../modules/chatCompletionHandler');
    let capturedOriginalQuery = null;
    const mockPluginManager = {
        messagePreprocessors: new Map([
            ['RAGDiaryPlugin', {
                async refreshRagBlock(_meta, _ctx, originalUserQuery) {
                    capturedOriginalQuery = originalUserQuery;
                    return '<!-- VCP_RAG_BLOCK_START {"dbName":"test"} -->REFRESHED<!-- VCP_RAG_BLOCK_END -->';
                }
            }]
        ])
    };
    const v3Formula = '$$势陷[∂星甲 ∧ ∇星乙]_φ ↦ 思奇 σ_∞(星丙 ⊖ φ) →_{τ,x} ?$$';
    const messages = [
        { role: 'user', content: '真正的用户原始问题' },
        { role: 'user', content: v3Formula },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'system', content: '<!-- VCP_RAG_BLOCK_START {"dbName":"test"} -->OLD<!-- VCP_RAG_BLOCK_END -->' }
    ];
    await ChatCompletionHandler.refreshRagBlocksIfNeeded(messages, {}, mockPluginManager, false);
    assert.equal(capturedOriginalQuery, '真正的用户原始问题');
});

test('V3.3 Star 2 mutual-pull geometry suppresses antipodal opposite and avoids -z1 fallback on focused query', async () => {
    const mtm = new MetaThinkingManager({});
    // Query aligned with Star 1 (e0): previously qOrthoZ fell back to -z1, pulling Antipodal (-e0) over SideWing (e1)!
    const e0 = unit([1, 0, 0, 0]);
    const vectors = new Map([
        [1, e0],                          // Star 1 (primary)
        [2, unit([-0.98, 0.18, 0, 0])],   // Pure antipodal opposite (cos1z = -0.98)
        [3, unit([0.05, 0.99, 0.05, 0])], // Orthogonal mutual-pull wing (cos1z = +0.05)
        [4, unit([0, 0, 0.99, 0.1])]      // Slingshot candidate
    ]);
    const starPool = {
        stars: [
            { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '主星.md', starName: '主星', text: '主星', raw: vectors.get(1), x: vectors.get(1), z: vectors.get(1), radius: 0.5 },
            { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '纯对立星.md', starName: '纯对立星', text: '纯对立星', raw: vectors.get(2), x: vectors.get(2), z: vectors.get(2), radius: 0.5 },
            { chunkId: 3, diaryName: '希夷星池簇', sourceFile: '互拉侧翼星.md', starName: '互拉侧翼星', text: '互拉侧翼星', raw: vectors.get(3), x: vectors.get(3), z: vectors.get(3), radius: 0.5 },
            { chunkId: 4, diaryName: '希夷星池簇', sourceFile: '抛飞星.md', starName: '抛飞星', text: '抛飞星', raw: vectors.get(4), x: vectors.get(4), z: vectors.get(4), radius: 0.5 }
        ],
        starMeanAxis: null,
        betaStar: 0.85,
        avgStarInDeg: 4
    };
    starPool.byChunkId = new Map(starPool.stars.map(s => [s.chunkId, s]));
    starPool.byStarName = new Map(starPool.stars.map(s => [s.starName, s]));
    mtm._v3LoadGlobalManifold = () => null;
    mtm._v3LoadStarPoolCache = () => starPool;
    const broadcasts = [];
    mtm.ragPlugin = {
        vectorDBManager: {
            async executeNativeRiverQuery() {
                return {
                    results: [
                        { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '主星.md', score: 0.95, topologyV3: { differentiaScore: 0.5 } },
                        { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '纯对立星.md', score: 0.40, topologyV3: { differentiaScore: 0.5 } },
                        { chunkId: 3, diaryName: '希夷星池簇', sourceFile: '互拉侧翼星.md', score: 0.40, topologyV3: { differentiaScore: 0.5 } },
                        { chunkId: 4, diaryName: '希夷星池簇', sourceFile: '抛飞星.md', score: 0.30, topologyV3: { differentiaScore: 0.5 } }
                    ],
                    diagnostics: { degraded: false }
                };
            },
            async getVectorByChunkId(id) {
                return vectors.get(id) || null;
            }
        },
        pushVcpInfo: (info) => broadcasts.push(info)
    };

    const focusedQuery = unit([0.995, 0.08, 0, 0]); // nearly parallel to z1
    await mtm.processMetaThinkingV3('希夷星池簇', focusedQuery, '聚焦查询', null, '聚焦查询', false, {});
    const stars = broadcasts[0]?.stars || [];
    assert.equal(stars[0]?.name, '主星');
    assert.equal(stars[1]?.name, '互拉侧翼星', 'Star 2 must pick mutual-pull wing instead of antipodal opposite');
});

test('V3.3 _formatV3Formula encodes memory resonance, grounded 3D cone residual, and 2nd-order time-flow phases', () => {
    const mtm = new MetaThinkingManager({});
    const stars = [
        { starName: '共晶点', slot: 'primary' },
        { starName: '伴随文本', slot: 'conjugate' },
        { starName: '回声反语', slot: 'slingshot', diaryBridge: 0.52, waveInterference: 0.1 }
    ];

    // 1) Post-jump deepen + strong unabsorbed residual (>0.980, grounded) + symmetric dual saddle (min/max >= 0.92) + memory dominance
    const loopFormula = mtm._formatV3Formula(stars, {
        b1: 0.25,
        b2: 0.235,
        coneResidual3D: 0.985,
        residualGrounded: true,
        timeFlow: { phase: 'post_jump_deepen', continuity: 0.62, shift: 0.0 }
    });
    assert.equal(loopFormula, '$$势陷[∂共晶点 ⋈ ∇伴随文本]_φ ↦ 思奇 σ_∞(回声反语 ⊖ φ | ℳ) ∥ ⊘(r_⊥ ≫ 0) →_{τ↺} ?^{-1}$$');

    // 2) Orthogonal outward jump + moderate residual (0.968 < r <= 0.980, grounded) + asymmetric b2 > b1 (NOT saddle!) + pure spatial slingshot
    const jumpFormula = mtm._formatV3Formula([
        { starName: '甲', slot: 'primary' },
        { starName: '乙', slot: 'conjugate' },
        { starName: '丙', slot: 'slingshot', diaryBridge: 0.05, waveInterference: 0.0 }
    ], {
        b1: 0.18,
        b2: 0.30,
        coneResidual3D: 0.974,
        residualGrounded: true,
        timeFlow: { phase: 'explore_jump', continuity: 0.08, shift: 0.28 }
    });
    assert.equal(jumpFormula, '$$势陷[∂甲 ∧ ∇乙]_φ ↦ 思奇 σ_∞(丙 ⊖ φ) ∥ ⊘(r_⊥) →_{τ↗} ?$$');

    // 3) Dialectic loopback synthesis
    const returnFormula = mtm._formatV3Formula([
        { starName: '甲', slot: 'primary' },
        { starName: '乙', slot: 'conjugate' },
        { starName: '丙', slot: 'slingshot', diaryBridge: 0.0, waveInterference: 0.0 }
    ], {
        coneResidual3D: 0.910,
        residualGrounded: true,
        timeFlow: { phase: 'dialectic_return', continuity: 0.05, shift: 0.4 }
    });
    assert.equal(returnFormula, '$$势陷[∂甲 ∧ ∇乙]_φ ↦ 思奇 σ_∞(丙 ⊖ φ) →_{τ⇄} ?$$');

    // 4) Un-grounded high residual (pure vector grounding gate off) omits ⊘ cleanly without any string-length rule
    const ungroundedFormula = mtm._formatV3Formula([
        { starName: '甲', slot: 'primary' },
        { starName: '乙', slot: 'conjugate' },
        { starName: '丙', slot: 'slingshot', diaryBridge: 0.0, waveInterference: 0.0 }
    ], {
        coneResidual3D: 0.990,
        residualGrounded: false,
        timeFlow: { phase: 'deepen_steady', continuity: 0.38, shift: 0.0 }
    });
    assert.equal(ungroundedFormula, '$$势陷[∂甲 ∧ ∇乙]_φ ↦ 思奇 σ_∞(丙 ⊖ φ) →_{τ,x} ?$$');

    // 5) All V3.3 & V3.2 formulas are recognized by messageProcessor & skipped when followed by real user message
    const { isMetaThinkingV3Message, findLastRealUserMessage } = require('../modules/messageProcessor');
    for (const f of [loopFormula, jumpFormula, returnFormula, ungroundedFormula]) {
        assert.equal(isMetaThinkingV3Message({ role: 'user', content: f }), true, `expected V3.3 formula match: ${f}`);
        const found = findLastRealUserMessage([
            { role: 'user', content: '上一轮问题' },
            { role: 'assistant', content: '上一轮回答' },
            { role: 'user', content: f },
            { role: 'user', content: '这一轮真正的问题' }
        ]);
        assert.equal(found.sanitizedContent, '这一轮真正的问题');
    }
    assert.equal(isMetaThinkingV3Message({ role: 'user', content: '$$x^2 + y^2 = 1$$' }), false);
});

test('V3.3 2nd-order timeFlow trajectory distinguishes steady deepening, outward jump, post-jump deepen, return, and stagnation', () => {
    const mtm = new MetaThinkingManager({});
    const z1 = unit([1, 0, 0, 0, 0]);
    const e0 = unit([1, 0, 0, 0, 0]);
    const e1 = unit([0, 1, 0, 0, 0]);
    const e2 = unit([0, 0, 1, 0, 0]);

    // 1) Normal steady deepening inside same scope (cPrev=0.35, cCurr=0.35, cAnchor=0.10): must stay calm steady!
    const segSteady = [{ vector: unit([0.85, 0.52, 0, 0, 0]) }];
    const aiSteady = unit([0.85, 0.10, 0.51, 0, 0]);
    const userSteady = unit([0.20, 0.05, 0.95, 0.23, 0]); // wait: compute exact cosines:
    // Let's use clean orthogonal basis weights:
    const vSeg = unit([1, 0, 0, 0, 0]);
    const vAiSteady = unit([0.35, 0.9367, 0, 0, 0]); // cPrev = 0.35
    const vUserSteady = unit([0.15, 0.30, 0.942, 0, 0]); // cCurr ≈ 0.333, cAnchor = 0.15 -> steady forward deepening!
    const resSteady = mtm._v3TimeFlowAxis('', vUserSteady, vAiSteady, vUserSteady, vUserSteady, z1, null, null, 0.85, [{ vector: vSeg }]);
    assert.equal(resSteady.phase, 'deepen_steady');

    // 2) Outward jump (calibrated: real cross-topic z-cosine median is ~0.09-0.11, so continuity < 0.12 triggers explore_jump)
    const vJumpUser = unit([0, 0.10, 0.995, 0, 0]); // cCurr ≈ 0.094 < 0.12, cAnchor = 0
    const resJump = mtm._v3TimeFlowAxis('', vJumpUser, vAiSteady, vJumpUser, vJumpUser, z1, null, null, 0.85, [{ vector: vSeg }]);
    assert.equal(resJump.phase, 'explore_jump');

    // 3) Post-jump consolidation (previous AI jumped away from vSeg: cPrev ≈ 0, now user deepens onto vAiJumped: cCurr ≈ 0.75)
    const vAiJumped = e1; // cPrev = <e1, vSeg> = 0 < 0.08
    const vUserFollowJump = unit([0.05, 0.75, 0.659, 0, 0]); // cCurr = 0.75 > 0.22
    const resPostJump = mtm._v3TimeFlowAxis('', vUserFollowJump, vAiJumped, vUserFollowJump, vUserFollowJump, z1, null, null, 0.85, [{ vector: vSeg }]);
    assert.equal(resPostJump.phase, 'post_jump_deepen');

    // 4) Dialectic loopback return (cCurr < 0.15, cAnchor > 0.25)
    const vUserReturn = unit([0.70, 0, 0, 0.714, 0]); // stepped away from e1 (cCurr=0), back toward vSeg=e0 (cAnchor=0.70)
    const resReturn = mtm._v3TimeFlowAxis('', vUserReturn, vAiJumped, vUserReturn, vUserReturn, z1, null, null, 0.85, [{ vector: vSeg }]);
    assert.equal(resReturn.phase, 'dialectic_return');

    // 5) Moderate coherent deepening (all ~0.60, <= 0.75) must remain deepen_steady (no false stagnation alarm)
    const vAiMid = unit([0.60, 0.80, 0, 0, 0]);
    const vUserMid = unit([0.60, 0.30, 0.7416, 0, 0]); // cPrev=0.60, cAnchor=0.60, cCurr=0.60
    const resMidSteady = mtm._v3TimeFlowAxis('', vUserMid, vAiMid, vUserMid, vUserMid, z1, null, null, 0.85, [{ vector: vSeg }]);
    assert.equal(resMidSteady.phase, 'deepen_steady');

    // 6) True 3-point local-minimum stagnation (all 3 cosines > 0.75)
    const vAiStuck = unit([0.85, 0.526, 0, 0, 0]);
    const vUserStuck = unit([0.85, 0.45, 0.274, 0, 0]); // cPrev=0.85, cAnchor=0.85, cCurr≈0.96
    const resStuck = mtm._v3TimeFlowAxis('', vUserStuck, vAiStuck, vUserStuck, vUserStuck, z1, null, null, 0.85, [{ vector: vSeg }]);
    assert.equal(resStuck.phase, 'stagnation_loop');
    void e2; void segSteady; void aiSteady; void userSteady; void e0;
});

test('V3.3 pure-vector grounding gate suppresses ⊘ on ungrounded noise while activating on real manifold signal', async () => {
    // 5D orthonormal pool: Query sits purely on e4 (noise/off-manifold), Tag explainedEnergy=0.05, omega=0, b1=0 < 0.12
    const vectors = new Map([
        [1, unit([1, 0, 0, 0, 0])],
        [2, unit([0, 1, 0, 0, 0])],
        [3, unit([0, 0, 1, 0, 0])]
    ]);
    const docs = [
        { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '星甲.md', score: 0.20, topologyV3: { omega: 0.05 } },
        { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '星乙.md', score: 0.15 },
        { chunkId: 3, diaryName: '希夷星池簇', sourceFile: '星丙.md', score: 0.10 }
    ];
    const broadcasts = [];
    let explained = 0.05;
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            async executeNativeRiverQuery() {
                return { results: docs, diagnostics: { degraded: false } };
            },
            async getVectorByChunkId(id) {
                return vectors.get(id) || null;
            }
        },
        pushVcpInfo: (info) => broadcasts.push(info)
    });
    const offManifoldQuery = unit([0, 0, 0, 0.02, 0.9998]); // b1 ≈ 0.02 < 0.12, r_perp ≈ 1.0
    const fOff = await mtm.processMetaThinkingV3('希夷星池簇', offManifoldQuery, '无关噪点', null, '无关噪点', false, {
        getObservation: async () => ({
            enhancedVector: offManifoldQuery,
            sourceObservationResult: { pyramid: { totalExplainedEnergy: explained } }
        })
    });
    assert.equal(broadcasts[0]?.residualGrounded, false);
    assert.ok(!fOff.includes('⊘'), `ungrounded noise must not trigger ⊘, got ${fOff}`);

    // Now simulate strong global Tag pyramid grounding (explainedEnergy = 0.62) with exact same 3 stars -> real blind spot!
    explained = 0.62;
    const fGrounded = await mtm.processMetaThinkingV3('希夷星池簇', offManifoldQuery, '真实复杂细节', null, '真实复杂细节', false, {
        getObservation: async () => ({
            enhancedVector: offManifoldQuery,
            sourceObservationResult: { pyramid: { totalExplainedEnergy: explained } }
        })
    });
    assert.equal(broadcasts[1]?.residualGrounded, true);
    assert.ok(fGrounded.includes('⊘(r_⊥ ≫ 0)'), `grounded high-residual query must trigger ⊘(r_⊥ ≫ 0), got ${fGrounded}`);
});

test('V3.5 leans directly on V5.2 continuous queryMorphology, native L1 depth, relative | ℳ dominance, and aligned baseTagBoost', async () => {
    const mtm = new MetaThinkingManager({});
    const stars = [
        { starName: '共晶点', slot: 'primary' },
        { starName: '伴随文本', slot: 'conjugate' },
        { starName: '回声反语', slot: 'slingshot', diaryBridge: 0.65, waveInterference: 0.0, torqueDeficit: 0.50 }
    ];

    // 1) Relative | ℳ dominance: 0.27*0.65=0.1755 < 0.54*0.50=0.27 -> NOT memory-dominated (fixes 95% always-on)
    const fProp = mtm._formatV3Formula(stars, {
        queryMorphology: 'propositional',
        coneResidual3D: 0.974,
        residualGrounded: true,
        hasDeepLayer: true,
        timeFlow: { phase: 'deepen_steady' }
    });
    assert.equal(fProp, '$$势陷[∂共晶点 ∧ ∇伴随文本]_φ ⊢ 思奇 σ_∞(回声反语 ⊖ φ) ∥ ⊘(r_⊥ ⊕ ∂_2) →_{τ,x} ?$$');

    // When memory+wavefront beats torque (0.27*0.95 + 0.19*0.40 = 0.3325 >= 0.54*0.45 = 0.243) -> | ℳ activates
    const fNarr = mtm._formatV3Formula([
        { starName: '共晶点', slot: 'primary' },
        { starName: '伴随文本', slot: 'conjugate' },
        { starName: '回声反语', slot: 'slingshot', diaryBridge: 0.95, waveInterference: 0.40, torqueDeficit: 0.45 }
    ], {
        queryMorphology: 'narrative',
        coneResidual3D: 0.910,
        residualGrounded: true,
        hasDeepLayer: true,
        timeFlow: { phase: 'explore_jump' }
    });
    assert.equal(fNarr, '$$势陷[∂共晶点 ∧ ∇伴随文本]_φ ⇝ 思奇 σ_∞(回声反语 ⊖ φ | ℳ) ∥ ⊘(∂_2) →_{τ↗} ?$$');

    // 2) Regex recognizes all V3.5 variants cleanly
    const { isMetaThinkingV3Message } = require('../modules/messageProcessor');
    assert.equal(isMetaThinkingV3Message({ role: 'user', content: fProp }), true);
    assert.equal(isMetaThinkingV3Message({ role: 'user', content: fNarr }), true);

    // 3) End-to-end: standalone V3 passes aligned baseTagBoost, directly respects native V5.2 queryProfile.mode (⊢)
    //    while broadcasting continuous queryMorphology weights, and relies purely on native pyramid depth>=2 + L1 for ∂_2
    const vectors = new Map([
        [1, unit([1, 0, 0, 0, 0])],
        [2, unit([0, 1, 0, 0, 0])],
        [3, unit([0, 0, 1, 0, 0])]
    ]);
    const broadcasts = [];
    const rawQ = unit([0.80, 0.50, 0.30, 0.10, 0]);
    const l1Vec = unit([0, 0.10, 0.99, 0.10, 0]);
    let capturedObsOpts = null;
    let releasedCount = 0;
    const e2eMtm = new MetaThinkingManager({
        vectorDBManager: {
            async prepareUnifiedMemoObservation(_q, opts) {
                capturedObsOpts = opts;
                return {
                    observationHandle: 'owned-obs-v35',
                    queryVector: rawQ,
                    enhancedVector: rawQ,
                    sourceObservationResult: {
                        pyramid: {
                            depth: 2,
                            totalExplainedEnergy: 0.62,
                            levels: [
                                { tags: [{ name: '表层词', contribution: 0.5 }] },
                                { tags: [{ name: '暗线词', contribution: 0.18 }] }
                            ]
                        }
                    }
                };
            },
            releaseMemoObservation(obs) {
                if (obs?.observationHandle === 'owned-obs-v35') releasedCount++;
            },
            async getTagVectorByName(name) {
                return name === '暗线词' ? l1Vec : null;
            },
            async executeNativeRiverQuery(_q, opts) {
                assert.equal(opts.preparedMemoObservation?.observationHandle, 'owned-obs-v35', 'must reuse owned observation');
                assert.equal(opts.includeTrace, false, 'default V3.5 star-pool query must disable includeTrace to cut 2.77x FFI JSON overhead');
                return {
                    results: [
                        { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '星甲.md', score: 0.88, topologyV3: { regime: 'dense', omega: 0.72, omegaEdge: 0.85, omegaEmerge: 0.55, omegaFlow: 0.88 } },
                        { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '星乙.md', score: 0.62 },
                        { chunkId: 3, diaryName: '希夷星池簇', sourceFile: '星丙.md', score: 0.41 }
                    ],
                    diagnostics: {
                        degraded: false,
                        queryProfile: {
                            mode: 'propositional',
                            morphology: { atomicWeight: 0.25, propositionalWeight: 0.45, narrativeWeight: 0.30, branching: 0.40, merging: 0.35 }
                        }
                    }
                };
            },
            async getVectorByChunkId(id) {
                return vectors.get(id) || null;
            }
        },
        pushVcpInfo: (info) => broadcasts.push(info)
    });
    const formula = await e2eMtm.processMetaThinkingV3('希夷星池簇', rawQ, '测试原生形态与L1', null, '测试', false, {
        userVector: rawQ,
        baseTagBoost: 0.25
    });
    assert.equal(capturedObsOpts?.sourceObservationConfig?.baseTagBoost, 0.25, 'standalone V3 must align baseTagBoost with mounted path');
    assert.equal(releasedCount, 1, 'must release owned unified observation in finally');
    assert.ok(formula.includes(' ⊢ '), `native V5.2 propositional mode must emit ⊢ arrow, got ${formula}`);
    assert.ok(formula.includes('∂_2'), `native V5.2 pyramid depth>=2 + L1 must trigger ∂_2, got ${formula}`);
    assert.equal(broadcasts[0]?.queryMorphology, 'propositional');
    assert.equal(broadcasts[0]?.queryMorphologyWeights?.propositionalWeight, 0.45);
    assert.equal(broadcasts[0]?.hasDeepLayer, true);
});

test('V3.5 regression: null/empty l0Coherence never coerces to 0 in broadcast', async () => {
    // l0DirectionCoherence=null in pyramid must broadcast as null, not 0
    const broadcasts = [];
    const qv = unit([1, 0, 0, 0]);
    const e2eMtm = new MetaThinkingManager({
        vectorDBManager: {
            async executeNativeRiverQuery() {
                return {
                    results: [
                        { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '星甲.md', score: 0.9 },
                        { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '星乙.md', score: 0.7 },
                        { chunkId: 3, diaryName: '希夷星池簇', sourceFile: '星丙.md', score: 0.5 }
                    ],
                    diagnostics: { degraded: false }
                };
            },
            async getVectorByChunkId(id) {
                if (id === 1) return unit([1, 0, 0, 0]);
                if (id === 2) return unit([0, 1, 0, 0]);
                return unit([0, 0, 1, 0]);
            }
        },
        pushVcpInfo: (info) => broadcasts.push(info)
    });
    e2eMtm._v3LoadGlobalManifold = () => null;
    e2eMtm._v3LoadStarPoolCache = () => null;
    await e2eMtm.processMetaThinkingV3('希夷星池簇', qv, '测试 null 强转', null, '测试', false, {
        getObservation: async () => ({
            enhancedVector: qv,
            queryVector: qv,
            sourceObservationResult: {
                pyramid: {
                    depth: 1,
                    totalExplainedEnergy: 0.5,
                    levels: [{ handshakeFeatures: { directionCoherence: null } }]
                }
            }
        })
    });
    assert.equal(broadcasts[0]?.l0DirectionCoherence, null, 'null directionCoherence must stay null, not 0');
});

test('V3.4 regression: 2nd-order timeFlow steps past lone trailing user segment from real ContextVectorManager.segmentContext', () => {
    const ContextVectorManager = require('../Plugin/RAGDiaryPlugin/ContextVectorManager');
    const cvm = new ContextVectorManager({
        _stripHtml: (t) => t,
        _stripEmoji: (t) => t,
        _stripToolMarkers: (t) => t
    }, 64);
    const mtm = new MetaThinkingManager({});
    const vTopicX = unit([1, 0, 0, 0, 0]);
    const vTopicX2 = unit([0.96, 0.28, 0, 0, 0]);
    const vTopicY = unit([0, 0, 1, 0, 0]);
    const vTopicY2 = unit([0, 0, 0.85, 0.526, 0]);

    const register = (msgsWithVecs) => {
        for (const item of msgsWithVecs) {
            const { hash } = cvm._getNormalizedAndHash(item.content, item.role);
            cvm.vectorMap.set(hash, { vector: item.vec, role: item.role, normalizedText: item.content, timestamp: Date.now() });
        }
        return msgsWithVecs.map(({ role, content }) => ({ role, content }));
    };

    // 1) Real post_jump_deepen: U1(X), A1(X) -> U2(Y), A2(Y) -> U3(Y')
    //    segmentContext excludes U3 and A2, leaving [seg0(X), seg1(lone U2=Y)]
    const postJumpMsgs = register([
        { role: 'user', content: 'topic x turn 1', vec: vTopicX },
        { role: 'assistant', content: 'topic x reply 1', vec: vTopicX },
        { role: 'user', content: 'topic y jump turn 2', vec: vTopicY },
        { role: 'assistant', content: 'topic y reply 2', vec: vTopicY },
        { role: 'user', content: 'topic y deepen turn 3', vec: vTopicY2 }
    ]);
    const postJumpSegs = cvm.segmentContext(postJumpMsgs);
    assert.equal(postJumpSegs.length, 2);
    assert.equal(postJumpSegs[1].count, 1);
    const tfPostJump = mtm._v3TimeFlowAxis('', vTopicY2, vTopicY, vTopicY2, vTopicY2, null, null, null, 0.85, postJumpSegs);
    assert.equal(tfPostJump.phase, 'post_jump_deepen', `expected post_jump_deepen with real segmentContext, got ${tfPostJump.phase}`);

    // 2) Real dialectic_return: U1(X), A1(X) -> U2(Y), A2(Y) -> U3(X')
    const returnMsgs = register([
        { role: 'user', content: 'ret x turn 1', vec: vTopicX },
        { role: 'assistant', content: 'ret x reply 1', vec: vTopicX },
        { role: 'user', content: 'ret y detour turn 2', vec: vTopicY },
        { role: 'assistant', content: 'ret y reply 2', vec: vTopicY },
        { role: 'user', content: 'ret back to x turn 3', vec: vTopicX2 }
    ]);
    const returnSegs = cvm.segmentContext(returnMsgs);
    const tfReturn = mtm._v3TimeFlowAxis('', vTopicX2, vTopicY, vTopicX2, vTopicX2, null, null, null, 0.85, returnSegs);
    assert.equal(tfReturn.phase, 'dialectic_return', `expected dialectic_return with real segmentContext, got ${tfReturn.phase}`);
});

test('V3.4 regression: OneRing preserves user-authored historical V3 formulas while still dropping unmarked same-turn injected blocks', () => {
    const oneRing = require('../Plugin/OneRing/OneRing');
    const v34Formula = '$$势陷[∂星甲 ⋈ ∇星乙]_φ ⊢ 思奇 σ_∞(星丙 ⊖ φ | ℳ) ∥ ⊘(r_⊥ ⊕ ∂_2) →_{τ↺} ?^{-1}$$';

    // 1) User-authored V3 formula in an earlier turn (followed by assistant reply) must be preserved
    const histView = oneRing._buildOneRingWorkingView([
        { role: 'user', content: v34Formula },
        { role: 'assistant', content: '这是你发的 V3.4 公式解析' },
        { role: 'user', content: '继续分析' }
    ]);
    assert.equal(histView.workingMessages.length, 3, 'OneRing must preserve user-authored historical V3 formula');
    assert.equal(histView.workingMessages[0].content, v34Formula);

    // 2) Unmarked (deep-cloned) injected V3 formula immediately above a real user message in the same turn must still be dropped
    const injectedView = oneRing._buildOneRingWorkingView([
        { role: 'user', content: '上一轮' },
        { role: 'assistant', content: '上一轮回复' },
        { role: 'user', content: v34Formula },
        { role: 'user', content: '本轮真实发言' }
    ]);
    assert.equal(injectedView.workingMessages.length, 3, 'OneRing must drop unmarked same-turn injected V3 block');
    assert.equal(injectedView.workingMessages[2].content, '本轮真实发言');
});

test('V3.5 regression: RAGDiaryPlugin tracks riverDiaryUseGroupFlags per useGroup and ignores non-RiverMemo placeholders', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'), 'utf8');
    assert.ok(src.includes('requestCache.riverDiaryUseGroupFlags = riverDiaryUseGroupFlags;'), 'must track per-useGroup RiverMemo diary flags');
    assert.ok(src.includes('requestCache?.riverDiaryUseGroupFlags?.has(Boolean(useGroup))'), 'V3 getObservation must gate on matching useGroup flag');
    const match = src.match(/sysText\.matchAll\((\/\\\[\\\[[^\n]+\/g)\)/);
    assert.ok(match, 'expected vector diary placeholder scanner regex in RAGDiaryPlugin.js');
    const re = new RegExp(match[1].slice(1, -2), 'g');
    for (const positive of ['[[日常回忆日记本]]', '《《日常回忆日记本::RiverMemo》》', '[[A|B日记本::Group]]']) {
        assert.equal([...positive.matchAll(re)].length, 1, `must match ${positive}`);
    }
    for (const negative of ['<<全文日记本>>', '{{纯文本日记本}}', '[[冷知识库]]', '[[VCP元思考V3]]']) {
        assert.equal([...negative.matchAll(re)].length, 0, `must not match non-RiverMemo placeholder ${negative}`);
    }
});

test('V3.5 audit repro #1: _v3StarPoolCache bounds LRU size, normalizes direct diaryNames, and evicts stale entry when empty', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Database = require('better-sqlite3');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-v3-pool-lru-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE files (id INTEGER PRIMARY KEY, diary_name TEXT, path TEXT, updated_at INTEGER);
            CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, content TEXT, vector BLOB, vector_version INTEGER);
        `);
        const vecBuf = (arr) => Buffer.from(new Float32Array(arr).buffer);
        const insFile = db.prepare('INSERT INTO files (id, diary_name, path, updated_at) VALUES (?, ?, ?, ?)');
        const insChunk = db.prepare('INSERT INTO chunks (id, file_id, content, vector, vector_version) VALUES (?, ?, ?, ?, ?)');
        for (let i = 1; i <= 12; i++) {
            insFile.run(i, `星池${i}`, `星池${i}/星${i}.md`, 1000);
            insChunk.run(i, i, `内容${i}`, vecBuf([1, i * 0.1, 0, 0]), 1);
        }
        const mtm = new MetaThinkingManager({});
        const vdb = fixtureStarReader(dbPath);

        // Equivalent scopes share the same cache entry.
        const p1 = await mtm._v3LoadStarPoolCache(vdb, ['星池2', '星池1'], null, { ttlMs: 60000 });
        const p2 = await mtm._v3LoadStarPoolCache(vdb, [' 星池1 ', '星池2', '星池1'], null, { ttlMs: 60000 });
        assert.strictEqual(p1, p2);

        for (let i = 1; i <= 12; i++) {
            const p = await mtm._v3LoadStarPoolCache(vdb, [`星池${i}`], null, { ttlMs: 0 });
            assert.ok(p && p.stars.length === 1);
        }
        assert.ok(mtm._v3StarPoolCache.size <= 8);

        db.prepare('DELETE FROM chunks WHERE file_id = 12').run();
        const emptyPool = await mtm._v3LoadStarPoolCache(vdb, ['星池12'], null, { ttlMs: 0 });
        assert.equal(emptyPool, null);
        const afterErr = await mtm._v3LoadStarPoolCache({
            dbPath,
            async readMetaStarPool() { throw new Error('native unavailable'); }
        }, ['星池12'], null, { ttlMs: 0 });
        assert.equal(afterErr, null);
        const key12 = [...mtm._v3StarPoolCache.keys()].find(k => k.includes('星池12'));
        assert.equal(key12, undefined, 'emptied star pool must be evicted from _v3StarPoolCache');
    } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('V3.5 audit repro #2: _v3TagVectorCache must not poison transient errors permanently or leak unboundedly', async () => {
    const mtm = new MetaThinkingManager({});
    let attempts = 0;
    const vdb = {
        dbPath: '/tmp/db-a.sqlite',
        async getTagVectorByName(name) {
            if (name === '瞬时异常Tag') {
                attempts++;
                if (attempts === 1) throw new Error('SQLITE_BUSY transient');
                return unit([1, 0, 0, 0]);
            }
            return unit([0, 1, 0, 0]);
        }
    };

    const first = await mtm._v3GetTagVectors(vdb, ['瞬时异常Tag']);
    assert.equal(first.size, 0);
    const second = await mtm._v3GetTagVectors(vdb, ['瞬时异常Tag']);
    assert.equal(attempts, 2, 'transient error must NOT permanently poison _v3TagVectorCache with null');
    assert.equal(second.size, 1, 'subsequent call after transient error must recover tag vector');

    // Different dbPath must not cross-contaminate
    const vdbB = {
        dbPath: '/tmp/db-b.sqlite',
        async getTagVectorByName() {
            return unit([0, 0, 1, 0]);
        }
    };
    const fromB = await mtm._v3GetTagVectors(vdbB, ['瞬时异常Tag']);
    assert.ok(mtm._v3Dot(fromB.get('瞬时异常Tag'), unit([0, 0, 1, 0])) > 0.99, 'tag cache must be scoped per dbPath');
});

test('V3.5 audit repro #3: _v3LoadGlobalManifold guards empty/cleared directories cleanly', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-v3-manifold-'));
    try {
        const mtm = new MetaThinkingManager({});
        mtm._v3GlobalManifoldCache = {
            storeDir: tmpDir,
            key: 'stale',
            value: { nodeCount: 10 },
            checkedAt: 0
        };
        const afterDelete = mtm._v3LoadGlobalManifold({ config: { storePath: tmpDir } }, { ttlMs: 0 });
        assert.equal(afterDelete, null);
        assert.equal(mtm._v3GlobalManifoldCache.value, null, 'missing .vcpwc must clear stale cached manifold value');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('V3.5 audit repro #4: _v3LoadStarPoolCache handles mixed-dimension neighbor smoothing without NaN or truncation', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Database = require('better-sqlite3');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-v3-mixdim-'));
    const dbPath = path.join(tmpDir, 'mix.sqlite');
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE files (id INTEGER PRIMARY KEY, diary_name TEXT, path TEXT, updated_at INTEGER);
            CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, content TEXT, vector BLOB, vector_version INTEGER);
        `);
        const vecBuf = (arr) => Buffer.from(new Float32Array(arr).buffer);
        db.prepare('INSERT INTO files VALUES (1, ?, ?, 1)').run('混维簇', '混维簇/二维首星.md');
        db.prepare('INSERT INTO files VALUES (2, ?, ?, 1)').run('混维簇', '混维簇/四维星甲.md');
        db.prepare('INSERT INTO files VALUES (3, ?, ?, 1)').run('混维簇', '混维簇/四维星乙.md');
        db.prepare('INSERT INTO chunks VALUES (1, 1, ?, ?, 1)').run('A', vecBuf([1, 0]));
        db.prepare('INSERT INTO chunks VALUES (2, 2, ?, ?, 1)').run('B', vecBuf([0.8, 0.6, 0, 0]));
        db.prepare('INSERT INTO chunks VALUES (3, 3, ?, ?, 1)').run('C', vecBuf([0.6, 0.8, 0, 0]));

        const mtm = new MetaThinkingManager({});
        const manifold = {
            cacheKey: 'mix-m',
            meanAxis: null,
            beta: 0.7,
            ids: [1, 2, 3],
            idToSlot: new Map([[1, 0], [2, 1], [3, 2]]),
            offsets: [0, 1, 2, 3],
            graph: [1, 2, 1],
            inDeg: new Float64Array([1, 2, 1]),
            radiusByChunkId: new Map([[1, 0.5], [2, 0.5], [3, 0.5]]),
            defaultRadius: 0.5,
            geo: null
        };
        const pool = await mtm._v3LoadStarPoolCache(fixtureStarReader(dbPath), ['混维簇'], manifold, { ttlMs: 0 });
        assert.ok(pool);
        const s2 = pool.byStarName.get('四维星甲');
        assert.ok(s2 && s2.z && s2.z.length === 4, `expected 4-dim smoothed z for 四维星甲 (no truncation to dim=2), got len=${s2?.z?.length}`);
        assert.ok(Array.from(s2.z).every(Number.isFinite), 'mixed-dim smoothing must never yield NaN');
    } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('V3.5 audit repro #5 & #6 & #8: canonical v3TaskKey dedupe, weighted RiverMemo cache bypass, and multimodal carrier preservation', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

    // Repro #6: cache bypass regex in RAGDiaryPlugin must match ::RiverMemo:0.5::Time
    const src = fs.readFileSync(path.join(__dirname, '../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'), 'utf8');
    const cacheBypassMatches = [...src.matchAll(/const cachedResult = requestCache\?\.riverThinking && (\/::RiverMemo[^\n]+\/i)\.test\(modifiers\)/g)];
    assert.ok(cacheBypassMatches.length >= 2, 'expected at least 2 riverThinking cache bypass checks');
    for (const m of cacheBypassMatches) {
        const re = new RegExp(m[1].slice(1, -2), 'i');
        assert.equal(re.test('::RiverMemo:0.5::Time'), true, `cache bypass regex ${m[1]} must match ::RiverMemo:0.5::Time`);
        assert.equal(re.test('::RiverMemo:1.2::Group'), true, `cache bypass regex ${m[1]} must match ::RiverMemo:1.2::Group`);
    }

    // Repro #5 & #8: A|B vs B|A deduplicates to 1 V3 invocation, and multimodal [系统提示:] carrier keeps its image_url
    const rag = new ragSingleton.constructor();
    rag.contextVectorManager = { updateContext: async () => {}, segmentContext: () => [] };
    rag.timeParser = { parse: () => [] };
    rag.ragParams = { RAGDiaryPlugin: {} };
    rag.getSingleEmbeddingCached = async () => unit([1, 0, 0, 0]);
    rag._calculateDynamicParams = async () => ({ k: 3, tagWeight: 0.15, tagTruncationRatio: 0.5, metrics: {} });
    const realMtm = new MetaThinkingManager(rag);
    let v3Calls = 0;
    const formula = '$$势陷[∂星甲 ∧ ∇星乙]_φ ↦ 思奇 σ_∞(星丙 ⊖ φ) →_{τ,x} ?$$';
    rag.metaThinkingManager = {
        _resolveV3StarPoolDiaries: realMtm._resolveV3StarPoolDiaries.bind(realMtm),
        processMetaThinkingV3: async () => {
            v3Calls++;
            return formula;
        }
    };

    const messages = [
        { role: 'system', content: '[[VCP元思考V3:星池A|星池B]]\n[[VCP元思考V3: 星池B | 星池A ]]' },
        {
            role: 'user',
            content: [
                { type: 'text', text: '[系统提示:]\n[[VCP元思考V3:星池A|星池B]]' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ]
        },
        { role: 'user', content: '真实提问' }
    ];
    const out = await rag._processMessagesWithMemoScope(messages, {});
    assert.equal(v3Calls, 1, 'reordered/spaced equivalent poolScopes A|B and B|A must deduplicate to a single V3 execution');
    assert.equal(out.length, messages.length);
    assert.equal(out[0].content, `${formula}\n${formula}`);
    assert.deepEqual(out[1].content, [
        { type: 'text', text: `[系统提示:]\n${formula}` },
        messages[1].content[1]
    ]);
});

test('V3.5 audit repro #7: AbortController aborts MetaThinkingV3 cleanly with zero phantom pushVcpInfo and zero handle leaks', async () => {
    const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
    const ac = new AbortController();
    const broadcasts = [];
    let preparedCount = 0;
    let releasedCount = 0;

    const rag = new ragSingleton.constructor();
    rag.contextVectorManager = { updateContext: async () => {}, segmentContext: () => [] };
    rag.timeParser = { parse: () => [] };
    rag.ragParams = { RAGDiaryPlugin: {} };
    rag.getSingleEmbeddingCached = async () => unit([1, 0, 0, 0]);
    rag._calculateDynamicParams = async () => ({ k: 3, tagWeight: 0.15, tagTruncationRatio: 0.5, metrics: {} });
    rag.pushVcpInfo = (info) => broadcasts.push(info);
    rag.vectorDBManager = {
        async prepareUnifiedMemoObservation() {
            preparedCount++;
            return { handle: 'obs-abort-1', enhancedVector: unit([1, 0, 0, 0]) };
        },
        releaseMemoObservation() {
            releasedCount++;
        },
        async executeNativeRiverQuery() {
            ac.abort();
            return {
                results: [
                    { chunkId: 1, sourceFile: '星甲.md', score: 0.9 },
                    { chunkId: 2, sourceFile: '星乙.md', score: 0.8 },
                    { chunkId: 3, sourceFile: '星丙.md', score: 0.7 }
                ],
                diagnostics: {}
            };
        },
        async getVectorByChunkId(id) {
            const m = { 1: [1, 0, 0, 0], 2: [0, 1, 0, 0], 3: [0, 0, 1, 0] };
            return unit(m[id]);
        }
    };
    const mtm = new MetaThinkingManager(rag);
    mtm._v3LoadGlobalManifold = () => null;
    mtm._v3LoadStarPoolCache = () => null;
    rag.metaThinkingManager = mtm;

    const messages = [
        { role: 'system', content: '[[VCP元思考V3]]' },
        { role: 'user', content: '测试中途 Abort' }
    ];

    await assert.rejects(
        () => rag._processMessagesWithMemoScope(messages, { signal: ac.signal }),
        (err) => err && err.name === 'AbortError'
    );
    assert.equal(preparedCount, releasedCount, 'ownedPrepared observation handle must be 100% released on abort');
    assert.equal(broadcasts.length, 0, 'aborted V3 request must NOT emit phantom pushVcpInfo broadcasts');
});

test('V3.5 audit repro #9 & #10: multi-turn user-sent V3 formula respects turn boundary and dynamicToolRegistry skips injected V3 blocks', () => {
    const { findLastRealUserMessage } = require('../modules/messageProcessor');
    const formula = '$$势陷[∂共晶点 ∧ ∇伴随文本]_φ ↦ 思奇 σ_∞(回声反语 ⊖ φ) →_{τ,x} ?$$';

    // Repro #9: Turn 2 user sends pure V3 formula after Turn 1 assistant reply
    const multiTurnUserFormula = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'user', content: formula }
    ];
    const found = findLastRealUserMessage(multiTurnUserFormula);
    assert.equal(found.index, 3, 'multi-turn user-sent pure V3 formula after assistant must be recognized as current-turn user message');
    assert.equal(found.sanitizedContent, formula);

    // Repro #10: dynamicToolRegistry must filter out V3 injected formula blocks
    const fs = require('node:fs');
    const path = require('node:path');
    const dtrSrc = fs.readFileSync(path.join(__dirname, '../modules/dynamicToolRegistry.js'), 'utf8');
    assert.ok(dtrSrc.includes('isMetaThinkingV3Message'), 'dynamicToolRegistry must filter injected V3 formula messages from fold query');
});

test('V3.6 pure-tensor _v3ComputeUserIntentLoad distinguishes sharp topic spikes & V5.2 denoised pulls from phatic collapse without text length', () => {
    const mtm = new MetaThinkingManager({});
    // 构造 24 维正交星池 + 公共均值轴 e0
    const dim = 28;
    const meanAxis = new Float32Array(dim);
    meanAxis[0] = 1;
    const stars = [];
    for (let i = 0; i < 24; i++) {
        const z = new Float32Array(dim);
        z[i + 1] = 1; // 24 个正交星方向（与均值轴 e0 正交）
        stars.push({ chunkId: i + 1, starName: `星${i + 1}`, z });
    }
    const pool = { stars, starMeanAxis: meanAxis, betaStar: 0.85 };

    // 1) 强聚焦新话题（与星1对齐 0.45、偏离均值轴）：意图载荷应接近 1.0
    const sharpRaw = new Float32Array(dim);
    sharpRaw[0] = 0.25; sharpRaw[1] = 0.45; sharpRaw[25] = 0.85;
    const sharpU = unit(sharpRaw);
    const sharpZ = new Float32Array(dim);
    sharpZ[1] = 0.45; sharpZ[25] = Math.sqrt(1 - 0.45 * 0.45);
    const sharpInfo = mtm._v3ComputeUserIntentLoad(sharpU, sharpZ, null, null, null, null, pool);
    assert.ok(sharpInfo.load >= 0.85, `expected high intent load for sharp topic, got ${sharpInfo.load}`);

    // 2) 低信息量附和（各向同性平底 + 塌向公共均值轴 e0）：意图载荷应显著衰减 (< 0.35)
    const phaticRaw = new Float32Array(dim);
    phaticRaw[0] = 0.50;
    phaticRaw[26] = 0.86;
    const phaticU = unit(phaticRaw);
    const phaticZ = new Float32Array(dim);
    for (let i = 1; i <= 24; i++) phaticZ[i] = 0.08;
    phaticZ[26] = 0.92;
    const phaticZUnit = unit(phaticZ);
    const phaticInfo = mtm._v3ComputeUserIntentLoad(phaticU, phaticZUnit, null, null, null, null, pool);
    assert.ok(phaticInfo.load < 0.30, `expected low intent load for phatic collapse, got ${phaticInfo.load}`);

    // 3) V5.2 去噪场兜底：当 31,050 全局 Tag 场将混合向量强推向用户（rawPullDiff > 0.03），救回星池外工程短词
    const prevRaw = new Float32Array(dim); prevRaw[27] = 1;
    const mixRaw = unit(Array.from({ length: dim }, (_, i) => 0.58 * phaticU[i] + 0.42 * prevRaw[i]));
    const enhTowardUser = unit(Array.from({ length: dim }, (_, i) => mixRaw[i] + 0.12 * phaticU[i]));
    const enhTowardPrev = unit(Array.from({ length: dim }, (_, i) => mixRaw[i] + 0.12 * prevRaw[i]));
    const rescued = mtm._v3ComputeUserIntentLoad(phaticU, phaticZUnit, prevRaw, mixRaw, enhTowardUser, null, pool);
    const notRescued = mtm._v3ComputeUserIntentLoad(phaticU, phaticZUnit, prevRaw, mixRaw, enhTowardPrev, null, pool);
    assert.ok(rescued.load >= 0.55, `V5.2 denoised pull toward user must rescue out-of-pool query, got ${rescued.load}`);
    assert.ok(notRescued.load < 0.30, `V5.2 denoised pull toward prevAi must keep phatic suppressed, got ${notRescued.load}`);

    // 4) 小于 16 星的合成测试池默认返回 1.0（完全向后兼容）
    const smallPool = { stars: stars.slice(0, 5), starMeanAxis: meanAxis, betaStar: 0.85 };
    assert.equal(mtm._v3ComputeUserIntentLoad(phaticU, phaticZUnit, null, null, null, null, smallPool).load, 1.0);
});

test('V3.6 low userIntentLoad prevents false explore_jump and attenuates primary background subtraction', () => {
    const mtm = new MetaThinkingManager({});
    const vSeg = unit([1, 0, 0, 0, 0]);
    const vAi = unit([0.60, 0.80, 0, 0, 0]);
    const vPhatic = unit([0.02, 0.06, 0.998, 0, 0]); // continuity ≈ 0.06 < 0.12

    // High intentLoad (real short topic jump) -> explore_jump & full shift
    const tfRealJump = mtm._v3TimeFlowAxis('', vPhatic, vAi, vPhatic, vPhatic, null, null, null, 0.85, [{ vector: vSeg }], 0.90);
    assert.equal(tfRealJump.phase, 'explore_jump');
    assert.ok(tfRealJump.shift > 0.25);

    // Low intentLoad (phatic confirmation like "当然可以助手加油") -> stays deepen_steady & attenuated shift
    const tfPhatic = mtm._v3TimeFlowAxis('', vPhatic, vAi, vPhatic, vPhatic, null, null, null, 0.85, [{ vector: vSeg }], 0.20);
    assert.equal(tfPhatic.phase, 'deepen_steady', `phatic confirmation must not trigger explore_jump, got ${tfPhatic.phase}`);
    assert.ok(tfPhatic.shift < tfRealJump.shift * 0.35, `shift must be attenuated by userIntentLoad, got ${tfPhatic.shift}`);

    // Primary calibration weight scales down with userIntentLoad so prevAi topic isn't stripped away
    const z1 = unit([0, 1, 0, 0, 0]);
    const z2 = unit([0, 0, 1, 0, 0]);
    const vecCache = new Map([[1, z1], [2, z2]]);
    const cands = [
        { chunkId: 1, score: 0.65 }, // aligned with prevAi (zBg)
        { chunkId: 2, score: 0.55 }  // aligned with phatic zUser
    ];
    const fullCal = mtm._v3CalibratePrimaryCandidates(cands, z2, z1, null, vecCache, (v) => v, 0.28);
    const dampedCal = mtm._v3CalibratePrimaryCandidates(cands, z2, z1, null, vecCache, (v) => v, 0.28 * 0.15);
    assert.ok(fullCal[1].score > fullCal[0].score, 'full calibration promotes genuine new user topic');
    assert.ok(dampedCal[0].score > dampedCal[1].score, 'damped calibration under low intentLoad preserves ongoing topic');
});

test('V3.7 multi-agent concurrent ContextVectorManager.updateContext keeps per-request historyAssistantVectors isolated', async () => {
    const ContextVectorManager = require('../Plugin/RAGDiaryPlugin/ContextVectorManager');
    const vA1 = unit([1, 0, 0, 0]);
    const vA2 = unit([0.8, 0.6, 0, 0]);
    const vB1 = unit([0, 0, 1, 0]);
    const vB2 = unit([0, 0, 0.6, 0.8]);
    const vecByText = new Map([
        ['agentA turn1', vA1],
        ['agentA turn2', vA2],
        ['agentB turn1', vB1],
        ['agentB turn2', vB2]
    ]);
    const fakePlugin = {
        _stripHtml: (t) => t,
        _stripEmoji: (t) => t,
        _stripToolMarkers: (t) => t,
        _getEmbeddingFromCacheOnly: () => null,
        getSingleEmbeddingCached: async (text) => {
            // Agent A deliberately yields longer so Agent B finishes after A starts
            const delay = text.startsWith('agentA') ? 25 : 2;
            await new Promise(r => setTimeout(r, delay));
            return vecByText.get(text) || unit([0.5, 0.5, 0.5, 0.5]);
        }
    };
    const cvm = new ContextVectorManager(fakePlugin);
    const msgsA = [
        { role: 'user', content: 'uA1' },
        { role: 'assistant', content: 'agentA turn1' },
        { role: 'user', content: 'uA2' },
        { role: 'assistant', content: 'agentA turn2' },
        { role: 'user', content: 'uA3' },
        { role: 'assistant', content: 'agentA last' },
        { role: 'user', content: '加油' }
    ];
    const msgsB = [
        { role: 'user', content: 'uB1' },
        { role: 'assistant', content: 'agentB turn1' },
        { role: 'user', content: 'uB2' },
        { role: 'assistant', content: 'agentB turn2' },
        { role: 'user', content: 'uB3' },
        { role: 'assistant', content: 'agentB last' },
        { role: 'user', content: '继续' }
    ];

    const [snapA, snapB] = await Promise.all([
        cvm.updateContext(msgsA, { allowApi: true }),
        cvm.updateContext(msgsB, { allowApi: true })
    ]);

    assert.equal(snapA.historyAssistantVectors.length, 2);
    assert.equal(snapB.historyAssistantVectors.length, 2);
    assert.ok(Math.abs(snapA.historyAssistantVectors[0][0] - vA1[0]) < 1e-6, 'Agent A snapshot must not be clobbered by concurrent Agent B');
    assert.ok(Math.abs(snapA.historyAssistantVectors[1][1] - vA2[1]) < 1e-6);
    assert.ok(Math.abs(snapB.historyAssistantVectors[0][2] - vB1[2]) < 1e-6);
    assert.ok(Math.abs(snapB.historyAssistantVectors[1][3] - vB2[3]) < 1e-6);
});

test('V3.7 pure AI kinematics recalibrates stagnation (>=0.87)', async () => {
    const mtm = new MetaThinkingManager({});
    // Normal AI continuity ≈ 0.72 (real-world p50) must NOT trigger stagnation_loop
    const a3 = unit([1, 0, 0, 0]);
    const a2 = unit([0.72, 0.694, 0, 0]);
    const a1Normal = unit([0.30, 0.78, 0.549, 0]); // dot(a1Normal, a2) ≈ 0.757 < 0.87
    const kinNormal = mtm._v3ComputeAgentKinematics([a3, a2], a1Normal, null, null, 0.85);
    assert.equal(kinNormal.stagnant, false, 'normal p50 AI continuity ~0.75 must not falsely trigger stagnation');
    assert.equal(kinNormal.mEndo, 0, 'non-stagnant steady advance emits zero noise mEndo');

    const tfNormal = mtm._v3TimeFlowAxis('', unit([0, 0, 0, 1]), a1Normal, a1Normal, a1Normal, null, null, null, 0.85, [], 0.15, {
        agentKinematics: kinNormal
    });
    assert.equal(tfNormal.phase, 'deepen_steady');

    // True stagnation: cSelf >= 0.88 -> stagnant=true & mEndo > 0
    const a1Stuck = unit([0.70, 0.71, 0.07, 0]); // dot with a2 ≈ 0.996 >= 0.87
    const kinStuck = mtm._v3ComputeAgentKinematics([a3, a2], a1Stuck, null, null, 0.85);
    assert.equal(kinStuck.stagnant, true, 'high pure-AI collapse >= 0.87 must trigger stagnation');
    assert.ok(kinStuck.mEndo > 0.5, 'stagnation must push mEndo positive to trigger escape');
    const tfStuck = mtm._v3TimeFlowAxis('', unit([0, 0, 0, 1]), a1Stuck, a1Stuck, a1Stuck, null, null, null, 0.85, [], 0.15, {
        agentKinematics: kinStuck
    });
    assert.equal(tfStuck.phase, 'stagnation_loop');
});

test('V3.7 low contentAlpha skips shared user-biased observation, rescues Top-48-excluded basin star, and supports meta polarity', async () => {
    const dim = 28;
    const meanAxis = new Float32Array(dim);
    meanAxis[0] = 1;
    const stars = [];
    for (let i = 0; i < 20; i++) {
        const z = new Float32Array(dim);
        z[i + 1] = 1;
        const sName = i === 0 ? '正题盆地星' : `旁支星${i}`;
        stars.push({
            chunkId: i + 1,
            fileId: i + 1,
            diaryName: '希夷星池簇',
            sourceFile: `${sName}.md`,
            starName: sName,
            text: `${sName}\nstar ${i}`,
            raw: z,
            x: z,
            z,
            zRaw: z,
            radius: 0.45 + (i % 5) * 0.04,
            leg: null
        });
    }
    const aiVec = new Float32Array(dim); aiVec[1] = 1; // aligned with 正题盆地星 (#1)
    const aiPrev2 = new Float32Array(dim); aiPrev2[1] = 0.72; aiPrev2[2] = 0.69;
    const phaticUserVec = new Float32Array(dim);
    phaticUserVec[0] = 0.50; phaticUserVec[25] = 0.866; // low star-pool load

    let sharedObsCalled = 0;
    let ownObsQueryVec = null;
    const broadcasts = [];
    const mockVdb = {
        dbPath: 'mock-v37.sqlite',
        prepareUnifiedMemoObservation: async ({ vector }) => {
            ownObsQueryVec = vector;
            return {
                enhancedVector: aiVec,
                sourceObservationResult: {
                    matchedTags: [],
                    pyramid: { totalExplainedEnergy: 0.6, depth: 1, levels: [{ tags: [] }] }
                }
            };
        },
        releaseMemoObservation: () => true,
        executeNativeRiverQuery: async () => ({
            omega: { omega: 0.4, regime: 'dense', omegaFlow: 0.7 },
            results: [
                // Deliberately omit 正题盆地星 (#1) from V5 primaryCandidates to verify full-pool rescue!
                { chunkId: 2, diaryName: '希夷星池簇', text: '[[tag]] 旁支星1', score: 0.72, baseScore: 0.60, fieldScore: 0.70, topologyBonus: 0.004 }
            ]
        }),
        getTagVectorByName: async () => null
    };

    const mtm = new MetaThinkingManager({
        vectorDBManager: mockVdb,
        pushVcpInfo: (payload) => broadcasts.push(payload)
    });
    // Pre-populate starPool cache so 20-star pool triggers full V3.7 low-alpha path
    mtm._v3StarPoolCache = new Map([[
        `mock-v37.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);

    const formula = await mtm.processMetaThinkingV3(
        '希夷星池簇',
        unit(Array.from({ length: dim }, (_, d) => 0.7 * phaticUserVec[d] + 0.3 * aiVec[d])),
        '当然可以助手加油',
        '上一轮AI正文',
        'display',
        false,
        {
            userVector: unit(phaticUserVec),
            aiVector: unit(aiVec),
            historyAssistantVectors: [unit(aiPrev2)],
            getObservation: async () => {
                sharedObsCalled++;
                return { enhancedVector: phaticUserVec };
            }
        }
    );

    assert.equal(sharedObsCalled, 0, 'low contentAlpha must skip user-biased shared ::RiverMemo observation');
    assert.ok(ownObsQueryVec && ownObsQueryVec[1] > 0.90, 'own precision-weighted observation must stay anchored to aiVector');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].independentObservationUsed, true);
    assert.equal(broadcasts[0].stars[0].name, '正题盆地星', 'Star 1 must be rescued from full pool even when missing from Top-K');
    assert.equal(broadcasts[0].modalityM, 0, 'non-stagnant pure-AI deepening under phatic turn keeps modalityM=0 without spurious drift');
    assert.match(formula, /^\$\$势陷\[∂正题盆地星/);

    // Verify _v3EvalMetaPolarity works with cached axes and falls back cleanly when offline
    assert.deepEqual(mtm._v3EvalMetaPolarity(unit(phaticUserVec), 0.1), { isMetaCmd: false, etaMode: 0 });
    const muP = unit([1, 0, 0, 0]);
    const eD = unit([0, 1, 0, 0]);
    const eE = unit([0, 0, 1, 0]);
    const drillRes = mtm._v3EvalMetaPolarity(unit([0.2, 0.98, 0, 0]), 0.3, { muPhatic: muP, eDrill: eD, eEscape: eE });
    const escRes = mtm._v3EvalMetaPolarity(unit([0.2, 0, 0.98, 0]), 0.3, { muPhatic: muP, eDrill: eD, eEscape: eE });
    const trapRes = mtm._v3EvalMetaPolarity(unit([0.95, 0.25, 0.18, 0]), 0.3, { muPhatic: muP, eDrill: eD, eEscape: eE });
    assert.equal(drillRes.isMetaCmd, true);
    assert.ok(drillRes.etaMode < -0.9);
    assert.equal(escRes.isMetaCmd, true);
    assert.ok(escRes.etaMode > 0.9);
    assert.equal(trapRes.isMetaCmd, false, 'phatic trap near muPhatic must not trigger meta-command gate');
});

test('V3.7 fixes: meta-word topic trap never clamps contentAlpha, transient MetaAxes failure recovers, and | M matches active weights', async () => {
    const muP = unit([1, 0, 0, 0]);
    const eD = unit([0, 1, 0, 0]);
    const eE = unit([0, 0, 1, 0]);
    let calls = 0;
    const flaky = new MetaThinkingManager({
        getBatchEmbeddings: async (texts) => {
            calls++;
            if (calls === 1) throw new Error('transient timeout');
            return texts.map((_, idx) => {
                if (idx < 8) return muP;
                if (idx < 12) return muP;
                if (idx < 17) return eD;
                return eE;
            });
        }
    });
    const first = await flaky._v3EnsureMetaPolarityAxes();
    assert.equal(first, null);
    assert.ok(flaky._v3MetaAxesRetryAt > Date.now(), 'transient failure must schedule retry rather than permanent lockout');
    flaky._v3MetaAxesRetryAt = Date.now() - 1;
    const recovered = await flaky._v3EnsureMetaPolarityAxes();
    assert.ok(recovered && recovered.muPhatic, 'must recover cleanly on retry after cooldown');

    const mtm = new MetaThinkingManager({});
    // Entity question containing meta words (high color energy qrEColor ≈ 0.83 > metaColorGateCut) -> must not clamp contentAlpha
    const trapVec = unit([0.10, 0.25, 0.25, 0.93]);
    const trapPol = mtm._v3EvalMetaPolarity(trapVec, 0.72, { muPhatic: muP, eDrill: eD, eEscape: eE });
    assert.equal(trapPol.clampContent, false, 'entity topic with meta phrasing must not clamp contentAlpha');

    // Pure meta command inside directive subspace (low color energy qrEColor < metaColorGateCut) -> clamps & sets negative etaMode
    const pureDrillVec = unit([0.20, 0.75, 0.15, 0.61]);
    const purePol = mtm._v3EvalMetaPolarity(pureDrillVec, 0.40, { muPhatic: muP, eDrill: eD, eEscape: eE });
    assert.equal(purePol.isMetaCmd, true);
    assert.equal(purePol.clampContent, true);
    assert.ok(purePol.etaMode < -0.9);
});

test('V3.7 V5.2 epaMean global tangent-space sharpness exposes continuous upstream signals without hard ramps', async () => {
    const epaMean = unit([1, 0, 0, 0]);
    const userVec = unit([0.6, 0.8, 0, 0]);
    const flatTag = unit([0.80, 0.16, 0.58, 0]);
    const sharpTag = unit([0.75, 0.50, 0.43, 0]);
    let released = 0;
    let mode = 'flat';
    let lastOpts = null;
    const mockVdb = {
        dbPath: 'mock-epa.sqlite',
        prepareUnifiedMemoObservation: async (_q, opts) => {
            lastOpts = opts;
            return {
                observationHandle: 'h1',
                sourceObservationResult: {
                    epa: { inDomainGate: mode === 'sharp' ? 0.90 : 0.15 },
                    pyramid: { levels: [{ energyExplained: mode === 'sharp' ? 0.85 : 0.10, tags: [{ name: mode === 'flat' ? 'flat_tag' : 'sharp_tag', contribution: mode === 'sharp' ? 0.85 : 0.15 }] }] }
                }
            };
        },
        releaseMemoObservation: () => { released++; },
        getTagVectorByName: async (name) => (name === 'flat_tag' ? flatTag : sharpTag)
    };
    const mtm = new MetaThinkingManager({});
    const resFlat = await mtm._v3MeasureV52TagSharpness(mockVdb, userVec, 'praise', epaMean, { lightweightProbe: true });
    assert.equal(lastOpts.maxPyramidLevels, 1, 'lightweightProbe must pass maxPyramidLevels=1');
    assert.equal(lastOpts.spikeRouting.maxSafeHops, 0, 'lightweightProbe must pass maxSafeHops=0');
    assert.ok(resFlat.maxTagX < 0.38 && resFlat.sharpness < 0.50, 'flat L0 tag must stay low');
    mode = 'sharp';
    const resSharp = await mtm._v3MeasureV52TagSharpness(mockVdb, userVec, 'entity', epaMean);
    assert.ok(resSharp.maxTagX > 0.65 && resSharp.sharpness > 0.85 && resSharp.sharpness > resFlat.sharpness * 2, 'sharp domain L0 tag must clearly dominate flat praise');
    assert.equal(released, 2, 'must release temporary probe observation handles');
});

test('V3.7+ ping-pong oscillation A->B->A->B triggers stagnation_loop via c13/kappaAi', () => {
    const mtm = new MetaThinkingManager({});
    const a = unit([1, 0, 0, 0, 0, 0]);
    const b = unit([0.05, 0.998, 0, 0, 0, 0]);
    const kin = mtm._v3ComputeAgentKinematics([a, b, a], b, null, null, 0.85);
    assert.ok(kin.cSelf < 0.10);
    assert.ok(kin.returnSim > 0.99);
    assert.equal(kin.oscillating, true);
    assert.equal(kin.stagnant, true);
    assert.ok(kin.mEndo >= 0.85, 'ping-pong loop must emit positive escape drive');
});

test('V3.7+ Form x Color decomposition strips directive subspace and epaMean centering isolates non-phatic tokens', () => {
    const mtm = new MetaThinkingManager({});
    const epaMean = unit([1, 0, 0, 0, 0, 0]);
    // Pure axes orthogonal to epaMean
    const muP = unit([0.6, 0.8, 0, 0, 0, 0]);
    const eD = unit([0, 0, 1, 0, 0, 0]);
    const eE = unit([0, 0, 0, 1, 0, 0]);
    // Compound utterance: common DC offset + directive + real topic on dim[4] (high color energy -> keeps content, strips meta cleanly)
    const compoundVec = unit([0.55, 0.10, 0.35, 0.05, 0.75, 0]);
    const pol = mtm._v3EvalMetaPolarity(compoundVec, 0.70, { muPhatic: muP, eDrill: eD, eEscape: eE }, { epaMean });
    assert.ok(pol.pPhaticCentered !== null && pol.pPhaticCentered < 0.36, 'non-phatic topic must have low centered phatic projection');
    assert.equal(pol.clampContent, false, 'compound entity + directive must not clamp contentAlpha');
    assert.ok(pol.colorVector && pol.colorVector[4] > 0.75, 'colorVector must concentrate on topic axis after stripping meta subspace');

    // Pure drill directive (low color energy) -> triggers strong negative etaMode
    const pureDrillVec = unit([0.20, 0.05, 0.70, 0.05, 0.68, 0]);
    const pureDrillPol = mtm._v3EvalMetaPolarity(pureDrillVec, 0.40, { muPhatic: muP, eDrill: eD, eEscape: eE }, { epaMean });
    assert.ok(pureDrillPol.etaMode < -0.5, 'pure drill directive must yield strong negative etaMode');

    // Centered phatic praise
    const praiseVec = unit([0.6, 0.78, 0.05, 0.05, 0.14, 0]);
    const praisePol = mtm._v3EvalMetaPolarity(praiseVec, 0.40, { muPhatic: muP, eDrill: eD, eEscape: eE }, { top1: 0.15, epaMean });
    assert.ok(praisePol.pPhaticCentered >= 0.90 && praisePol.phaticDamp < 0.25, 'centered phatic praise must be damped');
});

test('V3.7+ ContextVectorManager excludes VCP_TOOL_PAYLOAD from historyUserVectors and segmentContext', async () => {
    const ContextVectorManager = require('../Plugin/RAGDiaryPlugin/ContextVectorManager');
    const cvm = new ContextVectorManager({
        _stripHtml: (s) => s,
        _stripEmoji: (s) => s,
        _stripToolMarkers: (s) => s,
        _getEmbeddingFromCacheOnly: () => null,
        getSingleEmbeddingCached: async (txt) => (txt.includes('第一问') ? unit([1, 0, 0, 0]) : unit([0, 1, 0, 0]))
    });
    const msgs = [
        { role: 'user', content: '第一问真实问题' },
        { role: 'assistant', content: '工具调用中' },
        { role: 'user', content: '<!-- VCP_TOOL_PAYLOAD -->\n{"pool":32}' },
        { role: 'assistant', content: '查到了配置是32' },
        { role: 'user', content: '最后真实追问' }
    ];
    const snap = await cvm.updateContext(msgs, { allowApi: true });
    assert.equal(snap.historyUserVectors.length, 1, 'VCP_TOOL_PAYLOAD must never be vectorized as history user message');
    assert.equal(snap.historyAssistantVectors.length, 1);
    const segs = cvm.segmentContext(msgs);
    assert.equal(segs.reduce((s, g) => s + g.count, 0), 2, 'segmentContext must exclude VCP_TOOL_PAYLOAD');
});

test('V3.7 bugfix #1: useGroup semantic enhancement propagates through multi-turn observation and Star 1', async () => {
    const dim = 24;
    const rawUser = new Float32Array(dim); rawUser[1] = 1;
    const enhancedUser = new Float32Array(dim); enhancedUser[2] = 0.95; enhancedUser[1] = 0.31;
    const aiVec = new Float32Array(dim); aiVec[3] = 1;
    const aiPrev2 = new Float32Array(dim); aiPrev2[3] = 0.8; aiPrev2[4] = 0.6;
    const stars = [];
    for (let i = 0; i < 20; i++) {
        const z = new Float32Array(dim);
        z[(i % (dim - 1)) + 1] = 1;
        const name = i === 1 ? '语义组命中星' : `常规星${i}`;
        stars.push({
            chunkId: i + 1,
            fileId: i + 1,
            diaryName: '希夷星池簇',
            sourceFile: `${name}.md`,
            starName: name,
            text: name,
            raw: z,
            x: z,
            z,
            zRaw: z,
            radius: 0.5,
            leg: null
        });
    }

    let observedVector = null;
    const broadcasts = [];
    const mockVdb = {
        dbPath: 'mock-group-v37.sqlite',
        prepareUnifiedMemoObservation: async ({ vector }) => {
            observedVector = vector;
            return {
                enhancedVector: vector,
                sourceObservationResult: {
                    matchedTags: [],
                    pyramid: { totalExplainedEnergy: 0.6, depth: 1, levels: [{ tags: [] }] }
                }
            };
        },
        releaseMemoObservation: () => true,
        executeNativeRiverQuery: async ({ vector }) => ({
            omega: { omega: 0.4, regime: 'dense', omegaFlow: 0.7 },
            results: stars.slice(0, 6).map(s => ({
                chunkId: s.chunkId,
                diaryName: s.diaryName,
                sourceFile: s.sourceFile,
                text: s.text,
                score: s.raw.reduce((acc, v, idx) => acc + v * vector[idx], 0)
            }))
        }),
        getTagVectorByName: async () => null
    };

    const mtm = new MetaThinkingManager({
        vectorDBManager: mockVdb,
        semanticGroups: {
            detectAndActivateGroups: () => new Map([['GroupA', { strength: 1.0 }]]),
            getEnhancedVector: async () => unit(enhancedUser)
        },
        pushVcpInfo: (p) => broadcasts.push(p)
    });
    mtm._v3StarPoolCache = new Map([[
        `mock-group-v37.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: null,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);

    await mtm.processMetaThinkingV3(
        '希夷星池簇',
        unit(rawUser),
        '触发语义组的真实问题',
        '上一轮AI',
        'display',
        true,
        {
            userVector: unit(rawUser),
            aiVector: unit(aiVec),
            historyAssistantVectors: [unit(aiPrev2)]
        }
    );

    assert.ok(observedVector && observedVector[2] > 0.5, 'group-enhanced direction on dim[2] must reach observation vector');
    assert.equal(broadcasts[0].stars[0].name, '语义组命中星', 'Star 1 must follow group-enhanced vector rather than raw unenhanced userVector');
});

test('V3.7 bugfix #2: external topic jump resets old mEndo to 0 without forcing +0.65 escape and preserves orthogonal cone clearance', async () => {
    const dim = 24;
    const meanAxis = new Float32Array(dim); meanAxis[0] = 1;
    const aiVec = new Float32Array(dim); aiVec[1] = 1;
    const aiPrev2 = new Float32Array(dim); aiPrev2[1] = 0.96; aiPrev2[2] = 0.28; // high cSelf stagnation on OLD topic
    const newTopicVec = new Float32Array(dim); newTopicVec[5] = 1; // orthogonal to aiVec -> isExternalJump!
    const stars = [];
    for (let i = 0; i < 20; i++) {
        const z = new Float32Array(dim);
        if (i === 0) z[5] = 1;
        else z[((i + 5) % (dim - 1)) + 1] = 1;
        const name = i === 0 ? '新题主星' : `他星${i}`;
        stars.push({
            chunkId: i + 1,
            fileId: i + 1,
            diaryName: '希夷星池簇',
            sourceFile: `${name}.md`,
            starName: name,
            text: name,
            raw: z,
            x: z,
            z,
            zRaw: z,
            radius: 0.5,
            leg: null
        });
    }

    const broadcasts = [];
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-jump-v37.sqlite',
            prepareUnifiedMemoObservation: async ({ vector }) => ({
                enhancedVector: vector,
                sourceObservationResult: { matchedTags: [], pyramid: { totalExplainedEnergy: 0.7, depth: 1, levels: [{ tags: [] }] } }
            }),
            releaseMemoObservation: () => true,
            executeNativeRiverQuery: async () => ({
                omega: { omega: 0.5, regime: 'dense', omegaFlow: 0.8 },
                results: [{ chunkId: 1, diaryName: '希夷星池簇', sourceFile: '新题主星.md', text: '新题主星', score: 0.92 }]
            }),
            getTagVectorByName: async () => null
        },
        pushVcpInfo: (p) => broadcasts.push(p)
    });
    mtm._v3StarPoolCache = new Map([[
        `mock-jump-v37.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);

    const formulaJump = await mtm.processMetaThinkingV3(
        '希夷星池簇',
        unit(newTopicVec),
        '全新外部技术问题',
        '旧话题AI回复',
        'display',
        false,
        {
            userVector: unit(newTopicVec),
            aiVector: unit(aiVec),
            historyAssistantVectors: [unit(aiPrev2)]
        }
    );

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].modalityM, 0, 'external topic jump without explicit meta-command must reset old mEndo to 0 instead of injecting +0.65');
    assert.equal(broadcasts[0].timeFlowPhase, 'explore_jump', 'external topic jump must emit explore_jump rather than inheriting old-topic stagnation_loop');
    assert.ok(formulaJump.endsWith('→_{τ↗} ?$$'), `expected →_{τ↗} ? tail on external topic jump, got: ${formulaJump}`);
    assert.equal(broadcasts[0].stars[0].name, '新题主星');

    // Direct unit check on _selectV3TrinityStars WITH real manifold.geo: orthogonal cone clearance must favor the far orthogonal star over an in-cone candidate when modeM === 0
    const { createGeometry } = require('../Plugin/WarpedFieldAtlas/lib/geometry');
    const realGeo = createGeometry({
        profileKind: 1,
        profile: [0.15, 0, 0],
        config: { throatPhi0: 1.5, angularScaleKappa: 2.0, angularTau: 0, angularEta: 1 }
    });
    assert.equal(realGeo.supported, true);
    const x1 = unit([1, 0, 0, 0]);
    const x2 = unit([0, 1, 0, 0]);
    const xClose = unit([0.65, 0.65, 0.39, 0]); // high coneProj inside span(z1, z2)
    const xThroat = unit([0.10, 0.10, 0.99, 0]); // low coneProj, high orthogonal escape
    const cands = [
        { chunkId: 1, sourceFile: 'A.md', score: 0.9 },
        { chunkId: 2, sourceFile: 'B.md', score: 0.8 },
        { chunkId: 3, sourceFile: '近距星.md', score: 0.3 },
        { chunkId: 4, sourceFile: '深喉星.md', score: 0.3 }
    ];
    const vecs = new Map([[1, x1], [2, x2], [3, xClose], [4, xThroat]]);
    const pickedWithClearance = mtm._selectV3TrinityStars(cands, {
        lockedPrimary: { item: cands[0], starName: 'A', slot: 'primary' },
        lockedConjugate: { item: cands[1], starName: 'B', slot: 'conjugate' },
        zQuery: unit([0, 0, 1, 0]),
        ejectImpulseZ: unit([0.5, 0.5, 0.707, 0]),
        vectorByChunkId: vecs,
        manifold: { geo: realGeo, defaultRadius: 0.55 },
        modeM: 0,
        useV37Modality: true,
        externalJump: true
    });
    assert.equal(pickedWithClearance[2].starName, '深喉星', 'orthogonal cone clearance must favor far orthogonal star even with real manifold.geo when modeM === 0');
});

test('V3.7 bugfix #3: same-frame colorEnergy prevents low-meta spurious etaMode and keeps entity stripping clean', () => {
    const mtm = new MetaThinkingManager({});
    // Bugfix #3: even when epaMean aligns heavily with u (would inflate pPhaticCentered if mixed), raw-frame colorEnergy remains valid
    const epaMean = unit([0.7, 0.7, 0, 0, 0, 0]);
    const muP = unit([0, 1, 0, 0, 0, 0]);
    const eD = unit([0, 0, 1, 0, 0, 0]);
    const eE = unit([0, 0, 0, 1, 0, 0]);
    const vec = unit([0.55, 0.15, 0.35, 0.05, 0.74, 0]);
    const pol = mtm._v3EvalMetaPolarity(vec, 0.85, { muPhatic: muP, eDrill: eD, eEscape: eE }, { top1: 0.32, epaMean });
    assert.ok(pol.colorVector && pol.colorVector[4] > 0.75, 'same-frame colorEnergy must preserve topic colorVector cleanly');

    // Low metaStrength ordinary discourse must NEVER leak spurious etaMode or colorVector stripping
    const lowMetaEssay = unit([0.10, 0.15, 0.12, 0.08, 0.97, 0]);
    const lowMetaPol = mtm._v3EvalMetaPolarity(lowMetaEssay, 0.80, { muPhatic: muP, eDrill: eD, eEscape: eE }, { epaMean });
    assert.equal(lowMetaPol.etaMode, 0, 'ordinary essay with low metaStrength must not emit spurious etaMode');
    assert.equal(lowMetaPol.colorVector, null, 'ordinary essay with low metaStrength must not be stripped by meta subspace');
});

test('V3.7 bugfix #5: low-contentAlpha full-pool blend aligns V5 and agentAlign scales to [0, 1]', async () => {
    const dim = 28;
    const meanAxis = new Float32Array(dim); meanAxis[0] = 1;
    const aiVec = new Float32Array(dim); aiVec[1] = 1;
    const aiPrev2 = new Float32Array(dim); aiPrev2[1] = 0.72; aiPrev2[2] = 0.69;
    // Realistic star pool where best basin star has cos ≈ 0.35 with aiVec (not 1.0!),
    // while an off-basin V5 Top-1 star gets v5Score=0.80 (normalized to 1.0)
    const basinRaw = new Float32Array(dim); basinRaw[1] = 0.35; basinRaw[3] = Math.sqrt(1 - 0.35 * 0.35);
    const hijackedRaw = new Float32Array(dim); hijackedRaw[1] = 0.05; hijackedRaw[4] = Math.sqrt(1 - 0.05 * 0.05);
    const stars = [
        { chunkId: 1, fileId: 1, diaryName: '希夷星池簇', sourceFile: '真实盆地星.md', starName: '真实盆地星', text: '真实盆地星', raw: unit(basinRaw), x: unit(basinRaw), z: unit(basinRaw), zRaw: unit(basinRaw), radius: 0.5, leg: null },
        { chunkId: 2, fileId: 2, diaryName: '希夷星池簇', sourceFile: '误触Top1星.md', starName: '误触Top1星', text: '误触Top1星', raw: unit(hijackedRaw), x: unit(hijackedRaw), z: unit(hijackedRaw), zRaw: unit(hijackedRaw), radius: 0.5, leg: null }
    ];
    for (let i = 2; i < 20; i++) {
        const z = new Float32Array(dim); z[i + 5] = 1;
        stars.push({ chunkId: i + 1, fileId: i + 1, diaryName: '希夷星池簇', sourceFile: `旁支${i}.md`, starName: `旁支${i}`, text: `旁支${i}`, raw: z, x: z, z, zRaw: z, radius: 0.5, leg: null });
    }
    // Flat phatic utterance with low Fisher-Tippett zScore across 20 stars -> contentAlpha < 0.45
    const phaticUser = new Float32Array(dim);
    phaticUser[0] = 0.85;
    for (let k = 5; k <= 24; k++) phaticUser[k] = 0.08;
    const remSq = Math.max(0.01, 1 - phaticUser.reduce((s, v) => s + v * v, 0));
    phaticUser[27] = Math.sqrt(remSq);

    const broadcasts = [];
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-scale-v37.sqlite',
            prepareUnifiedMemoObservation: async () => ({
                enhancedVector: aiVec,
                sourceObservationResult: { matchedTags: [], pyramid: { totalExplainedEnergy: 0.5, depth: 1, levels: [{ tags: [] }] } }
            }),
            releaseMemoObservation: () => true,
            executeNativeRiverQuery: async () => ({
                omega: { omega: 0.4, regime: 'dense', omegaFlow: 0.7 },
                results: [{ chunkId: 2, diaryName: '希夷星池簇', sourceFile: '误触Top1星.md', text: '误触Top1星', score: 0.80 }]
            }),
            getTagVectorByName: async () => null
        },
        pushVcpInfo: (p) => broadcasts.push(p)
    });
    mtm._v3StarPoolCache = new Map([[
        `mock-scale-v37.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);

    await mtm.processMetaThinkingV3(
        '希夷星池簇',
        unit(phaticUser),
        '好的加油',
        '上一轮AI',
        'display',
        false,
        {
            userVector: unit(phaticUser),
            aiVector: unit(aiVec),
            historyAssistantVectors: [unit(aiPrev2)]
        }
    );

    assert.equal(broadcasts.length, 1);
    assert.ok(broadcasts[0].contentAlpha < 0.45);
    assert.equal(broadcasts[0].stars[0].name, '真实盆地星', 'scale-normalized agentAlign (0.35 -> 1.0) must beat hijacked V5 Top-1 when contentAlpha is low');
});

test('V3.7 bugfix #6: clean independent AI observation preserves grounded V5.2 Top-1 over bare cosine & reuses sharpestPrepared by numeric equality', async () => {
    const dim = 28;
    const meanAxis = new Float32Array(dim); meanAxis[0] = 1;
    const aiVec = new Float32Array(dim); aiVec[1] = 1;
    const aiPrev2 = new Float32Array(dim); aiPrev2[1] = 0.72; aiPrev2[2] = 0.69;
    // Star 1 (V5.2 hyperbolic/topology winner): high basin alignment (0.32) + top V5.2 score (0.90)
    // Star 2 (bare cosine winner): slightly higher raw cosine (0.36) but lower V5.2 score (0.65)
    const v5TopRaw = new Float32Array(dim); v5TopRaw[1] = 0.32; v5TopRaw[3] = Math.sqrt(1 - 0.32 * 0.32);
    const cosTopRaw = new Float32Array(dim); cosTopRaw[1] = 0.36; cosTopRaw[4] = Math.sqrt(1 - 0.36 * 0.36);
    const stars = [
        { chunkId: 1, fileId: 1, diaryName: '希夷星池簇', sourceFile: 'V5拓扑胜出星.md', starName: 'V5拓扑胜出星', text: 'V5拓扑胜出星', raw: unit(v5TopRaw), x: unit(v5TopRaw), z: unit(v5TopRaw), zRaw: unit(v5TopRaw), radius: 0.5, leg: null },
        { chunkId: 2, fileId: 2, diaryName: '希夷星池簇', sourceFile: '裸余弦略高星.md', starName: '裸余弦略高星', text: '裸余弦略高星', raw: unit(cosTopRaw), x: unit(cosTopRaw), z: unit(cosTopRaw), zRaw: unit(cosTopRaw), radius: 0.5, leg: null }
    ];
    for (let i = 2; i < 20; i++) {
        const z = new Float32Array(dim); z[i + 5] = 1;
        stars.push({ chunkId: i + 1, fileId: i + 1, diaryName: '希夷星池簇', sourceFile: `旁支${i}.md`, starName: `旁支${i}`, text: `旁支${i}`, raw: z, x: z, z, zRaw: z, radius: 0.5, leg: null });
    }
    const phaticUser = new Float32Array(dim);
    phaticUser[0] = 0.85;
    phaticUser[4] = 0.08;
    for (let k = 6; k <= 12; k++) phaticUser[k] = 0.06;
    phaticUser[27] = Math.sqrt(Math.max(0.01, 1 - phaticUser.reduce((s, v) => s + v * v, 0)));

    const broadcasts = [];
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-indep-v5trust.sqlite',
            prepareUnifiedMemoObservation: async () => ({
                enhancedVector: aiVec,
                sourceObservationResult: { matchedTags: [], pyramid: { totalExplainedEnergy: 0.5, depth: 1, levels: [{ tags: [] }] } }
            }),
            releaseMemoObservation: () => true,
            executeNativeRiverQuery: async () => ({
                omega: { omega: 0.5, regime: 'dense', omegaFlow: 0.7 },
                results: [
                    { chunkId: 1, diaryName: '希夷星池簇', sourceFile: 'V5拓扑胜出星.md', text: 'V5拓扑胜出星', score: 0.90 },
                    { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '裸余弦略高星.md', text: '裸余弦略高星', score: 0.65 }
                ]
            }),
            getTagVectorByName: async () => null
        },
        pushVcpInfo: (p) => broadcasts.push(p)
    });
    mtm._v3StarPoolCache = new Map([[
        `mock-indep-v5trust.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);

    await mtm.processMetaThinkingV3(
        '希夷星池簇',
        unit(phaticUser),
        '好的加油',
        '上一轮AI',
        'display',
        false,
        {
            userVector: unit(phaticUser),
            aiVector: unit(aiVec),
            historyAssistantVectors: [unit(aiPrev2)]
        }
    );

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].independentObservationUsed, true);
    assert.equal(broadcasts[0].stars[0].name, 'V5拓扑胜出星', 'grounded clean V5.2 Top-1 must not be overwritten by bare cosine under independent AI observation');

    // Also verify canReuseSharpest reuses probe observation when colorVector is numerically equal (different Float32Array instance)
    let prepCalls = 0;
    let sharpTagLookups = 0;
    const epaMean = new Float32Array(dim); epaMean[0] = 1;
    const muP = new Float32Array(dim); muP[1] = 1;
    const eD = new Float32Array(dim); eD[2] = 1;
    const eE = new Float32Array(dim); eE[3] = 1;
    // Compound utterance with nonPhaticCentered=true (orthogonal to muP/epaMean):
    // 1) metaStrength >= 0.18 -> generates non-null colorVector (distinct Float32Array on prePolHint vs metaPolarity)
    // 2) nonPhaticCentered && colorVector -> clampContent=false, and out-of-pool top1 < 0.28 -> enters _v3MeasureV52TagSharpness!
    // 3) V5.2 sharpness probe detects strong entity -> lifts preAlpha0 >= 0.55 -> !preferIndependentObs && sameProbeVec -> MUST reuse sharpestPrepared!
    const compoundUser = new Float32Array(dim);
    compoundUser[2] = 0.36;
    compoundUser[26] = Math.sqrt(1 - 0.36 * 0.36);
    const sharpTag = new Float32Array(dim); sharpTag[26] = 1;
    const reuseBroadcasts = [];
    const mtmReuse = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-reuse-sharp.sqlite',
            prepareUnifiedMemoObservation: async ({ vector }) => {
                prepCalls++;
                return {
                    observationHandle: `h-${prepCalls}`,
                    enhancedVector: vector,
                    sourceObservationResult: {
                        epa: { logicDepth: 0.45 },
                        matchedTags: [],
                        pyramid: { totalExplainedEnergy: 0.7, depth: 1, levels: [{ tags: [{ name: 'sharp_entity', contribution: 0.65 }] }] }
                    }
                };
            },
            releaseMemoObservation: () => true,
            executeNativeRiverQuery: async () => ({
                omega: { omega: 0.5, regime: 'dense', omegaFlow: 0.7 },
                results: [{ chunkId: 1, diaryName: '希夷星池簇', sourceFile: 'V5拓扑胜出星.md', text: 'V5拓扑胜出星', score: 0.90 }]
            }),
            getTagVectorByName: async (name) => {
                if (name === 'sharp_entity') sharpTagLookups++;
                return sharpTag;
            }
        },
        pushVcpInfo: (p) => reuseBroadcasts.push(p)
    });
    mtmReuse._v3MetaAxesCache = { muPhatic: muP, eDrill: eD, eEscape: eE };
    mtmReuse._v3EpaMeanCache = new Map([['mock-reuse-sharp.sqlite', { sig: 'mock', checkedAt: Date.now(), value: epaMean }]]);
    mtmReuse._v3StarPoolCache = new Map([[
        `mock-reuse-sharp.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);
    await mtmReuse.processMetaThinkingV3(
        '希夷星池簇',
        unit(compoundUser),
        '深入剖析一下某个冷门工程机制',
        '上一轮AI',
        'display',
        false,
        {
            userVector: unit(compoundUser),
            aiVector: unit(aiVec),
            historyAssistantVectors: [unit(aiPrev2)]
        }
    );
    assert.equal(sharpTagLookups, 1, 'test must genuinely enter _v3MeasureV52TagSharpness probe path');
    assert.equal(reuseBroadcasts[0]?.independentObservationUsed, false, 'rescued entity compound query must not switch to independent AI obs');
    assert.equal(prepCalls, 1, 'numerically identical colorVector must reuse sharpestPrepared instead of running prepareUnifiedMemoObservation twice');
});

test('V3.7 bugfix #7: effectiveMetaStrength uses epaMean-centered phatic baseline, confirmed phatic skips double V5.2 probe, and >=0.45 keeps caller obsQueryVector', async () => {
    // 1. Conversational non-phatic escape directive whose raw pPhatic is inflated by epaMean:
    //    epaMean=[0.85, 0.526, 0, ...], muP=[0.6, 0.8, 0, ...] -> xPhCn ≈ [-0.21, 0.98, 0, ...]
    //    u = [0.80, 0.08, 0.04, 0.35, 0.48, 0] -> raw pPhatic ≈ 0.54 (so raw metaStrength ≈ 0.16 < 0.18),
    //    but centered pPhaticCentered < 0 (non-phatic!), so effectiveMetaStrength ≈ 0.35 >= 0.18 -> emits positive etaMode!
    const mtm = new MetaThinkingManager({});
    const epaMean = unit([0.85, 0.526, 0, 0, 0, 0]);
    const muP = unit([0.60, 0.80, 0, 0, 0, 0]);
    const eD = unit([0, 0, 1, 0, 0, 0]);
    const eE = unit([0, 0, 0, 1, 0, 0]);
    const convEscape = unit([0.78, 0.08, 0.04, 0.45, 0.42, 0]);
    const escPol = mtm._v3EvalMetaPolarity(convEscape, 0.70, { muPhatic: muP, eDrill: eD, eEscape: eE }, { epaMean });
    assert.ok(escPol.pPhaticCentered < 0.36, `expected non-phatic centered score, got ${escPol.pPhaticCentered}`);
    assert.ok(escPol.etaMode > 0.8, `conversational non-phatic escape directive must emit strong positive etaMode, got ${escPol.etaMode}`);

    // 2. Confirmed saturated phatic (pPhaticCentered >= 0.48 & preAlpha0 * phaticDamp < 0.35):
    //    must short-circuit _v3MeasureV52TagSharpness and call prepareUnifiedMemoObservation exactly ONCE!
    const dim = 28;
    const meanAxis = new Float32Array(dim); meanAxis[0] = 1;
    const aiVec = new Float32Array(dim); aiVec[1] = 1;
    const aiPrev2 = new Float32Array(dim); aiPrev2[1] = 0.72; aiPrev2[2] = 0.69;
    const stars = [];
    for (let i = 0; i < 20; i++) {
        const z = new Float32Array(dim); z[i + 1] = 1;
        stars.push({
            chunkId: i + 1,
            fileId: i + 1,
            diaryName: '希夷星池簇',
            sourceFile: `星${i}.md`,
            starName: `星${i}`,
            text: `星${i}`,
            raw: z,
            x: z,
            z,
            zRaw: z,
            radius: 0.5,
            leg: null
        });
    }
    const epa28 = new Float32Array(dim); epa28[0] = 1;
    const muP28 = new Float32Array(dim); muP28[24] = 1;
    const eD28 = new Float32Array(dim); eD28[25] = 1;
    const eE28 = new Float32Array(dim); eE28[26] = 1;
    const strongPhaticUser = new Float32Array(dim);
    strongPhaticUser[0] = 0.40;
    strongPhaticUser[24] = 0.85;
    strongPhaticUser[27] = Math.sqrt(Math.max(0.01, 1 - 0.16 - 0.7225));

    let phaticPrepCalls = 0;
    let phaticTagLookups = 0;
    const phaticBroadcasts = [];
    const mtmPhatic = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-single-pass-phatic.sqlite',
            prepareUnifiedMemoObservation: async ({ vector }) => {
                phaticPrepCalls++;
                return {
                    observationHandle: `p-${phaticPrepCalls}`,
                    enhancedVector: vector,
                    sourceObservationResult: {
                        epa: { logicDepth: 0.1 },
                        matchedTags: [],
                        pyramid: { totalExplainedEnergy: 0.5, depth: 1, levels: [{ tags: [{ name: 't1', contribution: 0.1 }] }] }
                    }
                };
            },
            releaseMemoObservation: () => true,
            executeNativeRiverQuery: async () => ({
                omega: { omega: 0.4, regime: 'dense', omegaFlow: 0.7 },
                results: [{ chunkId: 1, diaryName: '希夷星池簇', sourceFile: '星0.md', text: '星0', score: 0.85 }]
            }),
            getTagVectorByName: async () => {
                phaticTagLookups++;
                return null;
            }
        },
        pushVcpInfo: (p) => phaticBroadcasts.push(p)
    });
    mtmPhatic._v3MetaAxesCache = { muPhatic: muP28, eDrill: eD28, eEscape: eE28 };
    mtmPhatic._v3EpaMeanCache = new Map([['mock-single-pass-phatic.sqlite', { sig: 'mock', checkedAt: Date.now(), value: epa28 }]]);
    mtmPhatic._v3StarPoolCache = new Map([[
        `mock-single-pass-phatic.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);
    await mtmPhatic.processMetaThinkingV3(
        '希夷星池簇',
        unit(Array.from({ length: dim }, (_, d) => 0.7 * strongPhaticUser[d] + 0.3 * aiVec[d])),
        '哈哈太棒了加油继续',
        '上一轮AI',
        'display',
        false,
        {
            userVector: unit(strongPhaticUser),
            aiVector: unit(aiVec),
            historyAssistantVectors: [unit(aiPrev2)]
        }
    );
    assert.equal(phaticBroadcasts[0]?.independentObservationUsed, true);
    assert.equal(phaticTagLookups, 0, 'confirmed saturated phatic must short-circuit _v3MeasureV52TagSharpness');
    assert.equal(phaticPrepCalls, 1, 'confirmed saturated phatic must run prepareUnifiedMemoObservation once, not twice');

    // 3a. In-pool new topic (top1 >= 0.28, skips sharpness probe, preContentAlpha >= 0.45):
    //     must preserve caller's 70/30 effectiveVector instead of diluting obsQueryVector down toward 55/45!
    const inPoolTopic = new Float32Array(dim);
    inPoolTopic[5] = 0.65;
    inPoolTopic[27] = Math.sqrt(1 - 0.65 * 0.65); // strong peak on 星4 (dim 5), orthogonal to aiVec (dim 1)
    const callerMixInPool = unit(Array.from({ length: dim }, (_, d) => 0.7 * inPoolTopic[d] + 0.3 * aiVec[d]));
    let observedInPoolVec = null;
    let inPoolPrepCalls = 0;
    const mtmJumpObs = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-jump-obs-nodilute.sqlite',
            prepareUnifiedMemoObservation: async ({ vector }) => {
                inPoolPrepCalls++;
                observedInPoolVec = vector;
                return {
                    observationHandle: `j-${inPoolPrepCalls}`,
                    enhancedVector: vector,
                    sourceObservationResult: {
                        epa: { logicDepth: 0.2 },
                        matchedTags: [],
                        pyramid: { totalExplainedEnergy: 0.5, depth: 1, levels: [{ tags: [] }] }
                    }
                };
            },
            releaseMemoObservation: () => true,
            executeNativeRiverQuery: async () => ({
                omega: { omega: 0.4, regime: 'dense', omegaFlow: 0.7 },
                results: [{ chunkId: 5, diaryName: '希夷星池簇', sourceFile: '星4.md', text: '星4', score: 0.85 }]
            }),
            getTagVectorByName: async () => null
        },
        pushVcpInfo: () => {}
    });
    mtmJumpObs._v3MetaAxesCache = { muPhatic: muP28, eDrill: eD28, eEscape: eE28 };
    mtmJumpObs._v3EpaMeanCache = new Map([['mock-jump-obs-nodilute.sqlite', { sig: 'mock', checkedAt: Date.now(), value: epa28 }]]);
    mtmJumpObs._v3StarPoolCache = new Map([[
        `mock-jump-obs-nodilute.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);
    await mtmJumpObs.processMetaThinkingV3(
        '希夷星池簇',
        callerMixInPool,
        '切换到全新技术领域问题',
        '上一轮AI',
        'display',
        false,
        {
            userVector: inPoolTopic,
            aiVector: aiVec,
            historyAssistantVectors: [unit(aiPrev2)],
            getObservation: async () => null
        }
    );
    assert.equal(inPoolPrepCalls, 1);
    const cosToCallerMix = mtmJumpObs._v3Dot(observedInPoolVec, callerMixInPool);
    assert.ok(cosToCallerMix > 0.9999, `in-pool high-content (>=0.45) standalone query must preserve caller 70/30 effectiveVector, got cos=${cosToCallerMix}`);

    // 3b. Out-of-pool non-phatic new topic (top1 < 0.28 -> sharpness probe runs, non-phatic floor lifts preContentAlpha=0.55):
    //     reuses sharpestPrepared in a single Rust pass without diluting back toward old aiVec!
    inPoolPrepCalls = 0;
    observedInPoolVec = null;
    const outOfPoolTopic = new Float32Array(dim);
    outOfPoolTopic[27] = 1;
    const callerMixOutOfPool = unit(Array.from({ length: dim }, (_, d) => 0.7 * outOfPoolTopic[d] + 0.3 * aiVec[d]));
    await mtmJumpObs.processMetaThinkingV3(
        '希夷星池簇',
        callerMixOutOfPool,
        '冷门报错 ECONNRESET',
        '上一轮AI',
        'display',
        false,
        {
            userVector: outOfPoolTopic,
            aiVector: aiVec,
            historyAssistantVectors: [unit(aiPrev2)],
            getObservation: async () => null
        }
    );
    assert.equal(inPoolPrepCalls, 1, 'out-of-pool non-phatic topic must finish in a single Rust observation pass');
    assert.ok(mtmJumpObs._v3Dot(observedInPoolVec, outOfPoolTopic) > 0.85, 'single-pass observation must stay anchored to the new topic vector');
});

test('V3.8 pure-tensor unified epaMean QR closure satisfies Parseval identity and prevents false etaMode on analytical essays', () => {
    const mtm = new MetaThinkingManager({});
    const epaMean = unit([1, 0, 0, 0, 0, 0]);
    const muP = unit([0.3, 0.954, 0, 0, 0, 0]);
    const eD = unit([0.3, 0, 0.954, 0, 0, 0]);
    const eE = unit([0.3, 0, 0, 0.954, 0, 0]);
    const axes = { muPhatic: muP, eDrill: eD, eEscape: eE };

    // 1. Analytical technical essay with slight uncentered drill alignment (below q10Mt0) must emit etaMode = 0 & colorVector = null
    const essay = unit([0.25, 0.05, 0.14, 0.02, 0.95, 0.05]);
    const essayPol = mtm._v3EvalMetaPolarity(essay, 0.85, axes, { epaMean });
    assert.ok(Math.abs((essayPol.qrEPh + essayPol.qrEMeta + essayPol.qrEColor) - 1.0) < 1e-6, 'QR energies must strictly sum to 1');
    assert.equal(essayPol.etaMode, 0, 'analytical essay with low qrEMeta must not trigger spurious drill etaMode');
    assert.equal(essayPol.colorVector, null, 'analytical essay must not be stripped by meta subspace');

    // 2. Pure escape directive (high qrEMeta, low qrEColor < 0.75) triggers isMetaCmd & strong positive etaMode
    const pureEsc = unit([0.2, 0.05, 0.05, 0.70, 0.68, 0]);
    const escPol = mtm._v3EvalMetaPolarity(pureEsc, 0.40, axes, { top1: 0.20, epaMean });
    assert.ok(Math.abs((escPol.qrEPh + escPol.qrEMeta + escPol.qrEColor) - 1.0) < 1e-6);
    assert.equal(escPol.isMetaCmd, true);
    assert.equal(escPol.clampContent, true);
    assert.ok(escPol.etaMode > 0.85, `expected strong positive escape etaMode, got ${escPol.etaMode}`);

    // 3. Pure phatic dominates meta energy -> strong phaticDamp & zero etaMode
    const phatic = unit([0.2, 0.75, 0.15, 0.10, 0.60, 0]);
    const phPol = mtm._v3EvalMetaPolarity(phatic, 0.35, axes, { top1: 0.18, epaMean });
    assert.equal(phPol.etaMode, 0);
    assert.ok(phPol.phaticDamp < 0.30, `expected strong phatic damping, got ${phPol.phaticDamp}`);
});

test('V3.8 pure-tensor 3-step Gram simplex volume V3 detects non-coplanar stagnation and ping-pong cleanly', () => {
    const mtm = new MetaThinkingManager({});
    // Normal 3D progression: large simplex volume V3 > 0.35 -> NOT stagnant
    const n3 = unit([1, 0, 0, 0, 0]);
    const n2 = unit([0.72, 0.69, 0, 0, 0]);
    const n1 = unit([0.45, 0.60, 0.66, 0, 0]);
    const kinNormal = mtm._v3ComputeAgentKinematics([n3, n2], n1, null, null, 0.85);
    assert.ok(kinNormal.simplexVolume3 > 0.40, `expected normal V3 > 0.40, got ${kinNormal.simplexVolume3}`);
    assert.equal(kinNormal.stagnant, false);

    // Non-coplanar 3D stagnation: low V3 <= 0.20 with high cSelf -> stagnant & positive mEndo
    const s3 = unit([1, 0, 0, 0, 0]);
    const s2 = unit([0.93, 0.35, 0.10, 0, 0]);
    const s1 = unit([0.92, 0.35, 0.10, 0.14, 0]);
    const kinStag = mtm._v3ComputeAgentKinematics([s3, s2], s1, null, null, 0.85);
    assert.ok(kinStag.simplexVolume3 <= 0.15, `expected collapsed V3 <= 0.15, got ${kinStag.simplexVolume3}`);
    assert.equal(kinStag.stagnant, true);
    assert.ok(kinStag.mEndo > 0.5);

    // Non-coplanar 3D ping-pong A -> B -> A + small 3D noise: low V3 <= 0.20 & returnSim >= 0.78 -> stagnant
    const p3 = unit([1, 0, 0, 0, 0]);
    const p2 = unit([0.1, 0.99, 0, 0, 0]);
    const p1 = unit([0.96, 0.12, 0.16, 0, 0]);
    const kinPP = mtm._v3ComputeAgentKinematics([p3, p2], p1, null, null, 0.85);
    assert.ok(kinPP.simplexVolume3 <= 0.20, `expected ping-pong V3 <= 0.20, got ${kinPP.simplexVolume3}`);
    assert.equal(kinPP.stagnant, true);
    assert.ok(kinPP.mEndo > 0.35);
});

test('V3.9 pure-tensor single-track QR stripping eliminates gray band and uses 2/3:1/3 formula | M accounting without dead wPmi', () => {
    const mtm = new MetaThinkingManager({});
    // 1. Formula | M fallback uses exact 2/3 : 1/3 ratio with zero dead wPmi
    const fNoM = mtm._formatV3Formula([
        { starName: '甲' }, { starName: '乙' }, { starName: '丙', torqueDeficit: 0.50, diaryBridge: 0.90 }
    ]);
    assert.ok(!fNoM.includes('| ℳ'), '1/3 * 0.90 = 0.30 < 2/3 * 0.50 = 0.333 must not emit | M');
    const fWithM = mtm._formatV3Formula([
        { starName: '甲' }, { starName: '乙' }, { starName: '丙', torqueDeficit: 0.30, diaryBridge: 0.70 }
    ]);
    assert.ok(fWithM.includes('| ℳ'), '1/3 * 0.70 = 0.233 >= 2/3 * 0.30 = 0.20 must emit | M');

    // 2. C4 same-space epaMean QR stripping eliminates 0.058..0.095 gray band and round-trips via P_beta^{-1}
    const epaMean = unit([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const muP = unit([0.3, 0.954, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const eD = unit([0.3, 0, 0.954, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const eE = unit([0.3, 0, 0, 0.954, 0, 0, 0, 0, 0, 0, 0, 0]);
    const axes = { muPhatic: muP, eDrill: eD, eEscape: eE };
    const c4Gray = unit([0.2, 0.02, 0.05, 0.27, 0, 0.94, 0, 0, 0, 0, 0, 0]);
    const pol = mtm._v3EvalMetaPolarity(c4Gray, 0.85, axes, { epaMean });
    assert.ok(pol.qrEMeta >= 0.058 && pol.qrEMeta < 0.095, `expected qrEMeta in old gray band, got ${pol.qrEMeta}`);
    assert.ok(pol.colorVector, 'C4 in [0.058, 0.095) must no longer be skipped unstripped');
    const xCleaned = mtm._v3ToTagGlobalSpace(pol.colorVector, epaMean);
    assert.ok(xCleaned[5] > 0.98, `expected clean entity alignment > 0.98 after same-space stripping, got ${xCleaned[5]}`);
});

test('V3.9 retires negative-gain rust-dual-field, blocks C7 tech-praise trap via epaMean L0 shell, and releases sharpestPrepared on Abort', async () => {
    const dim = 24;
    const basisVec = (idx) => {
        const v = new Float32Array(dim);
        v[idx] = 1;
        return v;
    };
    const epaMean = basisVec(23);
    const muP = basisVec(20);
    const eD = basisVec(21);
    const eE = basisVec(22);
    const stars = Array.from({ length: 20 }, (_, i) => {
        const v = basisVec(i);
        return {
            chunkId: i + 1,
            fileId: i + 1,
            diaryName: '希夷星池簇',
            sourceFile: `星卡${i}.md`,
            starName: `星卡${i}`,
            text: `星卡${i}`,
            raw: v,
            x: v,
            z: v,
            zRaw: v,
            radius: 0.63
        };
    });
    const starPool = {
        stars,
        byChunkId: new Map(stars.map(s => [s.chunkId, s])),
        byStarName: new Map(stars.map(s => [s.starName, s])),
        bySlot: new Map(),
        starSlots: new Set(),
        starMeanAxis: null,
        betaStar: 0.85,
        meanCritAngle: 0.784,
        meanRho: 1.492,
        orthTopScale: 0.22,
        manifoldMissingStars: 0,
        avgStarInDeg: 32,
        epaMean
    };

    const aiBasin = unit([0.85, 0.52, ...new Array(dim - 2).fill(0)]);
    const broadcasts = [];
    let jsTransportLoadCalls = 0;
    let sharedObsCalled = 0;
    const techTagVec = basisVec(4);
    // C7 tech-praise vector: mostly tech entity (dim[4]=0.89) + phatic praise wrapper (dim[20]=0.42 -> rawEPh≈0.176, diluted),
    // but stripping techTagVec in epaMean space exposes pure phatic shell (shellEPh > 0.85)!
    const c7TrapVec = unit(Array.from({ length: dim }, (_, i) => {
        if (i === 4) return 0.89;
        if (i === 20) return 0.42;
        if (i === 19) return 0.16;
        return 0;
    }));

    const releasedHandles = [];
    let prepSeq = 0;
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: ':memory:',
            async prepareUnifiedMemoObservation({ vector }) {
                prepSeq++;
                return {
                    observationHandle: `obs-${prepSeq}`,
                    enhancedVector: vector,
                    sourceObservationResult: {
                        epa: { logicDepth: 0.45, inDomainGate: 0.85 },
                        pyramid: {
                            depth: 1,
                            totalExplainedEnergy: 0.80,
                            levels: [{ energyExplained: 0.80, tags: [{ name: '硬核技术词', contribution: 0.82 }] }]
                        }
                    }
                };
            },
            releaseMemoObservation(obs) {
                if (obs?.observationHandle) releasedHandles.push(obs.observationHandle);
            },
            async getTagVectorByName(name) {
                return name === '硬核技术词' ? techTagVec : null;
            },
            async executeNativeRiverQuery() {
                return {
                    results: stars.slice(0, 6).map((s, idx) => ({
                        chunkId: s.chunkId,
                        diaryName: s.diaryName,
                        sourceFile: s.sourceFile,
                        text: s.text,
                        score: 0.90 - idx * 0.05
                    })),
                    diagnostics: { degraded: false }
                };
            }
        },
        pushVcpInfo(info) { broadcasts.push(info); }
    });
    mtm._v3MetaAxesCache = { muPhatic: muP, eDrill: eD, eEscape: eE };
    mtm._v3LoadGlobalManifold = () => null;
    mtm._v3LoadStarPoolCache = () => ({ ...starPool, epaMean });
    mtm._v3LoadSharedTransportCache = () => {
        jsTransportLoadCalls++;
        return null;
    };

    // 1. C7 trap must stay below 0.45 contentAlpha, skip poisoned shared observation, and never invoke rust-dual-field/sharedTransport
    await mtm.processMetaThinkingV3(
        '希夷星池簇',
        aiBasin,
        '绝了绝了助手把硬核技术词讲得太丝滑了继续！',
        '',
        'c7-test',
        false,
        {
            userVector: c7TrapVec,
            aiVector: aiBasin,
            historyAssistantVectors: [aiBasin, aiBasin],
            getObservation: async () => {
                sharedObsCalled++;
                return { enhancedVector: c7TrapVec };
            }
        }
    );
    assert.equal(jsTransportLoadCalls, 0);
    assert.equal(sharedObsCalled, 0, 'C7 tech-praise trap must NOT penetrate shared ::RiverMemo observation');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].dualTransferSource, 'retired');
    assert.ok(broadcasts[0].contentAlpha < 0.45, `C7 contentAlpha must be suppressed < 0.45, got ${broadcasts[0].contentAlpha}`);
    assert.equal(broadcasts[0].independentObservationUsed, true);

    // 2. Mid-probe Abort must still release sharpestPrepared handle (zero MemoRuntime handle leak!)
    const ac = new AbortController();
    mtm.ragPlugin.vectorDBManager.prepareUnifiedMemoObservation = async ({ vector }) => {
        prepSeq++;
        ac.abort();
        return {
            observationHandle: `leaked-guard-${prepSeq}`,
            enhancedVector: vector,
            sourceObservationResult: {
                pyramid: { levels: [{ tags: [{ name: '硬核技术词', contribution: 0.8 }] }] }
            }
        };
    };
    await assert.rejects(
        () => mtm.processMetaThinkingV3('希夷星池簇', aiBasin, 'mid-abort', '', 'abort', false, {
            signal: ac.signal,
            userVector: c7TrapVec,
            aiVector: aiBasin,
            historyAssistantVectors: [aiBasin, aiBasin]
        }),
        err => err?.name === 'AbortError'
    );
    assert.ok(releasedHandles.includes(`leaked-guard-${prepSeq}`), 'sharpestPrepared must be released even when Abort fires during probe');

    // 3. _v3MeasureV52TagSharpness must return entityEvidence=0 (not 1.0) on transient error
    const errRes = await mtm._v3MeasureV52TagSharpness({
        prepareUnifiedMemoObservation: async () => { throw new Error('SQLITE_BUSY'); }
    }, c7TrapVec, 'err-test', epaMean);
    assert.equal(errRes.entityEvidence, 0);

    // 4. Schur-complement partialPh separates tech-wrapped phatic (even when rawEPh < 0.155) from pure cold tech errors
    const techA = unit(Array.from({ length: dim }, (_, i) => {
        if (i === 4) return 0.94;
        if (i === 20) return 0.34;
        return 0;
    })); // tech tag with minor phatic overlap
    const techWrapped = unit(Array.from({ length: dim }, (_, i) => {
        if (i === 4) return 0.80;
        if (i === 20) return 0.52;
        if (i === 18) return 0.30;
        return 0;
    }));
    const pureCold = unit(Array.from({ length: dim }, (_, i) => {
        if (i === 4) return 0.94;
        if (i === 20) return 0.34;
        return 0;
    }));
    const stripPraise = mtm._v3StripBasisInEpaSpace(techWrapped, [techA], epaMean, 0.05, [muP]);
    const stripCold = mtm._v3StripBasisInEpaSpace(pureCold, [techA], epaMean, 0.05, [muP]);
    assert.ok(stripPraise.partialPh !== null && stripPraise.partialPh > 0.044, `tech-wrapped praise must retain partialPh > 0.044, got ${stripPraise.partialPh}`);
    assert.ok(stripCold.vector === null || (stripCold.partialPh ?? 0) < 0.02, `pure cold error aligned with tech tag must have partialPh < 0.02, got ${stripCold.partialPh}`);
});

test('V3.8+ unified qrEPh boundary eliminates 0.133~0.155 gray-band mismatch with _v3EvalMetaPolarity', async () => {
    const dim = 24;
    const basisVec = (idx) => {
        const v = new Float32Array(dim);
        v[idx] = 1;
        return v;
    };
    const epaMean = basisVec(23);
    const muP = basisVec(20);
    const eD = basisVec(21);
    const eE = basisVec(22);
    const axes = { muPhatic: muP, eDrill: eD, eEscape: eE };

    const mtm = new MetaThinkingManager({});
    // Under continuous zero-bias sPh (zero hard-step at 0.155): moderate qrEPh=0.145 stays lightly damped (>0.75) while strong phatic qrEPh=0.45 damps heavily (<0.30)
    const grayBandU = unit(Array.from({ length: dim }, (_, i) => {
        if (i === 20) return Math.sqrt(0.145);
        if (i === 0) return Math.sqrt(1 - 0.145);
        return 0;
    }));
    const polGray = mtm._v3EvalMetaPolarity(grayBandU, 0.70, axes, { epaMean });
    assert.ok(Math.abs(polGray.qrEPh - 0.145) < 1e-4, `expected qrEPh≈0.145, got ${polGray.qrEPh}`);
    assert.ok(polGray.phaticDamp > 0.65, `moderate qrEPh=0.145 must stay lightly damped (>0.65), got ${polGray.phaticDamp}`);

    const phaticU = unit(Array.from({ length: dim }, (_, i) => {
        if (i === 20) return Math.sqrt(0.45);
        if (i === 0) return Math.sqrt(1 - 0.45);
        return 0;
    }));
    const polPh = mtm._v3EvalMetaPolarity(phaticU, 0.40, axes, { epaMean });
    assert.ok(polPh.qrEPh >= 0.40 && polPh.phaticDamp < 0.30, `expected strong phatic damping for qrEPh=${polPh.qrEPh}, got ${polPh.phaticDamp}`);
});

test('V3.9 Item 1: same-topic probe keeps 70/30 AI context instead of silently dropping rawPrevAiVec via sharpestPrepared', async () => {
    const dim = 28;
    const meanAxis = new Float32Array(dim); meanAxis[0] = 1;
    const epaMean = new Float32Array(dim); epaMean[0] = 1;
    const muP = new Float32Array(dim); muP[1] = 1;
    const eD = new Float32Array(dim); eD[2] = 1;
    const eE = new Float32Array(dim); eE[3] = 1;
    const aiVec = new Float32Array(dim); aiVec[25] = 1;
    const aiPrev2 = new Float32Array(dim); aiPrev2[25] = 0.85; aiPrev2[24] = 0.526;

    // Same-topic follow-up: dot(user, aiVec) = 0.78 >= 0.25, preQrEPh = 0.075 (at null mean so sharpness probe runs cleanly
    // without false phatic shell damping), and out-of-pool top1 -> must keep 70/30 AI context instead of dropping rawPrevAiVec!
    const sameTopicUser = new Float32Array(dim);
    sameTopicUser[1] = Math.sqrt(0.075);
    sameTopicUser[25] = 0.78;
    sameTopicUser[26] = Math.sqrt(Math.max(0, 1 - 0.075 - 0.78 * 0.78));
    const expectedMix = unit(Array.from({ length: dim }, (_, i) => 0.7 * sameTopicUser[i] + 0.3 * aiVec[i]));

    const stars = Array.from({ length: 20 }, (_, i) => {
        const z = new Float32Array(dim);
        z[i + 4] = 1;
        return {
            chunkId: i + 1,
            fileId: i + 1,
            diaryName: '希夷星池簇',
            sourceFile: `星${i}.md`,
            starName: `星${i}`,
            text: `星${i}`,
            raw: z,
            x: z,
            z,
            zRaw: z,
            radius: 0.5
        };
    });

    const observedVectors = [];
    const released = [];
    let seq = 0;
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-same-topic-reuse.sqlite',
            prepareUnifiedMemoObservation: async ({ vector }) => {
                seq++;
                observedVectors.push(vector);
                return {
                    observationHandle: `obs-st-${seq}`,
                    enhancedVector: vector,
                    sourceObservationResult: {
                        epa: { logicDepth: 0.45, inDomainGate: 0.85 },
                        matchedTags: [],
                        pyramid: {
                            depth: 1,
                            totalExplainedEnergy: 0.75,
                            levels: [{ energyExplained: 0.75, tags: [{ name: 'same_topic_tag', contribution: 0.72 }] }]
                        }
                    }
                };
            },
            releaseMemoObservation: (obs) => {
                if (obs?.observationHandle) released.push(obs.observationHandle);
                return true;
            },
            executeNativeRiverQuery: async ({ vector }) => {
                observedVectors.push(vector);
                return {
                    omega: { omega: 0.5, regime: 'dense', omegaFlow: 0.7 },
                    results: [{ chunkId: 1, diaryName: '希夷星池簇', sourceFile: '星0.md', text: '星0', score: 0.90 }]
                };
            },
            getTagVectorByName: async () => {
                const tv = new Float32Array(dim);
                tv[26] = 1;
                return tv;
            }
        },
        pushVcpInfo: () => {}
    });
    mtm._v3MetaAxesCache = { muPhatic: muP, eDrill: eD, eEscape: eE };
    mtm._v3EpaMeanCache = new Map([['mock-same-topic-reuse.sqlite', { sig: 'mock', checkedAt: Date.now(), value: epaMean }]]);
    mtm._v3StarPoolCache = new Map([[
        `mock-same-topic-reuse.sqlite\0希夷星池簇`,
        {
            versionKey: 'no-manifold|mock',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            meanCritAngle: 0.784,
            meanRho: 1.492,
            manifoldMissingStars: 0,
            avgStarInDeg: 32
        }
    ]]);

    await mtm.processMetaThinkingV3(
        '希夷星池簇',
        expectedMix,
        '继续顺着刚才的冷门机制往下问',
        '上一轮AI',
        'display',
        false,
        {
            userVector: unit(sameTopicUser),
            aiVector: unit(aiVec),
            historyAssistantVectors: [unit(aiPrev2)]
        }
    );

    const step1QueryVec = observedVectors[observedVectors.length - 1];
    assert.ok(
        mtm._v3Dot(step1QueryVec, expectedMix) > 0.9999,
        'same-topic continuation (dot >= 0.25) must preserve 70/30 AI context in Step 1 rather than dropping rawPrevAiVec'
    );
    assert.equal(released.length, seq, 'probe observation and owned observation must both be released');
});

test('V3.9 Item 4: end-to-end RAGDiaryPlugin + OneRing + ContextVectorManager isolates C7 praise and preserves V3 placement', async () => {
    const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
    const oneRing = require('../Plugin/OneRing/OneRing');
    const ContextVectorManager = require('../Plugin/RAGDiaryPlugin/ContextVectorManager');
    const tray = require('../Plugin/MemoryThinkingTray/MemoryThinkingTray');

    const dim = 24;
    const basis = (idx) => {
        const v = new Float32Array(dim);
        v[idx] = 1;
        return v;
    };
    const epaMean = basis(23);
    const muP = basis(20);
    const eD = basis(21);
    const eE = basis(22);
    const aiBasin = unit([0.85, 0.52, ...new Array(dim - 2).fill(0)]);
    const techTag = basis(4);
    const c7Trap = unit(Array.from({ length: dim }, (_, i) => {
        if (i === 4) return 0.89;
        if (i === 20) return 0.42;
        if (i === 19) return 0.16;
        return 0;
    }));
    const stars = Array.from({ length: 20 }, (_, i) => {
        const v = basis(i);
        return {
            chunkId: i + 1,
            fileId: i + 1,
            diaryName: '希夷星池簇',
            sourceFile: `星${i}.md`,
            starName: `星${i}`,
            text: `星${i}`,
            raw: v,
            x: v,
            z: v,
            zRaw: v,
            radius: 0.63
        };
    });

    const rag = new ragSingleton.constructor();
    const embedByText = new Map([
        ['第一轮架构提问', basis(0)],
        ['第一轮AI架构解析', aiBasin],
        ['绝了绝了卡尔曼滤波讲得太丝滑继续', c7Trap]
    ]);
    rag.getSingleEmbeddingCached = async (text) => embedByText.get(String(text || '').trim()) || aiBasin;
    rag._getEmbeddingFromCacheOnly = (text) => embedByText.get(String(text || '').trim()) || null;
    rag.contextVectorManager = new ContextVectorManager(rag);
    rag.timeParser = { parse: () => [] };
    rag.ragParams = { RAGDiaryPlugin: {} };
    rag._calculateDynamicParams = async () => ({ k: 3, tagWeight: 0.15, tagTruncationRatio: 0.5, metrics: {} });

    const broadcasts = [];
    rag.pushVcpInfo = (info) => broadcasts.push(info);
    rag.vectorDBManager = {
        dbPath: ':memory:',
        async prepareUnifiedMemoObservation({ vector }) {
            return {
                observationHandle: 'e2e-obs-1',
                enhancedVector: vector,
                sourceObservationResult: {
                    epa: { logicDepth: 0.45, inDomainGate: 0.85 },
                    matchedTags: [],
                    pyramid: {
                        depth: 1,
                        totalExplainedEnergy: 0.80,
                        levels: [{ energyExplained: 0.80, tags: [{ name: '卡尔曼滤波', contribution: 0.82 }] }]
                    }
                }
            };
        },
        releaseMemoObservation: () => true,
        async executeNativeRiverQuery() {
            return {
                omega: { omega: 0.5, regime: 'dense', omegaFlow: 0.7 },
                results: stars.slice(0, 4).map((s, idx) => ({
                    chunkId: s.chunkId,
                    diaryName: s.diaryName,
                    sourceFile: s.sourceFile,
                    text: s.text,
                    score: 0.90 - idx * 0.05
                })),
                diagnostics: { degraded: false }
            };
        },
        async getTagVectorByName(name) {
            return name === '卡尔曼滤波' ? techTag : null;
        }
    };

    const mtm = new MetaThinkingManager(rag);
    mtm._v3MetaAxesCache = { muPhatic: muP, eDrill: eD, eEscape: eE };
    mtm._v3LoadGlobalManifold = () => null;
    mtm._v3LoadStarPoolCache = () => ({
        versionKey: 'e2e-mock',
        manifoldKey: 'no-manifold',
        checkedAt: Date.now(),
        stars,
        byChunkId: new Map(stars.map(s => [s.chunkId, s])),
        byStarName: new Map(stars.map(s => [s.starName, s])),
        bySlot: new Map(),
        starSlots: new Set(),
        starMeanAxis: null,
        betaStar: 0.85,
        meanCritAngle: 0.784,
        meanRho: 1.492,
        orthTopScale: 0.22,
        manifoldMissingStars: 0,
        avgStarInDeg: 32,
        epaMean
    });
    rag.metaThinkingManager = mtm;

    const messages = [
        { role: 'system', content: '设定\n<---VCP记忆思维区Start--->前文\n[[VCP元思考V3]]\n后文<---VCP记忆思维区End--->' },
        { role: 'user', content: '第一轮架构提问' },
        { role: 'assistant', content: '第一轮AI架构解析' },
        { role: 'user', content: '绝了绝了卡尔曼滤波讲得太丝滑继续' }
    ];
    const moved = await tray.processMessages(messages, { MEMORY_THINKING_TRAY_DEPTH: 2 });
    const processed = await rag._processMessagesWithMemoScope(moved, {});
    assert.equal(processed.length, moved.length);
    assert.equal(processed[0].content, moved[0].content);
    assert.match(processed[2].content, /^\[系统提示:\]\n前文\n\$\$[\s\S]+\$\$\n后文$/);
    assert.deepEqual(processed.slice(3), messages.slice(2));
    assert.equal(broadcasts.length, 1);
    assert.ok(broadcasts[0].contentAlpha < 0.45, `E2E C7 trap must clamp contentAlpha < 0.45, got ${broadcasts[0].contentAlpha}`);
    assert.equal(broadcasts[0].independentObservationUsed, true);

    // The tray reaches the model in its original position but is not a conversation record for either strategy.
    const inferred = oneRing._createServerInferredTimelineStrategy();
    const view = inferred.buildWorkingView(processed);
    assert.deepEqual(view.workingToOriginalIndex, [0, 1, 3, 4]);
    assert.equal(view.removedItems[0].reason, 'system-user');
    assert.deepEqual(inferred.restoreWorkingViewToOriginalMessages(processed, view.workingMessages, view), processed);

    const raw = oneRing._createRawClientTimelineStrategy();
    const contextMap = raw._buildClientContextMap(processed, '测试用户', '测试助手');
    assert.equal(contextMap.records[2].kind, 'side-pseudo-system-user');
    assert.equal(contextMap.records[2].dbText, '');
    assert.deepEqual(contextMap.contextRecords.map(record => record.rawIndex), [1, 3, 4]);
});

test('V3.10 redline contracts: C7 directional praise, C4 r_meta decoupling, V3 geodesic progression, multi-chunk, quantile radius, dimMismatch, RAGDiary handoff', async () => {
    const dim = 28;
    const basis = (idx) => {
        const v = new Float32Array(dim);
        v[idx] = 1;
        return v;
    };
    const epaMean = basis(27);
    const muP = basis(20);
    const muD = basis(21);
    const muE = basis(22);
    const axes = { muPhatic: muP, muDrill: muD, muEscape: muE, eDrill: muD, eEscape: muE };

    const mtm = new MetaThinkingManager({});
    assert.equal(mtm._v3ExtractDualFieldNetTransfer, undefined, 'retired rust-dual-field bridge must be removed');
    assert.equal(mtm._v3ComputeStatTransportBridge, undefined, 'retired JS transport bridge must be removed');
    assert.equal(mtm._v3LoadSharedTransportCache, undefined, 'retired sharedTransport loader must be removed');

    // 1. C7 long directional tech-praise: rawQrEPh ≈ 0.116 < 0.14, rawQrEMeta ≈ 0.090 >= 0.058,
    //    stripping tech tag leaves phatic+directional control shell -> MUST detect isTechWrappedPhatic & keep contentAlpha < 0.45!
    const techTag = basis(4);
    const dirC7Arr = new Float32Array(dim);
    dirC7Arr[4] = 0.87;
    dirC7Arr[20] = 0.34;
    dirC7Arr[21] = 0.30;
    dirC7Arr[19] = 0.19;
    const dirC7 = unit(dirC7Arr);
    const aiVec = basis(1);
    const stars = Array.from({ length: 20 }, (_, i) => {
        const v = basis(i);
        return { chunkId: i + 1, fileId: i + 1, diaryName: '希夷星池簇', sourceFile: `星${i}.md`, starName: `星${i}`, text: `星${i}`, raw: v, x: v, z: v, zRaw: v, radius: 0.63 };
    });
    let sharedCalled = 0;
    const c7Broadcasts = [];
    const mtmC7 = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: ':memory:',
            async prepareUnifiedMemoObservation({ vector }) {
                return {
                    observationHandle: 'c7-dir-1',
                    enhancedVector: vector,
                    sourceObservationResult: {
                        epa: { logicDepth: 0.45, inDomainGate: 0.85, outOfDomain: 0.30 },
                        pyramid: {
                            depth: 1,
                            totalExplainedEnergy: 0.80,
                            features: { coherence: 0.8 },
                            levels: [{ energyExplained: 0.80, handshakeFeatures: { patternStrength: 0.7, noiseSignal: 0.1 }, tags: [{ name: '技术实体', contribution: 0.85 }] }]
                        }
                    }
                };
            },
            releaseMemoObservation: () => true,
            async getTagVectorByName(name) { return name === '技术实体' ? techTag : null; },
            async executeNativeRiverQuery() {
                return { omega: { omega: 0.5, regime: 'dense' }, results: [{ chunkId: 5, diaryName: '希夷星池簇', sourceFile: '星4.md', text: '星4', score: 0.90 }] };
            }
        },
        pushVcpInfo: (p) => c7Broadcasts.push(p)
    });
    mtmC7._v3MetaAxesCache = axes;
    mtmC7._v3LoadGlobalManifold = () => null;
    mtmC7._v3LoadStarPoolCache = () => ({
        versionKey: 'c7-dir', manifoldKey: 'none', checkedAt: Date.now(), stars,
        byChunkId: new Map(stars.map(s => [s.chunkId, s])),
        byStarName: new Map(stars.map(s => [s.starName, s])),
        bySlot: new Map(), starSlots: new Set(), starMeanAxis: null, betaStar: 0.85, orthTopScale: 0.22, epaMean
    });
    await mtmC7.processMetaThinkingV3('希夷星池簇', aiVec, '把技术实体串得太丝滑了，按此方向继续推演即可！', '', 'c7-dir', false, {
        userVector: dirC7, aiVector: aiVec, historyAssistantVectors: [aiVec, aiVec],
        getObservation: async () => { sharedCalled++; return { enhancedVector: dirC7 }; }
    });
    assert.equal(sharedCalled, 0, 'C7 tech-praise with directional words must NEVER penetrate shared observation');
    assert.ok(c7Broadcasts[0].contentAlpha < 0.45, `expected C7 directional praise alpha < 0.45, got ${c7Broadcasts[0].contentAlpha}`);
    assert.equal(axes._qrUnifiedByEpa, undefined, 'QR cache must live on MetaThinkingManager instance, not mutate shared axes');

    // 2. C4 decoupling via r_meta = E_meta / (E_meta + E_color): strips colorVector cleanly while keeping etaMode = 0
    const c4Arr = new Float32Array(dim);
    c4Arr[5] = 0.92;
    c4Arr[21] = 0.30;
    c4Arr[22] = 0.05;
    const c4Sample = unit(c4Arr);
    const c4Pol = mtm._v3EvalMetaPolarity(c4Sample, 0.85, axes, { top1: 0.30, epaMean });
    assert.ok(c4Pol.colorVector && c4Pol.colorVector[5] > 0.99, 'C4 must cleanly strip meta shell into colorVector');
    assert.equal(c4Pol.etaMode, 0, 'C4 entity+rhetoric (r_meta < 0.145) must keep etaMode === 0 so S2/S3 are not warped');

    // 3. V3 monotonic geodesic progression at cSelf = 0.91 must NOT falsely trigger stagnant
    const cosStep = 0.91;
    const sinStep = Math.sqrt(1 - cosStep * cosStep);
    const g3 = basis(0);
    const g2Arr = new Float32Array(dim);
    g2Arr[0] = cosStep;
    g2Arr[1] = sinStep;
    const g2 = unit(g2Arr);
    const cos2Step = 2 * cosStep * cosStep - 1;
    const sin2Step = Math.sqrt(1 - cos2Step * cos2Step);
    const g1Arr = new Float32Array(dim);
    g1Arr[0] = cos2Step;
    g1Arr[1] = sin2Step;
    const g1 = unit(g1Arr);
    const kinMono = mtm._v3ComputeAgentKinematics([g3, g2], g1, null, null, 0.85);
    assert.ok(kinMono.cSelf >= 0.90, `expected cSelf >= 0.90, got ${kinMono.cSelf}`);
    assert.equal(kinMono.stagnant, false, 'monotonic geodesic progression at cSelf=0.91 must NOT be falsely flagged stagnant');

    // 4. _v3TimeFlowAxis skips ALL consecutive trailing user-only segments (streak >= 2)
    const tfMultiStreak = mtm._v3TimeFlowAxis(
        '继续', basis(0), basis(0), basis(0), basis(0), basis(0), null, null, 0.85,
        [
            { vector: basis(4), count: 2, roles: ['user', 'assistant'] },
            { vector: basis(0), count: 1, roles: ['user'] },
            { vector: basis(0), count: 1, roles: ['user'] }
        ],
        0.1
    );
    assert.ok(Math.abs(tfMultiStreak.cPrev) < 1e-6, 'must skip multiple trailing user-only segments to reach last assistant-bearing segment');

    // 5. Quantile radius calculation matches Rust warped_chunks.rs for unindexed/.vcpwi stars
    const knots = Float64Array.from(Array.from({ length: 64 }, (_, i) => i / 63));
    const rLow = mtm._v3ComputeChunkQuantileRadius(0.0, knots);
    const rMid = mtm._v3ComputeChunkQuantileRadius(0.5, knots);
    const rHigh = mtm._v3ComputeChunkQuantileRadius(1.0, knots);
    assert.ok(Math.abs(rLow - 0.65) < 1e-6 && Math.abs(rHigh - 0.35) < 1e-6 && rMid > 0.35 && rMid < 0.65);

    // 6. Dimension-mismatched vector in processMetaThinkingV3 must return '' gracefully rather than throwing
    const dimRes = await mtmC7.processMetaThinkingV3('希夷星池簇', new Float32Array(8).fill(0.25), '错维测试', '', 'dim', false, {
        userVector: new Float32Array(8).fill(0.25)
    });
    assert.equal(dimRes, '', 'dimension-mismatched input must degrade gracefully to empty string');

    // 7. RAGDiaryPlugin default useRiverMemo=true shares thinkingObservation with MetaThinkingV3 without explicit ::RiverMemo modifier
    const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
    const rag = new ragSingleton.constructor();
    rag.riverThinkingConfig = { enabled: true, maxTransitionRecords: 0 };
    rag.contextVectorManager = { updateContext: async () => {}, segmentContext: () => [] };
    rag.timeParser = { parse: () => [] };
    rag.ragParams = { RAGDiaryPlugin: {} };
    rag.getSingleEmbeddingCached = async () => basis(0);
    rag._calculateDynamicParams = async () => ({ k: 3, tagWeight: 0.459, tagTruncationRatio: 0.5, metrics: {} });
    rag.ragConfig = { '测试日常': { threshold: 0.1 } };
    rag.vectorDBManager = {
        config: { storePath: path.join(__dirname, '..', 'VectorStore'), nativeRiverQueryEnabled: true },
        tagIndex: { planMemoThinking: () => '{}' },
        prepareUnifiedMemoObservation: async () => ({ observationHandle: 'shared-default-river', enhancedVector: basis(0) }),
        releaseMemoObservation: () => true,
        executeNativeRiverQuery: async () => ({ results: [{ chunkId: 1, diaryName: '测试日常', sourceFile: 'a.md', text: '正文', score: 0.9 }], omega: { omega: 0.5, regime: 'dense' } })
    };
    let v3GotSharedObs = null;
    rag.metaThinkingManager = {
        _resolveV3StarPoolDiaries: () => ['希夷星池簇'],
        processMetaThinkingV3: async (_s, _q, _u, _a, _d, _g, opts) => {
            v3GotSharedObs = typeof opts?.getObservation === 'function' ? await opts.getObservation() : null;
            return '';
        }
    };
    await rag._processMessagesWithMemoScope([
        { role: 'system', content: '[[测试日常日记本]]\n[[VCP元思考V3]]' },
        { role: 'user', content: '测试默认 RiverMemo 共享观测' }
    ], {});
    assert.equal(v3GotSharedObs?.observationHandle, 'shared-default-river', 'default useRiverMemo=true diaries without ::RiverMemo text must share observation with V3');
});

test('P0 regression: segmentContext.assistantVector isolates mixed C7 praise segments from timeFlow baseline, and version-mismatched stars recompute quantile radius', async () => {
    const ContextVectorManager = require('../Plugin/RAGDiaryPlugin/ContextVectorManager');
    const os = require('node:os');
    const Database = require('better-sqlite3');

    // 1. Mixed ['assistant', 'user'] segment: user praise merged via >=0.70 cosine must NOT pollute assistantVector
    const aiTopic = unit([0.92, 0.39, 0, 0]);
    const c7Merged = unit([0.75, 0.30, 0.59, 0]); // dot(aiTopic, c7Merged) ≈ 0.807 >= 0.70
    const prevAi = unit([0.92, 0.39, 0, 0]);
    const currUser = unit([0.90, 0.43, 0.05, 0]);
    const vecByText = new Map([
        ['第一轮AI技术剖析', aiTopic],
        ['绝了绝了技术剖析太丝滑了继续！', c7Merged],
        ['第二轮AI延续', prevAi]
    ]);
    const cvm = new ContextVectorManager({
        _stripHtml: t => t,
        _stripEmoji: t => t,
        _stripToolMarkers: t => t,
        sanitizeForEmbedding: t => t,
        _getEmbeddingFromCacheOnly: (t) => vecByText.get(t) || null,
        _findFuzzyEmbeddingFromCache: () => null
    });
    const msgs = [
        { role: 'assistant', content: '第一轮AI技术剖析' },
        { role: 'user', content: '绝了绝了技术剖析太丝滑了继续！' },
        { role: 'assistant', content: '第二轮AI延续' },
        { role: 'user', content: '继续细化边界' }
    ];
    await cvm.updateContext(msgs, { allowApi: false });
    const segs = cvm.segmentContext(msgs, 0.70);
    assert.equal(segs.length, 1);
    assert.ok(segs[0].assistantVector, 'mixed segment must expose pure assistantVector');
    assert.ok(Math.abs(segs[0].assistantVector[2]) < 1e-6, 'assistantVector must exclude user praise component');

    const mtm = new MetaThinkingManager({});
    const tf = mtm._v3TimeFlowAxis('继续细化边界', currUser, prevAi, currUser, currUser, aiTopic, null, null, 0.85, segs, 0.6);
    assert.ok(tf.cPrev > 0.99, `expected pure assistant cPrev ≈ 1.0, got ${tf.cPrev}`);

    // 2. Stale .vcpwc version mismatch: edited chunk vectorVersion > trainedVersions[cid][0] must recompute radius via alignmentQuantiles
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-p0-ver-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, diary_name TEXT, updated_at INTEGER);
            CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, vector_version INTEGER, content TEXT, vector BLOB);
            CREATE TABLE kbm_runtime_meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
        `);
        db.prepare("INSERT INTO files (id, path, diary_name, updated_at) VALUES (1, '星甲.md', '测试星池', 100)").run();
        // New edited vector aligned 100% with meanAxis -> alignment=1.0 -> quantile_radius=0.35 (vs stale frozen 0.64!)
        const newVec = unit([1, 0, 0, 0]);
        const blob = Buffer.from(newVec.buffer, newVec.byteOffset, newVec.byteLength);
        db.prepare("INSERT INTO chunks (id, file_id, vector_version, content, vector) VALUES (1, 1, 2, '星甲正文', ?)").run(blob);
    } finally {
        db.close();
    }
    try {
        const mockManifold = {
            cacheKey: 'm1',
            meanAxis: unit([1, 0, 0, 0]),
            beta: 0.7,
            alignmentQuantiles: Float64Array.from(Array.from({ length: 64 }, (_, i) => i / 63)),
            idToSlot: new Map([[1, 0]]),
            trainedVersions: { 1: [1, 1] }, // stale version 1 vs live version 2!
            convertedVersions: null,
            convertedChunkIds: new Set(),
            radiusByChunkId: new Map([[1, 0.64]]),
            defaultRadius: 0.63
        };
        const pool = await mtm._v3LoadStarPoolCache(fixtureStarReader(dbPath), ['测试星池'], mockManifold, { ttlMs: 0 });
        assert.ok(pool && pool.stars.length === 1);
        assert.equal(pool.stars[0].slot, undefined, 'version-mismatched star must NOT retain stale CSR slot');
        assert.ok(Math.abs(pool.stars[0].radius - 0.35) < 1e-5, `expected live quantile radius 0.35, got ${pool.stars[0].radius}`);
        assert.equal(pool.manifoldMissingStars, 1);

        // When DB stat is unchanged after TTL expiry, cache returns identical reference via stat-guard fast path
        pool.checkedAt = 0;
        const poolFast = await mtm._v3LoadStarPoolCache(fixtureStarReader(dbPath), ['测试星池'], mockManifold, { ttlMs: 3000 });
        assert.strictEqual(poolFast, pool, 'unchanged DB stat after TTL expiry must reuse cached starPool without re-reading SQLite');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Step 3 kinematics boundary fixes: noisy ping-pong, slow spiral (0.5 < chordRatio < 1.0), and 2-step Turn-2 guard', () => {
    const mtm = new MetaThinkingManager({});
    const pool = { nnStepMed: 1.1184, pairStdCos: 0.0892, tauExtremeZ: 3.6259, pairMeanCos: 0 };

    // 1. Noisy ping-pong: c23=0.45, returnSim=0.85, c12≈-0.064 -> effReturnChord ≈ 0.093 > pairStdCos(0.0892) with V3 ≈ 0.143 <= vLim
    const z3 = unit([1, 0, 0, 0, 0, 0]);
    const z2 = unit([0.45, Math.sqrt(1 - 0.45 * 0.45), 0, 0, 0, 0]);
    const z1 = unit([0.85, -0.50, 0.16, 0, 0, 0]);
    const kinNoisyPP = mtm._v3ComputeAgentKinematics([z3, z2], z1, null, null, 0.85, { starPool: pool });
    assert.ok(kinNoisyPP.chordRatio > pool.pairStdCos && kinNoisyPP.chordRatio < 0.5);
    assert.equal(kinNoisyPP.oscillating, true, 'noisy ping-pong (effReturnChord=0.093 > pairStdCos, returnSim=0.85) must trigger oscillating');
    assert.equal(kinNoisyPP.stagnant, true);

    // 2. Basin turnback stagnation: cSelf=0.875, cSelfPrev=0.875, c13=0.88 (chordRatio ≈ 0.48 <= 0.50 & V3 <= vLim)
    const s3 = unit([1, 0, 0, 0, 0, 0]);
    const s2 = unit([0.875, Math.sqrt(1 - 0.875 * 0.875), 0, 0, 0, 0]);
    const sx = (0.875 - 0.88 * 0.875) / Math.sqrt(1 - 0.875 * 0.875);
    const sr = Math.sqrt(Math.max(0, 1 - 0.88 * 0.88 - sx * sx));
    const s1 = unit([0.88, sx, sr, 0, 0, 0]);
    const kinSpiral = mtm._v3ComputeAgentKinematics([s3, s2], s1, null, null, 0.85, { starPool: pool });
    assert.ok(kinSpiral.chordRatio <= 0.5);
    assert.equal(kinSpiral.stagnant, true, 'turnback basin stagnation (chordRatio <= 0.5, cSelf=0.875) must trigger stagnant');

    // 3. 2-step Turn 2 (no a3): cSelf=0.88 must NOT false-alarm; cSelf=0.985 MUST trigger stagnant
    const kinTwoNormal = mtm._v3ComputeAgentKinematics([s3], s2, null, null, 0.85, { starPool: pool });
    assert.equal(kinTwoNormal.stagnant, false, '2-step Turn-2 continuity 0.88 must not false-alarm');
    const sFrozen = unit([0.985, Math.sqrt(1 - 0.985 * 0.985), 0, 0, 0, 0]);
    const kinTwoFrozen = mtm._v3ComputeAgentKinematics([s3], sFrozen, null, null, 0.85, { starPool: pool });
    assert.equal(kinTwoFrozen.stagnant, true, '2-step frozen repetition 0.985 must trigger stagnant');
});

test('Step 4/5 pure-tensor contracts: dual-null Wiener stripping, shell amplification SNR vs cold error, Gumbel EVT load, and calibrated timeFlow', () => {
    const dim = 32;
    const basis = (idx) => {
        const v = new Float32Array(dim);
        v[idx] = 1;
        return v;
    };
    const epaMean = basis(31);
    const muP = basis(28);
    const muD = basis(29);
    const muE = basis(30);

    // Build 24 synthetic star-pool vectors with small realistic null projections onto ph/meta (muPh0≈0.08, sdPh0≈0.025)
    const stars = Array.from({ length: 24 }, (_, i) => {
        const arr = new Float32Array(dim);
        const phCoeff = Math.sqrt(0.055 + 0.05 * ((i % 5) / 4));
        const mtCoeff = Math.sqrt(0.045 + 0.04 * (((i + 2) % 5) / 4));
        arr[28] = phCoeff;
        arr[29] = mtCoeff * 0.7;
        arr[30] = mtCoeff * 0.7;
        arr[i % 20] = Math.sqrt(Math.max(0, 1 - phCoeff * phCoeff - mtCoeff * mtCoeff));
        const v = unit(arr);
        return { chunkId: i + 1, starName: `星${i}`, raw: v, x: v, z: v };
    });
    const starPool = {
        versionKey: 'step45-unit-v1',
        stars,
        starMeanAxis: null,
        betaStar: 0.85,
        tauExtremeZ: Math.sqrt(2 * Math.log(stars.length)),
        pairMeanCos: 0.02,
        pairStdCos: 0.09,
        nnStepMed: 1.15
    };
    const axes = {
        muPhatic: muP,
        muDrill: muD,
        muEscape: muE,
        eDrill: muD,
        eEscape: muE,
        phSamples: [muP, unit(Array.from({ length: dim }, (_, i) => {
            if (i === 28) return 0.75;
            if (i === 0) return 0.66;
            return 0;
        }))],
        drillSamples: [muD, unit(Array.from({ length: dim }, (_, i) => {
            if (i === 29) return 0.68;
            if (i === 1) return 0.73;
            return 0;
        }))],
        escapeSamples: [muE, unit(Array.from({ length: dim }, (_, i) => {
            if (i === 30) return 0.62;
            if (i === 2) return 0.78;
            return 0;
        }))]
    };

    const mtm = new MetaThinkingManager({});
    // 1. Cold error (qrEPh ≈ 0.11 above muPh0=0.08, after stripping its cold domain tag partialPh < shellThresh) must NOT trigger tech-wrapped phatic
    const coldTagArr = new Float32Array(dim);
    coldTagArr[10] = 0.94;
    coldTagArr[28] = 0.34;
    const coldTag = unit(coldTagArr);
    const coldArr = new Float32Array(dim);
    coldArr[28] = Math.sqrt(0.11);
    coldArr[29] = 0.05;
    coldArr[10] = Math.sqrt(1 - 0.11 - 0.0025);
    const coldVec = unit(coldArr);
    const coldStripped = mtm._v3StripBasisInEpaSpace(coldVec, [coldTag], epaMean, 0.05, [muP], [muD, muE]);
    const coldPol = mtm._v3EvalMetaPolarity(coldVec, 0.75, axes, {
        top1: 0.10,
        epaMean,
        epaDigest: 'step45-epa',
        starPool,
        shellUserVec: coldStripped.vector || coldTag,
        shellResidualNorm: coldStripped.residualNorm || 0.35,
        partialPh: coldStripped.partialPh ?? 0.01,
        partialCtrl: coldStripped.partialCtrl ?? 0.015
    });
    assert.equal(coldPol.isTechWrappedPhatic, false, 'cold error without shell amplification must not trip isTechWrappedPhatic');
    assert.ok(coldPol.sPh < 0.35, `expected low sPh for unamplified cold error, got ${coldPol.sPh}`);

    // 2. Tech-wrapped phatic (rawEPh ≈ 0.125, stripping tech tag amplifies shellEPh -> 0.55) MUST trip isTechWrappedPhatic & damp alphaC
    const c7RawArr = new Float32Array(dim);
    c7RawArr[28] = Math.sqrt(0.125);
    c7RawArr[29] = 0.08;
    c7RawArr[11] = Math.sqrt(1 - 0.125 - 0.0064);
    const c7ShellArr = new Float32Array(dim);
    c7ShellArr[28] = Math.sqrt(0.55);
    c7ShellArr[12] = Math.sqrt(0.45);
    const c7Pol = mtm._v3EvalMetaPolarity(unit(c7RawArr), 0.75, axes, {
        top1: 0.15,
        epaMean,
        epaDigest: 'step45-epa',
        starPool,
        shellUserVec: unit(c7ShellArr),
        shellResidualNorm: 0.50,
        partialPh: 0.55,
        partialCtrl: 0.56
    });
    assert.equal(c7Pol.isTechWrappedPhatic, true, 'amplified phatic shell must trigger isTechWrappedPhatic');
    const gatedC7 = mtm._v3ApplyPhaticContentGate(0.80, c7Pol);
    assert.ok(gatedC7 < 0.25, `tech-wrapped phatic alphaC must stay < 0.25, got ${gatedC7}`);

    // 3. Pure drill prompt (qrEMeta ≈ 0.24, qrEColor ≈ 0.70 < metaColorGateCut) keeps isMetaCmd=true and etaMode < 0
    const drillArr = new Float32Array(dim);
    drillArr[29] = 0.45;
    drillArr[30] = -0.18;
    drillArr[28] = 0.20;
    drillArr[15] = Math.sqrt(1 - 0.45 * 0.45 - 0.18 * 0.18 - 0.20 * 0.20);
    const drillPol = mtm._v3EvalMetaPolarity(unit(drillArr), 0.30, axes, {
        top1: 0.12,
        epaMean,
        epaDigest: 'step45-epa',
        starPool
    });
    assert.equal(drillPol.isMetaCmd, true, 'pure drill prompt must be detected as metaCmd');
    assert.ok(drillPol.etaMode < -0.3, `expected strong negative etaMode for drill prompt, got ${drillPol.etaMode}`);

    // 4. Gumbel EVT load distinguishes peaked star match from flat non-spiking query
    const spikeVec = unit(stars[0].raw);
    const flatVec = unit(Array.from({ length: dim }, (_, i) => (i < 24 ? 1 / Math.sqrt(24) : 0)));
    const spikeLoad = mtm._v3ComputeUserIntentLoad(spikeVec, spikeVec, basis(25), null, null, null, starPool);
    const flatLoad = mtm._v3ComputeUserIntentLoad(flatVec, flatVec, basis(25), null, null, null, starPool);
    assert.ok(spikeLoad.load > flatLoad.load + 0.2, `Gumbel spike (${spikeLoad.load}) must exceed flat (${flatLoad.load})`);

    // 5. Star-pool calibrated _v3TimeFlowAxis uses pairMeanCos + pairStdCos cleanly
    const tfJump = mtm._v3TimeFlowAxis('新题', basis(5), basis(6), basis(5), basis(5), basis(5), null, null, 0.85, null, 0.9, { starPool });
    assert.equal(tfJump.mode, 'orthogonal');
    assert.equal(tfJump.phase, 'explore_jump');
    assert.ok(tfJump.shift > 0.4);
});

test('V3.11 audit fixes: z-space probe reuse, discrete queryMorphology eject steer, continuous clampCap without 0.25 plateau', async () => {
    const dim = 28;
    const basis = (idx) => {
        const v = new Float32Array(dim);
        v[idx] = 1;
        return v;
    };
    const meanAxis = basis(0);
    // Simulate realistic anisotropic narrow cone where raw dot(user, prevAi) ≈ 0.72 > 0.25,
    // while in de-centered z space they are orthogonal (dot_z ≈ 0 < μ_pair + 1.5·σ_pair)!
    const makeConeVec = (entries) => {
        const arr = new Float32Array(dim);
        for (const [k, val] of entries) arr[k] = val;
        return unit(arr);
    };
    const rawPrevAi = makeConeVec([[0, 0.85], [1, 0.526]]);
    const rawUserNew = makeConeVec([[0, 0.85], [2, 0.526]]);
    assert.ok(new MetaThinkingManager({})._v3Dot(rawUserNew, rawPrevAi) > 0.70, 'raw cone dot must be > 0.70');

    const manifold = { meanAxis, beta: 0.7, defaultRadius: 0.63 };
    const epaMean = basis(27);
    const axes = { muPhatic: basis(20), muDrill: basis(21), muEscape: basis(22), eDrill: basis(21), eEscape: basis(22) };
    const stars = Array.from({ length: 20 }, (_, i) => {
        const raw = makeConeVec([[0, 0.85], [i + 1, 0.526]]);
        const mtmTmp = new MetaThinkingManager({});
        const x = mtmTmp._v3ToGlobalSpace(raw, manifold);
        const z = mtmTmp._v3ToStarSpace(x, meanAxis, 0.85);
        return { chunkId: i + 1, fileId: i + 1, diaryName: '希夷星池簇', sourceFile: `星${i}.md`, starName: `星${i}`, text: `星${i}`, raw, x, z, zRaw: z, radius: 0.63 };
    });
    const starPool = {
        versionKey: 'v311-reuse', manifoldKey: 'm', checkedAt: Date.now(), stars,
        byChunkId: new Map(stars.map(s => [s.chunkId, s])),
        byStarName: new Map(stars.map(s => [s.starName, s])),
        bySlot: new Map(), starSlots: new Set(), starMeanAxis: meanAxis, betaStar: 0.85,
        pairMeanCos: 0, pairStdCos: 0.09, orthTopScale: 0.35, tauExtremeZ: 3.0, gumbelAN: 0.33, gumbelBN: 2.5,
        coneResidualBase: 0.96, coneResidualHigh: 0.98, epaMean
    };

    // 1) Without shared getObservation & z-space distinct topic -> probe runs FULL (not lightweight) and is REUSED (total 1 prepare call!)
    const prepCallsNoShared = [];
    const mtmReuse = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: ':memory:',
            async prepareUnifiedMemoObservation({ vector }, opts) {
                prepCallsNoShared.push({ maxLevels: opts?.maxPyramidLevels ?? 3, maxHops: opts?.spikeRouting?.maxSafeHops ?? 4 });
                return {
                    observationHandle: `h-${prepCallsNoShared.length}`,
                    enhancedVector: vector,
                    sourceObservationResult: {
                        epa: { logicDepth: 0.4, inDomainGate: 0.8 },
                        pyramid: { depth: 1, totalExplainedEnergy: 0.6, levels: [{ energyExplained: 0.6, tags: [{ name: 'T', contribution: 0.5 }] }] }
                    }
                };
            },
            releaseMemoObservation: () => true,
            async getTagVectorByName() { return basis(2); },
            async executeNativeRiverQuery() {
                return {
                    omega: { omega: 0.5, regime: 'dense' },
                    diagnostics: { queryProfile: { mode: 'propositional' } },
                    results: [{ chunkId: 2, diaryName: '希夷星池簇', sourceFile: '星1.md', text: '星1', score: 0.9 }]
                };
            }
        }
    });
    mtmReuse._v3MetaAxesCache = axes;
    mtmReuse._v3LoadGlobalManifold = () => manifold;
    mtmReuse._v3LoadStarPoolCache = () => ({ ...starPool, epaMean });
    // Slight phatic signal triggers L0 probe, but non-phatic color stays high -> should reuse probe!
    const rawUserWithMildPh = makeConeVec([[0, 0.82], [2, 0.50], [20, 0.28]]);
    await mtmReuse.processMetaThinkingV3('希夷星池簇', rawUserWithMildPh, '新话题', '', 'new', false, {
        userVector: rawUserWithMildPh, aiVector: rawPrevAi, historyAssistantVectors: [rawPrevAi]
    });
    assert.equal(prepCallsNoShared.length, 1, `z-space distinct topic without shared obs must reuse probe (1 prepare call), got ${prepCallsNoShared.length}`);
    assert.equal(prepCallsNoShared[0].maxLevels, 3, 'reusable probe must keep full pyramid levels');

    // 2) With shared getObservation provider -> probe MUST switch to lightweight (maxLevels=1, maxHops=0)
    const prepCallsWithShared = [];
    mtmReuse.ragPlugin.vectorDBManager.prepareUnifiedMemoObservation = async ({ vector }, opts) => {
        prepCallsWithShared.push({ maxLevels: opts?.maxPyramidLevels ?? 3, maxHops: opts?.spikeRouting?.maxSafeHops ?? 4 });
        return {
            observationHandle: 'light-1',
            enhancedVector: vector,
            sourceObservationResult: {
                epa: { logicDepth: 0.4, inDomainGate: 0.8 },
                pyramid: { depth: 1, totalExplainedEnergy: 0.6, levels: [{ energyExplained: 0.6, tags: [{ name: 'T', contribution: 0.5 }] }] }
            }
        };
    };
    await mtmReuse.processMetaThinkingV3('希夷星池簇', rawUserWithMildPh, '新话题', '', 'new', false, {
        userVector: rawUserWithMildPh, aiVector: rawPrevAi, historyAssistantVectors: [rawPrevAi],
        getObservation: async () => ({ enhancedVector: rawUserWithMildPh, sourceObservationResult: { pyramid: { depth: 1, levels: [] } } })
    });
    assert.equal(prepCallsWithShared.length, 1);
    assert.equal(prepCallsWithShared[0].maxLevels, 1, 'probe with shared getObservation provider must use lightweight maxPyramidLevels=1');
    assert.equal(prepCallsWithShared[0].maxHops, 0, 'probe with shared getObservation provider must use lightweight maxSafeHops=0');

    // 3) Continuous clampCap produces distinct monotonic values below 0.25 (no rigid 0.25 plateau)
    const mtmGate = new MetaThinkingManager({});
    const capLow = mtmGate._v3ApplyPhaticContentGate(0.95, { clampContent: true, qrEColor: 0.50, sPh: 0, calib: { metaColorGateCut: 0.74, sdCl0: 0.05 } });
    const capMid = mtmGate._v3ApplyPhaticContentGate(0.95, { clampContent: true, qrEColor: 0.68, sPh: 0, calib: { metaColorGateCut: 0.74, sdCl0: 0.05 } });
    assert.ok(capLow > 0 && capLow < capMid && capMid < 0.25, `continuous clampCap must be strictly monotonic in (0, 0.25), got low=${capLow}, mid=${capMid}`);
});

test('V3.12 audit closing pack: multi-chunk byChunkId sync, counterfactual | M symbol, strong-meta EN etaMode, R4<1.0, CDF timeFlow, sigma_pair invariance', async (t) => {
    const dim = 28;
    const basis = (idx) => { const v = new Float32Array(dim); v[idx] = 1; return v; };

    // 1. Multi-chunk star card: byChunkId.get(chunk2).z MUST match aggregated byStarName.get(name).z
    const fsSync = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Database = require('better-sqlite3');
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'v3-mc-sync-'));
    t.after(() => { try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });
    const dbPath = path.join(tmpDir, 'mc.sqlite');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, diary_name TEXT, updated_at INTEGER);
        CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, vector_version INTEGER, content TEXT, vector BLOB);
        CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE kbm_runtime_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    const mkBlob = (arr) => Buffer.from(Float32Array.from(arr).buffer);
    db.prepare('INSERT INTO files VALUES (1, ?, ?, 100)').run('多块星.md', '希夷星池簇');
    db.prepare('INSERT INTO files VALUES (2, ?, ?, 100)').run('单块星.md', '希夷星池簇');
    db.prepare('INSERT INTO chunks VALUES (101, 1, 1, ?, ?)').run('part1', mkBlob(basis(1)));
    db.prepare('INSERT INTO chunks VALUES (102, 1, 1, ?, ?)').run('part2', mkBlob(basis(2)));
    db.prepare('INSERT INTO chunks VALUES (201, 2, 1, ?, ?)').run('single', mkBlob(basis(3)));
    db.close();

    const mtmMc = new MetaThinkingManager({});
    const mcPool = await mtmMc._v3LoadStarPoolCache(fixtureStarReader(dbPath), ['希夷星池簇'], null, { ttlMs: 0 });
    const aggStar = mcPool.byStarName.get('多块星');
    const byId2 = mtmMc._v3LookupStarMeta(mcPool, { chunkId: 102, sourceFile: '多块星.md' });
    assert.ok(aggStar && byId2);
    assert.ok(mtmMc._v3Dot(aggStar.z, byId2.z) > 0.9999, 'byChunkId for chunk2 must carry aggregated star z vector');

    // 2. Counterfactual | M symbol: active-diaries flipping Star 3 lights | M even when (1/3)*diary < (2/3)*torque
    const vectors = new Map([
        [1, unit([1, 0, 0, 0, 0, 0])],
        [2, unit([0, 1, 0, 0, 0, 0])],
        [3, unit([0, 0, 0.35, 0.9367, 0, 0])], // pure torque winner
        [4, unit([0, 0, 0.33, 0, 0.944, 0])],  // close torque runner-up aligned with diary!
        [900, unit([0, 0, 0, 0, 1, 0])]
    ]);
    const starDocs = [
        { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '主星.md', text: '主星', score: 0.9 },
        { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '对偶.md', text: '对偶', score: 0.5 },
        { chunkId: 3, diaryName: '希夷星池簇', sourceFile: '扭矩冠军星.md', text: '扭矩冠军星', score: 0.4 },
        { chunkId: 4, diaryName: '希夷星池簇', sourceFile: '日记翻盘星.md', text: '日记翻盘星', score: 0.35 }
    ];
    const bc = [];
    const mtmM = new MetaThinkingManager({
        vectorDBManager: {
            async executeNativeRiverQuery() { return { results: starDocs, diagnostics: { degraded: false } }; },
            async getVectorByChunkId(id) { return vectors.get(id) || null; }
        },
        pushVcpInfo: (p) => bc.push(p)
    });
    const qM = unit([0.80, 0.50, 0.33, 0, 0, 0]);
    const fFlip = await mtmM.processMetaThinkingV3('希夷星池簇', qM, '测试日记翻盘', null, 'm', false, {
        activeDiaryChunks: [{ chunkId: 900, diaryName: '技术笔记', score: 0.9 }]
    });
    assert.equal(bc[0].stars[2].name, '日记翻盘星');
    assert.equal(bc[0].memorySteered, true, 'counterfactual winner flip by active-diaries must set memorySteered=true');
    assert.ok(fFlip.includes('| ℳ'), `expected | ℳ when active-diaries flipped Star 3, got ${fFlip}`);

    // Without personal diary, memorySteered must remain false
    bc.length = 0;
    const fNoFlip = await mtmM.processMetaThinkingV3('希夷星池簇', qM, '无日记对照', null, 'm0', false, {});
    assert.equal(bc[0].stars[2].name, '扭矩冠军星');
    assert.equal(bc[0].memorySteered, false);
    assert.ok(!fNoFlip.includes('| ℳ'));

    // 3. Squared-distance R4 < 1.0 detects 0.5 < R4 < 1.0 tight-basin spiral (while keeping monotonic progression zero-FP)
    const pool = { pairMeanCos: 0, pairStdCos: 0.088, orthTopScale: 0.38, nnStepMed: 1.11, gumbelBN: 3.017, tauExtremeZ: 3.626, stars: new Array(716) };
    const rad = 0.29;
    const bVal = Math.sqrt(1 - rad * rad);
    const ang = (80 * Math.PI) / 180;
    const pts = [0, 1, 2, 3].map(k => {
        const arr = new Float32Array(dim);
        arr[0] = bVal;
        arr[1] = rad * Math.cos(k * ang);
        arr[2] = rad * Math.sin(k * ang);
        return unit(arr);
    });
    const kinR4 = mtmMc._v3ComputeAgentKinematics([pts[0], pts[1], pts[2]], pts[3], null, null, 0.85, { starPool: pool });
    assert.ok(kinR4.diffusionRatio4 < 1.0 && kinR4.stagnant === true, `R4=${kinR4.diffusionRatio4} < 1.0 within basinRadiusCrit must trigger stagnant`);

    // 4. English/bilingual strong meta directive (metaZ>=2.0 && rMetaZ>=2.5 && lowColorSubspace) keeps negative etaMode despite mild phatic overlap
    const epaMean = basis(27);
    const axes = { muPhatic: basis(20), eDrill: basis(21), eEscape: basis(22) };
    const enDrill = unit(Array.from({ length: dim }, (_, i) => {
        if (i === 20) return 0.45; // mild phatic overlap (qrEPh ≈ 0.20)
        if (i === 21) return 0.45; // strong drill meta (qrEMeta ≈ 0.20, metaZ >> 2.0)
        if (i === 10) return Math.sqrt(1 - 0.45 * 0.45 - 0.45 * 0.45); // qrEColor ≈ 0.595 < cut
        return 0;
    }));
    const polEn = mtmMc._v3EvalMetaPolarity(enDrill, 0.8, axes, { epaMean });
    assert.equal(polEn.isMetaCmd, true, 'strong metaZ>=2 && rMetaZ>=2.5 && lowColor must keep isMetaCmd=true');
    assert.ok(polEn.etaMode < -0.5, `strong bilingual drill must preserve negative etaMode, got ${polEn.etaMode}`);

    // 5. Star 2/3 scale invariance: increasing orthTopScale from 0.35 to 0.65 (dense 10k-star pool simulation) does NOT shift Star 2/3 scales
    const densePool = { ...pool, orthTopScale: 0.65 };
    const mkPair = (idxA, valA, idxB) => {
        const arr = new Float32Array(dim);
        arr[idxA] = valA;
        arr[idxB] = Math.sqrt(1 - valA * valA);
        return unit(arr);
    };
    const sweet = mkPair(3, 0.33, 4);
    const tooClose = mkPair(3, 0.65, 5);
    const vecMap = new Map([[1, basis(1)], [2, basis(2)], [3, sweet], [4, tooClose]]);
    const cands = [
        { chunkId: 1, sourceFile: 'A.md', score: 0.9 },
        { chunkId: 2, sourceFile: 'B.md', score: 0.8 },
        { chunkId: 3, sourceFile: '甜点星.md', score: 0.5 },
        { chunkId: 4, sourceFile: '密邻星.md', score: 0.5 }
    ];
    const pickedDense = mtmMc._selectV3TrinityStars(cands, {
        lockedPrimary: { item: cands[0], starName: 'A', slot: 'primary' },
        lockedConjugate: { item: cands[1], starName: 'B', slot: 'conjugate' },
        ejectImpulseZ: basis(3),
        starPool: densePool,
        vectorByChunkId: vecMap
    });
    assert.equal(pickedDense[2].starName, '甜点星', 'dense-pool orthTopScale=0.65 must NOT drag torqueSweetSpot up toward 0.65');
});

test('P0-1/P0-2/P0-3/P1 regressions: OneRing active strategies exclude V3, C7 blocks outer diaryBridge, and multi-chunk syncs radius/leg', async () => {
    const { ServerInferredTimelineStrategy } = require('../Plugin/OneRing/OneRingServerInferredTimeline');
    const { RawClientTimelineStrategy } = require('../Plugin/OneRing/OneRingRawClientTimeline');
    const oneRing = require('../Plugin/OneRing/OneRing');
    const { isMetaThinkingV3Message } = require('../modules/messageProcessor');
    const formula = '$$势陷[∂星甲 ∧ ∇星乙]_φ ↦ 思奇 σ_∞(星丙 ⊖ φ) →_{τ,x} ?$$';

    // 1) P0-1: ServerInferredTimelineStrategy must strip both explicit & unmarked same-turn V3 formulas,
    //         preserve standalone user-sent V3 formulas, and prepend DB history BEFORE V3.
    const injectedV3 = { role: 'user', content: formula };
    Object.defineProperty(injectedV3, '__vcpMetaThinkingV3__', { value: true, enumerable: false, configurable: true });
    const serverStrat = new ServerInferredTimelineStrategy({
        discardPatterns: [/^\s*\[系统/],
        sanitizeUserContentAtPipelineEntry: c => c,
        sanitizeUserTextAtPipelineEntry: t => String(t || ''),
        isMetaThinkingV3Message,
        hasUserTextContent: c => Boolean(String(c || '').trim()),
        markOneRingOriginalIndex: (m, i) => { if (m && typeof m === 'object') m.__origIdx = i; return m; },
        getOneRingOriginalIndex: m => m?.__origIdx,
        markOneRingWorkingKey: (m, k) => { if (m && typeof m === 'object') m.__wKey = k; return m; },
        getOneRingWorkingKey: m => m?.__wKey,
        isOneRingInjectedFromDb: m => Boolean(m?.__fromDb),
        getOneRingTimelineMeta: () => null,
        getOneRingTailMeta: () => null,
        cloneMessageWithOneRingMetadata: (m, ov) => ({ ...m, ...ov }),
        upsertTailTag: c => c
    });
    const origServerMsgs = [
        { role: 'system', content: 'sys' },
        injectedV3,
        { role: 'user', content: '真实用户发言' }
    ];
    const srvView = serverStrat.buildWorkingView(origServerMsgs);
    assert.equal(srvView.workingMessages.length, 2, 'ServerInferredTimelineStrategy must strip injected V3 formula');
    const prependedDb = { role: 'user', content: '跨端历史发言', __fromDb: true };
    const restoredSrv = serverStrat.restoreWorkingViewToOriginalMessages(
        origServerMsgs,
        [srvView.workingMessages[0], prependedDb, srvView.workingMessages[1]],
        srvView
    );
    assert.deepEqual(
        restoredSrv.map(m => m.content),
        ['sys', '跨端历史发言', formula, '真实用户发言'],
        'ServerInferredTimelineStrategy must keep prepended DB history above injected V3 formula'
    );
    // Unmarked same-turn cloned V3 above real user is stripped; standalone user-sent V3 is preserved
    const unmarkedSameTurn = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: formula },
        { role: 'user', content: '下一句真实问题' }
    ];
    assert.equal(serverStrat.buildWorkingView(unmarkedSameTurn).workingMessages.length, 2);
    const standaloneUserFormula = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: formula }
    ];
    assert.equal(serverStrat.buildWorkingView(standaloneUserFormula).workingMessages.length, 2);

    // 2) P0-1: RawClientTimelineStrategy & OneRing._extractLocalPostBlocks must treat injected V3 as side-pseudo-system-user
    const rawStrat = new RawClientTimelineStrategy({
        discardPatterns: [/^\s*\[系统/],
        sanitizeUserTextAtPipelineEntry: t => String(t || ''),
        isMetaThinkingV3Message,
        classifyUserContent: (t, u) => (t ? { cleanText: t, senderName: u } : null),
        classifyAssistantContent: (t, a) => (t ? { cleanText: t, senderName: a } : null)
    });
    const rawMap = rawStrat._buildClientContextMap(unmarkedSameTurn, 'TestUser', 'TestAgent');
    assert.equal(rawMap.contextRecords.length, 1, 'RawClientTimelineStrategy must exclude injected V3 from contextRecords');
    assert.equal(rawMap.contextRecords[0].dbText, '下一句真实问题');
    const localBlocks = oneRing._extractLocalPostBlocks(origServerMsgs, 'TestAgent', 'VCPChat', 'TestUser');
    assert.equal(localBlocks.length, 1, 'OneRing._extractLocalPostBlocks must skip injected V3 formula');
    assert.equal(localBlocks[0].text, '真实用户发言');

    // 3) P0-2: Low-load / C7 preferIndependentObs must NOT consume outer user-mixed activeDiaryChunks
    const dim = 24;
    const basisVec = (idx) => { const v = new Float32Array(dim); v[idx] = 1; return v; };
    const epaMean = basisVec(23);
    const muP = basisVec(20), eD = basisVec(21), eE = basisVec(22);
    const stars20 = Array.from({ length: 20 }, (_, i) => {
        const v = basisVec(i);
        return { chunkId: i + 1, fileId: i + 1, diaryName: '希夷星池簇', sourceFile: `星卡${i}.md`, starName: `星卡${i}`, text: `星卡${i}`, raw: v, x: v, z: v, zRaw: v, radius: 0.63 };
    });
    const sp20 = {
        stars: stars20,
        byChunkId: new Map(stars20.map(s => [s.chunkId, s])),
        byStarName: new Map(stars20.map(s => [s.starName, s])),
        bySlot: new Map(), starSlots: new Set(), starMeanAxis: null, betaStar: 0.85,
        orthTopScale: 0.22, manifoldMissingStars: 0, avgStarInDeg: 32, epaMean
    };
    const bcastsP02 = [];
    let diaryFetcherCalled = 0;
    const mtmP02 = new MetaThinkingManager({
        vectorDBManager: {
            async prepareUnifiedMemoObservation({ vector }) {
                return { observationHandle: 'h1', enhancedVector: vector, sourceObservationResult: { pyramid: { depth: 1, totalExplainedEnergy: 0.8, levels: [{ energyExplained: 0.8, tags: [{ name: 'T', contribution: 0.8 }] }] }, matchedTags: [] } };
            },
            releaseMemoObservation() {},
            async getTagVectorByName() { return basisVec(4); },
            async getVectorByChunkId(id) { return id === 999 ? basisVec(15) : null; },
            async executeNativeRiverQuery() {
                return { results: stars20.slice(0, 4).map((s, idx) => ({ chunkId: s.chunkId, diaryName: s.diaryName, sourceFile: s.sourceFile, text: s.text, score: 0.9 - idx * 0.05 })), diagnostics: { degraded: false } };
            }
        },
        pushVcpInfo: p => bcastsP02.push(p)
    });
    mtmP02._v3MetaAxesCache = { muPhatic: muP, eDrill: eD, eEscape: eE };
    mtmP02._v3LoadGlobalManifold = () => null;
    mtmP02._v3LoadStarPoolCache = () => ({ ...sp20, epaMean });
    const phaticPraise = unit(Array.from({ length: dim }, (_, i) => (i === 20 ? 0.96 : i === 4 ? 0.28 : 0)));
    const fP02 = await mtmP02.processMetaThinkingV3('希夷星池簇', basisVec(0), '太秀了继续！', '', 'p02', false, {
        userVector: phaticPraise,
        aiVector: basisVec(0),
        historyAssistantVectors: [basisVec(0)],
        getActiveDiaryChunks: async () => { diaryFetcherCalled++; return [{ chunkId: 999, diaryName: '我的日常', score: 0.95 }]; }
    });
    assert.equal(diaryFetcherCalled, 0, 'preferIndependentObs must bypass user-biased getActiveDiaryChunks');
    assert.notEqual(bcastsP02[0].diaryBridgeSource, 'active-diaries');
    assert.ok(!fP02.includes('| ℳ'));

    // 4) P0-3: Multi-chunk star card syncs aggregated raw, x, radius, and leg across every chunkId
    const fsSync = require('node:fs'), os = require('node:os'), pathMod = require('node:path'), Database = require('better-sqlite3');
    const tmpMc = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), 'vcp-v3-mc-sync-'));
    const mcDbPath = pathMod.join(tmpMc, 'mc.sqlite');
    const mcDb = new Database(mcDbPath);
    const vecBuf = arr => Buffer.from(unit(arr).buffer);
    try {
        mcDb.exec('CREATE TABLE files (id INTEGER PRIMARY KEY, diary_name TEXT, path TEXT, updated_at INTEGER); CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, content TEXT, vector BLOB, vector_version INTEGER); CREATE TABLE kbm_runtime_meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);');
        mcDb.prepare("INSERT INTO files VALUES (1, '希夷星池簇', '多块星.md', 100)").run();
        mcDb.prepare("INSERT INTO files VALUES (2, '希夷星池簇', '单块星.md', 100)").run();
        mcDb.prepare("INSERT INTO chunks VALUES (101, 1, '块1', ?, 1)").run(vecBuf([0.9, 0.4359, 0, 0]));
        mcDb.prepare("INSERT INTO chunks VALUES (102, 1, '块2', ?, 1)").run(vecBuf([0.1, 0.9950, 0, 0]));
        mcDb.prepare("INSERT INTO chunks VALUES (201, 2, '单', ?, 1)").run(vecBuf([0, 0, 1, 0]));
    } finally { mcDb.close(); }
    try {
        const mtmMc2 = new MetaThinkingManager({});
        const fakeManifold = {
            cacheKey: 'mc-test',
            meanAxis: unit([1, 0, 0, 0]),
            beta: 0.7,
            alignmentQuantiles: Array.from({ length: 64 }, (_, idx) => idx / 63),
            radiusByChunkId: new Map([[101, 0.36], [102, 0.64], [201, 0.65]]),
            idToSlot: new Map(),
            convertedChunkIds: new Set(),
            defaultRadius: 0.63,
            geo: { distance: (ra, rb, th) => Math.abs(ra - rb) + th, regime: () => 'dip', leg: r => ({ angle: r }) }
        };
        const poolMc = await mtmMc2._v3LoadStarPoolCache(fixtureStarReader(mcDbPath), ['希夷星池簇'], fakeManifold, { ttlMs: 0 });
        const c101 = poolMc.byChunkId.get(101);
        const c102 = poolMc.byChunkId.get(102);
        assert.ok(mtmMc2._v3Dot(c101.raw, c102.raw) > 0.999999, 'all chunks of a multi-chunk star must share aggregated raw');
        assert.ok(mtmMc2._v3Dot(c101.x, c102.x) > 0.999999, 'all chunks must share aggregated x');
        assert.ok(Math.abs(c101.radius - c102.radius) < 1e-6, 'all chunks must share aggregated quantile radius');
        assert.ok(Math.abs(c101.leg.angle - c102.leg.angle) < 1e-6, 'all chunks must share aggregated leg');
    } finally {
        fsSync.rmSync(tmpMc, { recursive: true, force: true });
    }
});

test('P0-audit regressions: C7 bait blocked from Star 3 via timeFlow/zEff, kinematics decoupled from nnStepMed, shellXVec skips P_beta^-1, and OneRing discards tool/invitation', async () => {
    const dim = 28;
    const basis = (idx) => {
        const v = new Float32Array(dim);
        v[idx] = 1;
        return v;
    };
    const epaMean = basis(27);
    const meanAxis = basis(0);
    const stars = [];
    for (let i = 0; i < 20; i++) {
        let sName = `星卡${i}`;
        if (i === 1) sName = '本域张力星';
        else if (i === 5) sName = '夸赞诱饵星';
        const raw = unit(Array.from({ length: dim }, (_, k) => {
            if (k === i + 1) return 1;
            if (k === 0) return 0.15;
            return 0;
        }));
        stars.push({
            chunkId: i + 1,
            fileId: i + 1,
            diaryName: '希夷星池簇',
            sourceFile: `${sName}.md`,
            starName: sName,
            text: `${sName}\nbody`,
            raw,
            x: raw,
            z: basis(i + 1),
            zRaw: basis(i + 1),
            radius: 0.5,
            leg: null
        });
    }
    const aiVec = basis(1); // aligned with 星卡0
    const aiPrev2 = unit([0, 0.72, 0.69, 0]);
    const phaticDim = 25;
    const axes = {
        muPhatic: basis(phaticDim),
        muDrill: basis(24),
        muEscape: basis(23),
        eDrill: basis(24),
        eEscape: basis(23),
        phSamples: [basis(phaticDim)],
        drillSamples: [basis(24)],
        escapeSamples: [basis(23)]
    };

    // 1. C7 praise bait combines strong phatic axis (e25) + bait star axis (e6 -> 夸赞诱饵星)
    const c7BaitVec = unit(Array.from({ length: dim }, (_, k) => {
        if (k === phaticDim) return 0.78;
        if (k === 6) return 0.50;
        if (k === 26) return 0.37;
        return 0;
    }));
    const broadcasts = [];
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-c7-star3.sqlite',
            async prepareUnifiedMemoObservation({ vector }) {
                return {
                    enhancedVector: vector,
                    sourceObservationResult: {
                        matchedTags: [],
                        pyramid: { totalExplainedEnergy: 0.6, depth: 1, levels: [{ tags: [{ name: '诱饵Tag', contribution: 0.2 }] }] }
                    }
                };
            },
            releaseMemoObservation: () => true,
            async getTagVectorByName() { return basis(6); },
            async executeNativeRiverQuery() {
                return {
                    omega: { omega: 0.5, regime: 'dense', omegaFlow: 0.8 },
                    diagnostics: { queryProfile: { mode: 'narrative' } },
                    results: [
                        { chunkId: 1, diaryName: '希夷星池簇', sourceFile: '星卡0.md', score: 0.90 },
                        { chunkId: 2, diaryName: '希夷星池簇', sourceFile: '本域张力星.md', score: 0.65 }
                    ]
                };
            }
        },
        pushVcpInfo: (info) => broadcasts.push(info)
    });
    mtm._v3MetaAxesCache = axes;
    mtm._v3StarPoolCache = new Map([[
        'mock-c7-star3.sqlite\0希夷星池簇',
        {
            versionKey: 'no-manifold|c7-star3',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: meanAxis,
            betaStar: 0.85,
            tauExtremeZ: Math.sqrt(2 * Math.log(20)),
            gumbelAN: 0.4,
            gumbelBN: 2.0,
            pairMeanCos: 0,
            pairStdCos: 0.089,
            nnStepMed: 1.12,
            epaMean,
            epaDigest: 'c7-star3-epa'
        }
    ]]);
    await mtm.processMetaThinkingV3('希夷星池簇', mixUnitArr(c7BaitVec, 0.7, aiVec, 0.3), '绝了太丝滑了继续！', '', 'test', false, {
        userVector: c7BaitVec,
        aiVector: aiVec,
        historyAssistantVectors: [aiPrev2]
    });
    assert.ok(broadcasts[0]?.independentObservationUsed, 'C7 bait must use independent observation');
    assert.notEqual(broadcasts[0]?.stars?.[2]?.name, '夸赞诱饵星', 'C7 bait must not hijack Star 3 via timeFlow.vector or zEff');

    // 2. Kinematics invariance to nnStepMed when pairStdCos is fixed
    const a3 = basis(1);
    const a2 = unit([0, 0.88, 0.475, 0]);
    const a1 = unit([0, 0.86, 0.20, 0.469]);
    const kinSparse = mtm._v3ComputeAgentKinematics([a3, a2], a1, null, null, 0.85, { starPool: { pairStdCos: 0.089, nnStepMed: 1.25 } });
    const kinDense = mtm._v3ComputeAgentKinematics([a3, a2], a1, null, null, 0.85, { starPool: { pairStdCos: 0.089, nnStepMed: 0.75 } });
    assert.equal(kinSparse.stagnant, kinDense.stagnant, 'stagnation decision must not drift as star pool densifies');
    assert.equal(kinSparse.mEndo, kinDense.mEndo);

    // 3. _v3StripBasisInEpaSpace skipInverse avoids P_beta^-1 and returns exact xResidual
    const stripped = mtm._v3StripBasisInEpaSpace(c7BaitVec, [basis(6)], epaMean, 0.05, [basis(phaticDim)], [basis(24), basis(23)], { skipInverse: true });
    assert.equal(stripped.vector, null);
    assert.ok(stripped.xResidual && Math.abs(mtm._v3Dot(stripped.xResidual, basis(6))) < 1e-6);

    // 4. OneRing ServerInferredTimelineStrategy drops [系统邀请指令] & <!-- VCP_TOOL_PAYLOAD -->
    const oneRing = require('../Plugin/OneRing/OneRing');
    const view = oneRing._buildOneRingWorkingView([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '[系统邀请指令:] 请发言' },
        { role: 'user', content: '<!-- VCP_TOOL_PAYLOAD -->{"tool":"x"}' },
        { role: 'user', content: '真实用户消息' }
    ]);
    assert.equal(view.workingMessages.length, 2, 'OneRing working view must exclude invitation and tool payload system blocks');
});

test('Boundary Footprint: RAGDiaryPlugin aligns v3ActiveDiaryChunks strictly to post-Rerank/Truncate/k visible results with topologyBonus', async () => {
    const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
    const rag = new ragSingleton.constructor();
    const cacheStore = new Map();
    rag.queryCacheEnabled = true;
    rag.cacheManager = {
        generateKey: (obj) => JSON.stringify(obj),
        get: (_ns, k) => cacheStore.get(k) || null,
        set: (_ns, k, v) => cacheStore.set(k, v)
    };
    rag.rerankConfig = { enabled: true, multiplier: 2 };
    rag.ragParams = { KnowledgeBaseManager: { riverMemo: { candidateSuperset: { maxUnionCandidates: 20, queryK: 10 } }, resultDeduplication: {} } };
    rag.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        async executeNativeRiverQuery() {
            return {
                artifactSig: 'sig-test',
                queryId: 'q-1',
                omega: { omega: 0.65, regime: 'active' },
                results: [
                    { chunkId: 101, diaryName: '技术笔记', sourceFile: 'a.md', text: '高初筛但被Truncate淘汰', score: 0.95, topologyBonus: 0.0, role: 'direct_answer' },
                    { chunkId: 102, diaryName: '技术笔记', sourceFile: 'b.md', text: '高初筛且保留', score: 0.90, topologyBonus: 0.01, role: 'thematic_neighbor' },
                    { chunkId: 103, diaryName: 'VCP开发', sourceFile: 'c.md', text: '低初筛高拓扑虫洞暗流', score: 0.72, topologyBonus: 0.08, role: 'wormhole' },
                    { chunkId: 104, diaryName: '技术笔记', sourceFile: 'd.md', text: '低初筛被k裁剪淘汰', score: 0.45, topologyBonus: 0.02, role: 'thematic_neighbor' }
                ],
                diagnostics: { degraded: false }
            };
        },
        async deduplicateResults(items) { return items; }
    };
    rag._rerankDocuments = async (_q, cands, k) => {
        const scoreMap = new Map([[103, 0.91], [102, 0.74], [101, 0.42], [104, 0.30]]);
        return [...cands]
            .map(c => ({ ...c, rerank_score: scoreMap.get(c.chunkId) ?? c.score }))
            .sort((a, b) => b.rerank_score - a.rerank_score)
            .slice(0, k);
    };

    const runOnce = async () => {
        const rc = rag._createRequestCache();
        const out = await rag._processRAGPlaceholder({
            dbName: '技术笔记',
            modifiers: '::RiverMemo::Rerank::Truncate0.60',
            queryVector: unit([1, 0, 0, 0]),
            userContent: '测试视野对齐',
            aiContent: '',
            combinedQueryForDisplay: '测试视野对齐',
            dynamicK: 3, // Rerank returns [103 (0.91), 102 (0.74), 101 (0.42)]; Truncate0.60 drops 101!
            requestCache: rc
        });
        return { out, chunks: rc.v3ActiveDiaryChunks };
    };

    const r1 = await runOnce();
    assert.ok(r1.out.includes('低初筛高拓扑虫洞暗流') && !r1.out.includes('高初筛但被Truncate淘汰'));
    assert.deepEqual(r1.chunks.map(c => c.chunkId), [103, 102], 'eliminated candidates (101, 104) must NEVER enter v3ActiveDiaryChunks');
    assert.equal(r1.chunks[0].topologyBonus, 0.08);
    assert.equal(r1.chunks[0].riverRole, 'wormhole');
    assert.equal(r1.chunks[0].score, 0.91);

    const r2 = await runOnce();
    assert.deepEqual(r2.chunks.map(c => c.chunkId), [103, 102], 'cache hit must replay post-Truncate visible chunks with topologyBonus');
    assert.equal(r2.chunks[0].topologyBonus, 0.08);
});

test('Boundary Footprint: mixed-diary anti-dilution amplifies dark-undercurrent wormhole, echo-chamber silences cleanly, and C7 blocks backdoor', async () => {
    const dim = 28;
    const basis = (idx) => { const v = new Float32Array(dim); v[idx] = 1; return v; };
    const epaMean = basis(27);
    const phaticDim = 25;
    const stars = Array.from({ length: 20 }, (_, i) => ({
        chunkId: i + 1,
        fileId: i + 1,
        diaryName: '希夷星池簇',
        sourceFile: `${i === 0 ? '主星' : (i === 1 ? '对偶星' : (i === 5 ? '跨界暗流星' : `星卡${i}`))}.md`,
        starName: i === 0 ? '主星' : (i === 1 ? '对偶星' : (i === 5 ? '跨界暗流星' : `星卡${i}`)),
        text: `星卡${i}`,
        raw: basis(i),
        x: basis(i),
        z: basis(i),
        zRaw: basis(i),
        radius: 0.63,
        leg: null
    }));
    const starDocs = stars.map((st, idx) => ({
        chunkId: st.chunkId,
        diaryName: '希夷星池簇',
        sourceFile: st.sourceFile,
        text: st.text,
        score: idx === 0 ? 0.90 : (idx === 1 ? 0.72 : (idx === 5 ? 0.35 : 0.42))
    }));
    const diaryVecs = new Map([
        // Two high-score conforming diaries mostly inside span(e0, e1), with canceling opposite residuals along e10
        [801, unit(Array.from({ length: dim }, (_, k) => (k === 0 ? 0.93 : (k === 1 ? 0.30 : (k === 10 ? 0.21 : 0)))))],
        [802, unit(Array.from({ length: dim }, (_, k) => (k === 1 ? 0.93 : (k === 0 ? 0.30 : (k === 10 ? -0.21 : 0)))))],
        // One lower-score high-topologyBonus wormhole diary aligned with 跨界暗流星 (e5) + moderate e0
        [803, unit(Array.from({ length: dim }, (_, k) => (k === 5 ? 0.96 : (k === 0 ? 0.28 : 0))))],
        // Echo-chamber diaries 100% inside span(z1=e0, z2=e1, zPrevAi=e2)
        [804, unit(Array.from({ length: dim }, (_, k) => (k === 0 ? 0.80 : (k === 1 ? 0.60 : 0))))],
        [805, unit(Array.from({ length: dim }, (_, k) => (k === 0 ? 0.50 : (k === 1 ? 0.50 : (k === 2 ? 0.7071 : 0)))))]
    ]);

    const broadcasts = [];
    const mtm = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-boundary-footprint.sqlite',
            async getVectorByChunkId(id) { return diaryVecs.get(id) || null; },
            async executeNativeRiverQuery() {
                return {
                    omega: { omega: 0.6, regime: 'active', omegaFlow: 0.7 },
                    diagnostics: { queryProfile: { mode: 'propositional' } },
                    results: starDocs
                };
            }
        },
        pushVcpInfo: (info) => broadcasts.push(info)
    });
    mtm._v3MetaAxesCache = {
        versionKey: 'epa|mock-bf',
        muPhatic: basis(phaticDim),
        muDrill: basis(24),
        muEscape: basis(23),
        eDrill: basis(24),
        eEscape: basis(23),
        phSamples: [basis(phaticDim)],
        drillSamples: [basis(24)],
        escapeSamples: [basis(23)]
    };
    mtm._v3StarPoolCache = new Map([[
        'mock-boundary-footprint.sqlite\0希夷星池簇',
        {
            versionKey: 'no-manifold|bf',
            manifoldKey: 'no-manifold',
            checkedAt: Date.now(),
            stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(),
            starSlots: new Set(),
            starMeanAxis: null,
            betaStar: 0.85,
            tauExtremeZ: Math.sqrt(2 * Math.log(20)),
            gumbelAN: 0.40,
            gumbelBN: 2.0,
            pairMeanCos: 0,
            pairStdCos: 0.089,
            nnStepMed: 1.12,
            epaMean,
            epaDigest: 'bf-epa'
        }
    ]]);

    // 1) Mixed-diary anti-dilution: without diaries, 星卡3 (k=3) wins on torque;
    //    with 2 conforming diaries + wormhole 803 (score=0.42, topologyBonus=0.08), 跨界暗流星 (k=5) flips Star 3 and lights | ℳ
    const qDomain = unit(Array.from({ length: dim }, (_, k) => (k === 0 ? 0.75 : (k === 1 ? 0.58 : (k === 3 ? 0.08 : (k === 26 ? 0.30 : 0))))));
    const fNoDiary = await mtm.processMetaThinkingV3('希夷星池簇', qDomain, '无日记基线', '', 'bf-nod', false, {
        userVector: qDomain
    });
    const bNoDiary = broadcasts.pop();
    assert.notEqual(bNoDiary.stars[2].name, '跨界暗流星');
    assert.ok(!fNoDiary.includes('| ℳ'));

    const fMixed = await mtm.processMetaThinkingV3('希夷星池簇', qDomain, '剖析跨界虫洞暗流耦合机制', '', 'bf-mix', false, {
        userVector: qDomain,
        activeDiaryChunks: [
            { chunkId: 801, diaryName: '技术笔记', score: 0.93, topologyBonus: 0, riverRole: 'direct_answer' },
            { chunkId: 802, diaryName: '技术笔记', score: 0.91, topologyBonus: 0, riverRole: 'thematic_neighbor' },
            { chunkId: 803, diaryName: 'VCP开发', score: 0.42, topologyBonus: 0.08, riverRole: 'wormhole' }
        ]
    });
    const bMix = broadcasts.pop();
    assert.equal(bMix.stars[2].name, '跨界暗流星', 'dark-undercurrent wormhole footprint must win Star 3 without centroid dilution');
    assert.equal(bMix.memorySteered, true, 'dark-undercurrent footprint must light | ℳ');
    assert.ok(fMixed.includes('| ℳ'));

    // 2) Echo-chamber silence: diaries inside span(z1, z2, zPrevAi) naturally saturate to null without | ℳ
    const aiPrev = basis(2);
    const fEcho = await mtm.processMetaThinkingV3('希夷星池簇', qDomain, '继续沿此结构深挖', '', 'bf-echo', false, {
        userVector: qDomain,
        aiVector: basis(19),
        timeFlowShift: 1.0,
        activeDiaryChunks: [
            { chunkId: 804, diaryName: '技术笔记', score: 0.95, topologyBonus: 0.05 }
        ]
    });
    const bEcho = broadcasts.pop();
    assert.equal(bEcho.diaryBridgeSource, 'active-diaries-saturated', 'in-plane echo diary must naturally saturate');
    assert.equal(bEcho.memorySteered, false, 'echo-chamber diary must NOT falsely light | ℳ');
    assert.ok(!fEcho.includes('| ℳ'));

    // Also verify _v3BuildDiaryBridge strips damped zPrevAi per diary cleanly
    const echoBridge = await mtm._v3BuildDiaryBridge(
        { async getVectorByChunkId(id) { return diaryVecs.get(id) || null; } },
        [{ chunkId: 805, diaryName: '技术笔记', score: 0.95, topologyBonus: 0.08 }],
        ['希夷星池簇'], null, null, 0.85, basis(0), basis(1), null, new Map(),
        { zPrevAi: aiPrev, timeFlowShift: 1.0 }
    );
    assert.equal(echoBridge.source, 'active-diaries-saturated');
    assert.equal(echoBridge.vector, null);
    assert.deepEqual(echoBridge.footprints, []);

    // 3) C7 isolation regression: high-phatic bait must reject activeDiaryChunks even with high topologyBonus
    const c7Bait = unit(Array.from({ length: dim }, (_, k) => (k === phaticDim ? 0.82 : (k === 5 ? 0.45 : (k === 26 ? 0.35 : 0)))));
    const fC7 = await mtm.processMetaThinkingV3('希夷星池簇', mixUnitArr(c7Bait, 0.7, basis(18), 0.3), '绝了太丝滑了完全赞同继续！', '', 'bf-c7', false, {
        userVector: c7Bait,
        aiVector: basis(18),
        historyAssistantVectors: [basis(17), basis(16)],
        activeDiaryChunks: [
            { chunkId: 803, diaryName: 'VCP开发', score: 0.92, topologyBonus: 0.08, riverRole: 'wormhole' }
        ]
    });
    const bC7 = broadcasts.pop();
    assert.equal(bC7.independentObservationUsed, true, 'C7 bait must engage preferIndependentObs');
    assert.notEqual(bC7.diaryBridgeSource, 'active-diaries', 'C7 must block activeDiaryChunks even with topologyBonus');
    assert.equal(bC7.memorySteered, false, 'C7 must never trigger | ℳ via diary backdoor');
    assert.ok(!fC7.includes('| ℳ'));
});

test('Frenet torsion3 & normalStep3: singularity-free 1D collinearity, 2D planar loops, noisy jitter stagnation, 3D helical deep-dive exemption, and scale invariance', async () => {
    const dim = 24;
    const basis = (idx) => { const v = new Float32Array(dim); v[idx] = 1; return v; };
    const pool = { pairMeanCos: 0, pairStdCos: 0.0889, orthTopScale: 0.38, nnStepMed: 1.118, gumbelBN: 3.017, tauExtremeZ: 3.626, stars: new Array(716) };
    const mtm = new MetaThinkingManager({});

    // 1) Boundary singularity: strict 1D geodesic forward progression -> torsion3 ≈ 0, no NaN
    const th = Math.acos(0.95);
    const mono1D = [0, 1, 2, 3].map(k => unit(Array.from({ length: dim }, (_, i) => (i === 0 ? Math.cos(k * th) : (i === 1 ? Math.sin(k * th) : 0)))));
    const kinMono1D = mtm._v3ComputeAgentKinematics([mono1D[0], mono1D[1], mono1D[2]], mono1D[3], null, null, 0.85, { starPool: pool });
    assert.ok(Number.isFinite(kinMono1D.torsion3) && kinMono1D.torsion3 < 1e-5, `1D geodesic torsion3 must be finite & ~0, got ${kinMono1D.torsion3}`);
    assert.ok(Number.isFinite(kinMono1D.normalStep3) && kinMono1D.normalStep3 < 1e-5);
    assert.equal(kinMono1D.helicalDeepDive, false);
    assert.equal(kinMono1D.stagnant, false);

    // 2) Boundary singularity: strict 1D ping-pong (v2 = -v1) -> torsion3 ≈ 0, oscillating=true, stagnant=true, no NaN
    const ppA = basis(0);
    const ppB = unit(Array.from({ length: dim }, (_, i) => (i === 0 ? 0.65 : (i === 1 ? Math.sqrt(1 - 0.65 * 0.65) : 0))));
    const kinPP1D = mtm._v3ComputeAgentKinematics([ppA, ppB, ppA], ppB, null, null, 0.85, { starPool: pool });
    assert.ok(Number.isFinite(kinPP1D.torsion3) && kinPP1D.torsion3 < 1e-5, `1D ping-pong torsion3 must be finite & ~0, got ${kinPP1D.torsion3}`);
    assert.equal(kinPP1D.oscillating, true);
    assert.equal(kinPP1D.stagnant, true);
    assert.equal(kinPP1D.helicalDeepDive, false);

    // 3) Degenerate frozen history (A -> A -> A -> B) -> torsion3 === 0, no NaN
    const kinFrozen = mtm._v3ComputeAgentKinematics([ppA, ppA, ppA], mixUnitArr(ppA, 0.9, basis(1), 0.43), null, null, 0.85, { starPool: pool });
    assert.equal(kinFrozen.torsion3, 0);
    assert.equal(kinFrozen.normalStep3, 0);

    // 4) 2D planar slow spirals (75°/90°/100°) -> torsion3 ≈ 0, stagnant === true
    for (const deg of [90, 100]) {
        const rad = 0.32;
        const bVal = Math.sqrt(1 - rad * rad);
        const ang = (deg * Math.PI) / 180;
        const sp2D = [0, 1, 2, 3].map(k => unit(Array.from({ length: dim }, (_, i) => {
            if (i === 0) return bVal;
            if (i === 1) return rad * Math.cos(k * ang);
            if (i === 2) return rad * Math.sin(k * ang);
            return 0;
        })));
        const kinSp = mtm._v3ComputeAgentKinematics([sp2D[0], sp2D[1], sp2D[2]], sp2D[3], null, null, 0.85, { starPool: pool });
        assert.ok(kinSp.torsion3 < 0.05, `2D ${deg}° loop torsion3 must stay ~0, got ${kinSp.torsion3}`);
        assert.equal(kinSp.helicalDeepDive, false);
        assert.equal(kinSp.stagnant, true, `2D ${deg}° loop must remain stagnant`);
    }

    // 5) High-dim noisy stagnation (frozen/loop jitter with isotropic orthogonal noise -> fake high torsion3, but small normalStep3 < halfStep/√3) -> MUST remain stagnant=true
    const noisyFrozen = [
        basis(0),
        unit(Array.from({ length: dim }, (_, i) => (i === 0 ? 0.99 : (i === 1 ? 0.14 : 0)))),
        unit(Array.from({ length: dim }, (_, i) => (i === 0 ? 0.99 : (i === 2 ? 0.14 : 0)))),
        unit(Array.from({ length: dim }, (_, i) => (i === 0 ? 0.99 : (i === 3 ? 0.14 : 0))))
    ];
    const kinNoisy = mtm._v3ComputeAgentKinematics([noisyFrozen[0], noisyFrozen[1], noisyFrozen[2]], noisyFrozen[3], null, null, 0.85, { starPool: pool });
    assert.ok(kinNoisy.torsion3 > 0.55, 'high-dim isotropic jitter naturally exhibits high normalized torsion3');
    assert.equal(kinNoisy.helicalDeepDive, false, 'small normalStep3 must block fake-torsion exemption');
    assert.equal(kinNoisy.stagnant, true, 'noisy frozen stagnation must remain stagnant=true');

    // 6) Tight-basin 3D helical deep dive (rho4 <= basinRadiusCrit, R4 < 1, 3 mutually orthogonal sub-dimensions, normalStep3 >= halfStep/√3) -> helicalDeepDive=true, stagnant=false, mEndo=0
    const rHelix = 0.36;
    const bHelix = Math.sqrt(1 - rHelix * rHelix);
    const helix = [
        unit(Array.from({ length: dim }, (_, i) => (i === 0 ? bHelix : (i === 1 ? -0.5 * rHelix : 0)))),
        unit(Array.from({ length: dim }, (_, i) => (i === 0 ? bHelix : (i === 1 ? rHelix : 0)))),
        unit(Array.from({ length: dim }, (_, i) => (i === 0 ? bHelix : (i === 2 ? rHelix : 0)))),
        unit(Array.from({ length: dim }, (_, i) => (i === 0 ? bHelix : (i === 3 ? rHelix : 0))))
    ];
    const kinHelix = mtm._v3ComputeAgentKinematics([helix[0], helix[1], helix[2]], helix[3], null, null, 0.85, { starPool: pool });
    const halfStep = Math.sqrt(2 * Math.sqrt(3) * pool.pairStdCos);
    assert.ok(kinHelix.basinRadiusK <= halfStep / Math.SQRT2 && kinHelix.diffusionRatio4 < 1.0, 'helix must lie inside tight subdiffusive basin');
    assert.ok(kinHelix.torsion3 >= 1 / Math.sqrt(3), `expected torsion3 >= 1/sqrt(3), got ${kinHelix.torsion3}`);
    assert.ok(kinHelix.normalStep3 >= halfStep / Math.sqrt(3), `expected normalStep3 >= halfStep/sqrt(3), got ${kinHelix.normalStep3}`);
    assert.equal(kinHelix.helicalDeepDive, true, '3D orthogonal tight-basin deep dive must set helicalDeepDive=true');
    assert.equal(kinHelix.stagnant, false, 'helicalDeepDive must exempt false stagnation');
    assert.equal(kinHelix.mEndo, 0, 'exempted helicalDeepDive must emit zero mEndo');

    // 7) Scale invariance under 10k-star pool densification (nnStepMed drops from 1.25 to 0.65 while pairStdCos is fixed)
    const densePool = { ...pool, nnStepMed: 0.65 };
    const kinHelixDense = mtm._v3ComputeAgentKinematics([helix[0], helix[1], helix[2]], helix[3], null, null, 0.85, { starPool: densePool });
    assert.equal(kinHelixDense.torsion3, kinHelix.torsion3);
    assert.equal(kinHelixDense.normalStep3, kinHelix.normalStep3);
    assert.equal(kinHelixDense.helicalDeepDive, true);
    assert.equal(kinHelixDense.stagnant, false);

    // 8) Telemetry broadcast exposes agentTorsion3, agentNormalStep3, agentHelicalDeepDive
    const epaMean = basis(23);
    const stars = Array.from({ length: 20 }, (_, i) => ({
        chunkId: i + 1, fileId: i + 1, diaryName: '希夷星池簇', sourceFile: `星卡${i}.md`, starName: `星卡${i}`,
        text: `星卡${i}`, raw: basis(i), x: basis(i), z: basis(i), zRaw: basis(i), radius: 0.63, leg: null
    }));
    const bc = [];
    const mtmBc = new MetaThinkingManager({
        vectorDBManager: {
            dbPath: 'mock-torsion-bc.sqlite',
            async executeNativeRiverQuery() {
                return {
                    omega: { omega: 0.6, regime: 'dense', omegaFlow: 0.7 },
                    diagnostics: { queryProfile: { mode: 'propositional' } },
                    results: stars.slice(0, 4).map((st, idx) => ({
                        chunkId: st.chunkId, diaryName: '希夷星池簇', sourceFile: st.sourceFile, text: st.text, score: 0.9 - idx * 0.1
                    }))
                };
            }
        },
        pushVcpInfo: (info) => bc.push(info)
    });
    mtmBc._v3MetaAxesCache = {
        versionKey: 'epa|mock-tbc', muPhatic: basis(20), muDrill: basis(21), muEscape: basis(22),
        eDrill: basis(21), eEscape: basis(22), phSamples: [basis(20)], drillSamples: [basis(21)], escapeSamples: [basis(22)]
    };
    mtmBc._v3StarPoolCache = new Map([[
        'mock-torsion-bc.sqlite\0希夷星池簇',
        {
            versionKey: 'no-manifold|tbc', manifoldKey: 'no-manifold', checkedAt: Date.now(), stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])), byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(), starSlots: new Set(), starMeanAxis: null, betaStar: 0.85,
            tauExtremeZ: 3.626, gumbelAN: 0.28, gumbelBN: 3.017, pairMeanCos: 0, pairStdCos: 0.0889,
            nnStepMed: 1.118, epaMean, epaDigest: 'tbc-epa'
        }
    ]]);
    await mtmBc.processMetaThinkingV3('希夷星池簇', helix[3], '深入探讨正交三维结构', '', 'tbc', false, {
        userVector: helix[3],
        aiVector: helix[3],
        historyAssistantVectors: [helix[0], helix[1], helix[2]]
    });
    assert.equal(bc[0].agentHelicalDeepDive, true);
    assert.ok(bc[0].agentTorsion3 >= 1 / Math.sqrt(3));
    assert.ok(bc[0].agentNormalStep3 >= halfStep / Math.sqrt(3));
});

test('Spectral Coarse Subspace (Partial-Go 2a): U_k is orthonormal, small pools skip coarse build, and large pools match full Star 2/3 & | M', async () => {
    const mtm = new MetaThinkingManager({});
    const smallPool = await mtm._v3LoadStarPoolCache(singleStarReader(), ['希夷星池簇'], null);
    assert.ok(smallPool?.stars.length);
    assert.equal(smallPool.coarseSubspace, null, 'small star pools stay on the exact scan');

    // 2) Orthonormality & lossless 2-stage Star 2/3 + | M agreement on a 2000-star multi-mode pool (dim=384)
    const N = 2000;
    const D = 384;
    let seed = 98765;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const zMat = new Float32Array(N * D);
    const stars = [];
    for (let i = 0; i < N; i++) {
        let ns = 0;
        const off = i * D;
        for (let c = 0; c < D; c++) {
            const amp = c < 128 ? (2.5 / Math.sqrt(c + 4)) : 0.05;
            const v = (rand() + rand() - 1) * amp;
            zMat[off + c] = v;
            ns += v * v;
        }
        const inv = 1 / Math.sqrt(Math.max(1e-18, ns));
        for (let c = 0; c < D; c++) zMat[off + c] *= inv;
        const zi = zMat.subarray(off, off + D);
        stars.push({ chunkId: i + 1, starName: `BigStar_${i}`, sourceFile: `BigStar_${i}.md`, text: `BigStar_${i}`, z: zi, x: zi, radius: 0.63 });
    }
    const coarse = mtm._v3BuildCoarseSubspace(zMat, N, D, 0.089);
    assert.ok(coarse && coarse.k >= 64 && coarse.k < D, `expected spectrum-derived k in [64, ${D}), got ${coarse?.k}`);
    for (let a = 0; a < Math.min(20, coarse.k); a++) {
        for (let b = a; b < Math.min(20, coarse.k); b++) {
            let dp = 0;
            for (let c = 0; c < D; c++) dp += coarse.uk[a * D + c] * coarse.uk[b * D + c];
            const expected = a === b ? 1 : 0;
            assert.ok(Math.abs(dp - expected) < 1e-4, `U_k orthonormality error at (${a},${b}): ${dp}`);
        }
    }

    const cands = stars.map(s => ({ item: { chunkId: s.chunkId, sourceFile: s.sourceFile, text: s.text, score: 0 }, starName: s.starName }));
    const poolBase = {
        stars,
        zMatrix: zMat,
        zDim: D,
        indexByStarName: new Map(stars.map((s, i) => [s.starName, i])),
        byStarName: new Map(stars.map(s => [s.starName, s])),
        pairMeanCos: 0,
        pairStdCos: 0.089,
        gumbelAN: 0.25,
        gumbelBN: 3.31
    };
    const poolCoarse = { ...poolBase, coarseSubspace: coarse };

    let agree2 = 0;
    let agree3 = 0;
    let agreeFlip = 0;
    const trials = 16;
    for (let t = 0; t < trials; t++) {
        const s1Idx = (t * 113) % N;
        const qArr = new Float32Array(D);
        for (let c = 0; c < D; c++) qArr[c] = (rand() - 0.5) * (c < 128 ? (2.5 / Math.sqrt(c + 4)) : 0.05);
        const zQ = unit(qArr);
        const fps = Array.from({ length: 6 }, (_, m) => ({
            vector: stars[(t * 59 + m * 211 + 7) % N].z,
            weight: 0.35 + 0.08 * m
        }));
        const common = {
            deduplicatedCandidates: cands,
            lockedPrimary: { item: cands[s1Idx].item, starName: cands[s1Idx].starName, slot: 'primary' },
            zQuery: zQ,
            tensionTangentZ: zQ,
            ejectImpulseZ: zQ,
            timeFlowZ: zQ,
            diaryFootprints: fps
        };
        const exact = mtm._selectV3TrinityStars([], { ...common, starPool: poolBase });
        const fast = mtm._selectV3TrinityStars([], { ...common, starPool: poolCoarse });
        if (fast[1].starName === exact[1].starName) agree2++;
        if (fast[2].starName === exact[2].starName) agree3++;
        if (Boolean(fast[2]._memoryFlippedWinner) === Boolean(exact[2]._memoryFlippedWinner)) agreeFlip++;
    }
    assert.equal(agree2, trials, `2-stage Star 2 must match 100% (${agree2}/${trials})`);
    assert.equal(agree3, trials, `2-stage Star 3 must match 100% (${agree3}/${trials})`);
    assert.equal(agreeFlip, trials, `2-stage counterfactual | ℳ flag must match 100% (${agreeFlip}/${trials})`);
});

function mixUnitArr(a, wa, b, wb) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = wa * a[i] + wb * b[i];
    return unit(out);
}

test('P1-1/P1-2/P1-3/P1-4 regressions: async worker coarseSubspace, lowLoad TOCTOU guard, pre-sort diary bridge + rrf_score, and low-rank eigen stability', async (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Database = require('better-sqlite3');

    // P1-4: Degenerate rank-10 2000-star pool drops Float32 noise eigenvalues <= 1e-6 and normalizes every U_k row
    const mtm = new MetaThinkingManager({});
    {
        const N = 2000;
        const D = 384;
        const zMat = new Float32Array(N * D);
        const bases = [];
        let seed = 777;
        const rand = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        for (let b = 0; b < 10; b++) {
            const v = new Float32Array(D);
            for (let c = 0; c < D; c++) v[c] = rand() - 0.5;
            bases.push(unit(v));
        }
        for (let i = 0; i < N; i++) zMat.set(bases[i % 10], i * D);
        const coarse = mtm._v3BuildCoarseSubspace(zMat, N, D, 0.089);
        assert.ok(coarse && coarse.k === 10, `expected rank-10 coarse k=10 without noise columns, got ${coarse?.k}`);
        for (let r = 0; r < coarse.k; r++) {
            let ns = 0;
            for (let c = 0; c < D; c++) ns += coarse.uk[r * D + c] * coarse.uk[r * D + c];
            assert.ok(Math.abs(Math.sqrt(ns) - 1) < 1e-4, `row ${r} must be unit norm, got ${Math.sqrt(ns)}`);
        }
    }

    // P1-1: >= 2000*3072 pool returns immediately with coarseSubspace=null and hot-fills via background worker_threads
    {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-p11-worker-'));
        t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });
        const dbPath = path.join(tmpDir, 'large_pool.sqlite');
        const db = new Database(dbPath);
        db.exec(`
            CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, diary_name TEXT, updated_at INTEGER);
            CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, vector_version INTEGER, content TEXT, vector BLOB);
            CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE kbm_runtime_meta (key TEXT PRIMARY KEY, value TEXT);
        `);
        const N = 2000;
        const D = 3072;
        const vec = new Float32Array(D);
        const insertFile = db.prepare('INSERT INTO files VALUES (?, ?, ?, 100)');
        const insertChunk = db.prepare('INSERT INTO chunks VALUES (?, ?, 1, ?, ?)');
        const tx = db.transaction(() => {
            for (let i = 0; i < N; i++) {
                vec.fill(0);
                vec[i % D] = 0.8;
                vec[(i * 7 + 13) % D] = 0.6;
                const blob = Buffer.from(vec.buffer.slice(0));
                insertFile.run(i + 1, `Big_${i}.md`, '大星池');
                insertChunk.run(i + 1, i + 1, `Big_${i}`, blob);
            }
        });
        tx();
        db.close();

        const mtmWorker = new MetaThinkingManager({});
        const t0 = Date.now();
        const pool = await mtmWorker._v3LoadStarPoolCache(fixtureStarReader(dbPath), ['大星池'], null, { ttlMs: 0 });
        const syncLoadMs = Date.now() - t0;
        assert.ok(pool && pool.stars.length === N);
        assert.equal(pool.coarseSubspace, null, 'initial load must NOT block main thread building coarseSubspace');
        assert.ok(syncLoadMs < 2000, `sync load must return fast without 3s eigen block, got ${syncLoadMs}ms`);
        await mtmWorker.waitCoarseSubspaceBuilds();
        assert.ok(pool.coarseSubspace && pool.coarseSubspace.k >= 64, 'background worker must hot-fill pool.coarseSubspace');
        assert.equal(pool.coarseSubspace.zMatrixK.length, N * pool.coarseSubspace.k);
    }

    // P1-2: _v3LowLoadObsCache TOCTOU across 15000ms boundary must NOT pass nativePreparedQuery-less snapshot to executeNativeRiverQuery
    {
        const dim = 24;
        const basis = (idx) => { const v = new Float32Array(dim); v[idx] = 1; return v; };
        const epaMean = basis(23);
        const stars = Array.from({ length: 20 }, (_, i) => {
            const v = basis(i);
            return { chunkId: i + 1, fileId: i + 1, diaryName: '希夷星池簇', sourceFile: `星卡${i}.md`, starName: `星卡${i}`, text: `星卡${i}`, raw: v, x: v, z: v, zRaw: v, radius: 0.63 };
        });
        let execCalls = 0;
        const mockVdb = {
            dbPath: 'mock-toctou.sqlite',
            async prepareUnifiedMemoObservation({ vector }) {
                return {
                    observationHandle: 'h-toctou',
                    nativePreparedQuery: { queryState: true, denoisedVector: vector, localVector: vector, transferVector: vector },
                    enhancedVector: vector,
                    sourceObservationResult: {
                        epa: { logicDepth: 0.5, inDomainGate: 0.9 },
                        matchedTags: [],
                        pyramid: { depth: 1, totalExplainedEnergy: 0.8, levels: [{ energyExplained: 0.8, tags: [{ name: 'T', contribution: 0.8 }] }] }
                    }
                };
            },
            releaseMemoObservation() { return true; },
            async getTagVectorByName() { return basis(4); },
            async executeNativeRiverQuery(_q, opts) {
                execCalls++;
                if (!opts?.preparedMemoObservation?.nativePreparedQuery) {
                    throw Object.assign(new Error('RiverMemo requires Rust-native prepared dual fields'), { code: 'RIVERMEMO_NATIVE_DUAL_FIELDS_UNAVAILABLE' });
                }
                return {
                    omega: { omega: 0.5, regime: 'dense' },
                    results: [{ chunkId: 1, diaryName: '希夷星池簇', sourceFile: '星卡0.md', text: '星卡0', score: 0.9 }]
                };
            }
        };
        const mtmT = new MetaThinkingManager({ vectorDBManager: mockVdb });
        mtmT._v3MetaAxesCache = { muPhatic: basis(20), eDrill: basis(21), eEscape: basis(22), phSamples: [basis(20)], drillSamples: [basis(21)], escapeSamples: [basis(22)] };
        mtmT._v3LoadGlobalManifold = () => null;
        mtmT._v3LoadStarPoolCache = () => ({
            versionKey: 'toctou-v1', manifoldKey: 'none', checkedAt: Date.now(), stars,
            byChunkId: new Map(stars.map(s => [s.chunkId, s])),
            byStarName: new Map(stars.map(s => [s.starName, s])),
            bySlot: new Map(), starSlots: new Set(), starMeanAxis: null, betaStar: 0.85,
            tauExtremeZ: 3.0, gumbelAN: 0.33, gumbelBN: 2.0, pairMeanCos: 0, pairStdCos: 0.089, epaMean, epaDigest: 'toctou'
        });

        const phaticU = unit(Array.from({ length: dim }, (_, i) => (i === 20 ? 0.98 : (i === 0 ? 0.20 : 0))));
        const aiU = basis(0);
        // Turn 1 populates _v3LowLoadObsCache
        const f1 = await mtmT.processMetaThinkingV3('希夷星池簇', aiU, '继续！', '', 't1', false, {
            userVector: phaticU, aiVector: aiU, historyAssistantVectors: [aiU]
        });
        assert.ok(f1.length > 0 && execCalls === 1);

        // Simulate 14999ms elapsed at L4693 then crossing 15000ms before _v3QueryStarPool L3590
        const vdbCache = mtmT._v3LowLoadObsCache.get(mockVdb);
        const [cacheEntry] = [...vdbCache.values()];
        const origNow = Date.now;
        cacheEntry.cachedAt = 100000;
        let stepClock = 114999;
        const origQueryStarPool = mtmT._v3QueryStarPool.bind(mtmT);
        mtmT._v3QueryStarPool = async (...args) => {
            stepClock = 115005;
            return origQueryStarPool(...args);
        };
        Date.now = () => stepClock;
        try {
            const f2 = await mtmT.processMetaThinkingV3('希夷星池簇', aiU, '继续！', '', 't2', false, {
                userVector: phaticU, aiVector: aiU, historyAssistantVectors: [aiU]
            });
            assert.ok(f2.length > 0, 'TOCTOU across 15s TTL boundary must still produce valid V3 formula without crashing');
            assert.equal(execCalls, 1, 'cached primaryQuery must be reused directly without re-entering executeNativeRiverQuery');
        } finally {
            mtmT._v3QueryStarPool = origQueryStarPool;
            Date.now = origNow;
        }
    }

    // P1-3: _collectV3DiaryBridgeChunks sorts rag/time before associate by rrf_score ?? rerank_score ?? score before slice(0, 8)
    {
        const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
        const rag = new ragSingleton.constructor();
        const items = [
            { chunkId: 1, diaryName: '技术笔记', source: 'associate', rrf_score: 0.050, score: 0.99 },
            ...Array.from({ length: 8 }, (_, idx) => ({
                chunkId: 10 + idx,
                diaryName: '技术笔记',
                source: 'rag',
                rrf_score: 0.010 + idx * 0.002,
                score: 0.90 - idx * 0.05
            })),
            { chunkId: 99, diaryName: '技术笔记', source: 'time', rrf_score: 0.045, score: 0.50 }
        ];
        const snap = [];
        const rc = rag._createRequestCache();
        rag._collectV3DiaryBridgeChunks(items, snap, rc, true);
        assert.equal(snap.length, 8);
        assert.equal(snap[0].chunkId, 99, 'highest rrf_score time item beyond index 8 must rise to position 0');
        assert.equal(snap[0].score, 0.045, 'useRerankScore=true must read rrf_score before score');
        assert.ok(!snap.some(s => s.chunkId === 1), 'associate item must rank behind top-8 rag/time items');
    }
});

test('Star 3 3-bit exposureIndex3: quantile cuts, boundary/tie handling, and silent fallback when N < 16', async (t) => {
    const os = require('node:os');
    const Database = require('better-sqlite3');
    const mtm = new MetaThinkingManager({});

    // 1) N < 16 returns null from _v3BuildExposureIndex3 and silently falls back in _selectV3TrinityStars
    const smallMat = new Float32Array(12 * 8);
    assert.equal(mtm._v3BuildExposureIndex3(smallMat, 12, 8), null);

    {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-exp3-small-'));
        t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });
        const dbPath = path.join(tmpDir, 'small.sqlite');
        const db = new Database(dbPath);
        db.exec(`
            CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, diary_name TEXT, updated_at INTEGER);
            CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, vector_version INTEGER, content TEXT, vector BLOB);
        `);
        const D = 16;
        for (let i = 0; i < 10; i++) {
            db.prepare('INSERT INTO files (id, path, diary_name, updated_at) VALUES (?, ?, ?, ?)').run(i + 1, `小星${i}.md`, '希夷星池簇', 1000);
            const arr = new Float32Array(D);
            arr[i % D] = 1;
            db.prepare('INSERT INTO chunks (id, file_id, vector_version, content, vector) VALUES (?, ?, ?, ?, ?)').run(
                i + 1, i + 1, 1, `小星${i}`, Buffer.from(arr.buffer)
            );
        }
        db.close();
        const smallPool = await mtm._v3LoadStarPoolCache(fixtureStarReader(dbPath), ['希夷星池簇'], null, { ttlMs: 0 });
        assert.ok(smallPool && smallPool.stars.length === 10);
        assert.equal(smallPool.exposureIndex3, null, 'pools with < 16 stars must skip exposureIndex3');
        const cands = smallPool.stars.map((s, idx) => ({
            item: { chunkId: s.chunkId, sourceFile: s.sourceFile, text: s.text, score: idx === 0 ? 0.9 : 0.1 },
            starName: s.starName
        }));
        const picked = mtm._selectV3TrinityStars([], {
            deduplicatedCandidates: cands,
            zQuery: smallPool.stars[0].z,
            ejectImpulseZ: smallPool.stars[1].z,
            starPool: smallPool
        });
        assert.equal(picked.length, 3);
        assert.equal(picked[2].uniqueExposureCdf, null, 'N < 16 must fall back to pure Rayleigh torqueDeficit');
    }

    // 2) N >= 16 builds cuts(7*D), tau(D) = (Q75-Q25)/8, binMass(8*D), codes(N*D) accurately, including ties & boundaries
    const N = 16;
    const D = 4;
    const zMat = new Float32Array(N * D);
    for (let i = 0; i < N; i++) {
        // dim 0: strictly increasing 0..15
        zMat[i * D + 0] = i;
        // dim 1: constant tie (all 0.5)
        zMat[i * D + 1] = 0.5;
        // dim 2: 50%+ tied at 0.5 (10 samples at 0.5, 2 below, 4 above)
        zMat[i * D + 2] = i < 2 ? -1.0 + i * 0.5 : (i < 12 ? 0.5 : 1.0 + (i - 12));
        // dim 3: negative/positive spread
        zMat[i * D + 3] = (i - 7.5) * 0.1;
    }
    const idx3 = mtm._v3BuildExposureIndex3(zMat, N, D);
    assert.ok(idx3);
    assert.equal(idx3.cuts.length, 7 * D);
    assert.equal(idx3.tau.length, D);
    assert.equal(idx3.binMass.length, 8 * D);
    assert.equal(idx3.codes.length, N * D);

    for (let d = 0; d < D; d++) {
        const expectedTau = (idx3.cuts[5 * D + d] - idx3.cuts[1 * D + d]) / 8;
        assert.ok(Math.abs(idx3.tau[d] - expectedTau) < 1e-6, `tau[${d}] must equal (Q75-Q25)/8`);
        let massSum = 0;
        for (let b = 0; b < 8; b++) {
            const m = idx3.binMass[b * D + d];
            assert.ok(m >= 0 && m <= 1);
            massSum += m;
        }
        assert.ok(Math.abs(massSum - 1.0) < 1e-6, `binMass sum for dim ${d} must be 1.0, got ${massSum}`);
    }
    // Boundary check on strictly increasing dim 0: min -> bin 0, max -> bin 7
    assert.equal(idx3.codes[0 * D + 0], 0);
    assert.equal(idx3.codes[(N - 1) * D + 0], 7);
    // Constant tie dim 1: tau === 0, all stars in bin 0
    assert.equal(idx3.tau[1], 0);
    assert.equal(idx3.binMass[0 * D + 1], 1);
    for (let i = 0; i < N; i++) assert.equal(idx3.codes[i * D + 1], 0);

    // Tied-cuts query must produce finite non-negative U_new scores with zero NaN
    const qTie = new Float32Array([7.5, 0.5, 0.5, 0.0]);
    const uTie = mtm._v3ComputeUniqueExposureScores(idx3, qTie, 0, 1);
    assert.ok(uTie && uTie.length === N);
    for (let i = 0; i < N; i++) {
        assert.ok(Number.isFinite(uTie[i]) && uTie[i] >= 0, `U_new[${i}] must be finite >= 0`);
    }
});

test('Star 3 U_new(x | s1, s2) blind-spot mask: zero duplicate credit for s1/s2-covered dims, high score only in blind dims', () => {
    const mtm = new MetaThinkingManager({});
    const N = 20;
    const D = 16;
    const zMat = new Float32Array(N * D);
    // Background stars 0..15 establish clean quantile range [-1, +1] across all dims
    for (let i = 0; i < 16; i++) {
        const val = -1 + (2 * i) / 15;
        for (let d = 0; d < D; d++) {
            zMat[i * D + d] = val * ((d % 2 === 0) ? 1 : -1);
        }
    }
    // Query sits near +1.0 on all dims; background is centered so +1.0 lies strictly in top bin 7 (far from -1.0 bin 0)
    const q = new Float32Array(D).fill(1.0);
    const s1Idx = 16;
    const s2Idx = 17;
    const sameUnionIdx = 18;
    const blindHitIdx = 19;

    // Star s1 hits dims 0..3, misses 4..15
    for (let d = 0; d < D; d++) zMat[s1Idx * D + d] = d < 4 ? 1.0 : -1.0;
    // Star s2 hits dims 4..7, misses 0..3 and 8..15
    for (let d = 0; d < D; d++) zMat[s2Idx * D + d] = (d >= 4 && d < 8) ? 1.0 : -1.0;
    // Candidate sameUnion hits dims 0..7 (exact union of s1 & s2), misses blind dims 8..15
    for (let d = 0; d < D; d++) zMat[sameUnionIdx * D + d] = d < 8 ? 1.0 : -1.0;
    // Candidate blindHit misses dims 0..7 and hits blind dims 8..15
    for (let d = 0; d < D; d++) zMat[blindHitIdx * D + d] = d >= 8 ? 1.0 : -1.0;

    const idx3 = mtm._v3BuildExposureIndex3(zMat, N, D);
    assert.ok(idx3);
    const u = mtm._v3ComputeUniqueExposureScores(idx3, q, s1Idx, s2Idx);
    assert.ok(u);
    assert.equal(u[s1Idx], 0, 's1 must receive 0 unique exposure');
    assert.equal(u[s2Idx], 0, 's2 must receive 0 unique exposure');
    assert.equal(u[sameUnionIdx], 0, 'candidate hitting only s1 U s2 covered dims must receive 0 unique exposure');
    assert.ok(u[blindHitIdx] > 5.0, `blind-spot hitting candidate must get high U_new, got ${u[blindHitIdx]}`);
});

test('Star 3 U_new first-order scale conservation preserves mean torqueDeficit and does not squeeze | M counterfactual flip', () => {
    const mtm = new MetaThinkingManager({});
    const N = 24;
    const D = 48;
    const zMat = new Float32Array(N * D);
    const stars = [];
    for (let i = 0; i < N; i++) {
        const v = new Float32Array(D);
        // Orthogonal primary axis i (dims 0..23) + smooth shared-basis spread on dims 24..47
        v[i] = 1.0;
        for (let d = 24; d < D; d++) {
            v[d] = 0.08 * Math.sin((i + 1) * (d + 1) * 1.37);
        }
        const zu = mtm._v3NormalizeVector(v);
        zMat.set(zu, i * D);
        stars.push({ chunkId: i + 1, starName: `星${i}`, sourceFile: `星${i}.md`, text: `星${i}`, z: zu, x: zu, radius: 0.63 });
    }
    const expIdx3 = mtm._v3BuildExposureIndex3(zMat, N, D);
    assert.ok(expIdx3);
    const basePool = {
        stars,
        zMatrix: zMat,
        zDim: D,
        indexByStarName: new Map(stars.map((s, i) => [s.starName, i])),
        byStarName: new Map(stars.map(s => [s.starName, s])),
        pairMeanCos: 0,
        pairStdCos: 1 / Math.sqrt(D),
        gumbelAN: 0.4,
        gumbelBN: 2.1
    };
    const expPool = { ...basePool, exposureIndex3: expIdx3 };
    const cands = stars.map((s, i) => ({
        item: { chunkId: s.chunkId, sourceFile: s.sourceFile, text: s.text, score: i === 0 ? 0.9 : 0.1 },
        starName: s.starName
    }));

    const zQ = stars[15].z;
    const zEj = stars[10].z;
    const zTime = stars[12].z;
    const pickedNoExp = mtm._selectV3TrinityStars([], {
        deduplicatedCandidates: cands,
        lockedPrimary: { item: cands[0].item, starName: cands[0].starName, slot: 'primary' },
        lockedConjugate: { item: cands[1].item, starName: cands[1].starName, slot: 'conjugate' },
        zQuery: zQ,
        zExpQuery: zQ,
        ejectImpulseZ: zEj,
        timeFlowZ: zTime,
        starPool: basePool
    });
    const pickedWithExp = mtm._selectV3TrinityStars([], {
        deduplicatedCandidates: cands,
        lockedPrimary: { item: cands[0].item, starName: cands[0].starName, slot: 'primary' },
        lockedConjugate: { item: cands[1].item, starName: cands[1].starName, slot: 'conjugate' },
        zQuery: zQ,
        zExpQuery: zQ,
        ejectImpulseZ: zEj,
        timeFlowZ: zTime,
        starPool: expPool
    });
    assert.equal(pickedNoExp[2].uniqueExposureCdf, null);
    assert.ok(Number.isFinite(pickedWithExp[2].uniqueExposureCdf) && pickedWithExp[2].uniqueExposureCdf > 0 && pickedWithExp[2].uniqueExposureCdf < 1);
    assert.ok(pickedWithExp[2].torqueDeficit >= 0 && pickedWithExp[2].torqueDeficit <= 1);

    // Direct verification of first-order scale conservation: mean(fusedTorque) <= mean(rawTorque) + 1e-9
    // and | M counterfactual flip via diaryFootprints is preserved without squeezing
    const fpStar = stars[20];
    const pickedBaseDiary = mtm._selectV3TrinityStars([], {
        deduplicatedCandidates: cands,
        lockedPrimary: { item: cands[0].item, starName: cands[0].starName, slot: 'primary' },
        lockedConjugate: { item: cands[1].item, starName: cands[1].starName, slot: 'conjugate' },
        zQuery: zQ,
        zExpQuery: zQ,
        ejectImpulseZ: zEj,
        timeFlowZ: zTime,
        diaryFootprints: [{ vector: fpStar.z, weight: 1.10 }],
        starPool: basePool
    });
    const pickedWithDiary = mtm._selectV3TrinityStars([], {
        deduplicatedCandidates: cands,
        lockedPrimary: { item: cands[0].item, starName: cands[0].starName, slot: 'primary' },
        lockedConjugate: { item: cands[1].item, starName: cands[1].starName, slot: 'conjugate' },
        zQuery: zQ,
        zExpQuery: zQ,
        ejectImpulseZ: zEj,
        timeFlowZ: zTime,
        diaryFootprints: [{ vector: fpStar.z, weight: 1.10 }],
        starPool: expPool
    });
    assert.equal(pickedBaseDiary[2].starName, fpStar.starName);
    assert.equal(pickedWithDiary[2].starName, fpStar.starName, 'diaryFootprints must still steer Star 3 cleanly');
    assert.equal(pickedBaseDiary[2]._memoryFlippedWinner, true);
    assert.equal(pickedWithDiary[2]._memoryFlippedWinner, true, '| M counterfactual flip must NOT be squeezed out by U_new fusion');
});

test('Star 3 C7 isolation: preferIndependentObs=true prevents C7 tech-praise bait from hijacking zExpQuery or U_new', async (t) => {
    const os = require('node:os');
    const Database = require('better-sqlite3');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-exp3-c7-'));
    t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });
    const dbPath = path.join(tmpDir, 'c7_pool.sqlite');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, diary_name TEXT, updated_at INTEGER);
        CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, vector_version INTEGER, content TEXT, vector BLOB);
    `);
    const D = 32;
    const basis = (idx) => {
        const a = new Float32Array(D);
        a[idx] = 1;
        return a;
    };
    const epaMean = basis(29);
    // 20 stars: star 0..17 in dims 0..17, star 18 = 夸赞诱饵星 (aligned with dim 20 bait), star 19 = 本域锚星
    for (let i = 0; i < 20; i++) {
        const name = i === 18 ? '夸赞诱饵星' : `常规星${i}`;
        db.prepare('INSERT INTO files (id, path, diary_name, updated_at) VALUES (?, ?, ?, ?)').run(i + 1, `${name}.md`, '希夷星池簇', 1000);
        const arr = new Float32Array(D);
        if (i === 18) {
            arr[20] = 0.95;
            arr[21] = 0.25;
        } else {
            arr[i % 18] = 0.9;
            arr[(i + 5) % 18] = 0.35;
        }
        const u = mtmNorm(arr);
        db.prepare('INSERT INTO chunks (id, file_id, vector_version, content, vector) VALUES (?, ?, ?, ?, ?)').run(
            i + 1, i + 1, 1, name, Buffer.from(u.buffer)
        );
    }
    db.close();

    function mtmNorm(a) {
        let s = 0;
        for (let i = 0; i < a.length; i++) s += a[i] * a[i];
        const inv = 1 / Math.sqrt(s);
        return Float32Array.from(a, v => v * inv);
    }

    const broadcasts = [];
    const mockVdb = {
        ...fixtureStarReader(dbPath, epaMean),
        async executeNativeRiverQuery() {
            return { results: [{ chunkId: 1, diaryName: '希夷星池簇', sourceFile: '常规星0.md', text: '常规星0', score: 0.9 }], diagnostics: { degraded: false } };
        },
        async prepareUnifiedMemoObservation({ vector }) {
            return { enhancedVector: vector, sourceObservationResult: { matchedTags: [] } };
        },
        releaseMemoObservation() {}
    };
    const mtm = new MetaThinkingManager({
        vectorDBManager: mockVdb,
        pushVcpInfo: (info) => broadcasts.push(info)
    });
    mtm._v3LoadGlobalManifold = () => null;
    mtm._v3MetaAxesCache = {
        muPhatic: basis(25),
        eDrill: basis(26),
        eEscape: basis(27),
        phSamples: [basis(25)],
        drillSamples: [basis(26)],
        escapeSamples: [basis(27)]
    };

    const starPool = await mtm._v3LoadStarPoolCache(mockVdb, ['希夷星池簇'], null, { ttlMs: 0 });
    assert.ok(starPool && starPool.exposureIndex3, 'real >= 20 star pool must build exposureIndex3');

    const seenZExp = [];
    const origCompExp = mtm._v3ComputeUniqueExposureScores.bind(mtm);
    mtm._v3ComputeUniqueExposureScores = (ei, zExpQ, s1, s2, candIdx) => {
        seenZExp.push(Float32Array.from(zExpQ));
        return origCompExp(ei, zExpQ, s1, s2, candIdx);
    };

    const aiVec = mtmNorm(Float32Array.from({ length: D }, (_, d) => (d === 0 ? 0.85 : (d === 3 ? 0.5 : 0))));
    const phaticPureVec = basis(25);
    const c7BaitVec = mtmNorm(Float32Array.from({ length: D }, (_, d) => (d === 25 ? 0.93 : (d === 20 ? 0.36 : 0))));

    // Baseline pure phatic turn
    await mtm.processMetaThinkingV3('希夷星池簇', aiVec, '嗯嗯好的', '', 'c1', false, {
        userVector: phaticPureVec,
        aiVector: aiVec,
        historyAssistantVectors: [aiVec]
    });
    const baseInfo = broadcasts[broadcasts.length - 1];

    // C7 praise + bait turn
    await mtm.processMetaThinkingV3('希夷星池簇', mtmNorm(Float32Array.from({ length: D }, (_, d) => 0.7 * c7BaitVec[d] + 0.3 * aiVec[d])), '说得太对了，夸赞诱饵星真的很妙', '', 'c7', false, {
        userVector: c7BaitVec,
        aiVector: aiVec,
        historyAssistantVectors: [aiVec]
    });
    const c7Info = broadcasts[broadcasts.length - 1];

    assert.equal(baseInfo.independentObservationUsed, true);
    assert.equal(c7Info.independentObservationUsed, true);
    assert.equal(c7Info.stars[2].name, baseInfo.stars[2].name, 'C7 bait must not flip Star 3 away from pure-AI baseline');
    assert.notEqual(c7Info.stars[2].name, '夸赞诱饵星', 'C7 bait star must not hijack Star 3 via U_new');
    assert.equal(seenZExp.length, 2);
    assert.ok(mtm._v3Dot(seenZExp[0], seenZExp[1]) > 0.9999, 'zExpQuery under preferIndependentObs must match pure AI axis and remain immune to C7 bait');
});

test('Star 3 2,000-star two-stage coarse subspace + exposureIndex3 computes U_new only on evalThirdCandidates', () => {
    const mtm = new MetaThinkingManager({});
    const N = 2000;
    const D = 384;
    let seed = 20261124;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const zMat = new Float32Array(N * D);
    const stars = [];
    for (let i = 0; i < N; i++) {
        let ns = 0;
        const off = i * D;
        for (let c = 0; c < D; c++) {
            const amp = c < 128 ? (2.5 / Math.sqrt(c + 4)) : 0.05;
            const v = (rand() + rand() - 1) * amp;
            zMat[off + c] = v;
            ns += v * v;
        }
        const inv = 1 / Math.sqrt(Math.max(1e-18, ns));
        for (let c = 0; c < D; c++) zMat[off + c] *= inv;
        const zi = zMat.subarray(off, off + D);
        stars.push({ chunkId: i + 1, starName: `BigExp_${i}`, sourceFile: `BigExp_${i}.md`, text: `BigExp_${i}`, z: zi, x: zi, radius: 0.63 });
    }
    const coarse = mtm._v3BuildCoarseSubspace(zMat, N, D, 0.089);
    const exposureIndex3 = mtm._v3BuildExposureIndex3(zMat, N, D);
    assert.ok(coarse && exposureIndex3);

    const cands = stars.map(s => ({ item: { chunkId: s.chunkId, sourceFile: s.sourceFile, text: s.text, score: 0 }, starName: s.starName }));
    const poolCoarseExp = {
        stars,
        zMatrix: zMat,
        zDim: D,
        coarseSubspace: coarse,
        exposureIndex3,
        indexByStarName: new Map(stars.map((s, i) => [s.starName, i])),
        byStarName: new Map(stars.map(s => [s.starName, s])),
        pairMeanCos: 0,
        pairStdCos: 0.089,
        gumbelAN: 0.25,
        gumbelBN: 3.31
    };

    const recordedCounts = [];
    const origCompExp = mtm._v3ComputeUniqueExposureScores.bind(mtm);
    mtm._v3ComputeUniqueExposureScores = (ei, zExpQ, s1, s2, candIdx) => {
        recordedCounts.push(candIdx ? candIdx.length : ei.nStars);
        return origCompExp(ei, zExpQ, s1, s2, candIdx);
    };

    const qArr = new Float32Array(D);
    for (let c = 0; c < D; c++) qArr[c] = (rand() - 0.5) * (c < 128 ? (2.5 / Math.sqrt(c + 4)) : 0.05);
    const zQ = unit(qArr);
    const picked = mtm._selectV3TrinityStars([], {
        deduplicatedCandidates: cands,
        lockedPrimary: { item: cands[0].item, starName: cands[0].starName, slot: 'primary' },
        zQuery: zQ,
        zExpQuery: zQ,
        tensionTangentZ: zQ,
        ejectImpulseZ: zQ,
        timeFlowZ: zQ,
        starPool: poolCoarseExp
    });

    assert.equal(picked.length, 3);
    assert.equal(new Set(picked.map(s => s.starName)).size, 3);
    assert.ok(Number.isFinite(picked[2].slingshotScore));
    assert.ok(Number.isFinite(picked[2].uniqueExposureCdf) && picked[2].uniqueExposureCdf > 0 && picked[2].uniqueExposureCdf < 1);
    assert.equal(recordedCounts.length, 1);
    assert.ok(recordedCounts[0] > 0 && recordedCounts[0] < 400, `2000-star coarse mode must score only evalThirdCandidates (<400), got ${recordedCounts[0]}`);
});













