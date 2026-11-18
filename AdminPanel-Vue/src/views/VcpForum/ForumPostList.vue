<template>
  <div class="forum-posts-list">
    <UiEmptyState v-if="posts.length === 0" title="暂无帖子" description="当有新帖子发布时，它们将显示在这里" />

    <div
      v-for="post in posts"
      :key="post.uid"
      class="forum-post-item"
      :class="{ 'pinned-post': isPinnedPost(post) }"
      @click="emit('viewPost', post)"
    >
      <div class="forum-post-header">
        <UiBadge v-if="isPinnedPost(post)" variant="info">置顶</UiBadge>
        <span class="post-title" :title="post.title">
          {{ post.title }}
        </span>
      </div>
      <div class="forum-post-meta">
        <span class="post-author">作者：{{ post.author }}</span>
        <span class="post-board">板块：{{ post.board }}</span>
        <span class="post-time">最后回复：{{ formatDate(post.lastReplyAt || post.timestamp) }}</span>
        <span class="post-replies">最后回复者：{{ post.lastReplyBy || "N/A" }}</span>
      </div>
    </div>

    <div v-if="totalPages > 1" class="pagination-controls">
      <UiButton
        variant="outline"
        size="sm"
        :disabled="!hasPrev"
        @click="emit('prevPage')"
      >
        <template #leading><span class="material-symbols-outlined">chevron_left</span></template>
        上一页
      </UiButton>
      <span class="pagination-info">第 {{ currentPage }} / {{ totalPages }} 页</span>
      <UiButton
        variant="outline"
        size="sm"
        :disabled="!hasNext"
        @click="emit('nextPage')"
      >
        下一页
        <template #trailing><span class="material-symbols-outlined">chevron_right</span></template>
      </UiButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatDate } from "@/utils";
import { isPinnedPost } from "@/features/vcp-forum/useVcpForum";
import type { ForumPost } from "@/features/vcp-forum/types";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";

defineProps<{
  posts: ForumPost[];
  currentPage: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}>();

const emit = defineEmits<{
  viewPost: [post: ForumPost];
  nextPage: [];
  prevPage: [];
}>();
</script>

<style scoped>
.forum-posts-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.forum-post-item {
  background: var(--secondary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 16px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.forum-post-item {
  position: relative;
}

.forum-post-item:hover {
  background: var(--accent-bg);
}

.forum-post-item.pinned-post {
  background: var(--primary-color-translucent);
  border-top: 2px solid var(--highlight-text);
}

.forum-post-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.post-title {
  font-weight: 600;
  font-size: var(--font-size-emphasis);
  color: var(--primary-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-word;
}

.forum-post-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.pagination-controls {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-5);
  padding: var(--space-4) 0;
}

.pagination-info {
  font-size: var(--font-size-body);
  color: var(--secondary-text);
  padding: 0 12px;
}

@media (max-width: 480px) {
  .pagination-controls {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .pagination-info {
    padding: 0;
    text-align: center;
  }
}

.material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
  vertical-align: middle;
}
</style>
