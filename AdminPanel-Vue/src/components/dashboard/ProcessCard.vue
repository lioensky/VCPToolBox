<template>
  <div class="dashboard-card-shell dashboard-card-shell--amber process-card">
    <h3 class="dashboard-card-title">PM2 进程状态</h3>
    <div class="process-layout">
      <div class="status-card-content">
        <div v-if="processes.length === 0" class="dashboard-card-empty empty-state">
          <p>没有正在运行的 PM2 进程。</p>
        </div>
        <div v-else class="process-list">
          <div
            v-for="proc in displayedProcesses"
            :key="proc.pid"
            class="dashboard-card-panel process-item"
          >
            <strong>{{ proc.name }}</strong>
            <span class="process-meta">进程 ID: {{ proc.pid }}</span>
            <span :class="['status', proc.status]">{{ getStatusLabel(proc.status) }}</span>
            <span class="process-usage">
              CPU {{ proc.cpu }}% · 内存 {{ formatProcessMemory(proc.memory) }} MB
            </span>
          </div>
          <div v-if="processes.length > maxDisplayValue" class="show-more">
            还有 {{ processes.length - maxDisplayValue }} 个进程未显示
          </div>
        </div>
      </div>

      <div class="dashboard-card-panel auth-code-display">
        <h4>用户认证码</h4>
        <div class="auth-code-row">
          <p>{{ authCode }}</p>
          <button
            type="button"
            class="copy-auth-code-button"
            :disabled="!authCode || authCode === '加载中...'"
            :aria-label="copied ? '已复制用户认证码' : '复制用户认证码'"
            @click="copyAuthCode"
          >
            {{ copied ? "已复制" : "复制" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { PM2Process } from "@/types/api.system";

const props = defineProps<{
  processes: PM2Process[];
  authCode: string;
  maxDisplay?: number;
}>();

const copied = ref(false);
let copiedResetTimer: number | undefined;

const displayedProcesses = computed(() => {
  return props.processes.slice(0, props.maxDisplay ?? 20);
});

const maxDisplayValue = computed(() => props.maxDisplay ?? 20);

function getStatusLabel(status: string): string {
  const statusMap: Record<string, string> = {
    online: "运行中",
    stopped: "已停止",
    errored: "错误",
    launching: "启动中",
  };

  return statusMap[status] ?? status;
}

function formatProcessMemory(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function copyAuthCode() {
  if (!props.authCode || props.authCode === "加载中...") {
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(props.authCode);
  } else {
    copyTextWithFallback(props.authCode);
  }

  copied.value = true;

  if (copiedResetTimer) {
    window.clearTimeout(copiedResetTimer);
  }

  copiedResetTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}

function copyTextWithFallback(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}
</script>

<style scoped>
@import "./dashboard-card.css";

/* 统一 Container Query 断点系统 */
/* 断点：768px (桌面), 520px (平板), 420px (小屏), 360px (大屏手机), 280px (小屏手机) */

.process-card {
  --dashboard-accent: var(--warning-color);
  --dashboard-accent-soft: color-mix(in srgb, var(--dashboard-accent) 18%, transparent);
  --dashboard-accent-border: color-mix(in srgb, var(--dashboard-accent) 34%, transparent);
}

.process-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 2fr) minmax(118px, 1fr);
  grid-template-rows: minmax(0, 1fr);
  align-items: stretch;
  min-height: 0;
  gap: 10px;
}

.status-card-content {
  display: flex;
  flex: 1;
  min-height: 0;
  height: 100%;
}

.status-card-content .empty-state {
  flex: 1;
  min-height: 0;
}
.process-list {
  display: grid;
  flex: 1;
  grid-template-columns: 1fr;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  grid-auto-rows: minmax(54px, auto);
  align-content: stretch;
  min-height: 0;
  height: 100%;
  gap: 8px;
  overflow-y: auto;
}

.process-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  align-content: center;
  gap: 4px 8px;
  min-width: 0;
  min-height: 0;
  padding: 8px 10px;
  font-size: var(--font-size-helper);
  line-height: 1.35;
  overflow: hidden;
}

.process-item strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.process-item .process-usage {
  min-width: 0;
  grid-column: 1 / -1;
}

.process-meta {
  min-width: 0;
  overflow: hidden;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.process-usage {
  overflow: hidden;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.process-item .status {
  justify-self: end;
  padding: 3px 8px;
  border-radius: var(--radius-full, 999px);
  font-size: var(--font-size-caption);
  font-weight: 700;
  color: var(--on-accent-text);
}

.process-item .status.online {
  background-color: var(--success-color);
}

.process-item .status.stopped,
.process-item .status.errored {
  background-color: var(--danger-color);
}

.process-item .status.launching {
  background-color: var(--warning-color);
}

.show-more {
  padding: 12px;
  font-size: var(--font-size-helper);
  text-align: center;
  color: var(--secondary-text);
}

.auth-code-display {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  height: 100%;
  padding: 12px;
}

.auth-code-display h4 {
  margin: 0 0 8px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.auth-code-row {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 8px;
}

.auth-code-display p {
  min-width: 0;
  margin: 0;
  color: var(--highlight-text);
  font-family: monospace;
  font-size: var(--font-size-emphasis);
  font-weight: 700;
  letter-spacing: 1px;
  line-height: 1.25;
  overflow-wrap: anywhere;
  word-break: break-all;
}

.copy-auth-code-button {
  flex: 0 0 auto;
  width: auto;
  min-width: 54px;
  padding: 6px 10px;
  border: 1px solid var(--dashboard-accent-border);
  border-radius: var(--radius-sm, 8px);
  background: var(--dashboard-accent-soft);
  color: var(--highlight-text);
  font-size: var(--font-size-caption);
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    border-color 0.18s ease,
    opacity 0.18s ease;
}

.copy-auth-code-button:hover:not(:disabled) {
  border-color: var(--dashboard-accent);
  background: color-mix(in srgb, var(--dashboard-accent) 26%, transparent);
}

.copy-auth-code-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.empty-state {
  padding-inline: 12px;
}

/* 断点 1: ≥520px - 宽卡片下略放大认证码列 */
@container dashboard-card (min-width: 520px) {
  .process-layout {
    grid-template-columns: minmax(0, 2fr) minmax(140px, 1fr);
  }

  .process-item {
    min-height: 0;
  }

  .auth-code-display {
    align-self: stretch;
  }
}

/* 断点 2: ≤360px - 极窄卡片才回退单列 */
@container dashboard-card (max-width: 360px) {
  .process-layout {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .process-list {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .process-item {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 8px 10px;
    font-size: var(--font-size-helper);
  }

  .process-item .status {
    justify-self: end;
  }

  .auth-code-display p {
    font-size: var(--font-size-emphasis);
    letter-spacing: 1px;
  }
}

/* 断点 3: ≤280px - 紧凑模式 */
@container dashboard-card (max-width: 280px) {
  .process-item {
    padding: 10px;
    font-size: var(--font-size-caption);
  }

  .process-meta,
  .process-usage {
    font-size: var(--font-size-caption);
  }

  .auth-code-display {
    padding: 14px;
  }

  .auth-code-display p {
    font-size: var(--font-size-body);
  }
}
</style>
