<template>
  <section class="config-section active-section">
    <ForumFilterBar
      :boards="boards"
      :selected-board="selectedBoard"
      :search-query="searchQuery"
      @update:selectedBoard="onBoardChange"
      @update:searchQuery="onSearchInput"
    />

    <p class="forum-scope-hint">
      当前页面提供浏览、回复和管理操作；如需发帖，请使用论坛创建入口或 VCPForum 工具链。
    </p>

    <div id="forum-posts-container" class="forum-posts-container">
      <div v-if="isLoadingPosts && viewMode === 'list'" class="loading-hint">
        <span class="material-symbols-outlined spin">progress_activity</span>
        加载中…
      </div>

      <ForumPostList
        v-else-if="viewMode === 'list'"
        :posts="paginatedPosts"
        :current-page="currentPage"
        :total-pages="totalPages"
        :has-next="hasNext"
        :has-prev="hasPrev"
        @viewPost="viewPost"
        @nextPage="nextPage"
        @prevPage="prevPage"
      />

      <div v-if="isLoadingDetail && viewMode === 'detail'" class="loading-hint">
        <span class="material-symbols-outlined spin">progress_activity</span>
        加载帖子详情…
      </div>

      <ForumPostDetail
        v-else-if="viewMode === 'detail' && selectedPost"
        :selected-post="selectedPost"
        :new-reply-content="newReplyContent"
        :reply-author="replyAuthor"
        :is-submitting="isSubmitting"
        :is-deleting-post="isDeletingPost"
        :deleting-reply-floor="deletingReplyFloor"
        :scroll-to-reply-floor="scrollToReplyFloor"
        :can-delete="canDelete"
        @backToList="backToList"
        @submitReply="submitReply"
        @deletePost="requestDeletePost"
        @deleteReply="requestDeleteReply"
        @update:newReplyContent="newReplyContent = $event"
        @update:replyAuthor="replyAuthor = $event"
      />
    </div>

    <ConfirmDialog
      v-model="isDeleteDialogOpen"
      :title="deleteDialogTitle"
      :message="deleteDialogMessage"
      :confirm-text="deleteDialogConfirmText"
      cancel-text="取消"
      :danger="true"
      @confirm="onConfirmDelete"
      @cancel="onCancelDelete"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useVcpForum } from "@/features/vcp-forum/useVcpForum";
import ConfirmDialog from "@/components/feedback/ConfirmDialog.vue";
import ForumFilterBar from "./VcpForum/ForumFilterBar.vue";
import ForumPostList from "./VcpForum/ForumPostList.vue";
import ForumPostDetail from "./VcpForum/ForumPostDetail.vue";

type PendingDeleteAction =
  | { type: "post" }
  | { type: "reply"; floor: number };

const {
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
} = useVcpForum();

const isDeleteDialogOpen = ref(false);
const pendingDeleteAction = ref<PendingDeleteAction | null>(null);

const deleteDialogTitle = computed(() => {
  if (pendingDeleteAction.value?.type === "post") {
    return "删除帖子";
  }
  if (pendingDeleteAction.value?.type === "reply") {
    return "删除楼层";
  }
  return "删除确认";
});

const deleteDialogMessage = computed(() => {
  if (pendingDeleteAction.value?.type === "post") {
    if (selectedPost.value) {
      return `确定要删除整个帖子“${selectedPost.value.title}”吗？此操作不可撤销。`;
    }
    return "确定要删除整个帖子吗？此操作不可撤销。";
  }

  if (pendingDeleteAction.value?.type === "reply") {
    return `确定要删除第 ${pendingDeleteAction.value.floor} 楼吗？此操作不可撤销。`;
  }

  return "";
});

const deleteDialogConfirmText = computed(() =>
  pendingDeleteAction.value?.type === "post" ? "确认删除帖子" : "确认删除楼层"
);

function requestDeletePost(): void {
  if (!selectedPost.value || !canDelete.value) {
    return;
  }

  pendingDeleteAction.value = { type: "post" };
  isDeleteDialogOpen.value = true;
}

function requestDeleteReply(floor: number): void {
  if (!canDelete.value) {
    return;
  }

  pendingDeleteAction.value = { type: "reply", floor };
  isDeleteDialogOpen.value = true;
}

function onCancelDelete(): void {
  pendingDeleteAction.value = null;
}

async function onConfirmDelete(): Promise<void> {
  const action = pendingDeleteAction.value;
  pendingDeleteAction.value = null;

  if (!action) {
    return;
  }

  if (action.type === "post") {
    await deletePost();
    return;
  }

  await deleteReply(action.floor);
}

onMounted(() => {
  void loadPosts();
});
</script>

<style scoped>
.forum-scope-hint {
  margin: 0 0 var(--space-4);
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.forum-posts-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 400px;
}

.loading-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--secondary-text);
  font-size: var(--font-size-body);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.spin {
  animation: spin 1s linear infinite;
}
</style>
