import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as UtilsModule from "@/utils";

type EnvEntry = {
  key: string | null;
  value: string;
  isCommentOrEmpty: boolean;
  isMultilineQuoted: boolean;
};

const { mockGetPlugins, mockSavePluginConfig, mockParseEnvToList, mockShowMessage } =
  vi.hoisted(() => ({
    mockGetPlugins: vi.fn(async () => []),
    mockSavePluginConfig: vi.fn(async () => undefined),
    mockParseEnvToList: vi.fn<(content: string) => EnvEntry[]>(),
    mockShowMessage: vi.fn<(message: string, type: string) => void>(),
  }));

vi.mock("@/api", () => ({
  pluginApi: {
    getPlugins: (...args: unknown[]) => mockGetPlugins(...args),
    savePluginConfig: (...args: unknown[]) => mockSavePluginConfig(...args),
    saveInvocationCommandDescription: vi.fn(async () => undefined),
    togglePlugin: vi.fn(async () => ({ success: true })),
  },
}));

vi.mock("@/utils", async () => {
  const actual = await vi.importActual<typeof UtilsModule>("@/utils");
  return {
    ...actual,
    parseEnvToList: (content: string) => mockParseEnvToList(content),
    showMessage: (...args: [string, string]) => mockShowMessage(...args),
  };
});

import { usePluginConfigStore } from "@/stores/pluginConfig";

describe("plugin config store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("loads plugin config and infers entry types", async () => {
    const store = usePluginConfigStore();

    mockGetPlugins.mockResolvedValueOnce([
      {
        manifest: {
          name: "calendar",
          configSchema: {
            ENABLED: "boolean",
            RETRIES: "integer",
            TITLE: "string",
          },
          defaults: {
            TITLE: "DefaultTitle",
          },
          capabilities: {
            invocationCommands: [
              {
                commandIdentifier: "calendar.refresh",
                description: "refresh cmd",
              },
            ],
          },
        },
        enabled: true,
        configEnvContent: "ENABLED=true\nRETRIES=3\nCUSTOM_KEY=abc",
      },
    ]);

    mockParseEnvToList.mockReturnValue([
      {
        key: "ENABLED",
        value: "true",
        isCommentOrEmpty: false,
        isMultilineQuoted: false,
      },
      {
        key: "RETRIES",
        value: "3",
        isCommentOrEmpty: false,
        isMultilineQuoted: false,
      },
      {
        key: "CUSTOM_KEY",
        value: "abc",
        isCommentOrEmpty: false,
        isMultilineQuoted: false,
      },
    ]);

    await store.loadPluginConfig("calendar");

    expect(store.pluginData?.manifest.name).toBe("calendar");
    expect(store.hasConfigSchema).toBe(true);

    const enabledEntry = store.configEntries.find((entry) => entry.key === "ENABLED");
    const retriesEntry = store.configEntries.find((entry) => entry.key === "RETRIES");
    const customEntry = store.configEntries.find((entry) => entry.key === "CUSTOM_KEY");

    expect(enabledEntry?.type).toBe("boolean");
    expect(enabledEntry?.value).toBe(true);
    expect(retriesEntry?.type).toBe("integer");
    expect(retriesEntry?.value).toBe(3);
    expect(customEntry?.type).toBe("string");
    expect(store.commandDescriptions["calendar.refresh"]).toBe("refresh cmd");
  });

  it("saves merged schema and custom config entries", async () => {
    const store = usePluginConfigStore();

    const pluginList = [
      {
        manifest: {
          name: "calendar",
          configSchema: {
            ENABLED: "boolean",
            RETRIES: "integer",
            TITLE: "string",
          },
          defaults: {
            TITLE: "DefaultTitle",
          },
        },
        enabled: true,
        configEnvContent: '# comment\nENABLED=true\nRETRIES=2\nCUSTOM_KEY=abc',
      },
    ];

    mockGetPlugins.mockResolvedValue(pluginList);
    mockSavePluginConfig.mockResolvedValueOnce(undefined);

    mockParseEnvToList.mockReturnValue([
      {
        key: null,
        value: "# comment",
        isCommentOrEmpty: true,
        isMultilineQuoted: false,
      },
      {
        key: "ENABLED",
        value: "true",
        isCommentOrEmpty: false,
        isMultilineQuoted: false,
      },
      {
        key: "RETRIES",
        value: "2",
        isCommentOrEmpty: false,
        isMultilineQuoted: false,
      },
      {
        key: "CUSTOM_KEY",
        value: "abc",
        isCommentOrEmpty: false,
        isMultilineQuoted: false,
      },
    ]);

    await store.loadPluginConfig("calendar");

    const retriesEntry = store.configEntries.find((entry) => entry.key === "RETRIES");
    const customEntry = store.configEntries.find((entry) => entry.key === "CUSTOM_KEY");

    if (!retriesEntry || !customEntry) {
      throw new Error("test setup failed: expected entries not found");
    }

    retriesEntry.value = 5;
    customEntry.value = 'overridden "quoted"\nnext';

    await store.savePluginConfig("calendar");

    expect(mockSavePluginConfig).toHaveBeenCalledTimes(1);
    const saveCall = mockSavePluginConfig.mock.calls[0] as [
      string,
      string,
      { loadingKey: string }
    ];
    expect(saveCall[0]).toBe("calendar");
    expect(saveCall[2]).toEqual({ loadingKey: "plugin-config.save" });
    expect(saveCall[1]).toContain("# comment");
    expect(saveCall[1]).toContain("ENABLED=true");
    expect(saveCall[1]).toContain("RETRIES=5");
    expect(saveCall[1]).toContain("TITLE=DefaultTitle");
    expect(saveCall[1]).toContain('CUSTOM_KEY="overridden \\"quoted\\"\\nnext"');
    expect(mockShowMessage).toHaveBeenCalledWith("插件配置已保存！", "success");
  });
});
