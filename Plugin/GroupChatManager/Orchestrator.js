const fs = require('fs').promises;
const path = require('path');
const AgentController = require('./AgentController');
const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";

/**
 * Orchestrator (协调器/导演) V5 - Decoupled and Mode-Driven
 * 负责管理群聊的对话流程，通过调用自身的高阶LLM来智能决定下一个发言者和行动。
 * 它能够根据不同的“协作模式”动态加载并采用不同的决策逻辑。
 */
class Orchestrator {
    constructor(groupState, vcpClient) {
        this.groupState = groupState;
        this.vcpClient = vcpClient;
        this.modes = new Map();

        if (!this.vcpClient) {
            throw new Error(`[Orchestrator] CRITICAL: VCPClient instance is required.`);
        }

        // 为Orchestrator自身创建一个特殊的AgentController用于决策
        this.decisionController = new AgentController('OrchestratorLLM', this.groupState.name, this.vcpClient, true);
        
        // 异步加载模式，但不阻塞构造函数
        this._loadModes().catch(err => console.error("[Orchestrator] Failed to load modes:", err));
    }

    async _loadModes() {
        const modesPath = path.join(__dirname, 'modes');
        try {
            const files = await fs.readdir(modesPath);
            for (const file of files) {
                if (file.endsWith('.js')) {
                    const mode = require(path.join(modesPath, file));
                    this.modes.set(mode.name.toLowerCase(), mode);
                    if (DEBUG_MODE) console.log(`[Orchestrator] Loaded collaboration mode: ${mode.name}`);
                }
            }
        } catch (error) {
            console.error(`[Orchestrator] Error loading modes from ${modesPath}:`, error);
            // 加载一个默认的后备模式
            this.modes.set('generic', require('./modes/generic.js'));
        }
    }

    /**
     * 核心决策方法。
     */
    async next(groupState, latestMessage) {
        this.groupState = groupState; // Ensure state is up-to-date
        const decisionPrompt = this._getPromptForMode(latestMessage);

        try {
            if (DEBUG_MODE) {
                console.log(`[Orchestrator] Generating decision for group '${this.groupState.name}' using mode '${this.groupState.mode}'...`);
            }

            const decisionResponse = await this.decisionController.decide(decisionPrompt);
            const decisionJson = this._parseDecision(decisionResponse);

            if (DEBUG_MODE) {
                console.log(`[Orchestrator] Received decision from LLM for group '${this.groupState.name}':`, JSON.stringify(decisionJson, null, 2));
            }

            return decisionJson;

        } catch (error) {
            console.error(`[Orchestrator] Error during LLM decision making for group '${this.groupState.name}': ${error.message}`);
            return this._fallbackDecision(latestMessage);
        }
    }

    _parseDecision(response) {
        try {
            const match = response.match(/```json\n([\s\S]*?)\n```/);
            if (match && match[1]) {
                return JSON.parse(match[1]);
            }
            return JSON.parse(response);
        } catch (e) {
            console.error(`[Orchestrator] Failed to parse decision JSON. Response: "${response}"`);
            return this._fallbackDecision();
        }
    }

    _getPromptForMode(latestMessage) {
        const modeName = this.groupState.mode.toLowerCase();
        const mode = this.modes.get(modeName) || this.modes.get('generic');
        
        if (!mode) {
            throw new Error(`Collaboration mode '${this.groupState.mode}' is not loaded and no generic fallback is available.`);
        }
        
        return mode.getPrompt(this.groupState, latestMessage);
    }
    
    _fallbackDecision(latestMessage) {
        const members = this.groupState.members || [];
        if (members.length === 0) {
            return { next_action: "FINISH", action_details: { final_summary: "No members in group." } };
        }
        
        const lastSpeaker = latestMessage ? latestMessage.from : '';
        const eligibleMembers = members.filter(m => m !== lastSpeaker);
        const nextSpeaker = eligibleMembers.length > 0 ? eligibleMembers[0] : members[0];

        return {
            decision_reason: "Fallback due to an error in the primary decision-making process.",
            new_summary: this.groupState.state_summary || "Continuing after a minor error.",
            next_action: "SPEAK",
            action_details: {
                next_speaker: nextSpeaker,
                instruction: `There was a brief issue with my thought process. @${nextSpeaker}, please continue the discussion based on the last message.`
            }
        };
    }
}

module.exports = Orchestrator;