// config.js - Centralized configuration for the GroupChatManager service

const path = require('path');

module.exports = {
    // Service settings
    PORT: process.env.GROUP_CHAT_PORT || 6007,
    VCP_SERVER_URL: process.env.VCP_SERVER_URL || 'http://localhost:6005',
    VCP_SERVER_KEY: process.env.Key || '',

    // Database settings
    DB_FILE: path.join(__dirname, 'data', 'groupchat.db'),

    // WebSocket settings
    WS_PATH_PREFIX: '/api/groups/ws/',

    // API routes
    API_BASE_PATH: '/api/groups',

    // VCP Communication settings
    VCP_API_ENDPOINT: '/v1/chat/completions',
    
    // Special model names or routes used for internal VCP calls
    AGENT_LIST_PROVIDER_MODEL: 'AgentAssistant', // Model/Agent responsible for providing the agent list
    TOOL_EXECUTOR_MODEL: 'vcp-executor',       // Model/Route for executing tool calls via VCP

    // Special commands/instructions
    GET_AGENT_LIST_COMMAND: '__GET_AGENT_LIST__',

    // Debug mode
    DEBUG_MODE: (process.env.DebugMode || "False").toLowerCase() === "true",
};