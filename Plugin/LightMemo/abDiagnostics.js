'use strict';

// 仅格式化原生查询回执，不求解图、不读取数据库、不修改排序。
function formatDiagnostics(plugin, request, response) {
    const cell = value => plugin._escapeMarkdownCell(value);
    const json = value => cell(JSON.stringify(value) ?? '未返回');
    const number = value => typeof value === 'number' && Number.isFinite(value)
        ? value.toFixed(4) : '未返回';
    const observation = response.memoObservation || {};
    const river = response.river;
    let output = '\n## RiverMemo 查询诊断\n\n';
    output += `- 请求 CoreTag：${json(request.coreTags)}\n`;
    output += `- 查询命中标签：${json(observation.queryTags?.matchedTags)}\n`;
    output += `- 实际命中 CoreTag：${json(observation.queryTags?.coreTagsMatched)}\n`;
    output += `- 请求 tag_boost：${request.tagBoost}；core_boost_factor：${request.coreBoostFactor}；实际标签增益：${number(observation.effectiveTagBoost)}\n`;
    if (!river) {
        return output + '- RiverMemo 未执行（候选池为空或原生未返回），没有可用的传播图和读出诊断。\n';
    }
    output += `- 资产：${cell(river.artifactSig || observation.artifactSig || '未返回')}；查询 ID：${cell(river.queryId || observation.queryId || '未返回')}\n`;
    output += `- 原生读出版本：${cell(river.algorithmVersion || '未返回')}\n`;
    output += `- Ω / 河网状态：${json(river.omega)}\n`;
    output += `- 查询形态：${json(river.queryMorphology)}\n\n`;
    const section = (title, parameters) => {
        output += `### ${title}\n\n`;
        if (!parameters || !Object.keys(parameters).length) {
            output += '原生未返回；请确认已重建匹配版本的原生模块。\n\n';
            return;
        }
        output += '| 参数 | 值 |\n|---|---|\n';
        for (const [key, value] of Object.entries(parameters)) {
            output += `| ${cell(key)} | ${json(value)} |\n`;
        }
        output += '\n';
    };
    section('传播参数（原生解析值）', observation.propagation?.parameters);
    section('Topology 读出参数（原生解析值；retiredControls 所列字段不再生效）', river.parameters);
    const graph = river.queryRiverGraph;
    output += '### 查询传播图\n\n';
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        output += '原生未返回传播图快照（不代表没有传播）；请重建匹配版本的原生模块。\n\n';
    } else {
        output += `展示 ${graph.nodes.length}/${graph.totalNodes} 个节点、${graph.edges.length}/${graph.totalEdges} 条边；`;
        output += graph.truncated ? '展示已截断，计算仍使用完整观测。\n\n' : '快照完整。\n\n';
        output += '| Tag ID | 标签 | Hop | 来源 | 能量 | 归一化能量 |\n|---:|---|---:|---|---:|---:|\n';
        const names = new Map();
        for (const node of graph.nodes) {
            names.set(node.id, node.name || `Tag ${node.id}`);
            output += `| ${node.id} | ${cell(node.name || '未命名')} | ${node.hop} | ${cell(node.sourceType)} | ${number(node.energy)} | ${number(node.normalizedEnergy)} |\n`;
        }
        output += '\n传播方向图（源 → 目标；保留回流和虫洞标记）：\n\n';
        output += '| 源 → 目标 | 流量 | 归一化流量 | 虫洞 | 即时回流 |\n|---|---:|---:|---|---|\n';
        for (const edge of graph.edges) {
            const source = `${names.get(edge.sourceId) || 'Tag'} (#${edge.sourceId})`;
            const target = `${names.get(edge.targetId) || 'Tag'} (#${edge.targetId})`;
            output += `| ${cell(source)} → ${cell(target)} | ${number(edge.flow)} | ${number(edge.normalizedFlow)} | ${edge.wormhole === true} | ${edge.immediateReturn === true} |\n`;
        }
        if (!graph.edges.length) output += '\n本次快照无传播边。\n';
        output += '\n';
    }
    section('传播诊断', graph?.diagnostics || observation.propagation?.diagnostics);
    section('EPA', observation.epa);
    section('残差金字塔', observation.pyramid);
    const explained = river.candidateDiagnostics || river.results || [];
    output += '### RiverMemo 候选解释\n\n';
    output += `解释候选 ${explained.length} 条（包含 Top-K 之外的共同池候选，如原生已提供）。\n\n`;
    const wormholeMode = river.algorithmVersion?.startsWith('rivermemo.wormhole-readout-');
    if (wormholeMode) {
        output += '独立虫洞通道：最终分＝最强路线的相对流量 × 终点正文正余弦；不是原查询底分加奖励，也不是相关性概率。无可用虫洞才整通道回退查询余弦。精确标签／来源文件仅为文件级地址诊断，不证明该 Chunk 回答问题。\n\n';
        output += '| Chunk | 排名 | 通道 | 原查询余弦 | 路线 | 原始流量 | 相对流量 | 终点正文余弦 | 最终分 | 地址定位 | 精确终点标签 | 边来源文件 |\n|---:|---:|---|---:|---|---:|---:|---:|---:|---|---|---|\n';
        const name = id => (graph?.nodes || []).find(node => node.id === id)?.name || `Tag#${id}`;
        for (const item of explained) {
            const trace = item.topologyV3 || {};
            const readout = trace.wormholeReadout || {};
            const route = readout.sourceId == null ? '—'
                : `${name(readout.sourceId)} → ${name(readout.targetId)}`;
            output += `| ${item.chunkId ?? item.id} | ${item.rank ?? '—'} | ${cell(item.role)} | ${number(trace.queryScore ?? item.vectorScore)} | ${cell(route)} | ${number(readout.flow)} | ${number(readout.relativeFlow)} | ${number(readout.endpointBodyCosine)} | ${number(item.score)} | ${cell(readout.location || '未返回')} | ${readout.exactTargetTag === true} | ${readout.edgeSourceFile === true} |\n`;
        }
        output += '\n';
        section('原生检索诊断', response.diagnostics);
        section('RiverMemo 读出诊断', river.diagnostics);
        return output;
    }
    const rrfMode = river.algorithmVersion?.includes('confidence-rrf');
    if (rrfMode) {
        output += '严格全局门控后的解释力度 RRF：原 RiverMemo 排名保留为基线通道；有效虫洞贡献按相对普通传播的流量力度与 Ω 加权。最终分为融合分，不是下方原评分分项之和；未触发时保留原分。\n\n';
        output += '| Chunk | 原排名 | 原评分 | 基线 RRF | 虫洞 RRF | 最终分 | 路线解释 |\n|---:|---:|---:|---:|---:|---:|---|\n';
        for (const item of explained) {
            const fusion = item.topologyV3?.wormholeRrf || {};
            output += `| ${item.chunkId ?? item.id} | ${fusion.baselineRank ?? '—'} | ${number(fusion.baselineScore)} | ${number(fusion.baselineContribution)} | ${number(fusion.wormholeContribution)} | ${number(item.score)} | ${json(fusion.winner)} |\n`;
        }
    }
    const endpointMode = river.algorithmVersion?.startsWith('rivermemo.source-endpoint-');
    output += rrfMode ? '下表保留原评分分项供审计；最终分列为上述融合结果。\n\n' : endpointMode
        ? '有效意图候选：基础分为原查询余弦；直锚列为直接意图证据分账，图奖励列为来源条件化传播的边际分账，共享单一预算；旧场共振、路径和图形匹配只作诊断。无有效意图候选保留兼容回退。最终分＝基础分＋路径奖励＋图奖励＋直锚奖励－截断扣分。\n\n'
        : '基础分已包含场共振增益；最终分＝基础分＋路径奖励＋图奖励＋直锚奖励－截断扣分，勿重复累加场共振。\n\n';
    output += '| Chunk | 角色 | 语义基础分 | 场分 | 场共振增益 | 路径奖励 | 图奖励 | 拓扑合计 | 直锚奖励 | 截断扣分 | 最终分 | 标签 | CoreTag |\n|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|\n';
    for (const item of explained) {
        output += `| ${item.chunkId ?? item.id} | ${cell(item.role)} | ${number(item.baseScore)} | ${number(item.fieldScore)} | ${number(item.fieldResonanceBonus)} | ${number(item.pathBonus)} | ${number(item.graphBonus)} | ${number(item.topologyBonus)} | ${number(item.anchorBonus)} | ${number(item.scoreClipping)} | ${number(item.score)} | ${json(item.matchedTags)} | ${json(item.coreTagsMatched)} |\n`;
    }
    if (river.parameters?.wormholeScoring && !rrfMode) {
        output += '\n### 虫洞辅助加权（保留原拓扑与 Ω 门控）\n\n';
        output += '虫洞只在原拓扑预算内增加图奖励，不替换基础分、路径、直锚或 Ω。无合格证据时增量为零；两个文件重复关联不等于独立证据。\n\n';
        output += '| Chunk | 原最终分 | 原图奖励 | 新增图奖励 | 最终分增量 | 路线证据 |\n|---:|---:|---:|---:|---:|---|\n';
        for (const item of explained) {
            const aux = item.topologyV3?.wormholeAuxiliary;
            if (!aux) continue;
            output += `| ${item.chunkId ?? item.id} | ${number(aux.originalFinalScore)} | ${number(aux.originalGraphBonus)} | ${number(aux.addedGraphBonus)} | ${number(aux.addedFinalScore)} | ${json(aux.readout)} |\n`;
        }
    }
    output += '\n### 意图账本（点火能量与区分权重分离）\n\n';
    for (const item of explained) {
        const intent = item.topologyV3?.intentReadout;
        if (!intent?.available) continue;
        output += `\nChunk ${item.chunkId ?? item.id}：合取满足度 ${number(intent.satisfaction)}；直接满足度 ${number(intent.directSatisfaction)}；${endpointMode ? '传播边际提升' : '虫洞提升'} ${number(intent.wormholeLift)}。\n\n`;
        output += '| Chunk | 意图种子 | 权重 | 留一残差能量 | 查询独立解释量 | 直接支持 | 传播支持 | 满足度 | 路线 | 电流校准 | 终点落地 | 虫洞 |\n|---:|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|\n';
        for (const axis of intent.ledger || []) {
            const name = id => (graph?.nodes || []).find(node => node.id === id)?.name || `Tag#${id}`;
            const route = axis.routeTarget == null ? '—'
                : `${name(axis.routeSource)} → ${name(axis.routeTarget)}`;
            output += `| ${item.chunkId ?? item.id} | ${cell((axis.seedIds || []).map(name).join(' / '))} | ${number(axis.weight)} | ${number(axis.residualEnergy)} | ${number(axis.queryExplanation)} | ${number(axis.directSupport)} | ${number(axis.wormholeSupport)} | ${number(axis.satisfaction)} | ${cell(route)} | ${number(axis.routeCurrent)} | ${number(axis.endpointGrounding)} | ${axis.routeIsWormhole === true} |\n`;
        }
    }
    output += '\n详细测绘（拓扑可靠性、锚点可靠性、覆盖率、路径几何和 Ω 门控）：\n\n';
    for (const item of explained) {
        for (const key of ['topologyV3', 'relativeTopology', 'geometry', 'observables']) {
            if (item[key]) output += `\n- Chunk ${item.chunkId ?? item.id} ${key}：${json(item[key])}\n\n`;
        }
    }
    section('原生检索诊断', response.diagnostics);
    section('RiverMemo 读出诊断', river.diagnostics);
    return output;
}

module.exports = { formatDiagnostics };