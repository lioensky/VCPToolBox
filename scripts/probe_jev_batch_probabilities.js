'use strict';

// Live opt-in probe. Supply a temporary key through stdin, never a command argument.
// Does not load dotenv, read diaries, write reports, or print upstream errors.
const fs = require('node:fs');
const { JevClient } = require('../modules/jevClient');

const query = '部署后数据库连接耗尽，日志提示 too many connections，如何修复连接泄漏？';
const prompt = '请选择最值得用于回答当前查询的记忆。综合逻辑关联、信息解释力，优先能直接回答问题的内容，压低重复、跑题或仅有表面词汇重合的内容。';
const docs = {
    target: '数据库报 too many connections 时，检查连接池 active/idle/waiting 指标。所有事务及查询必须在 finally 中释放连接，避免异常分支泄漏；限制连接池上限并预留管理连接。',
    strong: '本次事故已定位：订单接口异常后跳过 client.release()，持续占用连接。修复为 try/finally 释放，并回滚未完成事务；上线后 active 恢复正常。',
    partial: '数据库连接数过高时，先检查应用实例数乘以每实例连接池上限，是否超过数据库 max_connections。避免只提高数据库连接数。',
    weak: '今天讨论了数据库培训安排，下周继续学习 SQL。',
    unrelated: '晚餐准备番茄鸡蛋面，先炒鸡蛋再煮面。',
    unrelated2: '周末计划去公园散步，留意天气和防晒。'
};
const cases = [
    ['weak_competition', ['target', 'weak', 'unrelated']],
    ['strong_competition', ['target', 'strong', 'partial']],
    ['larger_pool', ['target', 'strong', 'partial', 'weak', 'unrelated', 'unrelated2']],
    ['reversed_pool', ['unrelated2', 'unrelated', 'weak', 'partial', 'strong', 'target']],
    ['duplicate_target', ['target', 'target_copy', 'weak']]
];

async function main() {
    // stdin is deliberately the only credential source.
    let key = fs.readFileSync(0, 'utf8').trim();
    if (!key || /[\r\n]/.test(key)) {
        console.error('Supply exactly one temporary API key through stdin.');
        process.exitCode = 1;
        return;
    }
    const rows = [];
    const client = new JevClient({
        provider: 'typesafe',
        url: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-latest',
        proxyUrl: 'http://127.0.0.1:7897',
        maxRetries: 0,
        timeoutMs: 30000
    });
    try {
        for (const [name, ids] of cases) {
            const criteria = Object.fromEntries(ids.map((id, index) => [
                `doc_${String(index).padStart(3, '0')}`,
                docs[id === 'target_copy' ? 'target' : id]
            ]));
            const started = Date.now();
            const data = await client.decide(
                { task: 'rag_memory_rerank', query, candidate_count: ids.length },
                { best_memory: { type: 'choice', instructions: prompt, criteria } },
                { apiKey: key }
            ).catch(error => {
                throw new Error(error.status ? `HTTP_${error.status}` : 'NETWORK_OR_RESPONSE_ERROR');
            });
            const answer = data?.answers?.best_memory;
            const probabilities = ids.map((id, index) => {
                const probability = answer?.probabilities?.[`doc_${String(index).padStart(3, '0')}`];
                if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
                    throw new Error('INVALID_PROBABILITY');
                }
                return { id, probability };
            });
            const row = {
                case: name, probabilities,
                probabilitySum: probabilities.reduce((sum, item) => sum + item.probability, 0),
                targetProbability: probabilities.find(item => item.id === 'target').probability,
                latencyMs: Date.now() - started,
                inputTokens: data.usage?.input_tokens ?? null
            };
            rows.push(row);
            console.log(JSON.stringify(row));
        }
        const values = rows.map(row => row.targetProbability);
        console.log(JSON.stringify({
            summary: 'Same target/query/prompt; candidate sets differ. Small exploratory sample, not a calibration benchmark.',
            targetMin: Math.min(...values), targetMax: Math.max(...values),
            targetSpread: Math.max(...values) - Math.min(...values)
        }));
    } finally {
        client.destroy();
        key = '';
    }
}

main().catch(error => {
    // Do not log request objects, headers, error causes or response bodies.
    const message = /^HTTP_\d+$|^INVALID_PROBABILITY$/.test(error.message)
        ? error.message : 'NETWORK_OR_RESPONSE_ERROR';
    console.error(`Probe stopped: ${message}`);
    process.exitCode = 1;
});