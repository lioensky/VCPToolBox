<template>
  <section class="config-section active-section">
    <p class="description">
      这里用于配置 <strong>AgentAssistant</strong> 插件。你可以：
      <br />1）从已注册的 Agent 一键创建助手； <br />2）添加完全自定义的助手；
      <br />3）为每个助手设置模型、性格说明和系统提示词。
      <br />所有修改会自动写入
      <code>Plugin/AgentAssistant/config.env</code> 中，无需手动编辑文本。
    </p>

    <div class="aa-config-container">
      <!-- 全局设置 -->
      <div class="aa-global-settings card">
        <h3>全局会话设置</h3>
        <div class="aa-global-grid">
          <div class="aa-global-item">
            <label for="aa-max-history">每个 Agent 记住的历史轮数</label>
            <input
              type="number"
              id="aa-max-history"
              v-model.number="globalConfig.maxHistory"
              min="1"
              max="50"
              step="1"
              placeholder="例如：7"
            />
            <p class="aa-hint">
              数值越大，Agent 能记住的上下文越多，但每次调用消耗的 Token
              也会增加。
            </p>
          </div>
          <div class="aa-global-item">
            <label for="aa-context-ttl">上下文保留时间（小时）</label>
            <input
              type="number"
              id="aa-context-ttl"
              v-model.number="globalConfig.contextTtl"
              min="1"
              max="168"
              step="1"
              placeholder="例如：24"
            />
            <p class="aa-hint">
              超过这个时间没有对话时，系统会自动清理旧会话，防止记忆无限增长。
            </p>
          </div>
        </div>
        <div class="aa-global-item-full">
          <label for="aa-global-system-prompt">
            所有助手共享的补充系统提示词（可选）
          </label>
          <textarea
            id="aa-global-system-prompt"
            v-model="globalConfig.globalSystemPrompt"
            rows="3"
            placeholder="例如：统一要求所有助手说话更温柔、避免输出敏感内容、统一使用某种语言等。"
          ></textarea>
          <p class="aa-hint">
            这里的内容会自动追加到每个助手的系统提示词后面，可用于统一规定整体风格和安全边界。
          </p>
        </div>
      </div>

      <!-- Agent 助手列表 -->
      <div class="aa-agents-header">
        <h3>已配置的 Agent 助手</h3>
        <div class="aa-agents-actions">
          <div class="aa-existing-helper">
            <label for="aa-existing-agent-select">从已注册 Agent 创建：</label>
            <select
              id="aa-existing-agent-select"
              v-model="selectedExistingAgent"
            >
              <option value="">选择一个已注册 Agent…</option>
              <option
                v-for="agent in availableAgents"
                :key="agent"
                :value="agent"
              >
                {{ agent }}
              </option>
            </select>
            <button
              @click="addFromExisting"
              class="btn-primary"
              :disabled="!selectedExistingAgent"
            >
              添加
            </button>
          </div>
          <button @click="addCustomAgent" class="btn-secondary">
            添加自定义 Agent
          </button>
        </div>
      </div>

      <div id="aa-agent-cards-container" class="aa-agent-cards-container">
        <div
          v-for="(agent, index) in agents"
          :key="agent.localId"
          class="aa-agent-card card"
        >
          <div class="aa-agent-card-header">
            <div class="aa-agent-name-row">
              <input
                type="text"
                v-model="agent.name"
                :name="`agent-name-${index}`"
                autocomplete="off"
                class="aa-agent-name-input"
                placeholder="助手名称（例如：小娜、ResearchBot）"
              />
              <span class="aa-agent-subtitle">
                在工具调用中使用：agent_name="{{ agent.name }}"
              </span>
              <button @click="removeAgent(index)" class="btn-danger btn-sm">
                删除
              </button>
            </div>
          </div>

          <div class="aa-agent-card-body">
            <div class="aa-row">
              <div class="aa-field-group">
                <label>模型 ID</label>
                <input
                  type="text"
                  v-model="agent.model"
                  :name="`agent-model-${index}`"
                  autocomplete="off"
                  placeholder="例如：gemini-2.5-flash-preview-05-20"
                />
                <p class="aa-hint">必须填写一个后端已配置的模型 ID。</p>
              </div>

              <div class="aa-field-group">
                <label>角色说明</label>
                <textarea
                  v-model="agent.personality"
                  :name="`agent-personality-${index}`"
                  autocomplete="off"
                  rows="2"
                  placeholder="例如：擅长检索与汇总多来源信息的研究助手…"
                ></textarea>
              </div>
            </div>

            <div class="aa-field-group aa-field-group-full">
              <label>系统提示词</label>
              <textarea
                v-model="agent.systemPrompt"
                :name="`agent-system-prompt-${index}`"
                autocomplete="off"
                rows="4"
                placeholder="可以简单写，也可以详细写。可使用 {{MaidName}}、{{Date}}、{{Time}} 等占位符。如果只想引用某个 Agent.txt 的内容，可以直接写 {{Nova}} 这样的占位符。"
              ></textarea>
              <p class="aa-hint">决定这个助手的性格和能力。</p>
            </div>

            <div class="aa-row aa-advanced-params">
              <div class="aa-field-group">
                <label>最大输出 Token 数</label>
                <input
                  type="number"
                  v-model.number="agent.maxOutputTokens"
                  :name="`agent-max-output-tokens-${index}`"
                  autocomplete="off"
                  min="1"
                  step="1"
                  placeholder="例如：8000"
                />
                <p class="aa-hint">
                  控制单次回答的最长长度，一般保持默认即可。
                </p>
              </div>

              <div class="aa-field-group">
                <label>温度（Temperature）</label>
                <input
                  type="number"
                  v-model.number="agent.temperature"
                  :name="`agent-temperature-${index}`"
                  autocomplete="off"
                  step="0.1"
                  min="0"
                  max="2"
                  placeholder="例如：0.7"
                />
                <p class="aa-hint">数值越低越稳健严谨，越高则越有创意。</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="aa-footer-actions">
        <button @click="saveConfig" class="btn-primary">
          保存 AgentAssistant 配置
        </button>
        <span v-if="statusMessage" :class="['status-message', statusType]">{{
          statusMessage
        }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useAgentAssistantConfig } from "@/features/agent-assistant-config/useAgentAssistantConfig";

const {
  globalConfig,
  agents,
  availableAgents,
  selectedExistingAgent,
  statusMessage,
  statusType,
  addFromExisting,
  addCustomAgent,
  removeAgent,
  saveConfig,
} = useAgentAssistantConfig();
</script>

<style scoped>
.aa-config-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.aa-global-settings {
  padding: 20px;
}

.aa-global-settings h3 {
  margin: 0 0 20px;
}

.aa-global-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 20px;
  margin-bottom: var(--space-5);
}

.aa-global-item {
  display: flex;
  flex-direction: column;
}

.aa-global-item label {
  font-weight: 600;
  margin-bottom: var(--space-2);
  color: var(--primary-text);
}

.aa-global-item input {
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.aa-hint {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  margin-top: var(--space-2);
  line-height: 1.4;
}

.aa-global-item-full {
  display: flex;
  flex-direction: column;
}

.aa-global-item-full label {
  font-weight: 600;
  margin-bottom: var(--space-2);
  color: var(--primary-text);
}

.aa-global-item-full textarea {
  padding: var(--space-2) var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  resize: vertical;
  font-family: inherit;
}

.aa-agents-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.aa-agents-header h3 {
  margin: 0;
}

.aa-agents-actions {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  flex-wrap: wrap;
}

.aa-existing-helper {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.aa-existing-helper label {
  font-size: var(--font-size-body);
  color: var(--secondary-text);
}

.aa-existing-helper select {
  padding: 8px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  min-width: 200px;
}

.aa-agent-cards-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: var(--space-4);
  max-width: 100%;
  overflow: visible;
}

.aa-agent-card {
  padding: 16px;
  box-sizing: border-box;
  max-width: 100%;
  overflow: hidden;
}

.aa-agent-card-header {
  margin-bottom: var(--space-4);
}

.aa-agent-name-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.aa-agent-name-input {
  width: 100%;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 600;
  box-sizing: border-box;
}

.aa-agent-subtitle {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  word-break: break-word;
}

.aa-agent-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.aa-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
  width: 100%;
}

.aa-advanced-params {
  grid-template-columns: 1fr 1fr;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
  width: 100%;
}

.aa-field-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.aa-field-group label {
  font-weight: 600;
  font-size: var(--font-size-helper);
  color: var(--primary-text);
  white-space: nowrap;
}

.aa-field-group input,
.aa-field-group textarea {
  width: 100%;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-family: inherit;
  box-sizing: border-box;
}

.aa-field-group textarea {
  resize: vertical;
}

.aa-field-group-full {
  grid-column: 1 / -1;
}

.aa-hint {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  line-height: 1.4;
  word-break: break-word;
}

@media (max-width: 768px) {
  .aa-row {
    grid-template-columns: 1fr;
  }

  .aa-agent-cards-container {
    grid-template-columns: 1fr;
  }
}

.aa-footer-actions {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: 16px 0;
}
</style>
