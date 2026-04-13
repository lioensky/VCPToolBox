import { ref } from "vue";
import { forumApi } from "@/api";
import { showMessage } from "@/utils";
import { usePagination } from "@/composables/usePagination";
import { useDebounceFn } from "@/composables/useDebounceFn";
import { useMarkdownRenderer } from "@/composables/useMarkdownRenderer";
import type {
  ForumPost,
  ForumPostDetail,
  ForumReply,
} from "@/features/vcp-forum/types";

const PINNED_MARKER = "[置顶]";

export const FORUM_REPLY_DELIMITER = "\n\n---\n\n## 评论区\n---";

const { renderMarkdownSync, initializeRenderer } = useMarkdownRenderer();

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

export function useVcpForum() {
  const boards = ref<string[]>([]);
  const posts = ref<ForumPost[]>([]);
  const filteredPosts = ref<ForumPost[]>([]);
  const selectedBoard = ref("all");
  const searchQuery = ref("");
  const viewMode = ref<"list" | "detail">("list");
  const selectedPost = ref<ForumPostDetail | null>(null);
  const newReplyContent = ref("");

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
    () => {
      filterPosts();
    },
    { delay: 250 }
  );

  function parseReplyItem(replyText: string, floor: number): ForumReply {
    const authorMatch = replyText.match(/\*\*回复者:\*\*\s*(.+)$/m);
    const timeMatch = replyText.match(/\*\*时间:\*\*\s*(.+)$/m);
    const bodyMatch = replyText.match(/\*\*时间:\*\*.+?\n\n([\s\S]*)$/m);
    const content = bodyMatch?.[1]?.trim() || replyText.trim();

    return {
      floor,
      author: authorMatch?.[1]?.trim() || "未知",
      createdAt: timeMatch?.[1]?.trim() || "",
      content,
      contentHtml: renderMarkdownSync(content),
    };
  }

  function buildPostDetail(post: ForumPost, content: string): ForumPostDetail {
    const splitIndex = content.indexOf(FORUM_REPLY_DELIMITER);
    const mainContent = splitIndex >= 0 ? content.slice(0, splitIndex) : content;
    const repliesRaw =
      splitIndex >= 0
        ? content.slice(splitIndex + FORUM_REPLY_DELIMITER.length).trim()
        : "";

    const repliesList = repliesRaw
      ? repliesRaw
          .split("\n\n---\n")
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item, index) => parseReplyItem(item, index + 1))
      : [];

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
    try {
      const data = await forumApi.getPosts({
        showLoader: false,
        suppressErrorMessage: true,
      });

      posts.value = sortForumPosts(data);
      loadBoards();
      filterPosts();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showMessage(`加载论坛帖子失败：${errorMessage}`, "error");
      posts.value = [];
      filteredPosts.value = [];
    }
  }

  function onBoardChange(value: string) {
    selectedBoard.value = value;
    filterPosts();
  }

  function onSearchInput(value: string) {
    searchQuery.value = value;
    debouncedFilter();
  }

  function filterPosts() {
    let result = [...posts.value];

    if (searchQuery.value) {
      const query = searchQuery.value.toLowerCase();
      result = result.filter(
        (post) =>
          post.title.toLowerCase().includes(query) ||
          post.author.toLowerCase().includes(query)
      );
    }

    if (selectedBoard.value !== "all") {
      result = result.filter((post) => post.board === selectedBoard.value);
    }

    filteredPosts.value = sortForumPosts(result);
    resetPagination();
  }

  async function viewPost(post: ForumPost) {
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
    }
  }

  function backToList() {
    viewMode.value = "list";
    selectedPost.value = null;
    newReplyContent.value = "";
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

    const maid = prompt("请输入您的昵称：")?.trim();
    if (!maid) {
      showMessage("请输入昵称", "error");
      return;
    }

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
      await loadPosts();
      await refreshSelectedPost(uid);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showMessage(`回复失败：${errorMessage}`, "error");
    }
  }

  async function deletePost() {
    if (!selectedPost.value) {
      return;
    }

    const currentPost = selectedPost.value;
    if (!confirm(`确定要删除整个帖子 "${currentPost.title}" 吗？此操作无法撤销。`)) {
      return;
    }

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

    if (!confirm(`确定要删除这个帖子的第 ${floor} 楼吗？`)) {
      return;
    }

    const uid = selectedPost.value.uid;

    try {
      const message = await forumApi.deleteReply(uid, floor, {
        loadingKey: "vcp-forum.reply.delete",
        showLoader: false,
        suppressErrorMessage: true,
      });

      showMessage(message || `已删除第 ${floor} 楼。`, "success");
      await loadPosts();
      await refreshSelectedPost(uid);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showMessage(`删除楼层失败：${errorMessage}`, "error");
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
