const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";

/**
 * AgentController (V5: Decoupled Architecture)
 * 负责接收来自 Orchestrator 的指令，并通过注入的 VCPClient 调用主 VCP 服务器来获取 LLM 的响应。
 */
class AgentController {
    constructor(agentName, groupName, vcpClient, isOrchestratorController = false) {
        this.agentName = agentName;
        this.groupName = groupName;
        this.vcpClient = vcpClient;
        this.isOrchestratorController = isOrchestratorController;

        if (!this.vcpClient) {
            throw new Error(`[AgentController-${this.agentName}] CRITICAL: VCPClient instance is required.`);
        }

        if (DEBUG_MODE) {
            const type = isOrchestratorController ? 'Orchestrator-Decision' : 'Agent';
            console.log(`[AgentController-${this.agentName}] Initialized as ${type} controller for group '${this.groupName}'.`);
        }
    }

    /**
     * 核心决策方法。
     * @param {string} instruction - 从 Orchestrator 接收到的、完整的、准备给LLM的指令性提示词。
     */
    async decide(instruction) {
        if (DEBUG_MODE) {
            console.log(`[AgentController-${this.agentName}] Received instruction/prompt: "${instruction.substring(0, 120)}..."`);
        }

        const response = await this._getLLMResponse(instruction);

        // 在非Orchestrator的普通Agent模式下，如果Agent决定"pass"，则不产生输出
        if (!this.isOrchestratorController && response && response.trim().toLowerCase() === 'pass') {
            return null;
        }

        return response;
    }

    /**
     * 通过 VCPClient 调用主服务器来获取LLM响应。
     * @private
     */
    async _getLLMResponse(prompt) {
        // 构建发送给主VCP服务器的消息数组
        const messages = [
            { role: 'user', content: prompt }
        ];

        // 'agentName' 应该在主VCP服务器中被映射到一个具体的模型配置
        const modelToUse = this.isOrchestratorController ? 'OrchestratorLLM' : this.agentName;

        try {
            // 使用 VCPClient 发送标准请求
            const result = await this.vcpClient.sendRequest(messages, modelToUse);
            return result; // VCPClient.sendRequest 已被设计为直接返回 message.content
        } catch (error) {
            console.error(`[AgentController-${this.agentName}] Error calling VCP Server via VCPClient: ${error.message}`);
            return `(Error: Could not get a response from the language model: ${error.message})`;
        }
    }
}

module.exports = AgentController;