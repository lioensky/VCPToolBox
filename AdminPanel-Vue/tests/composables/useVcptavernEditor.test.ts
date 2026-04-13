import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as VueModule from "vue";
import {
  createMockHTMLElement,
  installPointerDomTestGlobals,
} from "./pointerDomTestUtils";

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof VueModule>("vue");
  return {
    ...actual,
    onMounted: () => {},
    onBeforeUnmount: () => {},
  };
});

const {
  mockGetPresets,
  mockGetPreset,
  mockSavePreset,
  mockShowMessage,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockGetPresets: vi.fn(async () => []),
  mockGetPreset: vi.fn(async () => ({})),
  mockSavePreset: vi.fn(async () => undefined),
  mockShowMessage: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("@/api", () => ({
  vcptavernApi: {
    getPresets: (...args: unknown[]) => mockGetPresets(...args),
    getPreset: (...args: unknown[]) => mockGetPreset(...args),
    savePreset: (...args: unknown[]) => mockSavePreset(...args),
    deletePreset: vi.fn(async () => undefined),
  },
}));

vi.mock("@/utils", () => ({
  showMessage: mockShowMessage,
}));

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  }),
}));

import { useVcptavernEditor } from "@/features/vcptavern-editor/useVcptavernEditor";

describe("useVcptavernEditor", () => {
  beforeEach(() => {
    mockGetPresets.mockReset();
    mockGetPreset.mockReset();
    mockSavePreset.mockReset();
    mockShowMessage.mockReset();
    mockLoggerError.mockReset();
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.unstubAllGlobals();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("loads presets and preset detail correctly", async () => {
    mockGetPresets.mockResolvedValueOnce(["p1", "p2"]);
    mockGetPreset.mockResolvedValueOnce({
      description: "desc",
      rules: [
        {
          id: "r1",
          name: "R",
          enabled: true,
          type: "relative",
          position: "before",
          target: "system",
          content: { role: "user", content: "hello" },
        },
      ],
    });

    const state = useVcptavernEditor();
    await state.fetchPresets();
    await state.loadPreset("p1");

    expect(state.presetNames.value).toEqual(["p1", "p2"]);
    expect(state.editorState.name).toBe("p1");
    expect(state.editorState.description).toBe("desc");
    expect(state.editorState.rules).toHaveLength(1);
    expect(state.isEditorVisible.value).toBe(true);
    expect(state.isNewPreset.value).toBe(false);
  });

  it("supports new preset, rule add/remove and pointer drag reorder", () => {
    const state = useVcptavernEditor();

    state.createNewPreset();
    expect(state.isEditorVisible.value).toBe(true);
    expect(state.isNewPreset.value).toBe(true);

    state.addRule();
    state.addRule();
    state.editorState.rules[0].name = "A";
    state.editorState.rules[1].name = "B";

    const rulesList = createMockHTMLElement();
    const hoveredRule = createMockHTMLElement({
      dataset: { ruleId: state.editorState.rules[1].id },
      rect: { top: 20, height: 10 },
    });
    hoveredRule
      .setClosest("[data-rule-id]", hoveredRule)
      .setClosest('[data-rules-list="true"]', rulesList);

    const draggedRule = createMockHTMLElement({
      dataset: { ruleId: state.editorState.rules[0].id },
      rect: { top: 0, height: 10 },
    });
    const captureTarget = createMockHTMLElement().setClosest(
      "[data-rule-id]",
      draggedRule
    );
    installPointerDomTestGlobals(() => hoveredRule);

    state.handleRulePointerDown(
      state.editorState.rules[0].id,
      {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        currentTarget: captureTarget,
      } as unknown as PointerEvent
    );
    state.handlePointerMove(
      {
        pointerId: 1,
        clientX: 10,
        clientY: 30,
        preventDefault: vi.fn(),
      } as unknown as PointerEvent
    );
    state.handlePointerUp(
      {
        pointerId: 1,
        preventDefault: vi.fn(),
      } as unknown as PointerEvent
    );

    expect(state.editorState.rules[0].name).toBe("B");
    expect(state.editorState.rules[1].name).toBe("A");

    state.removeRule(1);
    expect(state.editorState.rules).toHaveLength(1);
  });

  it("validates and saves preset with normalized payload", async () => {
    const state = useVcptavernEditor();

    state.editorState.name = "invalid name";
    await state.savePreset();
    expect(mockShowMessage).toHaveBeenCalledWith(
      "预设名称只能包含字母、数字、下划线和连字符",
      "error"
    );

    mockShowMessage.mockReset();
    mockSavePreset.mockReset();
    mockGetPresets.mockReset();
    mockGetPreset.mockReset();

    state.editorState.name = "valid_name";
    state.editorState.description = "  test desc  ";
    state.editorState.rules = [
      {
        id: "r-depth",
        name: "depth-rule",
        enabled: true,
        type: "depth",
        depth: 2,
        position: "before",
        target: "system",
        content: { role: "assistant", content: "depth-content" },
      },
      {
        id: "r-embed",
        name: "embed-rule",
        enabled: true,
        type: "embed",
        position: "after",
        target: "last_user",
        content: { role: "user", content: "embed-content" },
      },
    ] as never;

    mockSavePreset.mockResolvedValueOnce(undefined);
    mockGetPresets.mockResolvedValueOnce(["valid_name"]);
    mockGetPreset.mockResolvedValueOnce({ description: "test desc", rules: [] });

    await state.savePreset();

    expect(mockSavePreset).toHaveBeenCalledTimes(1);
    const saveCall = mockSavePreset.mock.calls[0] as [
      string,
      { description?: string; rules?: Array<Record<string, unknown>> }
    ];
    expect(saveCall[0]).toBe("valid_name");
    expect(saveCall[1].description).toBe("test desc");
    expect(saveCall[1].rules?.[0]?.position).toBeUndefined();
    expect(saveCall[1].rules?.[0]?.target).toBeUndefined();
    expect(saveCall[1].rules?.[1]?.content).toMatchObject({ role: "system" });

    expect(state.selectedPresetName.value).toBe("valid_name");
    expect(state.isNewPreset.value).toBe(false);
  });

  it("exposes stable feature contract for vcptavern editor integration", () => {
    const state = useVcptavernEditor();

    expect(Object.keys(state).sort()).toEqual(
      [
        "addRule",
        "createNewPreset",
        "deletePreset",
        "dragGhost",
        "dragGhostElement",
        "dragState",
        "editorState",
        "fetchPresets",
        "handlePointerMove",
        "handlePointerUp",
        "handleRulePointerDown",
        "isEditorVisible",
        "isLoading",
        "isNewPreset",
        "isSaving",
        "loadPreset",
        "orderedRules",
        "presetNames",
        "removeRule",
        "savePreset",
        "selectedPresetName",
      ].sort()
    );
  });
});
