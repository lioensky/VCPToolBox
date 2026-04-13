import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref, type Ref } from "vue";

const {
  mockGetPosts,
  mockGetPostContent,
  mockSubmitReply,
  mockDeletePost,
  mockDeleteReply,
  mockShowMessage,
  mockResetPagination,
} = vi.hoisted(() => ({
  mockGetPosts: vi.fn(async () => []),
  mockGetPostContent: vi.fn(async () => ""),
  mockSubmitReply: vi.fn(async () => undefined),
  mockDeletePost: vi.fn(async () => ""),
  mockDeleteReply: vi.fn(async () => ""),
  mockShowMessage: vi.fn(),
  mockResetPagination: vi.fn(),
}));

vi.mock("@/api", () => ({
  forumApi: {
    getPosts: (...args: unknown[]) => mockGetPosts(...args),
    getPostContent: (...args: unknown[]) => mockGetPostContent(...args),
    submitReply: (...args: unknown[]) => mockSubmitReply(...args),
    deletePost: (...args: unknown[]) => mockDeletePost(...args),
    deleteReply: (...args: unknown[]) => mockDeleteReply(...args),
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

vi.mock("marked", () => ({
  marked: {
    parse: vi.fn((content: string) => `<p>${content}</p>`),
  },
}));

vi.mock("dompurify", () => ({
  default: {
    sanitize: vi.fn((content: string) => `sanitized:${content}`),
  },
}));

vi.mock("@/composables/usePagination", () => ({
  usePagination: (items: Ref<unknown[]>) => ({
    items,
    currentPage: ref(1),
    totalPages: ref(1),
    hasNext: ref(false),
    hasPrev: ref(false),
    nextPage: vi.fn(),
    prevPage: vi.fn(),
    reset: mockResetPagination,
  }),
}));

vi.mock("@/composables/useDebounceFn", () => ({
  useDebounceFn: (fn: () => void) => fn,
}));

import {
  FORUM_REPLY_DELIMITER,
  useVcpForum,
} from "@/features/vcp-forum/useVcpForum";

describe("useVcpForum", () => {
  beforeEach(() => {
    mockGetPosts.mockReset();
    mockGetPostContent.mockReset();
    mockSubmitReply.mockReset();
    mockDeletePost.mockReset();
    mockDeleteReply.mockReset();
    mockShowMessage.mockReset();
    mockResetPagination.mockReset();
    vi.stubGlobal("prompt", vi.fn(() => ""));
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("loads posts, keeps pinned threads first, and resets pagination on filters", async () => {
    mockGetPosts.mockResolvedValueOnce([
      {
        uid: "normal-new",
        title: "Alpha",
        author: "Alice",
        board: "General",
        timestamp: "2026-01-01T00:00:00.000Z",
        lastReplyAt: "2026-01-03T00:00:00.000Z",
      },
      {
        uid: "pinned-old",
        title: "[置顶] Beta",
        author: "Bob",
        board: "Tech",
        timestamp: "2025-12-01T00:00:00.000Z",
        lastReplyAt: "2025-12-02T00:00:00.000Z",
      },
      {
        uid: "normal-old",
        title: "Gamma",
        author: "Carol",
        board: "General",
        timestamp: "2026-01-01T00:00:00.000Z",
        lastReplyAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    const state = useVcpForum();
    await state.loadPosts();

    expect(state.paginatedPosts.value.map((post) => post.uid)).toEqual([
      "pinned-old",
      "normal-new",
      "normal-old",
    ]);

    state.onSearchInput("a");
    state.onBoardChange("General");

    expect(mockResetPagination).toHaveBeenCalled();
    expect(state.boards.value).toContain("General");
    expect(state.boards.value).toContain("Tech");
    expect(state.paginatedPosts.value.map((post) => post.uid)).toEqual([
      "normal-new",
      "normal-old",
    ]);
  });

  it("parses detail content and renders reply markdown", async () => {
    mockGetPostContent.mockResolvedValueOnce(
      [
        "# 标题",
        "",
        "**板块:** General",
        "**作者:** Alice",
        "**发布时间:** 2026-01-01T00:00:00.000Z",
        "",
        "主楼正文",
        FORUM_REPLY_DELIMITER,
        "### 楼层 #1",
        "**回复者:** Bob",
        "**时间:** 2026-01-02T00:00:00.000Z",
        "",
        "**bold** reply",
      ].join("\n")
    );

    const state = useVcpForum();
    await state.viewPost({
      uid: "post-1",
      title: "标题",
      author: "Alice",
      board: "General",
      timestamp: "2026-01-01T00:00:00.000Z",
      lastReplyBy: "Bob",
      lastReplyAt: "2026-01-02T00:00:00.000Z",
    });

    expect(state.selectedPost.value?.contentHtml).toContain("sanitized:");
    expect(state.selectedPost.value?.repliesList).toEqual([
      {
        floor: 1,
        author: "Bob",
        createdAt: "2026-01-02T00:00:00.000Z",
        content: "**bold** reply",
        contentHtml: "sanitized:<p>**bold** reply</p>",
      },
    ]);
  });

  it("validates reply content and nickname before submit", async () => {
    const state = useVcpForum();

    await state.submitReply();
    expect(mockShowMessage).toHaveBeenCalled();

    state.selectedPost.value = {
      uid: "p1",
      title: "T",
      author: "A",
      board: "B",
      timestamp: "now",
      contentHtml: "x",
      replies: 0,
      repliesList: [],
    };
    state.newReplyContent.value = "hello";
    await state.submitReply();

    expect(mockSubmitReply).not.toHaveBeenCalled();
    expect(mockShowMessage).toHaveBeenCalled();
  });

  it("deletes the selected post after confirmation and returns to list", async () => {
    mockDeletePost.mockResolvedValueOnce("帖子删除成功");

    const state = useVcpForum();
    state.viewMode.value = "detail";
    state.selectedPost.value = {
      uid: "p1",
      title: "T",
      author: "A",
      board: "B",
      timestamp: "now",
      contentHtml: "x",
      replies: 0,
      repliesList: [],
    };

    await state.deletePost();

    expect(mockDeletePost).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        loadingKey: "vcp-forum.post.delete",
        showLoader: false,
        suppressErrorMessage: true,
      })
    );
    expect(state.viewMode.value).toBe("list");
    expect(state.selectedPost.value).toBeNull();
    expect(mockShowMessage).toHaveBeenCalledWith("帖子删除成功", "success");
  });

  it("exposes stable feature contract for forum view integration", () => {
    const state = useVcpForum();

    expect(Object.keys(state).sort()).toEqual(
      [
        "backToList",
        "boards",
        "currentPage",
        "deletePost",
        "deleteReply",
        "hasNext",
        "hasPrev",
        "loadPosts",
        "newReplyContent",
        "nextPage",
        "onBoardChange",
        "onSearchInput",
        "paginatedPosts",
        "prevPage",
        "searchQuery",
        "selectedBoard",
        "selectedPost",
        "submitReply",
        "totalPages",
        "viewMode",
        "viewPost",
      ].sort()
    );
  });
});
