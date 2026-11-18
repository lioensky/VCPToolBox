const fs = require('fs').promises;
const path = require('path');

// 目标 JSON 文件路径（编辑暂存文件，由 SemanticGroupManager 自动 merge 到主文件）。
// 测试环境可通过 SEMANTIC_GROUPS_PATH 指向隔离夹具，避免触碰生产数据。
const SEMANTIC_GROUPS_PATH = process.env.SEMANTIC_GROUPS_PATH
    ? path.resolve(process.env.SEMANTIC_GROUPS_PATH)
    : path.join(__dirname, '..', 'RAGDiaryPlugin', 'semantic_groups.edit.json');

// ============ 文件 I/O ============

async function readSemanticGroupsFile() {
    try {
        const data = await fs.readFile(SEMANTIC_GROUPS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { config: {}, groups: {} };
        }
        throw new Error(`读取语义组文件失败: ${error.message}`);
    }
}

async function writeSemanticGroupsFile(data) {
    const tempPath = `${SEMANTIC_GROUPS_PATH}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tempPath, SEMANTIC_GROUPS_PATH);
    } catch (error) {
        try {
            await fs.unlink(tempPath);
        } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
                console.error(`清理语义组临时文件失败: ${cleanupError.message}`);
            }
        }
        throw new Error(`写入语义组文件失败: ${error.message}`);
    }
}

// ============ 串语法解析器 ============

function parseBatchCommands(request) {
    const commandEntries = Object.keys(request)
        .map(key => {
            const match = key.match(/^command(\d+)$/);
            return match ? { key, index: Number(match[1]) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index);

    if (commandEntries.length === 0) {
        return [request];
    }

    return commandEntries.map(({ key, index }) => {
        const cmd = { command: request[key] };
        for (const paramKey of Object.keys(request)) {
            const match = paramKey.match(/^(.*?)(\d+)$/);
            if (!match || Number(match[2]) !== index || paramKey === key) continue;
            if (match[1]) cmd[match[1]] = request[paramKey];
        }
        return cmd;
    });
}

// ============ 命令实现 ============

/**
 * QueryGroups - 查询语义组
 * 可选参数 groupname：逗号分隔的组名列表，不传则返回全部
 */
async function queryGroups(params) {
    const data = await readSemanticGroupsFile();
    const groups = data.groups || {};

    let targetNames = null;
    if (params.groupname) {
        targetNames = params.groupname.split(',').map(n => n.trim()).filter(Boolean);
    }

    let resultText = '';
    const notFound = [];

    if (targetNames) {
        for (const name of targetNames) {
            if (groups[name]) {
                const g = groups[name];
                const words = g.words || [];
                const autoLearned = g.auto_learned || [];
                resultText += `【${name}】\n`;
                resultText += `  权重: ${g.weight ?? 1}\n`;
                resultText += `  词元 (${words.length}): ${words.join(', ')}\n`;
                if (autoLearned.length > 0) {
                    resultText += `  自动学习 (${autoLearned.length}): ${autoLearned.join(', ')}\n`;
                }
                resultText += `\n`;
            } else {
                notFound.push(name);
            }
        }
        if (notFound.length > 0) {
            resultText += `⚠️ 未找到的组名: ${notFound.join(', ')}\n`;
        }
        if (resultText === '' && notFound.length === 0) {
            resultText = '当前系统中没有任何语义词元组。';
        }
    } else {
        // 全量列举
        const groupNames = Object.keys(groups);
        if (groupNames.length === 0) {
            resultText = '当前系统中没有任何语义词元组。';
        } else {
            resultText = `共 ${groupNames.length} 个语义组：\n\n`;
            for (const [name, g] of Object.entries(groups)) {
                const words = g.words || [];
                const autoLearned = g.auto_learned || [];
                resultText += `【${name}】 权重:${g.weight ?? 1} | 词元(${words.length}): ${words.join(', ')}`;
                if (autoLearned.length > 0) {
                    resultText += ` | 自学(${autoLearned.length}): ${autoLearned.join(', ')}`;
                }
                resultText += `\n`;
            }
        }
    }

    return { success: true, result: resultText.trim() };
}

/**
 * UpdateGroups - 更新或创建语义组的词元
 */
async function updateGroups(params) {
    const { groupname, groupwords } = params;
    if (!groupname || !groupwords) {
        return { success: false, error: "缺少必需参数。请提供 'groupname' 和 'groupwords'。" };
    }

    const data = await readSemanticGroupsFile();
    const groups = data.groups || {};

    const wordsArray = groupwords.split(',').map(w => w.trim()).filter(Boolean);
    const isNew = !groups[groupname];

    if (isNew) {
        groups[groupname] = {
            words: wordsArray,
            auto_learned: [],
            weight: 1
        };
    } else {
        groups[groupname].words = wordsArray;
    }

    data.groups = groups;
    await writeSemanticGroupsFile(data);

    const action = isNew ? '新建' : '更新';
    return { success: true, result: `已${action}组「${groupname}」，词元数: ${wordsArray.length}。` };
}

/**
 * SetWeight - 设置组权重
 * 参数：groupname（必需，逗号分隔支持多组）、weight（必需，大于 0 的有限数字）
 */
async function setWeight(params) {
    const { groupname, weight } = params;
    if (!groupname) return { success: false, error: '缺少 groupname 参数。' };
    if (weight === undefined || weight === null || weight === '') {
        return { success: false, error: '缺少 weight 参数。' };
    }

    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) {
        return { success: false, error: `weight 必须是大于 0 的有限数字，收到: "${weight}"` };
    }

    const data = await readSemanticGroupsFile();
    const groups = data.groups || {};

    const names = groupname.split(',').map(n => n.trim()).filter(Boolean);
    const updated = [];
    const notFound = [];

    for (const name of names) {
        if (groups[name]) {
            groups[name].weight = w;
            updated.push(name);
        } else {
            notFound.push(name);
        }
    }

    if (updated.length === 0) {
        return { success: false, error: `所有指定组名均不存在: ${notFound.join(', ')}` };
    }

    data.groups = groups;
    await writeSemanticGroupsFile(data);

    let result = `已将 [${updated.join(', ')}] 的权重设为 ${w}。`;
    if (notFound.length > 0) {
        result += `\n⚠️ 未找到: ${notFound.join(', ')}`;
    }
    result += `\n提示: 权重变更将在 VCP 后端下次启动时由 SemanticGroupManager 自动 merge 生效。`;
    return { success: true, result };
}

// ============ 命令路由 ============

function dispatch(command, params) {
    switch (command) {
        case 'QueryGroups': return queryGroups(params);
        case 'UpdateGroups': return updateGroups(params);
        case 'SetWeight': return setWeight(params);
        default: return Promise.resolve({ success: false, error: `未知指令: ${command}` });
    }
}

// ============ 主逻辑 ============

async function main() {
    let input = '';
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        input += chunk;
    }

    try {
        const request = JSON.parse(input);
        const commands = parseBatchCommands(request);
        const results = [];

        for (const cmd of commands) {
            const response = await dispatch(cmd.command, cmd, request);
            results.push(response);
        }

        // 聚合输出
        const allSuccess = results.every(r => r.success);
        const combinedResult = results.map((r, i) => {
            if (commands.length > 1) {
                const prefix = `[步骤${i + 1}/${commands.length} ${commands[i].command}]`;
                return r.success ? `${prefix} ✅\n${r.result}` : `${prefix} ❌\n${r.error}`;
            }
            return r.success ? r.result : r.error;
        }).join('\n\n');

        if (allSuccess) {
            console.log(JSON.stringify({ status: "success", result: combinedResult }));
        } else {
            // 部分失败时仍返回 success 状态以展示结果，通过内容区分
            const hasAnySuccess = results.some(r => r.success);
            console.log(JSON.stringify({
                status: hasAnySuccess ? "success" : "error",
                result: hasAnySuccess ? combinedResult : undefined,
                error: hasAnySuccess ? undefined : combinedResult
            }));
        }
    } catch (e) {
        console.log(JSON.stringify({ status: "error", error: e.message }));
        process.exit(1);
    }
}

main();
