<template>
  <section class="config-section active-section">
    <div class="log-viewer-container">
      <!-- 日志头部控制栏 -->
      <div class="log-header">
        <span class="log-path">
          <span class="material-symbols-outlined">description</span>
          {{ logPath }}
        </span>

        <input
          type="search"
          v-model="filterText"
          placeholder="🔍 过滤日志内容…"
          class="log-filter"
          @input="handleFilter"
        />

        <div class="log-stats">
          <span class="stat-item">
            <span class="stat-label">总行数:</span>
            <strong>{{ totalLines }}</strong>
          </span>
          <span class="stat-item">
            <span class="stat-label">显示:</span>
            <strong>{{ displayedLines.length }}</strong>
          </span>
          <span class="stat-item">
            <span class="stat-label">匹配:</span>
            <strong>{{ filteredLines.length }}</strong>
          </span>
        </div>

        <div class="log-controls">
          <label class="control-item">
            <span>行数限制:</span>
            <input
              type="number"
              v-model.number="logLimit"
              min="100"
              max="100000"
              step="500"
              class="limit-input"
            />
          </label>

          <button
            type="button"
            @click="toggleReverse"
            :class="['btn-secondary', { active: isReverse }]"
            aria-label="切换日志顺序"
            title="切换顺序"
          >
            <span class="material-symbols-outlined">swap_vert</span>
          </button>

          <button type="button" @click="copyLog" class="btn-secondary" aria-label="复制日志" title="复制日志">
            <span class="material-symbols-outlined">content_copy</span>
          </button>

          <button type="button" @click="clearLog" class="btn-secondary" aria-label="清空日志显示" title="清空显示">
            <span class="material-symbols-outlined">delete</span>
          </button>

          <button
            type="button"
            @click="toggleAutoScroll"
            :class="['btn-secondary', { active: autoScroll }]"
            aria-label="切换自动滚动"
            title="自动滚动"
          >
            <span class="material-symbols-outlined">autoplay</span>
          </button>
        </div>
      </div>

      <!-- 虚拟滚动日志区域 -->
      <div
        ref="logContainerRef"
        class="log-content-virtual"
        @scroll="handleScroll"
      >
        <div class="log-spacer" :style="{ height: totalHeight + 'px' }">
          <div
            class="log-viewport"
            :style="{ transform: `translateY(${offsetY}px)` }"
          >
            <div
              v-for="line in visibleLines"
              :key="line.index"
              v-memo="[line.item.content, filterText]"
              class="log-line"
              :class="getLineClass(line.item.content)"
            >
              <span class="line-number">{{ line.index + 1 }}</span>
              <span
                class="line-content"
                v-html="highlightText(line.item.content)"
              ></span>
            </div>
          </div>
        </div>
      </div>

      <!-- 快速操作按钮 -->
      <transition name="fade">
        <div
          v-if="showScrollToBottom"
          class="scroll-to-bottom-btn"
          @click="scrollToBottom"
        >
          <span class="material-symbols-outlined">arrow_downward</span>
          跳到底部
        </div>
      </transition>

      <!-- 加载状态 -->
      <div v-if="isLoading" class="loading-indicator">
        <span class="material-symbols-outlined spinning">sync</span>
        <span>加载中…</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useServerLogViewer } from "@/features/server-log-viewer/useServerLogViewer";

const {
  logPath,
  filterText,
  logLimit,
  isReverse,
  autoScroll,
  showScrollToBottom,
  isLoading,
  logContainerRef,
  filteredLines,
  displayedLines,
  visibleLines,
  totalHeight,
  offsetY,
  totalLines,
  handleFilter,
  handleScroll,
  scrollToBottom,
  toggleAutoScroll,
  toggleReverse,
  copyLog,
  clearLog,
  getLineClass,
  highlightText,
} = useServerLogViewer();

void logContainerRef; // 显式读取，避免 TS 将模板 ref 字符串用法判定为未使用
</script>

<style scoped>
.log-viewer-container {
  display: flex;
  flex-direction: column;
  height: calc(var(--app-viewport-height, 100vh) - 140px);
  gap: var(--space-3);
  position: relative;
}

.log-header {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  padding: 12px 16px;
  background: var(--secondary-bg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
}

.log-path {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  min-width: 200px;
}

.log-path .material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
}

.log-filter {
  flex: 1;
  min-width: 200px;
  padding: 8px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.log-filter:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-color: var(--highlight-text);
}

.log-stats {
  display: flex;
  gap: var(--space-4);
  font-size: var(--font-size-helper);
}

.stat-item {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.stat-label {
  color: var(--secondary-text);
}

.log-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.control-item {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: var(--font-size-helper);
}

.limit-input {
  width: 70px;
  padding: 6px 8px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--primary-text);
  font-size: var(--font-size-helper);
}

.btn-secondary {
  padding: 8px;
  min-width: 40px;
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-secondary .material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
}

.btn-secondary.active {
  background: var(--accent-bg);
  border-color: var(--highlight-text);
  color: var(--highlight-text);
}

/* 虚拟滚动日志区域 */
.log-content-virtual {
  flex: 1;
  overflow-y: auto;
  background: var(--tertiary-bg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  font-family: "Consolas", "Monaco", "Courier New", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.5;
}

.log-spacer {
  position: relative;
  width: 100%;
}

.log-viewport {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding-bottom: 22px; /* 增加底部内边距，防止最后一行被截断 */
}

.log-line {
  display: flex;
  gap: var(--space-3);
  padding: 2px 16px;
  border-bottom: 1px solid var(--border-color);
  transition: background 0.15s;
  font-size: var(--font-size-helper);
}

.log-line:hover {
  background: var(--accent-bg);
}

.line-number {
  flex-shrink: 0;
  width: 50px;
  text-align: right;
  color: var(--secondary-text);
  user-select: none;
  opacity: 0.75;
}

.line-content {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 日志级别样式 */
.log-error {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.log-warn {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.log-info {
  background: var(--info-bg);
  color: var(--info-text);
}

.log-debug {
  background: var(--success-bg);
  color: var(--success-text);
}

.log-normal {
  color: var(--primary-text);
}

/* 搜索高亮 */
mark {
  background: var(--warning-bg-strong);
  color: inherit;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 600;
}

/* 滚动到底部按钮 */
.scroll-to-bottom-btn {
  position: fixed;
  bottom: 30px;
  right: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: var(--button-bg);
  color: var(--on-accent-text);
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  z-index: 100;
}

.scroll-to-bottom-btn:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-xl);
}

.scroll-to-bottom-btn .material-symbols-outlined {
  font-size: var(--font-size-emphasis) !important;
}

/* 加载指示器 */
.loading-indicator {
  position: absolute;
  top: 80px;
  right: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--secondary-bg);
  border-radius: var(--radius-full);
  border: 1px solid var(--border-color);
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.loading-indicator .spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 淡入淡出动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 响应式 */
@media (max-width: 1024px) {
  .log-header {
    flex-direction: column;
    align-items: stretch;
  }

  .log-stats {
    justify-content: space-between;
  }

  .log-controls {
    flex-wrap: wrap;
    justify-content: center;
  }

  .limit-input {
    width: 100%;
  }
}
</style>
