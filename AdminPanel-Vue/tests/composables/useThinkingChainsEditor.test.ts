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
  mockGetThinkingChains,
  mockSaveThinkingChains,
  mockShowMessage,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockGetThinkingChains: vi.fn(async () => ({ chains: {} })),
  mockSaveThinkingChains: vi.fn(async () => undefined),
  mockShowMessage: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("@/api", () => ({
  ragApi: {
    getThinkingChains: (...args: unknown[]) => mockGetThinkingChains(...args),
    saveThinkingChains: (...args: unknown[]) => mockSaveThinkingChains(...args),
    getAvailableClusters: vi.fn(async () => []),
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

import { useThinkingChainsEditor } from "@/features/thinking-chains-editor/useThinkingChainsEditor";

type PointerListener = (event: PointerEvent) => void;

interface TestChain {
  uiId: string;
  theme: string;
  clusters: string[];
  kSequence: number[];
}

let testUiId = 0;

function createTestChain(
  theme: string,
  clusters: string[],
  kSequence: number[]
): TestChain {
  testUiId += 1;

  return {
    uiId: `test-chain-${testUiId}`,
    theme,
    clusters,
    kSequence,
  };
}

function createPointerEvent(
  overrides: Partial<PointerEvent> = {}
): PointerEvent {
  return {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 10,
    clientY: 10,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as PointerEvent;
}

function createPointerHarness(
  elementFromPoint: (x: number, y: number) => unknown
) {
  const dom = installPointerDomTestGlobals(elementFromPoint);

  function getWindowListener(eventName: string): PointerListener {
    const matchingCalls = dom.windowMock.addEventListener.mock.calls.filter(
      ([registeredEventName]: [string]) => registeredEventName === eventName
    ) as Array<[string, PointerListener]>;
    const latestCall = matchingCalls[matchingCalls.length - 1];

    if (!latestCall) {
      throw new Error(`Missing ${eventName} listener`);
    }

    return latestCall[1];
  }

  return {
    ...dom,
    move(event: PointerEvent) {
      getWindowListener("pointermove")(event);
    },
    up(event: PointerEvent) {
      getWindowListener("pointerup")(event);
    },
  };
}

describe("useThinkingChainsEditor", () => {
  beforeEach(() => {
    testUiId = 0;
    mockGetThinkingChains.mockReset();
    mockSaveThinkingChains.mockReset();
    mockShowMessage.mockReset();
    mockLoggerError.mockReset();
    vi.unstubAllGlobals();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("loads thinking chains with old/new formats", async () => {
    mockGetThinkingChains.mockResolvedValueOnce({
      chains: {
        legacy: ["clusterA", "clusterB"],
        modern: {
          clusters: ["clusterX"],
          kSequence: [3],
        },
      },
    });

    const state = useThinkingChainsEditor();
    await state.loadThinkingChains();

    expect(state.thinkingChains.value).toMatchObject([
      {
        theme: "legacy",
        clusters: ["clusterA", "clusterB"],
        kSequence: [1, 1],
      },
      {
        theme: "modern",
        clusters: ["clusterX"],
        kSequence: [3],
      },
    ]);
    expect(
      state.thinkingChains.value.every(chain =>
        typeof chain.uiId === "string" && chain.uiId.length > 0
      )
    ).toBe(true);
  });

  it("saves thinking chains with expected payload", async () => {
    const state = useThinkingChainsEditor();
    state.thinkingChains.value = [
      createTestChain("  theme-1  ", ["alpha", "beta"], [2, 4]),
    ];

    mockSaveThinkingChains.mockResolvedValueOnce(undefined);

    await state.saveThinkingChains();

    expect(mockSaveThinkingChains).toHaveBeenCalledWith(
      {
        chains: {
          "theme-1": {
            clusters: ["alpha", "beta"],
            kSequence: [2, 4],
          },
        },
      },
      {
        loadingKey: "thinking-chains.save",
      }
    );
    expect(state.statusType.value).toBe("success");
    expect(mockShowMessage).toHaveBeenCalledWith(expect.any(String), "success");
    expect(state.thinkingChains.value[0].theme).toBe("theme-1");
  });

  it("rejects empty or duplicate theme names before saving", async () => {
    const state = useThinkingChainsEditor();
    state.thinkingChains.value = [
      createTestChain("   ", ["alpha"], [2]),
      createTestChain("alpha", ["beta"], [3]),
      createTestChain("alpha", ["gamma"], [4]),
    ];

    await state.saveThinkingChains();

    expect(mockSaveThinkingChains).not.toHaveBeenCalled();
    expect(state.statusType.value).toBe("error");
    expect(mockShowMessage).toHaveBeenCalled();
  });

  it("reorders clusters and kSequence together when dragging in same chain", () => {
    const state = useThinkingChainsEditor();
    state.thinkingChains.value = [
      createTestChain("drag-theme", ["A", "B", "C"], [1, 2, 3]),
    ];

    const chainList = createMockHTMLElement({
      dataset: { chainIndex: "0" },
    });
    const hoveredItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "1", clusterName: "B" },
      rect: { top: 20, height: 10 },
    });
    const trailingItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "2", clusterName: "C" },
      rect: { top: 40, height: 10 },
    });
    hoveredItem
      .setClosest('[data-chain-item="true"]', hoveredItem)
      .setClosest('[data-chain-list="true"]', chainList);
    trailingItem
      .setClosest('[data-chain-item="true"]', trailingItem)
      .setClosest('[data-chain-list="true"]', chainList);

    const draggedItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "0", clusterName: "A" },
      rect: { top: 0, height: 10 },
    });
    chainList.setQuerySelectorAll('[data-chain-item="true"]', [
      draggedItem,
      hoveredItem,
      trailingItem,
    ]);
    const captureTarget = createMockHTMLElement().setClosest(
      '[data-chain-item="true"]',
      draggedItem
    );
    const pointerHarness = createPointerHarness(() => hoveredItem);

    state.startChainPointerDrag(
      0,
      0,
      createPointerEvent({
        currentTarget: captureTarget,
      })
    );
    pointerHarness.move(
      createPointerEvent({
        pointerId: 1,
        clientY: 30,
      })
    );
    pointerHarness.up(
      createPointerEvent({
        pointerId: 1,
      })
    );

    expect(state.thinkingChains.value[0].clusters).toEqual(["B", "A", "C"]);
    expect(state.thinkingChains.value[0].kSequence).toEqual([2, 1, 3]);
  });

  it("adds available cluster once and avoids duplicates on drop", () => {
    const state = useThinkingChainsEditor();
    state.thinkingChains.value = [
      createTestChain("drop-theme", ["base"], [5]),
    ];

    const chainList = createMockHTMLElement({
      dataset: { chainIndex: "0" },
    });
    const hoveredItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "0", clusterName: "base" },
      rect: { top: 20, height: 10 },
    });
    hoveredItem
      .setClosest('[data-chain-item="true"]', hoveredItem)
      .setClosest('[data-chain-list="true"]', chainList);
    chainList.setQuerySelectorAll('[data-chain-item="true"]', [hoveredItem]);

    const availableClusterItem = createMockHTMLElement({
      rect: { top: 0, height: 10 },
    });
    const captureTarget = createMockHTMLElement().setClosest(
      '[data-available-cluster="true"]',
      availableClusterItem
    );
    const pointerHarness = createPointerHarness(() => hoveredItem);

    state.startAvailablePointerDrag(
      "new-cluster",
      createPointerEvent({
        currentTarget: captureTarget,
      })
    );
    pointerHarness.move(
      createPointerEvent({
        pointerId: 1,
        clientY: 30,
      })
    );
    pointerHarness.up(
      createPointerEvent({
        pointerId: 1,
      })
    );

    state.startAvailablePointerDrag(
      "new-cluster",
      createPointerEvent({
        pointerId: 2,
        currentTarget: captureTarget,
      })
    );
    pointerHarness.move(
      createPointerEvent({
        pointerId: 2,
        clientY: 30,
      })
    );
    pointerHarness.up(
      createPointerEvent({
        pointerId: 2,
      })
    );

    expect(state.thinkingChains.value[0].clusters).toEqual(["base", "new-cluster"]);
    expect(state.thinkingChains.value[0].kSequence).toEqual([5, 1]);
  });

  it("keeps available-cluster preview stable when the pointer hovers the preview item itself", () => {
    const state = useThinkingChainsEditor();
    state.thinkingChains.value = [
      createTestChain("drag-theme", ["A", "B", "C"], [1, 2, 3]),
    ];

    const chainList = createMockHTMLElement({
      dataset: { chainIndex: "0" },
    });
    const hoveredTarget = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "1", clusterName: "B" },
      rect: { top: 20, height: 10 },
    });
    const leadingItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "0", clusterName: "A" },
      rect: { top: 0, height: 10 },
    });
    const trailingItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "2", clusterName: "C" },
      rect: { top: 40, height: 10 },
    });
    hoveredTarget
      .setClosest('[data-chain-item="true"]', hoveredTarget)
      .setClosest('[data-chain-list="true"]', chainList);

    const hoveredPreviewItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "1", clusterName: "X" },
      rect: { top: 20, height: 10 },
    });
    hoveredPreviewItem
      .setClosest('[data-chain-item="true"]', hoveredPreviewItem)
      .setClosest('[data-chain-list="true"]', chainList);
    leadingItem
      .setClosest('[data-chain-item="true"]', leadingItem)
      .setClosest('[data-chain-list="true"]', chainList);
    trailingItem
      .setClosest('[data-chain-item="true"]', trailingItem)
      .setClosest('[data-chain-list="true"]', chainList);

    const availableClusterItem = createMockHTMLElement({
      rect: { top: 0, height: 10 },
    });
    const captureTarget = createMockHTMLElement().setClosest(
      '[data-available-cluster="true"]',
      availableClusterItem
    );

    let currentHover: unknown = hoveredTarget;
    chainList.setQuerySelectorAll('[data-chain-item="true"]', [
      leadingItem,
      hoveredTarget,
      trailingItem,
    ]);
    const pointerHarness = createPointerHarness(() => currentHover);

    state.startAvailablePointerDrag(
      "X",
      createPointerEvent({
        clientY: 0,
        currentTarget: captureTarget,
      })
    );

    pointerHarness.move(
      createPointerEvent({
        pointerId: 1,
        clientY: 22,
      })
    );

    currentHover = hoveredPreviewItem;
    chainList.setQuerySelectorAll('[data-chain-item="true"]', [
      leadingItem,
      hoveredPreviewItem,
      hoveredTarget,
      trailingItem,
    ]);

    pointerHarness.move(
      createPointerEvent({
        pointerId: 1,
        clientY: 22,
      })
    );
    pointerHarness.up(
      createPointerEvent({
        pointerId: 1,
      })
    );

    expect(state.thinkingChains.value[0].clusters).toEqual(["A", "X", "B", "C"]);
    expect(state.thinkingChains.value[0].kSequence).toEqual([1, 1, 2, 3]);
  });

  it("keeps insertion position when the pointer is in the gap between list items", () => {
    const state = useThinkingChainsEditor();
    state.thinkingChains.value = [
      createTestChain("gap-theme", ["A", "B", "C"], [1, 2, 3]),
    ];

    const chainList = createMockHTMLElement({
      dataset: { chainIndex: "0" },
    });
    const firstItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "0", clusterName: "A" },
      rect: { top: 0, height: 10 },
    });
    const secondItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "1", clusterName: "B" },
      rect: { top: 20, height: 10 },
    });
    const thirdItem = createMockHTMLElement({
      dataset: { chainIndex: "0", clusterIndex: "2", clusterName: "C" },
      rect: { top: 40, height: 10 },
    });

    chainList.setQuerySelectorAll('[data-chain-item="true"]', [
      firstItem,
      secondItem,
      thirdItem,
    ]);
    firstItem
      .setClosest('[data-chain-item="true"]', firstItem)
      .setClosest('[data-chain-list="true"]', chainList);
    secondItem
      .setClosest('[data-chain-item="true"]', secondItem)
      .setClosest('[data-chain-list="true"]', chainList);
    thirdItem
      .setClosest('[data-chain-item="true"]', thirdItem)
      .setClosest('[data-chain-list="true"]', chainList);
    chainList.setClosest('[data-chain-item="true"]', null).setClosest(
      '[data-chain-list="true"]',
      chainList
    );

    const availableClusterItem = createMockHTMLElement({
      rect: { top: 0, height: 10 },
    });
    const captureTarget = createMockHTMLElement().setClosest(
      '[data-available-cluster="true"]',
      availableClusterItem
    );
    const pointerHarness = createPointerHarness(() => chainList);

    state.startAvailablePointerDrag(
      "X",
      createPointerEvent({
        clientY: 0,
        currentTarget: captureTarget,
      })
    );
    pointerHarness.move(
      createPointerEvent({
        pointerId: 1,
        clientY: 12,
      })
    );
    pointerHarness.up(
      createPointerEvent({
        pointerId: 1,
      })
    );

    expect(state.thinkingChains.value[0].clusters).toEqual(["A", "X", "B", "C"]);
    expect(state.thinkingChains.value[0].kSequence).toEqual([1, 1, 2, 3]);
  });

  it("exposes stable feature contract for thinking chains editor integration", () => {
    const state = useThinkingChainsEditor();

    expect(Object.keys(state).sort()).toEqual(
      [
        "addCluster",
        "addThinkingChain",
        "availableClusters",
        "dragGhost",
        "dragGhostElement",
        "getRenderedClusters",
        "getRenderedKValue",
        "isAvailableClusterDragging",
        "isChainClusterDragging",
        "isChainDropAfter",
        "isChainDropBefore",
        "isChainDropTarget",
        "isPreviewDragging",
        "loadAvailableClusters",
        "loadThinkingChains",
        "removeChain",
        "removeCluster",
        "removeClusterByName",
        "saveThinkingChains",
        "startAvailablePointerDrag",
        "startChainPointerDrag",
        "statusMessage",
        "statusType",
        "thinkingChains",
        "updateClusterKValue",
      ].sort()
    );
  });
});
