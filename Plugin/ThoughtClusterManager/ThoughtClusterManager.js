const fs = require('fs').promises;
const path = require('path');

const DAILYNOTE_DIR = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, '../../dailynote');
const META_CHAINS_PATH = path.join(__dirname, '..', 'RAGDiaryPlugin', 'meta_thinking_chains.json');

async function main() {
    try {
        const input = await readStdin();
        const request = JSON.parse(input);

        // 检查是否为串行调用
        if (request.command1) {
            const results = await processBatchRequest(request);
            const overallSuccess = results.every(r => r.success);
            const report = results.map((r, i) =>
                `[Command ${i + 1}]: ${r.success ? 'SUCCESS' : 'FAILED'}\n  - Message: ${r.message || r.error}`
            ).join('\n\n');
            
            console.log(JSON.stringify({ status: overallSuccess ? 'success' : 'error', result: `Batch processing completed.\n\n${report}` }));
        } else {
            // 处理单个命令
            const { command, ...parameters } = request;
            let result;
            switch (command) {
                case 'CreateClusterFile':
                    result = await createClusterFile(parameters);
                    break;
                case 'EditClusterFile':
                    result = await editClusterFile(parameters);
                    break;
                case 'ListClusters':
                    result = await listClusters(parameters);
                    break;
                default:
                    result = { success: false, error: `Unknown command: ${command}` };
            }
            console.log(JSON.stringify({ status: result.success ? 'success' : 'error', result: result.message || result.error }));
        }
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: error.message }));
        process.exit(1);
    }
}

async function listClusters({ clusterName, chainName }) {
    const targetFolders = new Set();

    // 模式3：通过链名解析簇文件夹列表
    if (chainName) {
        try {
            const chainsData = JSON.parse(await fs.readFile(META_CHAINS_PATH, 'utf8'));
            const chainNames = chainName.split(/[,，|]/).map(n => n.trim()).filter(Boolean);
            for (const name of chainNames) {
                const chain = chainsData.chains?.[name];
                if (chain && Array.isArray(chain.clusters)) {
                    chain.clusters.forEach(c => targetFolders.add(c));
                } else {
                    const available = Object.keys(chainsData.chains || {}).join(', ');
                    return {
                        success: false,
                        error: `未找到链 "${name}"。可用链名: ${available}`
                    };
                }
            }
        } catch (e) {
            return { success: false, error: `读取 meta_thinking_chains.json 失败: ${e.message}` };
        }
    }

    // 模式2：直接指定簇文件夹名
    if (clusterName) {
        const names = clusterName.split(/[,，|]/).map(n => n.trim().replace(/\s/g, '')).filter(Boolean);
        names.forEach(n => targetFolders.add(n));
    }

    // 模式1：未指定任何参数，全量枚举
    if (targetFolders.size === 0) {
        try {
            const allDirs = await fs.readdir(DAILYNOTE_DIR, { withFileTypes: true });
            allDirs
                .filter(d => d.isDirectory() && d.name.endsWith('簇'))
                .forEach(d => targetFolders.add(d.name));
        } catch (e) {
            return { success: false, error: `读取 dailynote 目录失败: ${e.message}` };
        }
    }

    if (targetFolders.size === 0) {
        return { success: true, message: '未找到任何思维簇文件夹。' };
    }

    // 读取并返回内容
    let result = `共找到 ${targetFolders.size} 个簇文件夹:\n`;

    for (const folderName of [...targetFolders].sort()) {
        const dirPath = path.join(DAILYNOTE_DIR, folderName);

        try {
            const stat = await fs.stat(dirPath);
            if (!stat.isDirectory()) {
                result += `\n⚠️ "${folderName}" 不是有效目录，已跳过。\n`;
                continue;
            }
        } catch {
            result += `\n⚠️ "${folderName}" 不存在，已跳过。\n`;
            continue;
        }

        const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
        result += `\n${'═'.repeat(50)}\n`;
        result += `📁 ${folderName} (${files.length} 个文件)\n`;
        result += `${'═'.repeat(50)}\n`;

        for (const file of files.sort()) {
            const filePath = path.join(dirPath, file);
            const content = await fs.readFile(filePath, 'utf8');
            result += `\n┌── 📄 ${file}\n`;
            result += `${content}\n`;
            result += `└${'─'.repeat(40)}\n`;
        }
    }

    return { success: true, message: result };
}

async function createClusterFile({ clusterName, content }) {
    if (!clusterName || !content) {
        return { success: false, error: 'Missing required parameters: clusterName and content.' };
    }

    const cleanedClusterName = clusterName.replace(/\s/g, '');
    if (!cleanedClusterName.endsWith('簇')) {
        return { success: false, error: "Folder name must end with '簇'." };
    }

    try {
        const clusterPath = path.join(DAILYNOTE_DIR, cleanedClusterName);
        await fs.mkdir(clusterPath, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${timestamp}.md`;
        const filePath = path.join(clusterPath, fileName);

        await fs.writeFile(filePath, content, 'utf8');

        return { success: true, message: `File created successfully at ${filePath}` };
    } catch (error) {
        return { success: false, error: `Failed to create file: ${error.message}` };
    }
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => {
            resolve(data);
        });
    });
}

async function editClusterFile({ clusterName, targetText, replacementText }) {
    if (!targetText || !replacementText) {
        return { success: false, error: 'Missing required parameters: targetText and replacementText.' };
    }
    if (targetText.length < 15) {
        return { success: false, error: 'targetText must be at least 15 characters long.' };
    }

    try {
        const searchPaths = [];
        if (clusterName) {
            const cleanedClusterName = clusterName.replace(/\s/g, '');
            if (!cleanedClusterName.endsWith('簇')) {
                return { success: false, error: "Folder name must end with '簇'." };
            }
            searchPaths.push(path.join(DAILYNOTE_DIR, cleanedClusterName));
        } else {
            const allDirs = await fs.readdir(DAILYNOTE_DIR, { withFileTypes: true });
            for (const dirent of allDirs) {
                if (dirent.isDirectory() && dirent.name.endsWith('簇')) {
                    searchPaths.push(path.join(DAILYNOTE_DIR, dirent.name));
                }
            }
        }

        if (searchPaths.length === 0) {
            return { success: false, error: 'No cluster folders found to search in.' };
        }

        for (const dirPath of searchPaths) {
            const files = await fs.readdir(dirPath);
            for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stat = await fs.stat(filePath);
                if (stat.isFile()) {
                    const content = await fs.readFile(filePath, 'utf8');
                    if (content.includes(targetText)) {
                        const newContent = content.replace(targetText, replacementText);
                        await fs.writeFile(filePath, newContent, 'utf8');
                        return { success: true, message: `File updated successfully at ${filePath}` };
                    }
                }
            }
        }

        return { success: false, error: 'Target text not found in any file.' };
    } catch (error) {
        return { success: false, error: `Failed to edit file: ${error.message}` };
    }
}

async function processBatchRequest(request) {
    const results = [];
    let i = 1;
    while (request[`command${i}`]) {
        const command = request[`command${i}`];
        const parameters = {
            clusterName: request[`clusterName${i}`],
            chainName: request[`chainName${i}`],
            content: request[`content${i}`],
            targetText: request[`targetText${i}`],
            replacementText: request[`replacementText${i}`]
        };

        let result;
        switch (command) {
            case 'CreateClusterFile':
                result = await createClusterFile(parameters);
                break;
            case 'EditClusterFile':
                result = await editClusterFile(parameters);
                break;
            case 'ListClusters':
                result = await listClusters(parameters);
                break;
            default:
                result = { success: false, error: `Unknown command: ${command}` };
        }
        results.push(result);
        i++;
    }
    return results;
}

main();