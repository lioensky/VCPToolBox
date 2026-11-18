const IPC_ENV_KEYS = [
    'SSH_MANAGER_SOCK',
    'SSH_MANAGER_TOKEN',
    'LOG_MONITOR_SOCK',
    'LOG_MONITOR_TOKEN'
];

function createSanitizedUserCommandEnv(baseEnv = process.env) {
    const env = { ...baseEnv };
    for (const key of IPC_ENV_KEYS) {
        delete env[key];
    }
    return env;
}

module.exports = {
    IPC_ENV_KEYS,
    createSanitizedUserCommandEnv
};
