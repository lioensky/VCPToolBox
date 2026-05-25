<template>
  <div v-if="selectedPost" class="forum-post-detail">
    <div class="post-detail-header">
      <div class="post-detail-actions">
        <button @click="emit('backToList')" class="btn-secondary btn-sm">
          <span class="material-symbols-outlined">arrow_back</span>
          返回列表
        </button>
        <button
          v-if="canDelete"
          @click="emit('deletePost')"
          class="btn-danger btn-sm"
          :disabled="isDeletingPost"
        >
          {{ isDeletingPost ? "删除中..." : "删除整个帖子" }}
        </button>
      </div>
      <span class="post-title">{{ selectedPost.title }}</span>
    </div>

    <div class="post-detail-meta">
      <span>作者：{{ selectedPost.author }}</span>
      <span>发布时间：{{ formatDate(selectedPost.timestamp) }}</span>
      <span>板块：{{ selectedPost.board }}</span>
    </div>

    <div class="post-detail-content card" v-html="selectedPost.contentHtml"></div>

    <div class="post-replies">
      <h3>回复 ({{ selectedPost.replies }})</h3>
      <p v-if="selectedPost.repliesList.length === 0" class="empty-replies">
        <span class="material-symbols-outlined empty-replies-icon">chat_bubble_outline</span>
        还没有回复。
        <span class="empty-replies-hint">成为第一个回复的人吧！</span>
      </p>
      <div
        v-for="reply in selectedPost.repliesList"
        :id="getReplyAnchorId(reply.floor)"
        :key="`${reply.floor}-${reply.createdAt}`"
        class="reply-item"
      >
        <div class="reply-header">
          <div class="reply-meta">
            <span class="reply-floor">楼层 #{{ reply.floor }}</span>
            <span class="reply-author">{{ reply.author }}</span>
            <span class="reply-time">{{ formatDate(reply.createdAt) }}</span>
          </div>
          <button
            v-if="canDelete"
            class="btn-danger btn-sm"
            :disabled="deletingReplyFloor === reply.floor"
            @click="emit('deleteReply', reply.floor)"
          >
            {{ deletingReplyFloor === reply.floor ? "删除中..." : "删除此楼层" }}
          </button>
        </div>
        <div class="reply-content" v-html="reply.contentHtml"></div>
      </div>
    </div>

    <div class="reply-form card">
      <h3>发表回复</h3>
      <label class="reply-author-field">
        <span class="reply-author-label">昵称</span>
        <input
          type="text"
          maxlength="50"
          :value="replyAuthor"
          placeholder="请输入回复昵称"
          @input="emit('update:replyAuthor', ($event.target as HTMLInputElement).value)"
        >
      </label>
      <textarea
        :value="newReplyContent"
        rows="4"
        placeholder="输入您的回复内容（支持 Markdown）..."
        @input="emit('update:newReplyContent', ($event.target as HTMLTextAreaElement).value)"
      ></textarea>
      <button
        @click="emit('submitReply')"
        class="btn-primary"
        :disabled="isSubmitting || !newReplyContent.trim() || !replyAuthor.trim()"
      >
        {{ isSubmitting ? "提交中..." : "发表回复" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, watch } from "vue";
import { formatDate } from "@/utils";
import type { ForumPostDetail } from "@/features/vcp-forum/types";

const props = defineProps<{
  selectedPost: ForumPostDetail | null;
  newReplyContent: string;
  replyAuthor: string;
  isSubmitting: boolean;
  canDelete: boolean;
  isDeletingPost: boolean;
  deletingReplyFloor: number | null;
  scrollToReplyFloor: number | null;
}>();

const emit = defineEmits<{
  backToList: [];
  submitReply: [];
  deletePost: [];
  deleteReply: [floor: number];
  "update:newReplyContent": [value: string];
  "update:replyAuthor": [value: string];
}>();

function getReplyAnchorId(floor: number): string {
  return `forum-reply-floor-${floor}`;
}

watch(
  () => props.scrollToReplyFloor,
  async (floor) => {
    if (!floor || floor <= 0) {
      return;
    }

    await nextTick();
    const target = document.getElementById(getReplyAnchorId(floor));
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
);
</script>

<style scoped>
.post-detail-header {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: var(--space-4);
}

.post-detail-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.post-title {
  font-size: var(--font-size-display);
  font-weight: 600;
  line-height: 1.3;
  width: 100%;
  overflow-wrap: anywhere;
}

.post-detail-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: var(--font-size-body);
  color: var(--secondary-text);
  margin-bottom: var(--space-4);
}

.post-detail-content {
  padding: var(--space-5);
  margin-bottom: var(--space-6);
  line-height: 1.6;
  width: 100%;
  max-width: none;
}

.post-detail-content :deep(img) {
  max-width: 100%;
  height: auto;
}

.post-replies h3 {
  margin: 0 0 var(--space-4);
}

.empty-replies {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0 0 var(--space-4);
  padding: var(--space-4) 0;
  color: var(--secondary-text);
}

.empty-replies-icon {
  font-size: var(--font-size-icon-empty);
  opacity: 0.3;
  color: var(--highlight-text);
}

.empty-replies-hint {
  font-size: var(--font-size-helper);
  opacity: 0.7;
}

.reply-item {
  padding: var(--space-4) 0;
  margin-bottom: 0;
  border-bottom: 1px solid var(--border-color);
  background: transparent;
  scroll-margin-top: var(--space-6);
}

.reply-item:last-child {
  border-bottom: none;
}

.reply-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: var(--space-3);
  font-size: var(--font-size-body);
}

.reply-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}

.reply-floor {
  font-weight: 600;
  color: var(--highlight-text);
}

.reply-author {
  font-weight: 600;
}

.reply-time {
  color: var(--secondary-text);
}

.reply-content {
  line-height: 1.5;
}

.reply-form {
  padding: var(--space-5);
  margin-top: var(--space-6);
}

.reply-form h3 {
  margin: 0 0 var(--space-4);
}

.reply-author-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: var(--space-3);
}

.reply-author-label {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.reply-form input,
.reply-form textarea {
  width: 100%;
  padding: 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-family: inherit;
}

.reply-form input:focus-visible,
.reply-form textarea:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--button-bg) 46%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.reply-form textarea {
  resize: vertical;
  margin-bottom: var(--space-3);
}

.material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
  vertical-align: middle;
}

.post-detail-content :deep(p),
.reply-content :deep(p) {
  margin: 0 0 12px;
}

.post-detail-content :deep(:last-child),
.reply-content :deep(:last-child) {
  margin-bottom: 0;
}

.post-detail-content :deep(pre),
.reply-content :deep(pre) {
  overflow-x: auto;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
}

@media (max-width: 720px) {
  .reply-header {
    flex-direction: column;
  }
}
</style>
