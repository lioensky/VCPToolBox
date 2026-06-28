<template>
  <div v-if="selectedPost" class="forum-post-detail">
    <div class="post-detail-header">
      <div class="post-detail-actions">
        <UiButton variant="outline" size="sm" @click="emit('backToList')">
          <template #leading><span class="material-symbols-outlined">arrow_back</span></template>
          返回列表
        </UiButton>
        <UiButton
          v-if="canDelete"
          @click="emit('deletePost')"
          variant="danger"
          size="sm"
          :disabled="isDeletingPost"
        >
          {{ isDeletingPost ? "删除中..." : "删除整个帖子" }}
        </UiButton>
      </div>
      <span class="post-title">{{ selectedPost.title }}</span>
    </div>

    <div class="post-detail-meta">
      <span>作者：{{ selectedPost.author }}</span>
      <span>发布时间：{{ formatDate(selectedPost.timestamp) }}</span>
      <span>板块：{{ selectedPost.board }}</span>
    </div>

    <UiCard class="post-detail-content" variant="flat" v-html="selectedPost.contentHtml"></UiCard>

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
          <UiButton
            v-if="canDelete"
            variant="danger"
            size="sm"
            :disabled="deletingReplyFloor === reply.floor"
            @click="emit('deleteReply', reply.floor)"
          >
            {{ deletingReplyFloor === reply.floor ? "删除中..." : "删除此楼层" }}
          </UiButton>
        </div>
        <div class="reply-content" v-html="reply.contentHtml"></div>
      </div>
    </div>

    <UiCard class="reply-form" title="发表回复" variant="subtle">
      <UiField label="昵称">
        <UiInput
          type="text"
          maxlength="50"
          :model-value="replyAuthor"
          placeholder="请输入回复昵称"
          @update:model-value="value => emit('update:replyAuthor', String(value))"
        />
      </UiField>
      <UiField label="回复内容">
      <UiTextarea
        :model-value="newReplyContent"
        rows="4"
        placeholder="输入您的回复内容（支持 Markdown）..."
        @update:model-value="value => emit('update:newReplyContent', String(value))"
      />
      </UiField>
      <UiButton
        @click="emit('submitReply')"
        :disabled="isSubmitting || !newReplyContent.trim() || !replyAuthor.trim()"
      >
        {{ isSubmitting ? "提交中..." : "发表回复" }}
      </UiButton>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
import { nextTick, watch } from "vue";
import { formatDate } from "@/utils";
import type { ForumPostDetail } from "@/features/vcp-forum/types";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";

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
  margin-top: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
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
