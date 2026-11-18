<!--
  示例第三方贡献卡片：服务器运行时长

  这是一个最简的"读取后端已有 API → 展示"演示，
  目的是让贡献者通过对照本文件快速上手。

  关键点：
    1) 顶部的 <script lang="ts"> 导出 cardMeta（必需）
    2) <script setup> 中只通过 _sdk.ts 暴露的 cardSdk 取数据
    3) 使用 dashboard-card-shell 外壳类名（视觉与官方卡一致）
    4) 默认 defaultEnabled: false，避免污染默认布局

  详见 contrib/README.md 与 docs/DASHBOARD_CONTRIB_GUIDE.md
-->

<script lang="ts">
import type { CardMeta } from "./_types";

export const cardMeta: CardMeta = {
  typeId: "contrib.example-uptime",
  title: "服务器运行时长",
  description: "示例卡片：展示 Node 进程运行时长与基础信息。",
  defaultEnabled: false,
  singleton: true,
  defaultSize: { desktopCols: 3, tabletCols: 3, rows: 9 },
  minSize:     { desktopCols: 3, tabletCols: 3, rows: 7 },
  maxSize:     { desktopCols: 6, tabletCols: 6, rows: 14 },
  author: "VCP Core Team",
  version: "1.0.0",
};
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { cardSdk } from "./_sdk";

const logger = cardSdk.utils.createLogger("ExampleUptimeCard");

const platform = ref<string>("--");
const arch = ref<string>("--");
const nodeVersion = ref<string>("--");
const uptimeSeconds = ref<number>(0);
const error = ref<string | null>(null);

async function refresh() {
  try {
    const resources = await cardSdk.system.getSystemResources();
    platform.value = resources.nodeProcess?.platform ?? "--";
    arch.value = resources.nodeProcess?.arch ?? "--";
    nodeVersion.value = resources.nodeProcess?.version ?? "--";
    uptimeSeconds.value = Math.floor(resources.nodeProcess?.uptime ?? 0);
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    logger.warn("拉取系统资源失败：", err);
  }
}

// 30 秒刷新一次（卸载时会自动停止）
const polling = cardSdk.utils.usePolling(refresh, {
  interval: 30 * 1000,
  immediate: true,
  onError: (err) => logger.warn("polling error:", err),
});

onMounted(() => {
  polling.start();
});

onUnmounted(() => {
  polling.stop();
});

const uptimeDisplay = computed(() => {
  const total = uptimeSeconds.value;
  if (!Number.isFinite(total) || total <= 0) {
    return "—";
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) {
    return `${days} 天 ${hours} 小时 ${minutes} 分`;
  }
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  }
  return `${minutes} 分 ${seconds} 秒`;
});
</script>

<template>
  <div class="dashboard-card-shell dashboard-card-shell--teal example-uptime-card">
    <h3 class="dashboard-card-title">服务器运行时长</h3>

    <div v-if="error" class="dashboard-card-empty">
      <p class="example-error">{{ error }}</p>
    </div>

    <template v-else>
      <div class="example-uptime-display">
        <span class="example-uptime-value">{{ uptimeDisplay }}</span>
        <span class="example-uptime-label">已稳定运行</span>
      </div>

      <dl class="example-info-grid">
        <div>
          <dt>平台</dt>
          <dd>{{ platform }}</dd>
        </div>
        <div>
          <dt>架构</dt>
          <dd>{{ arch }}</dd>
        </div>
        <div>
          <dt>Node</dt>
          <dd>{{ nodeVersion }}</dd>
        </div>
      </dl>
    </template>
  </div>
</template>

<style scoped>
@import "../dashboard-card.css";

.example-uptime-card {
  --dashboard-accent: oklch(0.70 0.14 180);
}

.example-uptime-display {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin-bottom: 16px;
}

.example-uptime-value {
  font-size: var(--font-size-metric-secondary, 1.6rem);
  font-weight: 700;
  color: var(--primary-text);
  word-break: break-word;
}

.example-uptime-label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  letter-spacing: 0.04em;
}

.example-info-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
}

.example-info-grid > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 10px);
  background: var(--accent-bg);
  min-width: 0;
}

.example-info-grid dt {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.example-info-grid dd {
  margin: 0;
  font-size: var(--font-size-helper);
  font-weight: 600;
  color: var(--primary-text);
  word-break: break-word;
}

.example-error {
  font-size: var(--font-size-helper);
  color: var(--error-text, oklch(0.7 0.18 30));
}

@container dashboard-card (max-width: 360px) {
  .example-info-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>