// Plugin/FileListGenerator/file-list-generator.js
const fs = require('fs').promises;
const path = require('path');

// The project base path is passed via environment variable by PluginManager
const projectBasePath = process.env.PROJECT_BASE_PATH;
// Get config variables passed by PluginManager
const httpUrl = process.env.VarHttpUrl;
const fileKey = process.env.File_Key;
const port = process.env.PORT;

if (!projectBasePath) {
    console.error("[FileListGenerator] Error: PROJECT_BASE_PATH environment variable not set.");
    process.exit(1);
}

const FILE_DIR = path.join(projectBasePath, 'file');
// Define special directories to include
const SPECIAL_DIRS_MAP = {
    'doubaogen': path.join(projectBasePath, 'image', 'doubaogen'),
    'fluxgen': path.join(projectBasePath, 'image', 'fluxgen')
};

/**
 * Recursively scans a directory and builds a tree-like string representation.
 * @param {string} dirPath - The path to the directory to scan.
 * @param {string} prefix - The prefix for the current level of the tree.
 * @returns {Promise<string>} A string representing the directory tree.
 */
async function generateDirectoryTree(dirPath, prefix = '') {
    let tree = '';
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const newPrefix = prefix + (isLast ? '    ' : '│   ');

            tree += `${prefix}${connector}${entry.name}\n`;

            if (entry.isDirectory()) {
                const subDirPath = path.join(dirPath, entry.name);
                tree += await generateDirectoryTree(subDirPath, newPrefix);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            tree += `${prefix}└── [Error reading directory: ${error.message}]\n`;
        }
    }
    return tree;
}

async function main() {
    let combinedTree = '';
    let contentGenerated = false;

    // 1. Get the tree from the main 'file' directory
    try {
        await fs.access(FILE_DIR);
        const fileDirTree = await generateDirectoryTree(FILE_DIR);
        if (fileDirTree) {
            combinedTree += fileDirTree;
            contentGenerated = true;
        }
    } catch (error) {
        // Silently ignore if 'file' dir doesn't exist, unless it's a read error
        if (error.code !== 'ENOENT') {
            combinedTree += `[读取主 'file' 目录时出错: ${error.message}]\n`;
            contentGenerated = true;
        }
    }

    // 2. Get trees from special directories and prepend their virtual folder name
    for (const [dirName, dirPath] of Object.entries(SPECIAL_DIRS_MAP)) {
        try {
            await fs.access(dirPath);
            const specialDirTree = await generateDirectoryTree(dirPath, '│   ');
            if (specialDirTree) {
                combinedTree += `├── ${dirName}\n${specialDirTree}`;
                contentGenerated = true;
            }
        } catch (error) {
            // Silently ignore if special dirs don't exist
            if (error.code !== 'ENOENT') {
                combinedTree += `├── ${dirName} [读取时出错: ${error.message}]\n`;
                contentGenerated = true;
            }
        }
    }
    


    let finalOutput = '';
    if (contentGenerated) {
        let usageExample = '';
        if (httpUrl && port && fileKey) {
            const exampleFileName = "doubaogen/example.png"; // Use a more predictable example
            usageExample = `\n\n# 如何使用这些文件:\n# 你可以通过拼接URL来访问这些文件，格式如下：\n# ${httpUrl}:${port}/pw=${fileKey}/files/[文件路径]\n# 例如，访问'${exampleFileName}'的URL是：\n# ${httpUrl}:${port}/pw=${fileKey}/files/${exampleFileName}`;
        } else {
            usageExample = `\n\n# 使用说明: (部分环境变量缺失，无法生成完整URL示例)`;
        }
        finalOutput = `可用文件列表:${usageExample}\n\n${combinedTree}`;
    } else {
        finalOutput = "[FileListGenerator] 'file' 目录及特别收录目录均未找到。";
    }
    
    // The final output to stdout is captured by PluginManager
    console.log(finalOutput);
}

main();