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
        <p>{{ authCode }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { PM2Process } from "@/types/api.system";

const props = defineProps<{
  processes: PM2Process[];
  authCode: string;
  maxDisplay?: number;
}>();

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
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 20px;
}

.status-card-content {
  display: flex;
  flex: 1;
  min-height: 0;
}

.status-card-content .empty-state {
  flex: 1;
  min-height: 0;
}

.process-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 12px;
  overflow-y: auto;
}

.process-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 10px;
  padding: 10px 12px;
  font-size: var(--font-size-body);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.process-item strong,
.process-item .process-usage {
  min-width: 0;
  grid-column: 1 / -1;
}

.process-meta {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
}

.process-usage {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.process-item .status {
  justify-self: start;
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
  padding: 18px;
}

.auth-code-display h4 {
  margin: 0 0 8px;
  font-size: var(--font-size-body);
  color: var(--secondary-text);
}

.auth-code-display p {
  margin: 0;
  font-size: var(--font-size-title);
  font-weight: 700;
  letter-spacing: 1.5px;
  word-break: break-all;
  color: var(--highlight-text);
  font-family: monospace;
}

.empty-state {
  padding-inline: 12px;
}

/* 断点 1: ≥520px - 双列布局 */
@container dashboard-card (min-width: 520px) {
  .process-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(220px, 0.75fr);
    align-items: stretch;
  }

  .process-item {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .process-item strong,
  .process-item .process-usage {
    grid-column: auto;
  }

  .process-item .process-usage {
    justify-self: end;
    text-align: right;
  }
}

/* 断点 2: ≤420px - 单列布局 */
@container dashboard-card (max-width: 420px) {
  .process-layout {
    gap: 16px;
  }

  .process-list {
    gap: 10px;
  }

  .process-item {
    grid-template-columns: 1fr;
    padding: 12px;
    font-size: var(--font-size-helper);
  }

  .process-item .status {
    justify-self: start;
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
