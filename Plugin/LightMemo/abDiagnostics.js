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
    section('Topology 读出参数（传入原生；未列项采用原生默认值）', river.parameters);
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
    output += '### RiverMemo 候选解释\n\n';
    output += '| Chunk | 角色 | 语义基础分 | 路径奖励 | 图奖励 | 拓扑合计 | 直锚奖励 | 截断扣分 | 最终分 | 标签 | CoreTag |\n|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|\n';
    for (const item of river.results || []) {
        output += `| ${item.chunkId ?? item.id} | ${cell(item.role)} | ${number(item.baseScore)} | ${number(item.pathBonus)} | ${number(item.graphBonus)} | ${number(item.topologyBonus)} | ${number(item.anchorBonus)} | ${number(item.scoreClipping)} | ${number(item.score)} | ${json(item.matchedTags)} | ${json(item.coreTagsMatched)} |\n`;
    }
    output += '\n详细测绘（拓扑可靠性、锚点可靠性、覆盖率、路径几何和 Ω 门控）：\n\n';
    for (const item of river.results || []) {
        for (const key of ['topologyV3', 'relativeTopology', 'geometry', 'observables']) {
            if (item[key]) output += `\n- Chunk ${item.chunkId ?? item.id} ${key}：${json(item[key])}\n\n`;
        }
    }
    section('原生检索诊断', response.diagnostics);
    section('RiverMemo 读出诊断', river.diagnostics);
    return output;
}

module.exports = { formatDiagnostics };