// Plugin/FileListGenerator/file-list-generator.js
const fs = require('fs').promises;
const path = require('path');

// The project base path is passed via environment variable by PluginManager
const projectBasePath = process.env.PROJECT_BASE_PATH;
// Get config variables passed by PluginManager
const httpUrl = process.env.VarHttpUrl;
const fileKey = process.env.File_Key;
const port = process.env.PORT;

function parseExtensionWhitelist(rawValue) {
    if (!rawValue || !rawValue.trim()) {
        return null;
    }

    const extensions = rawValue
        .split(',')
        .map(extension => extension.trim().toLowerCase())
        .filter(Boolean)
        .map(extension => extension.startsWith('.') ? extension : `.${extension}`);

    return extensions.length > 0 ? new Set(extensions) : null;
}

function parseMaxFilesPerDirectory(rawValue) {
    if (!rawValue || !rawValue.trim()) {
        return Infinity;
    }

    const parsedValue = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(parsedValue) || parsedValue < 0) {
        console.error(
            `[FileListGenerator] Warning: invalid MAX_FILES_PER_DIRECTORY="${rawValue}", no limit will be applied.`
        );
        return Infinity;
    }

    return parsedValue;
}

const extensionWhitelist = parseExtensionWhitelist(process.env.FILE_EXTENSION_WHITELIST);
const maxFilesPerDirectory = parseMaxFilesPerDirectory(process.env.MAX_FILES_PER_DIRECTORY);

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

function isAllowedFile(fileName) {
    return !extensionWhitelist || extensionWhitelist.has(path.extname(fileName).toLowerCase());
}

/**
 * Reads and orders entries in one directory. Directories are retained, while
 * files are filtered by extension and limited to the newest modification times.
 * @param {string} dirPath - The path to the directory to read.
 * @returns {Promise<Array<{entry: import('fs').Dirent, mtimeMs: number}>>}
 */
async function getVisibleEntries(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const directories = [];
    const files = [];

    await Promise.all(entries.map(async entry => {
        if (entry.isDirectory()) {
            directories.push({ entry, mtimeMs: 0 });
            return;
        }

        if (!entry.isFile() || !isAllowedFile(entry.name)) {
            return;
        }

        try {
            const stats = await fs.stat(path.join(dirPath, entry.name));
            files.push({ entry, mtimeMs: stats.mtimeMs });
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(
                    `[FileListGenerator] Warning: cannot stat "${path.join(dirPath, entry.name)}": ${error.message}`
                );
            }
        }
    }));

    directories.sort((left, right) =>
        left.entry.name.localeCompare(right.entry.name, undefined, { sensitivity: 'base' })
    );
    files.sort((left, right) =>
        right.mtimeMs - left.mtimeMs ||
        left.entry.name.localeCompare(right.entry.name, undefined, { sensitivity: 'base' })
    );

    return directories.concat(files.slice(0, maxFilesPerDirectory));
}

/**
 * Recursively scans a directory and builds a tree-like string representation.
 * @param {string} dirPath - The path to the directory to scan.
 * @param {string} prefix - The prefix for the current level of the tree.
 * @returns {Promise<string>} A string representing the directory tree.
 */
async function generateDirectoryTree(dirPath, prefix = '') {
    let tree = '';
    try {
        const entries = await getVisibleEntries(dirPath);
        for (let i = 0; i < entries.length; i++) {
            const { entry } = entries[i];
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