import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { forumApi } from "@/api";
import { showMessage } from "@/utils";
import { usePagination } from "@/composables/usePagination";
import { useDebounceFn } from "@/composables/useDebounceFn";
import { useMarkdownRenderer } from "@/composables/useMarkdownRenderer";
import { useAuthStore } from "@/stores/auth";
import type {
  ForumPost,
  ForumPostDetail,
  ForumReply,
} from "@/features/vcp-forum/types";

const PINNED_MARKER = "[置顶]";
export const FORUM_REPLY_DELIMITER = "\n\n---\n\n## 评论区\n---";
const REPLY_SPLIT_DELIMITER = "\n\n---\n";
const COMMENT_SECTION_PATTERN = /\n{2,}##\s*评论区\s*\n[-\s]*\n?/m;
const REPLY_BLOCK_PATTERN =
  /###\s*楼层\s*#\d+[\s\S]*?(?=\n\n---\n###\s*楼层\s*#\d+|\s*$)/g;
const REPLY_FLOOR_PATTERN = /###\s*楼层\s*#(\d+)/;
const REPLY_AUTHOR_PATTERN = /\*\*回复者:\*\*\s*(.+)$/m;
const REPLY_TIME_PATTERN = /\*\*时间:\*\*\s*(.+)$/m;
const REPLY_BODY_PATTERN = /\*\*时间:\*\*.+?\n\n([\s\S]*)$/m;
const REPLY_AUTHOR_ALLOWED_PATTERN = /^[\u4e00-\u9fa5a-zA-Z0-9_.\- ]+$/;
const DELETE_ALLOWED_ROLES = new Set([
  "admin",
  "root",
  "owner",
  "superadmin",
  "moderator",
  "ops",
]);

function toSortableTimestamp(value: string): number {
  const directParsed = Date.parse(value);
  if (!Number.isNaN(directParsed)) {
    return directParsed;
  }

  const normalizedParsed = Date.parse(value.replace(/-/g, ":"));
  return Number.isNaN(normalizedParsed) ? 0 : normalizedParsed;
}

export function isPinnedPost(post: Pick<ForumPost, "title">): boolean {
  return post.title.includes(PINNED_MARKER);
}

export function sortForumPosts(posts: readonly ForumPost[]): ForumPost[] {
  return [...posts].sort((left, right) => {
    const leftPinned = isPinnedPost(left);
    const rightPinned = isPinnedPost(right);

    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }

    const leftTime = toSortableTimestamp(left.lastReplyAt || left.timestamp);
    const rightTime = toSortableTimestamp(right.lastReplyAt || right.timestamp);
    return rightTime - leftTime;
  });
}

function toForumPostSummary(post: ForumPost | ForumPostDetail): ForumPost {
  return {
    uid: post.uid,
    title: post.title,
    author: post.author,
    board: post.board,
    timestamp: post.timestamp,
    lastReplyBy: post.lastReplyBy,
    lastReplyAt: post.lastReplyAt,
  };
}

function normalizeLineBreaks(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function extractMainContent(content: string): string {
  const normalized = normalizeLineBreaks(content);
  const commentSectionIndex = normalized.match(COMMENT_SECTION_PATTERN)?.index ?? -1;
  const firstReplyIndex = normalized.search(/\n###\s*楼层\s*#\d+\s*\n/);
  const splitCandidates = [commentSectionIndex, firstReplyIndex].filter(
    (index) => index >= 0
  );

  const splitIndex =
    splitCandidates.length > 0 ? Math.min(...splitCandidates) : normalized.length;

  return normalized
    .slice(0, splitIndex)
    .replace(/\n\s*---\s*$/, "")
    .trim();
}

function extractReplyBlocks(content: string): string[] {
  const normalized = normalizeLineBreaks(content).trim();
  const regexBlocks = normalized.match(REPLY_BLOCK_PATTERN);

  if (regexBlocks && regexBlocks.length > 0) {
    return regexBlocks.map((item) => item.trim()).filter(Boolean);
  }

  const splitIndex = normalized.indexOf(FORUM_REPLY_DELIMITER);
  if (splitIndex < 0) {
    return [];
  }

  const repliesRaw = normalized
    .slice(splitIndex + FORUM_REPLY_DELIMITER.length)
    .trim();

  if (!repliesRaw) {
    return [];
  }

  return repliesRaw
    .split(REPLY_SPLIT_DELIMITER)
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateReplyAuthor(value: string): string | null {
  const maid = value.trim();
  if (!maid) {
    return "请输入昵称";
  }

  if (maid.length > 50) {
    return "昵称不能超过 50 个字符";
  }

  if (!REPLY_AUTHOR_ALLOWED_PATTERN.test(maid)) {
    return "昵称仅支持中英文、数字、空格、下划线、点和短横线";
  }

  return null;
}

export function useVcpForum() {
  const authStore = useAuthStore();
  const { user } = storeToRefs(authStore);
  const { renderMarkdownSync, initializeRenderer } = useMarkdownRenderer();

  const boards = ref<string[]>([]);
  const posts = ref<ForumPost[]>([]);
  const selectedBoard = ref("all");
  const searchQuery = ref("");
  const debouncedSearchQuery = ref("");
  const viewMode = ref<"list" | "detail">("list");
  const selectedPost = ref<ForumPostDetail | null>(null);
  const newReplyContent = ref("");
  const replyAuthor = ref("");
  const isLoadingPosts = ref(false);
  const isLoadingDetail = ref(false);
  const isSubmitting = ref(false);
  const isDeletingPost = ref(false);
  const deletingReplyFloor = ref<number | null>(null);
  const scrollToReplyFloor = ref<number | null>(null);

  const canDelete = computed(() => {
    const role = user.value?.role?.trim().toLowerCase();
    if (!role) {
      return true;
    }
    return DELETE_ALLOWED_ROLES.has(role);
  });

  const filteredPosts = computed(() => {
    let result = posts.value;
    const query = debouncedSearchQuery.value;

    if (query) {
      result = result.filter(
        (post) =>
          post.title.toLowerCase().includes(query) ||
          post.author.toLowerCase().includes(query)
      );
    }

    if (selectedBoard.value !== "all") {
      result = result.filter((post) => post.board === selectedBoard.value);
    }

    return result;
  });

  const {
    items: paginatedPosts,
    currentPage,
    totalPages,
    hasNext,
    hasPrev,
    nextPage,
    prevPage,
    reset: resetPagination,
  } = usePagination(filteredPosts, { pageSize: 20 });

  const debouncedFilter = useDebounceFn(
    (value: unknown) => {
      const text = typeof value === "string" ? value : "";
      debouncedSearchQuery.value = text.trim().toLowerCase();
    },
    { delay: 250 }
  );

  watch(
    [selectedBoard, debouncedSearchQuery],
    () => {
      resetPagination();
    },
    { flush: "sync" }
  );

  watch(
    () => user.value?.username,
    (username) => {
      const normalized = typeof username === "string" ? username.trim() : "";
      if (!replyAuthor.value && normalized) {
        replyAuthor.value = normalized.slice(0, 50);
      }
    },
    { immediate: true }
  );

  function parseReplyItem(replyText: string, fallbackFloor: number): ForumReply {
    const authorMatch = replyText.match(REPLY_AUTHOR_PATTERN);
    const timeMatch = replyText.match(REPLY_TIME_PATTERN);
    const bodyMatch = replyText.match(REPLY_BODY_PATTERN);
    const floorMatch = replyText.match(REPLY_FLOOR_PATTERN);
    const parsedFloor = Number.parseInt(floorMatch?.[1] || "", 10);

    const content = bodyMatch?.[1]?.trim() || replyText.trim();

    return {
      floor: Number.isInteger(parsedFloor) && parsedFloor > 0 ? parsedFloor : fallbackFloor,
      author: authorMatch?.[1]?.trim() || "未知",
      createdAt: timeMatch?.[1]?.trim() || "",
      content,
      contentHtml: renderMarkdownSync(content),
    };
  }

  function buildPostDetail(post: ForumPost, content: string): ForumPostDetail {
    const mainContent = extractMainContent(content);
    const repliesList = extractReplyBlocks(content).map((item, index) =>
      parseReplyItem(item, index + 1)
    );

    return {
      ...post,
      contentHtml: renderMarkdownSync(mainContent),
      replies: repliesList.length,
      repliesList,
    };
  }

  function loadBoards() {
    const boardSet = new Set(
      posts.value.map((post) => post.board.trim()).filter(Boolean)
    );
    boards.value = Array.from(boardSet).sort((left, right) =>
      left.localeCompare(right, "zh-Hans-CN")
    );
  }

  async function loadPosts() {
    isLoadingPosts.value = true;
    try {
      const data = await forumApi.getPosts({
        showLoader: false,
        suppressErrorMessage: true,
      });

      posts.value = sortForumPosts(data);
      loadBoards();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showMessage(`加载论坛帖子失败：${errorMessage}`, "error");
      posts.value = [];
    } finally {
      isLoadingPosts.value = false;
    }
  }

  function onBoardChange(value: string) {
    selectedBoard.value = value;
  }

  function onSearchInput(value: string) {
    searchQuery.value = value;
    debouncedFilter(value);
  }

  async function viewPost(post: ForumPost) {
    isLoadingDetail.value = true;
    scrollToReplyFloor.value = null;
    try {
      await initializeRenderer();
      const content = await forumApi.getPostContent(post.uid, {
        showLoader: false,
        suppressErrorMessage: true,
      });

      selectedPost.value = buildPostDetail(post, content);
      viewMode.value = "detail";
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showMessage(`加载帖子详情失败：${errorMessage}`, "error");
    } finally {
      isLoadingDetail.value = false;
    }
  }

  function backToList() {
    viewMode.value = "list";
    selectedPost.value = null;
    newReplyContent.value = "";
    scrollToReplyFloor.value = null;
  }

  async function refreshSelectedPost(uid: string) {
    const sourcePost =
      posts.value.find((item) => item.uid === uid) ||
      (selectedPost.value?.uid === uid
        ? toForumPostSummary(selectedPost.value)
        : null);

    if (!sourcePost) {
      return;
    }

    await viewPost(sourcePost);
  }

  async function submitReply() {
    if (!selectedPost.value || !newReplyContent.value.trim()) {
      showMessage("请输入回复内容", "error");
      return;
    }

    const maid = replyAuthor.value.trim();
    const authorError = validateReplyAuthor(maid);
    if (authorError) {
      showMessage(authorError, "error");
      return;
    }

    isSubmitting.value = true;
    try {
      const uid = selectedPost.value.uid;
      await forumApi.submitReply(
        uid,
        {
          maid,
          content: newReplyContent.value.trim(),
        },
        {
          loadingKey: "vcp-forum.reply.submit",
          showLoader: false,
          suppressErrorMessage: true,
        }
      );

      showMessage("回复成功", "success");
      newReplyContent.value = "";
      await Promise.all([loadPosts(), refreshSelectedPost(uid)]);
      scrollToReplyFloor.value =
        selectedPost.value?.uid === uid
          ? (selectedPost.value.repliesList[selectedPost.value.repliesList.length - 1]
              ?.floor ?? null)
          : null;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showMessage(`回复失败：${errorMessage}`, "error");
    } finally {
      isSubmitting.value = false;
    }
  }

  async function deletePost() {
    if (!selectedPost.value) {
      return;
    }

    if (!canDelete.value) {
      showMessage("当前账号无删除权限", "error");
      return;
    }

    const currentPost = selectedPost.value;
    isDeletingPost.value = true;
    try {
      const message = await forumApi.deletePost(currentPost.uid, {
        loadingKey: "vcp-forum.post.delete",
        showLoader: false,
        suppressErrorMessage: true,
      });

      showMessage(message || "帖子已删除。", "success");
      backToList();
      await loadPosts();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showMessage(`删除帖子失败：${errorMessage}`, "error");
    } finally {
      isDeletingPost.value = false;
    }
  }

  async function deleteReply(floor: number) {
    if (!selectedPost.value) {
      return;
    }

    if (!Number.isInteger(floor) || floor <= 0) {
      showMessage("无效的楼层号", "error");
      return;
    }

    if (!canDelete.value) {
      showMessage("当前账号无删除权限", "error");
      return;
    }

    const uid = selectedPost.value.uid;
    deletingReplyFloor.value = floor;

    try {
      const message = await forumApi.deleteReply(uid, floor, {
        loadingKey: "vcp-forum.reply.delete",
        showLoader: false,
        suppressErrorMessage: true,
      });

      showMessage(message || `已删除第 ${floor} 楼。`, "success");
      await Promise.all([loadPosts(), refreshSelectedPost(uid)]);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showMessage(`删除楼层失败：${errorMessage}`, "error");
    } finally {
      deletingReplyFloor.value = null;
    }
  }

  return {
    boards,
    selectedBoard,
    searchQuery,
    viewMode,
    paginatedPosts,
    currentPage,
    totalPages,
    hasNext,
    hasPrev,
    selectedPost,
    newReplyContent,
    replyAuthor,
    isLoadingPosts,
    isLoadingDetail,
    isSubmitting,
    isDeletingPost,
    deletingReplyFloor,
    scrollToReplyFloor,
    canDelete,
    nextPage,
    prevPage,
    loadPosts,
    onBoardChange,
    onSearchInput,
    viewPost,
    backToList,
    submitReply,
    deletePost,
    deleteReply,
  };
}
