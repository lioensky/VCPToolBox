<template>
  <section class="config-section active-section server-log-section">
    <div class="log-viewer-container">
      <div class="log-toolbar">
        <div class="log-toolbar__primary">
          <div class="log-path-chip" :title="logPath">
            <span class="material-symbols-outlined">description</span>
            <span class="log-path-chip__text">{{ logPath }}</span>
          </div>

          <label class="limit-control">
            <span>行数</span>
            <UiInput
              type="number"
              v-model.number="logLimit"
              min="100"
              max="100000"
              step="500"
              size="sm"
              class="limit-input"
            />
          </label>

          <label class="log-search">
            <span class="material-symbols-outlined" aria-hidden="true">search</span>
            <UiInput
              type="search"
              v-model="filterText"
              placeholder="过滤日志内容"
              size="sm"
              @input="handleFilter"
            />
          </label>
        </div>

        <div class="log-toolbar__secondary">
          <div class="log-stats">
            <span class="stat-badge stat-badge--total">
              <span class="stat-badge__accent" />
              <span class="stat-badge__label">总行数</span>
              <strong>{{ totalLines }}</strong>
            </span>
            <span class="stat-badge stat-badge--displayed">
              <span class="stat-badge__accent" />
              <span class="stat-badge__label">显示</span>
              <strong>{{ displayedLines.length }}</strong>
            </span>
            <span class="stat-badge stat-badge--matched">
              <span class="stat-badge__accent" />
              <span class="stat-badge__label">匹配</span>
              <strong>{{ filteredLines.length }}</strong>
            </span>
          </div>

          <div class="log-controls">
            <UiIconButton label="切换日志顺序" title="切换顺序" :active="isReverse" @click="toggleReverse">
              <span class="material-symbols-outlined">swap_vert</span>
            </UiIconButton>

            <UiIconButton label="复制日志" title="复制日志" class="copy-button" @click="copyLog" @touchend.prevent="copyLog">
              <span class="material-symbols-outlined">content_copy</span>
              <span v-if="showCopyTip" class="copy-tip">已复制</span>
            </UiIconButton>

            <UiIconButton label="清空日志显示" title="清空显示" @click="clearLog">
              <span class="material-symbols-outlined">delete</span>
            </UiIconButton>

            <UiIconButton label="切换自动滚动" title="自动滚动" :active="autoScroll" @click="toggleAutoScroll">
              <span class="material-symbols-outlined">autoplay</span>
            </UiIconButton>
          </div>
        </div>
      </div>

      <div class="log-panel">
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
      </div>

      <!-- 加载状态 -->
      <div v-if="isLoading" class="loading-indicator">
        <span class="material-symbols-outlined spinning">sync</span>
        <span>加载中…</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
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
  copyLog: originalCopyLog,
  clearLog,
  getLineClass,
  highlightText,
} = useServerLogViewer();
// 复制提示状态
const showCopyTip = ref(false);

// 包装复制功能，添加提示
const copyLog = async (event?: Event) => {
  // 阻止移动端的默认行为和事件冒泡
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  
  await originalCopyLog();
  showCopyTip.value = true;
  
  // 清除之前的定时器，避免快速点击时提示消失异常
  if (copyTipTimer) {
    clearTimeout(copyTipTimer);
  }
  
  copyTipTimer = setTimeout(() => {
    showCopyTip.value = false;
  }, 2000);
};

// 定时器变量
let copyTipTimer: ReturnType<typeof setTimeout> | null = null;

void logContainerRef; // 显式读取，避免 TS 将模板 ref 字符串用法判定为未使用
</script>

<style scoped>
.server-log-section {
  display: flex;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.log-viewer-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  gap: 12px;
  position: relative;
}

.log-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--highlight-text) 4%, transparent),
      transparent
    ),
    color-mix(in srgb, var(--secondary-bg) 88%, var(--primary-bg));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.log-toolbar__primary,
.log-toolbar__secondary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.log-toolbar__primary {
  align-items: stretch;
}

.log-toolbar__secondary {
  justify-content: space-between;
}

.log-path-chip,
.limit-control {
  min-height: 32px;
  border: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--primary-bg) 82%, transparent);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.log-path-chip:hover,
.limit-control:hover {
  background: color-mix(in srgb, var(--primary-bg) 92%, transparent);
  border-color: color-mix(in srgb, var(--highlight-text) 42%, var(--border-color));
}

.log-path-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 220px;
  max-width: min(38vw, 520px);
  padding: 0 10px;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.log-path-chip .material-symbols-outlined,
.log-search .material-symbols-outlined,
.log-controls :deep(.material-symbols-outlined) {
  font-size: 18px !important;
  line-height: 1;
}

.log-path-chip__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.limit-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 10px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.limit-input {
  width: 82px;
  font-variant-numeric: tabular-nums;
}

.log-search {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 260px;
  color: var(--secondary-text);
}

.log-search :deep(.ui-input) {
  flex: 1;
}

.limit-control:focus-within {
  border-color: var(--highlight-text);
  outline: none;
  background: color-mix(in srgb, var(--primary-bg) 96%, transparent);
}

.log-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.stat-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--input-bg) 48%, transparent);
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  box-shadow: var(--shadow-xs, none);
}

.stat-badge__accent {
  width: 2px;
  height: 14px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--highlight-text) 74%, transparent);
}

.stat-badge--displayed .stat-badge__accent {
  background: color-mix(in srgb, var(--success-color, var(--highlight-text)) 70%, transparent);
}

.stat-badge--matched .stat-badge__accent {
  background: color-mix(in srgb, var(--warning-color, var(--highlight-text)) 70%, transparent);
}

.stat-badge strong {
  color: var(--primary-text);
  font-family: "Consolas", "Monaco", "Courier New", monospace;
  font-variant-numeric: tabular-nums;
}

.log-controls {
  display: flex;
  gap: 4px;
  align-items: center;
}

.copy-button {
  position: relative;
}

/* 复制成功提示 */
.copy-tip {
  position: absolute;
  top: -32px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--button-bg);
  color: var(--on-accent-text);
  padding: 4px 8px;
  border-radius: var(--radius-md);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  animation: fadeInOut 2s ease;
}

@keyframes fadeInOut {
  0% {
    opacity: 0;
    transform: translateX(-50%) translateY(5px);
  }
  15% {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
  85% {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
  100% {
    opacity: 0;
    transform: translateX(-50%) translateY(-5px);
  }
}

.log-panel {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-bg) 26%, transparent);
}

.log-content-virtual {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: "Consolas", "Monaco", "Courier New", monospace;
  font-size: var(--font-size-helper);
  line-height: 1.45;
  scrollbar-gutter: stable;
}

.log-spacer {
  position: relative;
  width: 100%;
}

.log-viewport {
  position: absolute;
  top: 0;
  left: 0;
  min-width: 100%;
  padding-bottom: 18px;
}

.log-line {
  position: relative;
  display: flex;
  gap: 10px;
  min-height: 24px;
  padding: 2px 14px 2px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 54%, transparent);
  background: transparent;
  font-size: var(--font-size-helper);
  transition: background-color var(--transition-fast);
}

.log-line::before {
  content: "";
  flex: 0 0 3px;
  align-self: stretch;
  background: transparent;
}

.log-line:hover {
  background: color-mix(in srgb, var(--accent-bg) 34%, transparent);
}

.line-number {
  flex-shrink: 0;
  width: 54px;
  text-align: right;
  color: var(--secondary-text);
  user-select: none;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.line-content {
  flex: 1;
  min-width: 0;
  white-space: pre;
}

/* 日志级别样式 */
.log-error {
  color: var(--danger-text);
  background: color-mix(in srgb, var(--danger-bg) 28%, transparent);
}

.log-error::before {
  background: var(--danger-color);
}

.log-warn {
  color: var(--warning-text);
  background: color-mix(in srgb, var(--warning-bg) 24%, transparent);
}

.log-warn::before {
  background: var(--warning-color, var(--highlight-text));
}

.log-info {
  color: var(--info-text);
}

.log-info::before {
  background: color-mix(in srgb, var(--info-color, var(--highlight-text)) 62%, transparent);
}

.log-debug {
  color: var(--success-text);
}

.log-debug::before {
  background: color-mix(in srgb, var(--success-color, var(--highlight-text)) 58%, transparent);
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
  position: absolute;
  bottom: 14px;
  right: 18px;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  background: color-mix(in srgb, var(--button-bg) 92%, transparent);
  color: var(--on-accent-text);
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-md);
  cursor: pointer;
  font-size: var(--font-size-helper);
  transition: transform var(--transition-fast), box-shadow var(--transition-fast);
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
  top: 72px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 12px;
  background: color-mix(in srgb, var(--secondary-bg) 88%, transparent);
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
  .log-toolbar__primary,
  .log-toolbar__secondary {
    align-items: stretch;
  }

  .log-path-chip,
  .log-search {
    max-width: none;
    flex: 1 1 100%;
  }

  .log-controls {
    margin-left: auto;
  }
}

@media (max-width: 768px) {  
  .limit-control,
  .log-search,
  .stat-badge {
    min-height: 34px;
  }

  .log-stats {
    flex: 1 1 100%;
  }

  .line-number {
    width: 42px;
  }

  .line-content {
    white-space: pre-wrap;
    word-break: break-all;
  }
}

@media (prefers-reduced-motion: reduce) {
  .log-line,
  .scroll-to-bottom-btn {
    transition: none;
  }
}
</style>
