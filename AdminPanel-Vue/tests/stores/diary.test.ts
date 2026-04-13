import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const {
  mockGetFolders,
  mockGetDiaryList,
  mockGetRagTagsConfig,
  mockShowMessage,
} = vi.hoisted(() => ({
  mockGetFolders: vi.fn(async () => []),
  mockGetDiaryList: vi.fn(async () => ({ notes: [], total: 0, page: 1, pageSize: 0 })),
  mockGetRagTagsConfig: vi.fn(async () => ({
    thresholdEnabled: false,
    threshold: 0.7,
    tags: [],
  })),
  mockShowMessage: vi.fn<(message: string, type: string) => void>(),
}));

vi.mock("@/api", () => ({
  diaryApi: {
    getFolders: (...args: unknown[]) => mockGetFolders(...args),
    getDiaryList: (...args: unknown[]) => mockGetDiaryList(...args),
    getRagTagsConfig: (...args: unknown[]) => mockGetRagTagsConfig(...args),
    saveRagTagsConfig: vi.fn(async () => undefined),
    getDiaryContent: vi.fn(async () => ""),
    saveDiary: vi.fn(async () => undefined),
    deleteDiary: vi.fn(async () => ({ deleted: [] })),
    moveDiaries: vi.fn(async () => undefined),
  },
}));

vi.mock("@/utils", () => ({
  showMessage: (...args: [string, string]) => mockShowMessage(...args),
}));

import { useDiaryStore } from "@/stores/diary";

describe("diary store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("initializes folders, notes and rag tags", async () => {
    const store = useDiaryStore();

    mockGetFolders.mockResolvedValueOnce([{ name: "knowledge", path: "knowledge" }]);
    mockGetDiaryList.mockResolvedValueOnce({
      notes: [
        {
          file: "first.md",
          title: "first",
          modified: "2026-03-29T00:00:00.000Z",
          preview: "hello",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 1,
    });
    mockGetRagTagsConfig.mockResolvedValueOnce({
      thresholdEnabled: true,
      threshold: 0.8,
      tags: ["tag-a"],
    });

    await store.init();

    expect(store.selectedFolder).toBe("knowledge");
    expect(store.notes).toHaveLength(1);
    expect(store.ragTagsConfig.tags).toEqual(["tag-a"]);
    expect(store.ragTagsConfig.threshold).toBe(0.8);
  });

  it("filters notes by query", async () => {
    const store = useDiaryStore();

    store.notes = [
      { file: "alpha.md", title: "Alpha", modified: "" },
      { file: "beta.md", title: "Beta", modified: "" },
    ];

    store.setSearchQuery("alp");

    expect(store.filteredNotes).toHaveLength(1);
    expect(store.filteredNotes[0]?.file).toBe("alpha.md");
  });
});
