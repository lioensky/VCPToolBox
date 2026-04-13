<template>
  <section class="config-section active-section">
    <ForumFilterBar
      :boards="boards"
      :selected-board="selectedBoard"
      :search-query="searchQuery"
      @update:selectedBoard="onBoardChange"
      @update:searchQuery="onSearchInput"
    />

    <div id="forum-posts-container" class="forum-posts-container">
      <ForumPostList
        v-if="viewMode === 'list'"
        :posts="paginatedPosts"
        :current-page="currentPage"
        :total-pages="totalPages"
        :has-next="hasNext"
        :has-prev="hasPrev"
        @viewPost="viewPost"
        @nextPage="nextPage"
        @prevPage="prevPage"
      />

      <ForumPostDetail
        v-else-if="viewMode === 'detail' && selectedPost"
        :selected-post="selectedPost"
        :new-reply-content="newReplyContent"
        @backToList="backToList"
        @submitReply="submitReply"
        @deletePost="deletePost"
        @deleteReply="deleteReply"
        @update:newReplyContent="newReplyContent = $event"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { useVcpForum } from "@/features/vcp-forum/useVcpForum";
import ForumFilterBar from "./VcpForum/ForumFilterBar.vue";
import ForumPostList from "./VcpForum/ForumPostList.vue";
import ForumPostDetail from "./VcpForum/ForumPostDetail.vue";

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

onMounted(() => {
  void loadPosts();
});
</script>

<style scoped>
.forum-posts-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 400px;
}
</style>
