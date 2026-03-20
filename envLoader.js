const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function resolveConfigPath(configPath) {
    return path.isAbsolute(configPath) ? configPath : path.resolve(configPath);
}

function getEnvCascadePaths(configPath) {
    const resolvedConfigPath = resolveConfigPath(configPath);
    const directory = path.dirname(resolvedConfigPath);
    const baseName = path.basename(resolvedConfigPath);

    if (baseName !== 'config.env') {
        return [resolvedConfigPath];
    }

    return [
        resolvedConfigPath,
        path.join(directory, 'config.local.env')
    ];
}

function parseEnvCascade(configPath) {
    const mergedEnv = {};
    const loadedFiles = [];

    for (const currentPath of getEnvCascadePaths(configPath)) {
        if (!fs.existsSync(currentPath)) {
            continue;
        }

        const envContent = fs.readFileSync(currentPath, 'utf-8');
        Object.assign(mergedEnv, dotenv.parse(envContent));
        loadedFiles.push(currentPath);
    }

    return { env: mergedEnv, loadedFiles };
}

function loadEnvCascade(configPath, targetEnv = process.env) {
    const { env, loadedFiles } = parseEnvCascade(configPath);
    Object.assign(targetEnv, env);
    return { env, loadedFiles };
}

module.exports = {
    getEnvCascadePaths,
    parseEnvCascade,
    loadEnvCascade
};
