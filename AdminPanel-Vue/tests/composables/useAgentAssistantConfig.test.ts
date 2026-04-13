import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as VueModule from "vue";

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof VueModule>("vue");
  return {
    ...actual,
    onMounted: () => {},
  };
});

const {
  mockGetAgentConfig,
  mockGetAgentMap,
  mockSaveAgentConfig,
  mockGetPlugins,
  mockShowMessage,
} = vi.hoisted(() => ({
  mockGetAgentConfig: vi.fn(async () => ({})),
  mockGetAgentMap: vi.fn(async () => ({})),
  mockSaveAgentConfig: vi.fn(async () => undefined),
  mockGetPlugins: vi.fn(async () => []),
  mockShowMessage: vi.fn(),
}));

vi.mock("@/api", () => ({
  agentApi: {
    getAgentConfig: (...args: unknown[]) => mockGetAgentConfig(...args),
    getAgentMap: (...args: unknown[]) => mockGetAgentMap(...args),
    saveAgentConfig: (...args: unknown[]) => mockSaveAgentConfig(...args),
  },
  pluginApi: {
    getPlugins: (...args: unknown[]) => mockGetPlugins(...args),
  },
}));

vi.mock("@/utils", () => ({
  showMessage: (...args: unknown[]) => mockShowMessage(...args),
}));

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { useAgentAssistantConfig } from "@/features/agent-assistant-config/useAgentAssistantConfig";

describe("useAgentAssistantConfig", () => {
  beforeEach(() => {
    mockGetAgentConfig.mockReset();
    mockGetAgentMap.mockReset();
    mockSaveAgentConfig.mockReset();
    mockGetPlugins.mockReset();
    mockShowMessage.mockReset();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("loads config and agent map into reactive state", async () => {
    mockGetAgentConfig.mockResolvedValueOnce({
      maxHistoryRounds: "9",
      contextTtlHours: 48,
      globalSystemPrompt: "global-prompt",
      agents: [
        {
          chineseName: "灏忓",
          baseName: "Nova",
          modelId: "gemini-2.5-flash",
          description: "鍔╂墜鎻忚堪",
          systemPrompt: "{{Nova}}",
          maxOutputTokens: 4096,
          temperature: 0.8,
        },
        {
          chineseName: "榛樿鍊兼祴璇?",
          baseName: "",
          modelId: "model-b",
          description: "",
          systemPrompt: "",
        },
      ],
    });
    mockGetAgentMap.mockResolvedValueOnce({ Nova: {}, Atlas: {} });

    const state = useAgentAssistantConfig();
    await state.loadConfig();

    expect(state.globalConfig.value).toEqual({
      maxHistory: 9,
      contextTtl: 48,
      globalSystemPrompt: "global-prompt",
    });

    expect(state.agents.value).toHaveLength(2);
    expect(state.agents.value[0]).toMatchObject({
      name: "灏忓",
      baseName: "Nova",
      model: "gemini-2.5-flash",
      personality: "鍔╂墜鎻忚堪",
      systemPrompt: "{{Nova}}",
      maxOutputTokens: 4096,
      temperature: 0.8,
    });
    expect(state.agents.value[1]).toMatchObject({
      name: "榛樿鍊兼祴璇?",
      model: "model-b",
      maxOutputTokens: 8000,
      temperature: 0.7,
    });
    expect(state.availableAgents.value).toEqual(["Nova", "Atlas"]);
  });

  it("supports creating/removing assistants from existing agent and custom template", () => {
    const state = useAgentAssistantConfig();

    state.selectedExistingAgent.value = "Nova";
    state.addFromExisting();

    expect(state.selectedExistingAgent.value).toBe("");
    expect(state.agents.value[0]).toMatchObject({
      name: "Nova",
      baseName: "Nova",
      systemPrompt: "{{Nova}}",
    });
    expect(mockShowMessage).toHaveBeenCalled();

    state.addCustomAgent();
    expect(state.agents.value[1]).toMatchObject({
      name: "新 Agent",
      model: "",
      maxOutputTokens: 8000,
      temperature: 0.7,
    });

    state.removeAgent(1);
    expect(state.agents.value).toHaveLength(1);
  });

  it("validates before save and posts normalized payload on success", async () => {
    const state = useAgentAssistantConfig();

    state.agents.value = [
      {
        name: "鏈夊悕鏃犳ā鍨?",
        baseName: "",
        model: "",
        personality: "",
        systemPrompt: "",
        maxOutputTokens: 8000,
        temperature: 0.7,
      },
    ];

    await state.saveConfig();
    expect(mockShowMessage).toHaveBeenCalled();
    expect(mockSaveAgentConfig).not.toHaveBeenCalled();

    mockShowMessage.mockReset();
    mockSaveAgentConfig.mockReset();

    state.globalConfig.value.maxHistory = 10;
    state.globalConfig.value.contextTtl = 72;
    state.globalConfig.value.globalSystemPrompt = "缁熶竴琛ュ厖";
    state.agents.value = [
      {
        name: "Nova鍔╂墜",
        baseName: "Nova",
        model: "gemini-2.5-pro",
        personality: "鐮旂┒鍨?",
        systemPrompt: "{{Nova}}",
        maxOutputTokens: 0,
        temperature: 0,
      },
      {
        name: "",
        baseName: "",
        model: "",
        personality: "",
        systemPrompt: "",
        maxOutputTokens: 8000,
        temperature: 0.7,
      },
    ];

    mockSaveAgentConfig.mockResolvedValueOnce(undefined);

    await state.saveConfig();

    expect(mockSaveAgentConfig).toHaveBeenCalledWith(
      {
        maxHistoryRounds: 10,
        contextTtlHours: 72,
        globalSystemPrompt: "缁熶竴琛ュ厖",
        agents: [
          {
            baseName: "Nova",
            chineseName: "Nova鍔╂墜",
            modelId: "gemini-2.5-pro",
            description: "鐮旂┒鍨?",
            systemPrompt: "{{Nova}}",
            maxOutputTokens: 8000,
            temperature: 0.7,
          },
        ],
      },
      {
        loadingKey: "agent-assistant.config.save",
      }
    );

    expect(state.statusType.value).toBe("success");
    expect(state.statusMessage.value).toBe("AgentAssistant 配置已保存！");
  });

  it("exposes stable feature contract for agent assistant config integration", () => {
    const state = useAgentAssistantConfig();

    expect(Object.keys(state).sort()).toEqual(
      [
        "addCustomAgent",
        "addFromExisting",
        "agents",
        "availableAgents",
        "globalConfig",
        "loadConfig",
        "removeAgent",
        "saveConfig",
        "selectedExistingAgent",
        "statusMessage",
        "statusType",
      ].sort()
    );
  });
});
