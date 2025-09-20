const { v4: uuidv4 } = require('uuid');
const { WebSocketServer } = require('ws');
const AgentController = require('./AgentController');
const Orchestrator = require('./Orchestrator');
const config = require('./config'); // 引入配置文件

/**
 * GroupChatServer (V10: Refactored for Maintainability)
 * 负责管理所有群聊的生命周期、状态和消息路由。
 * 通过注入的 VCPClient 与主 VCP 服务器通信，通过 DatabaseManager 进行持久化。
 */
class GroupChatServer {
    constructor(vcpClient, dbManager) {
        if (!vcpClient || !dbManager) {
            throw new Error("[GroupChatServer] VCPClient and DatabaseManager are required.");
        }
        this.vcpClient = vcpClient;
        this.dbManager = dbManager;

        this.groupsState = new Map();
        this.activeControllers = new Map();
        this.activeOrchestrators = new Map();
        this.clients = new Map();

        this.wss = new WebSocketServer({ noServer: true });
        this.wss.on('connection', this._handleConnection.bind(this));

        // WebSocket 消息处理器映射
        this.messageHandlers = {
            'USER_SEND_MESSAGE': this._handleUserMessage.bind(this),
        };
    }

    handleUpgrade(request, socket, head) {
        const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
        const match = pathname.match(new RegExp(`^${config.WS_PATH_PREFIX}([a-fA-F0-9-]+)$`));

        if (!match) {
            socket.destroy();
            return;
        }

        const groupId = match;
        if (!this.groupsState.has(groupId)) {
            console.log(`[GroupChatServer] WebSocket connection rejected for unknown group ID: ${groupId}`);
            socket.destroy();
            return;
        }

        this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit('connection', ws, request, groupId);
        });
    }

    _handleConnection(ws, request, groupId) {
        if (!this.clients.has(groupId)) {
            this.clients.set(groupId, new Set());
        }
        this.clients.get(groupId).add(ws);
        if (config.DEBUG_MODE) console.log(`[GroupChatServer] Client connected to group ${groupId}`);

        ws.on('message', (message) => this._handleFrontendMessage(message, groupId, ws));
        ws.on('close', () => this.clients.get(groupId)?.delete(ws));
        ws.on('error', (error) => console.error(`[GroupChatServer] WebSocket error for group ${groupId}:`, error));
    }

    async _handleFrontendMessage(message, groupId, ws) {
        try {
            const { type, payload } = JSON.parse(message);
            const handler = this.messageHandlers[type];
            if (handler) {
                await handler(payload, groupId, ws);
            } else {
                ws.send(JSON.stringify({ type: 'ERROR', payload: `Unknown message type: ${type}` }));
            }
        } catch (error) {
            console.error(`[GroupChatServer] Error parsing message from client for group ${groupId}:`, error);
            ws.send(JSON.stringify({ type: 'ERROR', payload: 'Invalid JSON message format.' }));
        }
    }
    
    async _handleUserMessage(payload, groupId) {
        await this.send_message_to_group({
            group_id: groupId,
            from_agent: payload.from_agent || 'Human_Observer',
            content: payload.content
        });
    }

    broadcastToGroup(groupId, message) {
        const groupClients = this.clients.get(groupId);
        if (groupClients) {
            const payload = JSON.stringify(message);
            groupClients.forEach(client => {
                if (client.readyState === 1) client.send(payload); // WebSocket.OPEN
            });
            if (config.DEBUG_MODE) console.log(`[GroupChatServer] Broadcasted to group ${groupId}:`, message.type);
        }
    }

    async initialize() {
        try {
            await this._loadGroupsIntoMemory();
            return { success: true };
        } catch (error) {
            console.error(`[GroupChatServer] CRITICAL: Failed to initialize: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async _loadGroupsIntoMemory() {
        const groups = await this.dbManager.getAllGroups();
        for (const group of groups) {
            const chatHistory = await this.dbManager.getHistory(group.id);
            this.groupsState.set(group.id, {
                ...group,
                chat_history: chatHistory,
                shared_workspace: {},
                agent_states: {},
                sub_tasks: [],
                parent_group: null,
                state_summary: null,
            });
            if (config.DEBUG_MODE) console.log(`[GroupChatServer] Loaded group '${group.name}' (ID: ${group.id}) into memory.`);
        }
    }
    
    async get_all_groups() {
        return await this.dbManager.getAllGroups();
    }

    async create_group({ group_name, members, roles = {}, goal = "未定义的目标", mode = "Debate" }) {
        if (!group_name || !members || !Array.isArray(members) || members.length === 0) {
            return { success: false, error: "必须提供群组名称和非空的成员列表数组。" };
        }
        const groupId = uuidv4();
        const newGroupData = { id: groupId, name: group_name, members, roles, goal, mode, created_at: new Date().toISOString() };
        
        await this.dbManager.createGroup(newGroupData);
        this.groupsState.set(groupId, { ...newGroupData, chat_history: [], shared_workspace: {}, agent_states: {}, sub_tasks: [], parent_group: null });
        
        if (config.DEBUG_MODE) console.log(`[GroupChatServer] Group '${group_name}' (ID: ${groupId}) created with mode '${mode}'.`);
        return { success: true, message: `群组 '${group_name}' 已成功创建。`, group_id: groupId };
    }

    async start_group_session({ group_id }) {
        const groupState = this.groupsState.get(group_id);
        if (!groupState) return { success: false, error: `群组 ID '${group_id}' 不存在。` };
        if (this.activeOrchestrators.has(group_id)) return { success: false, error: `群组 ID '${group_id}' 的会话已在运行中。` };

        const controllers = new Map();
        for (const agentName of groupState.members) {
            controllers.set(agentName, new AgentController(agentName, groupState.name, this.vcpClient));
        }
        this.activeControllers.set(group_id, controllers);

        const orchestrator = new Orchestrator(groupState, this.vcpClient);
        this.activeOrchestrators.set(group_id, orchestrator);

        if (config.DEBUG_MODE) console.log(`[GroupChatServer] Session started for group '${groupState.name}'. Orchestrator (Mode: ${groupState.mode}) and controllers activated.`);
        
        const initialMessage = {
            group_id: group_id,
            from_agent: 'System',
            content: `Session started. The goal is: "${groupState.goal}". The collaboration mode is "${groupState.mode}". Orchestrator, please provide the first instruction.`
        };
        setImmediate(() => this.send_message_to_group(initialMessage));

        return { success: true, message: `群组 '${groupState.name}' 的会话已启动。` };
    }

    async send_message_to_group(messagePayload) {
        const { group_id, from_agent, content } = messagePayload;
        const groupState = this.groupsState.get(group_id);
        if (!groupState) return { success: false, error: `群组 ID '${group_id}' 不存在。` };

        const messageEntry = await this._logAndBroadcastMessage(messagePayload);

        if (content.includes('<<<[TOOL_REQUEST]>>>')) {
            this._execute_tool_call(group_id, from_agent, content);
            return { success: true, message_id: messageEntry.id };
        }

        if (!this.activeOrchestrators.has(group_id)) {
            return { success: true, message_id: messageEntry.id, notice: 'Session not active, message logged.' };
        }

        if (config.DEBUG_MODE) console.log(`[GroupChatServer] Message from '${from_agent}' in group '${groupState.name}'. Passing to Orchestrator.`);
        
        await this._triggerOrchestration(groupState, messageEntry);

        return { success: true, message_id: messageEntry.id };
    }

    async _logAndBroadcastMessage({ group_id, from_agent, content, to_agent = null, is_tool_response = false }) {
        const messageEntry = { id: uuidv4(), group_id, from: from_agent, content, to: to_agent, is_tool_response, timestamp: new Date().toISOString() };
        await this.dbManager.logMessage(messageEntry);
        this.groupsState.get(group_id).chat_history.push(messageEntry);
        this.broadcastToGroup(group_id, { type: 'NEW_MESSAGE', payload: messageEntry });
        return messageEntry;
    }

    async _triggerOrchestration(groupState, messageEntry) {
        const orchestrator = this.activeOrchestrators.get(groupState.id);
        const decision = await orchestrator.next(groupState, messageEntry);
        this.broadcastToGroup(groupState.id, { type: 'ORCHESTRATOR_DECISION', payload: decision });

        if (decision) {
            this._processOrchestratorDecision(groupState.id, decision);
        }
    }

    _processOrchestratorDecision(groupId, decision) {
        if (decision.next_action === 'SPEAK') {
            this._handle_speak_action(groupId, decision.action_details);
        } else if (decision.next_action === 'FINISH') {
            this._handle_finish_action(groupId, decision.action_details);
        }
        
        if (decision.update_state) {
            Object.assign(this.groupsState.get(groupId), decision.update_state);
            this.broadcastToGroup(groupId, { type: 'STATE_UPDATE', payload: decision.update_state });
        }
        if (decision.new_summary) {
            this.groupsState.get(groupId).state_summary = decision.new_summary;
            this.broadcastToGroup(groupId, { type: 'STATE_SUMMARY_UPDATE', payload: { summary: decision.new_summary } });
        }
    }

    _handle_speak_action(group_id, { next_speaker, instruction }) {
        const nextController = this.activeControllers.get(group_id)?.get(next_speaker);
        if (!nextController) return;

        if (config.DEBUG_MODE) console.log(`[GroupChatServer] Orchestrator selected '${next_speaker}' to SPEAK.`);
        this.broadcastToGroup(group_id, { type: 'AGENT_STATUS_UPDATE', payload: { agent_name: next_speaker, status: 'Thinking...' } });
        
        setImmediate(async () => {
            try {
                const reply = await nextController.decide(instruction);
                if (reply) {
                    this.broadcastToGroup(group_id, { type: 'AGENT_STATUS_UPDATE', payload: { agent_name: next_speaker, status: 'Idle' } });
                    await this.send_message_to_group({ group_id, from_agent: next_speaker, content: reply });
                }
            } catch (err) {
                console.error(`[AgentController-${next_speaker}] Error: ${err.message}`);
                this.broadcastToGroup(group_id, { type: 'AGENT_STATUS_UPDATE', payload: { agent_name: next_speaker, status: 'Error' } });
            }
        });
    }

    _handle_finish_action(group_id, { final_summary }) {
        const groupName = this.groupsState.get(group_id)?.name || 'Unknown';
        if (config.DEBUG_MODE) console.log(`[GroupChatServer] Orchestrator decided to FINISH session for '${groupName}'. Final summary: ${final_summary}`);
        // Here you could add logic to report to a parent group if needed
    }

    async _execute_tool_call(group_id, from_agent, tool_call_string) {
        if (config.DEBUG_MODE) console.log(`[GroupChatServer] Executing tool call from '${from_agent}'...`);
        this.broadcastToGroup(group_id, { type: 'AGENT_STATUS_UPDATE', payload: { agent_name: from_agent, status: `Executing tool...` } });

        let toolResult;
        try {
            const messages = [{ role: 'user', content: tool_call_string }];
            const resultString = await this.vcpClient.sendRequest(messages, config.TOOL_EXECUTOR_MODEL);
            toolResult = JSON.parse(resultString);
        } catch (error) {
            console.error(`[GroupChatServer] Tool execution failed: ${error.message}`);
            toolResult = { success: false, error: error.message };
        }
        
        this.broadcastToGroup(group_id, { type: 'AGENT_STATUS_UPDATE', payload: { agent_name: from_agent, status: 'Idle' } });

        const toolResponseMessage = {
            group_id: group_id,
            from_agent: 'System',
            content: `Tool call result:\n\`\`\`json\n${JSON.stringify(toolResult, null, 2)}\n\`\`\``,
            is_tool_response: true
        };
        
        setImmediate(() => this.send_message_to_group(toolResponseMessage));
    }

    async get_group_state({ group_id, last_n_messages = 50 }) {
        const groupState = this.groupsState.get(group_id);
        if (!groupState) return { success: false, error: `群组 ID '${group_id}' 不存在。` };
        
        const history = await this.dbManager.getHistory(group_id, last_n_messages);
        return { success: true, state: { ...groupState, chat_history: history } };
    }

    close() {
        if (config.DEBUG_MODE) console.log('[GroupChatServer] Shutting down...');
        this.wss.clients.forEach(client => client.close(1000, 'Server is shutting down.'));
        this.clients.clear();
        this.groupsState.clear();
        this.activeControllers.clear();
        this.activeOrchestrators.clear();
        if (config.DEBUG_MODE) console.log('[GroupChatServer] Shutdown complete.');
    }
}

module.exports = GroupChatServer;