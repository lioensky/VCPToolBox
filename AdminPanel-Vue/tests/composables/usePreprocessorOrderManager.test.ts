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
  mockGetPreprocessorOrder,
  mockSavePreprocessorOrder,
  mockShowMessage,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockGetPreprocessorOrder: vi.fn(async () => []),
  mockSavePreprocessorOrder: vi.fn(async () => undefined),
  mockShowMessage: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("@/api", () => ({
  adminConfigApi: {
    getPreprocessorOrder: (...args: unknown[]) =>
      mockGetPreprocessorOrder(...args),
    savePreprocessorOrder: (...args: unknown[]) =>
      mockSavePreprocessorOrder(...args),
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

import { usePreprocessorOrderManager } from "@/features/preprocessor-order-manager/usePreprocessorOrderManager";

describe("usePreprocessorOrderManager", () => {
  beforeEach(() => {
    mockGetPreprocessorOrder.mockReset();
    mockSavePreprocessorOrder.mockReset();
    mockShowMessage.mockReset();
    mockLoggerError.mockReset();
    vi.unstubAllGlobals();
  });

  it("loads preprocessors from order/newOrder", async () => {
    mockGetPreprocessorOrder
      .mockResolvedValueOnce([
        { name: "a", displayName: "A" },
        { name: "b" },
      ])
      .mockResolvedValueOnce([{ name: "c", displayName: "C" }]);

    const state = usePreprocessorOrderManager();

    await state.loadPreprocessors();
    expect(state.preprocessors.value).toEqual([
      { name: "a", displayName: "A", description: undefined },
      { name: "b", displayName: "b", description: undefined },
    ]);

    await state.loadPreprocessors();
    expect(state.preprocessors.value).toEqual([
      { name: "c", displayName: "C", description: undefined },
    ]);
  });

  it("supports pointer drag reorder", () => {
    const state = usePreprocessorOrderManager();
    state.preprocessors.value = [
      { name: "a", displayName: "A" },
      { name: "b", displayName: "B" },
      { name: "c", displayName: "C" },
    ];

    const listElement = createMockHTMLElement();
    const hoveredItem = createMockHTMLElement({
      dataset: { preprocessorName: "c" },
      rect: { top: 20, height: 10 },
    });
    hoveredItem
      .setClosest("[data-preprocessor-name]", hoveredItem)
      .setClosest('[data-preprocessor-list="true"]', listElement);

    const draggedItem = createMockHTMLElement({
      dataset: { preprocessorName: "a" },
      rect: { top: 0, height: 10 },
    });
    const captureTarget = createMockHTMLElement().setClosest(
      "[data-preprocessor-name]",
      draggedItem
    );
    installPointerDomTestGlobals(() => hoveredItem);

    state.handleDragHandlePointerDown(
      "a",
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

    expect(state.preprocessors.value.map((item) => item.name)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(state.draggingPluginName.value).toBeNull();
  });

  it("saves order with expected payload", async () => {
    const state = usePreprocessorOrderManager();
    state.preprocessors.value = [
      { name: "first", displayName: "First" },
      { name: "second", displayName: "Second" },
    ];

    mockSavePreprocessorOrder.mockResolvedValueOnce(undefined);

    await state.saveOrder();

    expect(mockSavePreprocessorOrder).toHaveBeenCalledWith(
      ["first", "second"],
      { loadingKey: "preprocessors.order.save" }
    );
    expect(state.statusType.value).toBe("success");
    expect(mockShowMessage).toHaveBeenCalledWith("顺序已保存！", "success");
  });

  it("exposes stable feature contract for preprocessor order manager integration", () => {
    const state = usePreprocessorOrderManager();

    expect(Object.keys(state).sort()).toEqual(
      [
        "dragGhost",
        "dragGhostElement",
        "dragOverPluginName",
        "draggingPluginName",
        "dropPlacement",
        "handleDragHandlePointerDown",
        "handlePointerMove",
        "handlePointerUp",
        "loadPreprocessors",
        "orderedPreprocessors",
        "preprocessors",
        "saveOrder",
        "statusMessage",
        "statusType",
      ].sort()
    );
  });
});
