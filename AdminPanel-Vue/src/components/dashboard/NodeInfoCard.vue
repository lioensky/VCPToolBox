<template>
  <div class="dashboard-card-shell dashboard-card-shell--teal node-card">
    <h3 class="dashboard-card-title">Node.js 进程信息</h3>
    <div class="status-card-content">
      <div v-if="info.pid" class="dashboard-card-panel node-info-item">
        <strong>进程 ID:</strong> {{ info.pid }}
      </div>
      <div v-if="info.version" class="dashboard-card-panel node-info-item">
        <strong>Node.js 版本:</strong> {{ info.version }}
      </div>
      <div v-if="info.memory" class="dashboard-card-panel node-info-item">
        <strong>内存占用:</strong> {{ formatMemory(info.memory.rss) }} MB
      </div>
      <div v-if="info.uptime" class="dashboard-card-panel node-info-item">
        <strong>运行时间:</strong> {{ formatUptime(info.uptime) }}
      </div>
      <div v-if="!info.pid" class="dashboard-card-empty empty-state">
        <p>加载中...</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NodeProcessInfo } from "@/types/api.system";

defineProps<{
  info: Partial<NodeProcessInfo>;
}>();

function formatMemory(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);

  return parts.join(" ") || "少于 1 分钟";
}
</script>

<style scoped>
@import "./dashboard-card.css";

/* 统一 Container Query 断点系统 */
/* 断点：768px (桌面), 520px (平板), 420px (小屏), 360px (大屏手机), 280px (小屏手机) */

.node-card {
  --dashboard-accent: var(--info-text);
  --dashboard-accent-soft: color-mix(in srgb, var(--dashboard-accent) 18%, transparent);
  --dashboard-accent-border: color-mix(in srgb, var(--dashboard-accent) 34%, transparent);
}

.status-card-content {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  flex: 1;
  min-height: 0;
  gap: 12px;
}

.node-info-item {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 10px 12px;
  font-size: var(--font-size-body);
  overflow-wrap: anywhere;
  min-height: auto;
}

.node-info-item strong {
  display: inline-block;
  margin-right: 8px;
  color: var(--primary-text);
}

.empty-state {
  min-height: 220px;
}

/* 断点 1: ≤420px - 单列布局 */
@container dashboard-card (max-width: 420px) {
  .status-card-content {
    grid-template-columns: 1fr;
  }

  .node-info-item {
    padding: 12px;
    font-size: var(--font-size-helper);
    line-height: 1.55;
    word-break: break-word;
  }

  .node-info-item strong {
    display: inline-block;
    margin-right: 6px;
  }
}

/* 断点 2: ≤280px - 紧凑模式 */
@container dashboard-card (max-width: 280px) {
  .status-card-content {
    gap: 10px;
  }

  .node-info-item {
    padding: 10px;
    font-size: var(--font-size-caption);
  }
}
</style>
