<template>
  <div class="dashboard-card-shell dashboard-card-shell--rose news-card">
    <div class="news-header">
      <h3 class="dashboard-card-title">滚动新闻</h3>
      <div class="source-filter">
        <select
          v-model="selectedSource"
          class="source-select"
          aria-label="筛选新闻来源"
        >
          <option :value="null">全部来源</option>
          <option v-for="source in availableSources" :key="source" :value="source">
            {{ source }}
          </option>
        </select>
        <button
          v-if="selectedSource"
          type="button"
          class="clear-filter-btn"
          @click="selectedSource = null"
          aria-label="清除筛选"
        >
          ✕
        </button>
      </div>
    </div>
    <div class="news-container">
      <div class="news-scroller" :style="{ animationDuration }">
        <div v-if="filteredItems.length === 0" class="dashboard-card-empty empty-state">
          {{ items.length === 0 ? '正在加载实时热点...' : '该来源暂无新闻' }}
        </div>
        <template v-else>
          <component
            :is="entry.item.url ? 'a' : 'div'"
            v-for="entry in duplicatedFilteredItems"
            :key="`${getStableItemId(entry.item)}-${entry.cycle}`"
            :href="entry.item.url || undefined"
            :target="entry.item.url ? '_blank' : undefined"
            :rel="entry.item.url ? 'noopener noreferrer' : undefined"
            class="dashboard-card-panel news-item"
            :class="{ 'news-item-disabled': !entry.item.url }"
            :role="entry.item.url ? undefined : 'note'"
            :aria-label="entry.item.url ? undefined : '该新闻链接不可用'"
          >
            <span class="news-source">{{ entry.item.source }}</span>
            <span class="news-title">{{ entry.item.title }}</span>
          </component>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { NewsItem } from "@/dashboard/types";

const props = defineProps<{
  items: NewsItem[];
}>();

// 选中的来源筛选
const selectedSource = ref<string | null>(null);

// 获取所有可用来源
const availableSources = computed(() => {
  const sources = new Set(props.items.map(item => item.source));
  return Array.from(sources).sort();
});

// 根据来源筛选的新闻
const filteredItems = computed(() => {
  if (!selectedSource.value) {
    return props.items;
  }
  return props.items.filter(item => item.source === selectedSource.value);
});

// 用于无限滚动的重复列表
const duplicatedFilteredItems = computed(() => [
  ...filteredItems.value.map((item) => ({ item, cycle: 0 as const })),
  ...filteredItems.value.map((item) => ({ item, cycle: 1 as const })),
]);

// 加快滚动速度：从 4s 改为 2s
const animationDuration = computed(() => `${Math.max(filteredItems.value.length, 1) * 2}s`);

// 生成稳定的 key，使用 URL 的 hash 作为唯一标识
function getStableItemId(item: NewsItem): string {
  if (item.url) {
    return `url-${item.url}`;
  }

  return `note-${item.source}-${item.title.slice(0, 20)}`;
}
</script>

<style scoped>
@import "./dashboard-card.css";

/* 统一 Container Query 断点系统 */
/* 断点：768px (桌面), 520px (平板), 420px (小屏), 360px (大屏手机), 280px (小屏手机) */

.news-card {
  min-height: 0;
}

.news-header {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.news-header .dashboard-card-title {
  min-width: 0;
  margin-bottom: 0;
  padding-right: 8px;
}

.source-filter {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.source-select {
  max-width: 132px;
  padding: 5px 26px 5px 10px;
  border: 1px solid var(--warning-border);
  border-radius: 8px;
  background: var(--warning-bg);
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 500;
  cursor: pointer;
  appearance: none;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.source-select:hover {
  background-color: var(--warning-bg-strong);
  border-color: var(--warning-border);
}

.source-select:focus-visible {
  outline: none;
  border-color: var(--warning-text);
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.source-select:focus:not(:focus-visible) {
  outline: none;
}

.source-select option {
  background: var(--secondary-bg);
  color: var(--primary-text);
}

.clear-filter-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--warning-border);
  border-radius: 6px;
  background: var(--warning-bg);
  color: var(--warning-text);
  font-size: var(--font-size-helper);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.clear-filter-btn:hover {
  background: var(--warning-bg-strong);
  border-color: var(--warning-border);
}

.clear-filter-btn:focus-visible {
  outline: none;
  border-color: var(--warning-text);
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.news-container {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.news-scroller {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  gap: 6px;
  animation: scroll-news linear infinite;
}

.news-container:hover .news-scroller {
  animation-play-state: paused;
}

@keyframes scroll-news {
  0% {
    transform: translateY(0);
  }

  100% {
    transform: translateY(calc(-50% - 3px));
  }
}

.news-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  min-height: 34px;
  padding: 7px 10px;
  text-decoration: none;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-fast),
    box-shadow var(--transition-fast);
}

.news-item:hover {
  transform: translateX(3px);
  box-shadow: var(--shadow-overlay-soft);
}

.news-item:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.news-item-disabled {
  cursor: default;
  opacity: 0.75;
}

.news-item-disabled:hover {
  transform: none;
  box-shadow: none;
}

.news-source {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  max-width: 34%;
  min-width: 0;
  padding: 2px 7px;
  border-radius: var(--radius-full, 999px);
  background: var(--warning-bg);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--warning-text);
  opacity: 0.95;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.news-title {
  display: block;
  min-width: 0;
  overflow: hidden;
  font-size: var(--font-size-helper);
  line-height: 1.35;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--primary-text);
}

.empty-state {
  opacity: 0.6;
  font-size: var(--font-size-body);
}

/* 断点 1: ≥520px - 宽松布局 */
@container dashboard-card (min-width: 520px) {
  .news-header {
    align-items: center;
    margin-bottom: 12px;
  }

  .source-select {
    min-width: 120px;
    max-width: 180px;
  }

  .news-scroller {
    gap: 7px;
  }

  .news-item {
    min-height: 36px;
    padding: 8px 12px;
  }

  .news-title {
    font-size: var(--font-size-body);
    line-height: 1.35;
  }
}

/* 断点 2: ≤420px - 紧凑布局 */
@container dashboard-card (max-width: 420px) {
  .news-item {
    min-height: 32px;
    padding: 6px 9px;
    gap: 8px;
  }

  .news-source {
    max-width: 38%;
    font-size: var(--font-size-caption);
  }

  .news-title {
    font-size: var(--font-size-helper);
    line-height: 1.3;
  }
}

/* 断点 3: ≤280px - 极简模式 */
@container dashboard-card (max-width: 280px) {
  .news-item {
    min-height: 30px;
    padding: 5px 8px;
    gap: 6px;
  }

  .news-source {
    max-width: 42%;
    font-size: var(--font-size-caption);
  }

  .news-title {
    font-size: var(--font-size-helper);
    line-height: 1.25;
  }
}
</style>
