import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  buildConfigPayload,
  createConfigDraft,
  createConfigEditor,
  createDefaultConfig,
  validateConfig,
} from "../src/features/dynamic-tools/config";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("动态工具专属配置", () => {
  it("提供v2业务默认值且模型没有独立端点", () => {
    const c = createDefaultConfig();
    expect(c.version).toBe(2);
    expect(c.summary).toEqual({
      lightListTokenBudget: 15,
      briefTokenBudget: 6,
      minBriefTokenBudget: 3,
    });
    expect(c.classification.maxCategories).toBe(3);
    expect(c.classification.embeddingThreshold).toBe(0.34);
    expect(c.classification.categoryRules.length).toBeGreaterThan(0);
    expect(c.smallModel).toEqual({
      enabled: false,
      model: "",
      maxRetries: 2,
      retryDelayMs: 250,
      maxTokens: 2048,
      temperature: 0.1,
    });
    expect(c.smallModel).not.toHaveProperty("endpoint");
    expect(c.smallModel).not.toHaveProperty("apiKey");
    expect(c.smallModel).not.toHaveProperty("useMainConfig");
  });

  it("前后端v2默认值与完整payload约束一致", () => {
    const backend = createRequire(import.meta.url)(
      "../../modules/dynamicToolRegistry.js",
    );
    const config = createDefaultConfig();
    expect(config).toEqual(backend.DEFAULT_CONFIG);
    const payload = buildConfigPayload(createConfigDraft(config));
    expect(backend.validateConfigPatch(payload)).toEqual(payload);
  });

  it("完整payload保留摘要、规则、重试和人工说明，不发送占位符和历史密钥", () => {
    const draft = createConfigDraft(createDefaultConfig());
    draft.config.smallModel = {
      enabled: true,
      model: "main-model",
      maxRetries: 1,
      retryDelayMs: 50,
      maxTokens: 512,
      temperature: 0.2,
    };
    draft.aliasText = "搜索=web_search\n代码=file_code";
    draft.categoryRulesText = JSON.stringify([
      {
        category: "web_search",
        parent: "search",
        description: "检索网页",
        keywords: ["搜索"],
      },
    ]);
    draft.config.manualOverrides.descriptionOverrides["local:Search"] = {
      brief: "网页搜索",
      fullDescription: "完整网页搜索说明",
      categories: ["web_search"],
      keywords: ["网页"],
    };
    (draft.config.smallModel as unknown as Record<string, unknown>).apiKey =
      "secret";
    (draft.config.smallModel as unknown as Record<string, unknown>).endpoint =
      "https://private.invalid";
    const payload = buildConfigPayload(draft);
    expect(payload).not.toHaveProperty("placeholder");
    expect(payload.smallModel).not.toHaveProperty("apiKey");
    expect(payload.smallModel).not.toHaveProperty("endpoint");
    expect(payload.summary).toEqual(draft.config.summary);
    expect(payload.classification.categoryRules[0].parent).toBe("search");
    expect(payload.manualOverrides.categoryAliases).toEqual({
      搜索: "web_search",
      代码: "file_code",
    });
    expect(payload.manualOverrides.descriptionOverrides).toEqual(
      draft.config.manualOverrides.descriptionOverrides,
    );
    expect(payload.smallModel.maxTokens).toBe(512);
  });

  it.each([NaN, Infinity, 1.5, "5", null])("拒绝非法整数 %s", (value) => {
    const config = createDefaultConfig();
    (config as unknown as Record<string, unknown>).maxBriefListItems = value;
    expect(validateConfig(config)).toBeTruthy();
  });

  it("校验布尔、范围、摘要关系、分类规则和完整人工覆盖", () => {
    const c = createDefaultConfig();
    c.summary.minBriefTokenBudget = 7;
    expect(validateConfig(c)).toBeTruthy();
    c.summary.minBriefTokenBudget = 3;
    c.smallModel.temperature = 3;
    expect(validateConfig(c)).toBeTruthy();
    c.smallModel.temperature = 0.1;
    (c as unknown as Record<string, unknown>).enabled = "false";
    expect(validateConfig(c)).toBeTruthy();
    c.enabled = true;
    c.classification.categoryRules = [
      { category: "search", description: "搜索", keywords: ["web"] },
      { category: "search", description: "重复", keywords: ["x"] },
    ];
    expect(validateConfig(c)).toBeTruthy();
    c.classification.categoryRules = [
      { category: "search", description: "搜索", keywords: ["web"] },
    ];
    c.manualOverrides.descriptionOverrides.x = {
      keywords: [5] as unknown as string[],
    };
    expect(validateConfig(c)).toBeTruthy();
    c.manualOverrides.descriptionOverrides.x = { keywords: [] };
    expect(validateConfig(c)).toBeNull();
  });

  it("无效JSON或别名提供反馈，不静默清空规则", () => {
    const draft = createConfigDraft(createDefaultConfig());
    draft.categoryRulesText = "[{ broken";
    expect(() => buildConfigPayload(draft)).toThrow(/分类规则/);
    draft.categoryRulesText = "[]";
    expect(() => buildConfigPayload(draft)).toThrow();
    draft.categoryRulesText = JSON.stringify(
      createDefaultConfig().classification.categoryRules,
    );
    draft.aliasText = "missing equals";
    expect(() => buildConfigPayload(draft)).toThrow(/别名/);
  });

  it("刷新与轮询只更新干净草稿，脏草稿保持", () => {
    const editor = createConfigEditor();
    const first = createDefaultConfig();
    first.smallModel.model = "server-a";
    editor.refresh(first);
    expect(editor.draft.config.smallModel.model).toBe("server-a");
    editor.draft.config.smallModel.model = "my-edit";
    editor.draft.aliasText = "自定义=search";
    const refreshed = {
      ...first,
      smallModel: { ...first.smallModel, model: "server-b" },
    };
    editor.refresh(refreshed);
    expect(editor.draft.config.smallModel.model).toBe("my-edit");
    expect(editor.draft.aliasText).toBe("自定义=search");
    expect(editor.dirty).toBe(true);
  });

  it("保存原子成功、重复提交被禁用，失败保留草稿且解除忙状态", async () => {
    const editor = createConfigEditor();
    editor.refresh(createDefaultConfig());
    editor.draft.config.smallModel.model = "save-me";
    const pending = deferred<ReturnType<typeof createDefaultConfig>>();
    let calls = 0;
    const submit = async () => {
      calls++;
      return pending.promise;
    };
    const saved = editor.save(submit);
    expect(editor.saving).toBe(true);
    expect(await editor.save(submit)).toBe(false);
    expect(calls).toBe(1);
    pending.reject(new Error("disk full"));
    expect(await saved).toBe(false);
    expect(editor.error).toContain("disk full");
    expect(editor.draft.config.smallModel.model).toBe("save-me");
    expect(editor.saving).toBe(false);
    expect(
      await editor.save(async (payload) => ({
        ...createDefaultConfig(),
        ...payload,
      })),
    ).toBe(true);
    expect(editor.dirty).toBe(false);
  });

  it("人工分类与关键词输入的未完成分隔符也属于草稿", () => {
    const editor = createConfigEditor();
    editor.refresh(createDefaultConfig());
    expect(editor.draft.descriptionArrayText).toEqual({});
    editor.draft.descriptionArrayText["local:x"] = {
      categories: "search/web,",
      keywords: "web,",
    };
    editor.refresh(createDefaultConfig());
    expect(editor.dirty).toBe(true);
    expect(editor.draft.descriptionArrayText["local:x"].categories).toBe(
      "search/web,",
    );
  });

  it("晚到保存响应不覆盖在途产生的新编辑，刷新也不覆盖", async () => {
    const editor = createConfigEditor();
    editor.refresh(createDefaultConfig());
    const pending = deferred<ReturnType<typeof createDefaultConfig>>();
    const saved = editor.save(async () => pending.promise);
    editor.draft.config.smallModel.model = "new-edit";
    editor.refresh(createDefaultConfig());
    pending.resolve(createDefaultConfig());
    expect(await saved).toBe(true);
    expect(editor.draft.config.smallModel.model).toBe("new-edit");
    expect(editor.dirty).toBe(true);
  });

  it("专属Tab涵盖全部业务编辑入口，不再跳插件env", () => {
    const page = readFileSync(
      new URL("../src/views/DynamicToolsManager.vue", import.meta.url),
      "utf8",
    );
    expect(page).toContain("语义摘要与分类模型");
    expect(page).toContain("API_URL / API_Key");
    expect(page).toContain("已保存并热生效");
    for (const field of [
      "lightListTokenBudget",
      "briefTokenBudget",
      "minBriefTokenBudget",
      "maxCategories",
      "embeddingThreshold",
      "categoryRulesText",
      "maxRetries",
      "retryDelayMs",
      "maxTokens",
      "temperature",
      "fullDescription",
      "keywords",
    ])
      expect(page).toContain(field);
    expect(page).not.toContain("openPluginConfig");
    expect(page).not.toContain("useMainConfig");
    expect(page).not.toContain("smallModel.endpoint");
    expect(page).not.toContain('name: "PluginConfig"');
  });
});
