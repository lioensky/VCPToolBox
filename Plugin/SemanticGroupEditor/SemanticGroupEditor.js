const fs = require('fs').promises;
const path = require('path');

// 目标JSON文件的路径，这里我们直接指向RAGDiaryPlugin中的文件
const SEMANTIC_GROUPS_PATH = path.join(__dirname, '..', 'RAGDiaryPlugin', 'semantic_groups.edit.json');

// --- 核心功能 ---

/**
 * 读取语义组文件
 */
async function readSemanticGroupsFile() {
    try {
        const data = await fs.readFile(SEMANTIC_GROUPS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // 如果文件不存在，返回一个空的结构
            return { config: {}, groups: {} };
        }
        throw new Error(`读取语义组文件失败: ${error.message}`);
    }
}

/**
 * 写入语义组文件
 * @param {object} data 要写入的完整JSON对象
 */
async function writeSemanticGroupsFile(data) {
    try {
        await fs.writeFile(SEMANTIC_GROUPS_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        throw new Error(`写入语义组文件失败: ${error.message}`);
    }
}

/**
 * 查询所有语义组
 */
async function queryGroups() {
    const data = await readSemanticGroupsFile();
    const groups = data.groups || {};
    let resultText = "当前系统中的语义词元组如下：\n\n";

    if (Object.keys(groups).length === 0) {
        resultText = "当前系统中没有任何语义词元组。";
    } else {
        for (const groupName in groups) {
            const words = groups[groupName].words || [];
            resultText += `组名: ${groupName}\n`;
            resultText += `词元: ${words.join(', ')}\n\n`;
        }
    }
    return { success: true, result: resultText.trim() };
}

/**
 * 更新一个或多个语义组
 * @param {object} params - 输入的参数对象
 */
async function updateGroups(params) {
    const data = await readSemanticGroupsFile();
    const groups = data.groups || {};
    let updatesCount = 0;
    let newGroupsCount = 0;
    const updatedGroupNames = [];

    // 检查是单个更新还是批量更新
    if (params.groupname && params.groupwords) {
        // 单个更新
        const { groupname, groupwords } = params;
        const wordsArray = groupwords.split(',').map(w => w.trim()).filter(Boolean);

        if (groups[groupname]) {
            updatesCount++;
        } else {
            newGroupsCount++;
        }
        
        // 创建或覆盖组
        if (groups[groupname]) {
            // 组已存在，只更新词元
            groups[groupname].words = wordsArray;
        } else {
            // 组不存在，创建新组并设置默认值
            groups[groupname] = {
                words: wordsArray,
                auto_learned: [],
                weight: 1,
                vector: null,
                last_activated: null,
                activation_count: 0,
                vector_id: null
            };
        }
        updatedGroupNames.push(groupname);

    } else {
        // 批量更新
        let i = 1;
        while (params[`groupname${i}`] && params[`groupwords${i}`]) {
            const groupname = params[`groupname${i}`];
            const groupwords = params[`groupwords${i}`];
            const wordsArray = groupwords.split(',').map(w => w.trim()).filter(Boolean);

            if (groups[groupname]) {
                updatesCount++;
            } else {
                newGroupsCount++;
            }

            if (groups[groupname]) {
                // 组已存在，只更新词元
                groups[groupname].words = wordsArray;
            } else {
                // 组不存在，创建新组并设置默认值
                groups[groupname] = {
                    words: wordsArray,
                    auto_learned: [],
                    weight: 1,
                    vector: null,
                    last_activated: null,
                    activation_count: 0,
                    vector_id: null
                };
            }
            updatedGroupNames.push(groupname);
            i++;
        }
    }
    
    if (updatedGroupNames.length === 0) {
        return { success: false, error: "没有提供有效的更新参数。请提供 'groupname' 和 'groupwords'。" };
    }

    data.groups = groups;
    await writeSemanticGroupsFile(data);

    let resultText = `操作成功！\n`;
    if (newGroupsCount > 0) {
        resultText += `- 新建了 ${newGroupsCount} 个词元组。\n`;
    }
    if (updatesCount > 0) {
        resultText += `- 更新了 ${updatesCount} 个词元组。\n`;
    }
    resultText += `涉及的组名: ${updatedGroupNames.join(', ')}`;

    return { success: true, result: resultText };
}


// --- 主逻辑 ---

async function main() {
    let input = '';
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        input += chunk;
    }

    try {
        const request = JSON.parse(input);
        // 兼容批量和单个指令
        const command = request.command || request.command1; 
        let response;

        switch (command) {
            case 'QueryGroups':
                response = await queryGroups();
                break;
            case 'UpdateGroups':
                response = await updateGroups(request);
                break;
            default:
                // 检查是否存在批量更新指令
                if (request.command1 || request.groupname1) {
                     response = await updateGroups(request);
                } else {
                    throw new Error(`未知的指令: ${command}`);
                }
        }

        if (response.success) {
            console.log(JSON.stringify({ status: "success", result: response.result }));
        } else {
            throw new Error(response.error);
        }
    } catch (e) {
        console.log(JSON.stringify({ status: "error", error: e.message }));
        process.exit(1);
    }
}

main();
