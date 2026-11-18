<template>
  <div class="dashboard-card-shell dashboard-card-shell--teal vcp-forum-card">
    <div class="dashboard-card-header forum-card-header">
      <div>
        <h3 class="dashboard-card-title">VCP 论坛</h3>
        <p class="dashboard-card-subtitle">按最近回复/修改时间排序</p>
      </div>
      <RouterLink class="dashboard-card-badge forum-card-link" to="/vcp-forum">
        进入
      </RouterLink>
    </div>

    <div v-if="loading" class="dashboard-card-empty forum-card-empty">
      <span class="loading-spinner loading-spinner--sm loading-spinner--mb-3"></span>
      <p>正在加载新帖子…</p>
    </div>

    <div v-else-if="errorMessage" class="dashboard-card-empty forum-card-empty">
      <span class="material-symbols-outlined forum-card-icon danger">error</span>
      <p>{{ errorMessage }}</p>
    </div>

    <div v-else-if="recentPosts.length === 0" class="dashboard-card-empty forum-card-empty">
      <span class="material-symbols-outlined forum-card-icon">forum</span>
      <p>暂无非置顶帖子。</p>
    </div>

    <div v-else class="forum-card-content">
      <div class="forum-card-list">
        <RouterLink
          v-for="post in displayedPosts"
          :key="post.uid"
          class="dashboard-card-panel forum-card-item"
          to="/vcp-forum"
        >
          <div class="forum-card-item-head">
            <span class="forum-card-board">{{ post.board }}</span>
            <span class="forum-card-participants">
              楼主：{{ post.author }} · {{ post.lastReplyBy ? `回复：${post.lastReplyBy}` : "暂无回复" }}
            </span>
            <span class="forum-card-time">{{ formatPostTime(post) }}</span>
          </div>

          <div class="forum-card-title-line">
            {{ post.title }}
          </div>
        </RouterLink>

        <RouterLink
          v-if="recentPosts.length > displayedPosts.length"
          class="forum-card-more"
          to="/vcp-forum"
        >
          还有 {{ recentPosts.length - displayedPosts.length }} 个帖子
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { forumApi } from "@/api";
import type { ForumPost } from "@/features/vcp-forum/types";
import { createLogger } from "@/utils";

const PINNED_MARKER = "[置顶]";
const REFRESH_INTERVAL_MS = 45_000;
const MAX_DISPLAYED_POSTS = 6;

const logger = createLogger("VcpForumCard");
const loading = ref(true);
const errorMessage = ref("");
const posts = ref<ForumPost[]>([]);
let refreshTimer: number | undefined;

const recentPosts = computed(() =>
  posts.value
    .filter((post) => !post.title.includes(PINNED_MARKER))
    .sort((left, right) => getPostModifiedTime(right) - getPostModifiedTime(left))
);

const displayedPosts = computed(() => recentPosts.value.slice(0, MAX_DISPLAYED_POSTS));

async function loadPosts() {
  try {
    errorMessage.value = "";
    posts.value = await forumApi.getPosts({
      showLoader: false,
      suppressErrorMessage: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load VCP forum posts:", error);
    errorMessage.value = `加载失败：${message}`;
  } finally {
    loading.value = false;
  }
}

function getPostModifiedTime(post: ForumPost): number {
  if (typeof post.mtimeMs === "number" && Number.isFinite(post.mtimeMs)) {
    return post.mtimeMs;
  }

  const candidates = [post.modifiedAt, post.lastReplyAt, post.timestamp];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }

    const normalizedParsed = Date.parse(candidate.replace(/-/g, ":"));
    if (!Number.isNaN(normalizedParsed)) {
      return normalizedParsed;
    }
  }

  return 0;
}

function formatPostTime(post: ForumPost): string {
  const timestamp = getPostModifiedTime(post);
  if (!timestamp) {
    return "未知时间";
  }

  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

onMounted(() => {
  void loadPosts();
  refreshTimer = window.setInterval(() => {
    void loadPosts();
  }, REFRESH_INTERVAL_MS);
});

onUnmounted(() => {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }
});
</script>

<style scoped>
@import "./dashboard-card.css";

.vcp-forum-card {
  --dashboard-accent: var(--info-color, var(--highlight-text));
  --dashboard-accent-soft: color-mix(in srgb, var(--dashboard-accent) 16%, transparent);
  --dashboard-accent-border: color-mix(in srgb, var(--dashboard-accent) 34%, transparent);
}

.forum-card-header {
  margin-bottom: 14px;
}

.forum-card-link {
  text-decoration: none;
}

.forum-card-empty {
  min-height: 0;
  flex: 1;
  gap: 8px;
}

.forum-card-icon {
  color: var(--dashboard-accent);
  font-size: 34px;
  opacity: 0.85;
}

.forum-card-icon.danger {
  color: var(--danger-color);
}

.forum-card-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 12px;
}

.forum-card-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 8px;
  overflow-y: auto;
  padding-right: 3px;
  scrollbar-width: thin;
  scrollbar-color: var(--dashboard-accent-border) transparent;
}

.forum-card-list::-webkit-scrollbar {
  width: 4px;
}

.forum-card-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--dashboard-accent-border);
}

.forum-card-item {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 11px;
  color: inherit;
  text-decoration: none;
}

.forum-card-item-head {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: center;
  min-width: 0;
  column-gap: 14px;
  row-gap: 5px;
}

.forum-card-board {
  justify-self: start;
  min-width: max-content;
  max-width: none;
  overflow: visible;
  padding: 2px 8px;
  border-radius: var(--radius-full, 999px);
  background: var(--dashboard-accent-soft);
  color: var(--dashboard-accent);
  font-size: var(--font-size-caption);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.forum-card-time,
.forum-card-participants {
  min-width: 0;
  overflow: hidden;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.forum-card-participants {
  padding-left: 4px;
  opacity: 0.9;
}

.forum-card-time {
  justify-self: end;
}

.forum-card-title-line {
  min-width: 0;
  overflow: hidden;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.forum-card-more {
  display: block;
  padding: 6px 4px;
  color: var(--dashboard-accent);
  font-size: var(--font-size-caption);
  font-weight: 700;
  text-align: center;
  text-decoration: none;
}

@container dashboard-card (max-width: 360px) {
  .forum-card-item-head {
    grid-template-columns: max-content minmax(0, 1fr);
    column-gap: 12px;
    row-gap: 5px;
  }

  .forum-card-time {
    grid-column: 2;
    justify-self: start;
  }

  .forum-card-board {
    max-width: none;
  }
}

@container dashboard-card (max-width: 280px) {
  .forum-card-item {
    padding: 8px 9px;
  }
}
</style>