import { onMounted, ref } from "vue";
import { agentApi, pluginApi } from "@/api";
import type {
  AgentAssistantConfigAgent,
  AgentAssistantConfigResponse,
  SaveAgentAssistantConfigPayload,
} from "@/types/api.agent";
import { showMessage } from "@/utils";
import { createLogger } from "@/utils/logger";

const logger = createLogger("AgentAssistantConfig");

export interface AgentConfig {
  localId: string;
  name: string;
  baseName: string;
  model: string;
  personality: string;
  systemPrompt: string;
  maxOutputTokens: number;
  temperature: number;
}

let nextAgentConfigLocalId = 0;

function createAgentConfig(
  entry: Partial<Omit<AgentConfig, "localId">> = {}
): AgentConfig {
  nextAgentConfigLocalId += 1;

  return {
    localId: `agent-config-${nextAgentConfigLocalId}`,
    name: entry.name ?? "",
    baseName: entry.baseName ?? "",
    model: entry.model ?? "",
    personality: entry.personality ?? "",
    systemPrompt: entry.systemPrompt ?? "",
    maxOutputTokens: entry.maxOutputTokens ?? 8000,
    temperature: entry.temperature ?? 0.7,
  };
}

export interface GlobalConfig {
  maxHistory: number;
  contextTtl: number;
  globalSystemPrompt: string;
}

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  code?: number | string;
  data?: T;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapApiPayload<T>(response: unknown): T {
  let current: unknown = response;

  for (let i = 0; i < 5; i += 1) {
    if (!isRecord(current) || !("data" in current)) {
      break;
    }

    const hasEnvelopeHint =
      "success" in current ||
      "message" in current ||
      "code" in current ||
      Object.keys(current).length === 1;

    if (!hasEnvelopeHint) {
      break;
    }

    current = (current as ApiEnvelope<unknown>).data;
  }

  return current as T;
}

function pickString(source: UnknownRecord, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return fallback;
}

function pickNumber(source: UnknownRecord, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = source[key];
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string"
        ? Number(value)
        : NaN;
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }
  return fallback;
}

function normalizeAgentEntry(agent: unknown): AgentConfig {
  const source: UnknownRecord = isRecord(agent) ? agent : {};

  return createAgentConfig({
    name: pickString(source, [
      "chineseName",
      "name",
      "displayName",
      "assistantName",
    ]),
    baseName: pickString(source, ["baseName", "base", "agentBaseName"]),
    model: pickString(source, ["modelId", "model", "modelName", "model_id"]),
    personality: pickString(source, ["description", "personality", "desc"]),
    systemPrompt: pickString(source, ["systemPrompt", "system_prompt", "prompt"]),
    maxOutputTokens: pickNumber(
      source,
      ["maxOutputTokens", "max_tokens", "maxToken", "max_output_tokens"],
      8000
    ),
    temperature: pickNumber(source, ["temperature", "temp"], 0.7),
  });
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function buildConfigFromEnvPairs(
  pairs: Map<string, string>
): AgentAssistantConfigResponse {
  const maxHistoryRounds = Number(
    pairs.get("AGENT_ASSISTANT_MAX_HISTORY_ROUNDS") ||
      pairs.get("MAX_HISTORY_ROUNDS") ||
      pairs.get("maxHistoryRounds") ||
      7
  );
  const contextTtlHours = Number(
    pairs.get("AGENT_ASSISTANT_CONTEXT_TTL_HOURS") ||
      pairs.get("CONTEXT_TTL_HOURS") ||
      pairs.get("contextTtlHours") ||
      24
  );
  const globalSystemPrompt =
    pairs.get("AGENT_ALL_SYSTEM_PROMPT") ||
    pairs.get("GLOBAL_SYSTEM_PROMPT") ||
    pairs.get("globalSystemPrompt") ||
    "";

  const agentsRaw =
    pairs.get("AGENTS") ||
    pairs.get("AGENT_ASSISTANTS") ||
    pairs.get("agents") ||
    "[]";

  const jsonAgents = parseJsonArray<AgentAssistantConfigAgent>(agentsRaw);

  if (jsonAgents.length > 0) {
    return {
      maxHistoryRounds,
      contextTtlHours,
      globalSystemPrompt,
      agents: jsonAgents,
    };
  }

  const baseNames = new Set<string>();
  for (const key of pairs.keys()) {
    const match = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i);
    if (match && match[1]) {
      baseNames.add(match[1].toUpperCase());
    }
  }

  const envAgents = Array.from(baseNames)
    .map((baseName) => {
      const modelId = pairs.get(`AGENT_${baseName}_MODEL_ID`) || "";
      const chineseName = pairs.get(`AGENT_${baseName}_CHINESE_NAME`) || "";

      if (!modelId || !chineseName) {
        return null;
      }

      const maxOutputTokens = Number(
        pairs.get(`AGENT_${baseName}_MAX_OUTPUT_TOKENS`) || 8000
      );
      const temperature = Number(pairs.get(`AGENT_${baseName}_TEMPERATURE`) || 0.7);

      return {
        baseName,
        chineseName,
        modelId,
        description: pairs.get(`AGENT_${baseName}_DESCRIPTION`) || "",
        systemPrompt: pairs.get(`AGENT_${baseName}_SYSTEM_PROMPT`) || "",
        maxOutputTokens: Number.isNaN(maxOutputTokens) ? 8000 : maxOutputTokens,
        temperature: Number.isNaN(temperature) ? 0.7 : temperature,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return {
    maxHistoryRounds,
    contextTtlHours,
    globalSystemPrompt,
    agents: envAgents,
  };
}

function parseEnvConfig(content: string): AgentAssistantConfigResponse {
  const pairs = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const rawKey = trimmed.slice(0, separatorIndex).trim();
    let rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }

    pairs.set(rawKey, rawValue);
  }

  return buildConfigFromEnvPairs(pairs);
}

function normalizeConfigPayload(payload: unknown): AgentAssistantConfigResponse {
  if (typeof payload === "string") {
    return parseEnvConfig(payload);
  }

  if (!isRecord(payload)) {
    return {};
  }

  if (typeof payload.content === "string") {
    return parseEnvConfig(payload.content);
  }

  const source = isRecord(payload.config) ? payload.config : payload;
  const agentsSource =
    source.agents ?? source.assistants ?? source.agentList ?? source.agentConfigs;

  if (
    !Array.isArray(agentsSource) &&
    Object.keys(source).some((key) => key.startsWith("AGENT_"))
  ) {
    const envPairs = new Map<string, string>();
    for (const [key, value] of Object.entries(source)) {
      if (value == null) {
        continue;
      }
      envPairs.set(key, String(value));
    }
    return buildConfigFromEnvPairs(envPairs);
  }

  return {
    maxHistoryRounds: pickNumber(
      source,
      [
        "maxHistoryRounds",
        "max_history_rounds",
        "maxHistory",
        "MAX_HISTORY_ROUNDS",
        "AGENT_ASSISTANT_MAX_HISTORY_ROUNDS",
      ],
      7
    ),
    contextTtlHours: pickNumber(
      source,
      [
        "contextTtlHours",
        "context_ttl_hours",
        "contextTtl",
        "CONTEXT_TTL_HOURS",
        "AGENT_ASSISTANT_CONTEXT_TTL_HOURS",
      ],
      24
    ),
    globalSystemPrompt: pickString(source, [
      "globalSystemPrompt",
      "global_system_prompt",
      "GLOBAL_SYSTEM_PROMPT",
      "AGENT_ALL_SYSTEM_PROMPT",
    ]),
    agents: Array.isArray(agentsSource)
      ? agentsSource.map((item) => ({
          chineseName: pickString(isRecord(item) ? item : {}, [
            "chineseName",
            "name",
            "displayName",
            "assistantName",
          ]),
          baseName: pickString(isRecord(item) ? item : {}, [
            "baseName",
            "base",
            "agentBaseName",
          ]),
          modelId: pickString(isRecord(item) ? item : {}, [
            "modelId",
            "model",
            "modelName",
            "model_id",
          ]),
          description: pickString(isRecord(item) ? item : {}, [
            "description",
            "personality",
            "desc",
          ]),
          systemPrompt: pickString(isRecord(item) ? item : {}, [
            "systemPrompt",
            "system_prompt",
            "prompt",
          ]),
          maxOutputTokens: pickNumber(
            isRecord(item) ? item : {},
            ["maxOutputTokens", "max_tokens", "maxToken", "max_output_tokens"],
            8000
          ),
          temperature: pickNumber(isRecord(item) ? item : {}, ["temperature", "temp"], 0.7),
        }))
      : [],
  };
}

function normalizeAgentMap(payload: unknown): string[] {
  const source = unwrapApiPayload<unknown>(payload);

  if (Array.isArray(source)) {
    return source
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isRecord(item)) {
          return pickString(item, ["name", "agentName", "label"]);
        }
        return "";
      })
      .filter(Boolean);
  }

  if (isRecord(source)) {
    const mapSource = isRecord(source.map) ? source.map : source;
    return Object.keys(mapSource);
  }

  return [];
}

async function loadConfigFromPluginsEndpoint(): Promise<AgentAssistantConfigResponse | null> {
  try {
    const pluginsResponse = await pluginApi.getPlugins({
      showLoader: false,
      loadingKey: "agent-assistant.plugins.load",
    });

    const pluginsPayload = unwrapApiPayload<unknown>(pluginsResponse);
    if (!Array.isArray(pluginsPayload)) {
      return null;
    }

    const agentAssistantPlugin = pluginsPayload.find((item) => {
      if (!isRecord(item)) {
        return false;
      }

      const directName = pickString(item, ["name"]);
      if (directName === "AgentAssistant") {
        return true;
      }

      if (isRecord(item.manifest)) {
        return pickString(item.manifest, ["name"]) === "AgentAssistant";
      }

      return false;
    });

    if (!isRecord(agentAssistantPlugin)) {
      return null;
    }

    const envContent =
      pickString(agentAssistantPlugin, ["configEnvContent", "content"]) ||
      (isRecord(agentAssistantPlugin.manifest)
        ? pickString(agentAssistantPlugin.manifest, ["configEnvContent", "content"])
        : "");

    if (!envContent) {
      return null;
    }

    return parseEnvConfig(envContent);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
      "Failed to load AgentAssistant config from /admin_api/plugins:",
      errorMessage
    );
    return null;
  }
}

export function useAgentAssistantConfig() {
  const globalConfig = ref<GlobalConfig>({
    maxHistory: 7,
    contextTtl: 24,
    globalSystemPrompt: "",
  });

  const agents = ref<AgentConfig[]>([]);
  const availableAgents = ref<string[]>([]);
  const selectedExistingAgent = ref("");
  const statusMessage = ref("");
  const statusType = ref<"info" | "success" | "error">("info");

  async function loadConfig() {
    try {
      const configResponse = await agentApi.getAgentConfig(
        {},
        {
          showLoader: false,
          loadingKey: "agent-assistant.config.load",
        }
      );

      const configPayload = unwrapApiPayload<unknown>(configResponse);
      let data = normalizeConfigPayload(configPayload);

      const isLegacyFallbackPayload =
        isRecord(configPayload) &&
        !Array.isArray((configPayload as Record<string, unknown>).agents) &&
        ("systemPromptTemplate" in configPayload ||
          "defaultMemoryPrompt" in configPayload ||
          Object.keys(configPayload).length === 0);

      if (isLegacyFallbackPayload) {
        const pluginConfig = await loadConfigFromPluginsEndpoint();
        if (pluginConfig) {
          data = pluginConfig;
        }
      }

      globalConfig.value = {
        maxHistory: Number(data.maxHistoryRounds) || 7,
        contextTtl: Number(data.contextTtlHours) || 24,
        globalSystemPrompt: data.globalSystemPrompt || "",
      };

      agents.value = Array.isArray(data.agents)
        ? data.agents.map((agent) => normalizeAgentEntry(agent))
        : [];

      const agentMapResponse = await agentApi.getAgentMap(
        {},
        {
          showLoader: false,
          loadingKey: "agent-assistant.agent-map.load",
        }
      );

      availableAgents.value = normalizeAgentMap(agentMapResponse);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to load config:", errorMessage);
      showMessage(`加载配置失败：${errorMessage}`, "error");
    }
  }

  function addFromExisting() {
    if (!selectedExistingAgent.value) {
      return;
    }

    const baseName = selectedExistingAgent.value;
    agents.value.push(createAgentConfig({
      name: baseName,
      baseName,
      model: "",
      personality: `基于已注册 Agent "${baseName}" 创建的助手，请补充模型 ID 和更详细的说明。`,
      systemPrompt: `{{${baseName}}}`,
      maxOutputTokens: 8000,
      temperature: 0.7,
    }));

    selectedExistingAgent.value = "";
    showMessage(`已为 "${baseName}" 创建一个新的 Agent 助手卡片。`, "success");
  }

  function addCustomAgent() {
    agents.value.push(createAgentConfig({
      name: "新 Agent",
      baseName: "",
      model: "",
      personality: "",
      systemPrompt: "",
      maxOutputTokens: 8000,
      temperature: 0.7,
    }));
  }

  function removeAgent(index: number) {
    if (confirm("确定要删除这个 Agent 助手配置吗？")) {
      agents.value.splice(index, 1);
    }
  }

  async function saveConfig() {
    try {
      for (const agent of agents.value) {
        if (!agent.name.trim() && !agent.model.trim()) {
          continue;
        }
        if (!agent.name.trim()) {
          showMessage("有助手未填写名称，请补充后再保存。", "error");
          return;
        }
        if (!agent.model.trim()) {
          showMessage(`助手 "${agent.name}" 未填写模型 ID，请补充后再保存。`, "error");
          return;
        }
      }

      const configData: SaveAgentAssistantConfigPayload = {
        maxHistoryRounds: globalConfig.value.maxHistory,
        contextTtlHours: globalConfig.value.contextTtl,
        globalSystemPrompt: globalConfig.value.globalSystemPrompt,
        agents: agents.value
          .filter((agent) => agent.name.trim() || agent.model.trim())
          .map((agent) => ({
            baseName: agent.baseName,
            chineseName: agent.name,
            modelId: agent.model,
            description: agent.personality,
            systemPrompt: agent.systemPrompt,
            maxOutputTokens: agent.maxOutputTokens || 8000,
            temperature: agent.temperature || 0.7,
          })),
      };

      await agentApi.saveAgentConfig(configData, {
        loadingKey: "agent-assistant.config.save",
      });

      statusMessage.value = "AgentAssistant 配置已保存！";
      statusType.value = "success";
      showMessage("AgentAssistant 配置已保存！", "success");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      statusMessage.value = `保存失败：${errorMessage}`;
      statusType.value = "error";
      showMessage(`保存失败：${errorMessage}`, "error");
    }
  }

  onMounted(() => {
    loadConfig();
  });

  return {
    globalConfig,
    agents,
    availableAgents,
    selectedExistingAgent,
    statusMessage,
    statusType,
    loadConfig,
    addFromExisting,
    addCustomAgent,
    removeAgent,
    saveConfig,
  };
}
