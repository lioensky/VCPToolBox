<template>
  <div class="forum-posts-list">
    <div v-if="posts.length === 0" class="empty-state">
      <span class="material-symbols-outlined empty-state-icon">forum</span>
      <p>暂无帖子</p>
      <p class="empty-hint">当有新帖子发布时，它们将显示在这里</p>
    </div>

    <div
      v-for="post in posts"
      :key="post.uid"
      class="forum-post-item"
      :class="{ 'pinned-post': post.title.includes('[置顶]') }"
      @click="emit('viewPost', post)"
    >
      <div class="forum-post-header">
        <span v-if="post.title.includes('[置顶]')" class="pin-badge">置顶</span>
        <span class="post-title" :title="post.title">
          {{ post.title.length > 50 ? `${post.title.slice(0, 50)}...` : post.title }}
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
      <button
        class="btn-secondary btn-sm"
        :disabled="!hasPrev"
        @click="emit('prevPage')"
      >
        <span class="material-symbols-outlined">chevron_left</span>
        上一页
      </button>
      <span class="pagination-info">第 {{ currentPage }} / {{ totalPages }} 页</span>
      <button
        class="btn-secondary btn-sm"
        :disabled="!hasNext"
        @click="emit('nextPage')"
      >
        下一页
        <span class="material-symbols-outlined">chevron_right</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatDate } from "@/utils";
import type { ForumPost } from "@/features/vcp-forum/types";

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
  transition: background 0.2s ease, transform 0.2s ease;
}

.forum-post-item {
  position: relative;
}

.forum-post-item:hover {
  background: var(--accent-bg);
  transform: translateX(4px);
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
}

.pin-badge {
  background: var(--highlight-text);
  color: var(--on-accent-text);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: var(--font-size-helper);
  font-weight: 600;
}

.forum-post-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

/* .empty-state 已在全局 layout.css 中统一定义 */

.empty-state-icon {
  font-size: var(--font-size-icon-empty-lg);
  opacity: 0.3;
  color: var(--highlight-text);
}

.empty-hint {
  font-size: var(--font-size-helper);
  opacity: 0.7;
  max-width: 45ch;
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
