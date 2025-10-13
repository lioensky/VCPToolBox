const fs = require('fs').promises;
const path = require('path');

const DAILYNOTE_DIR = path.join(__dirname, '../../dailynote');

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
            default:
                result = { success: false, error: `Unknown command: ${command}` };
        }
        results.push(result);
        i++;
    }
    return results;
}

main();