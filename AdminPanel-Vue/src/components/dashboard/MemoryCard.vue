<template>
  <div class="dashboard-card-shell dashboard-card-shell--emerald memory-card">
    <h3 class="dashboard-card-title">内存使用情况</h3>
    <div class="memory-layout">
      <div class="memory-summary">
        <span class="memory-summary-value">{{ usage.toFixed(1) }}%</span>
        <span class="memory-summary-label">{{ info }}</span>
      </div>

      <div class="memory-bars">
        <div class="memory-bar-row">
          <div class="memory-bar-head">
            <span class="memory-bar-label">总内存</span>
            <span class="memory-bar-value">{{ formatBytes(memTotal) }}</span>
          </div>
          <div class="memory-bar-track memory-bar-track--total">
            <div class="memory-bar-fill memory-bar-fill--total" style="width: 100%"></div>
          </div>
        </div>

        <div class="memory-bar-row">
          <div class="memory-bar-head">
            <span class="memory-bar-label">内存占用</span>
            <span class="memory-bar-value">
              {{ formatBytes(memUsed) }} · {{ usage.toFixed(1) }}%
            </span>
          </div>
          <div class="memory-bar-track memory-bar-track--used">
            <div
              class="memory-bar-fill memory-bar-fill--used"
              :style="{ width: clampPercent(usage) }"
            ></div>
          </div>
        </div>

        <div class="memory-bar-row">
          <div class="memory-bar-head">
            <span class="memory-bar-label">VCP 内存占用</span>
            <span class="memory-bar-value">
              {{ formatBytes(vcpMemBytes) }} · {{ vcpUsage.toFixed(1) }}%
            </span>
          </div>
          <div class="memory-bar-track memory-bar-track--vcp">
            <div
              class="memory-bar-fill memory-bar-fill--vcp"
              :style="{ width: clampPercent(vcpUsage) }"
            ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  usage: number;
  info: string;
  vcpUsage: number;
  memTotal: number;
  memUsed: number;
  vcpMemBytes: number;
}>();

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function clampPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return `${clamped.toFixed(2)}%`;
}
</script>

<style scoped>
@import "./dashboard-card.css";

.memory-card {
  --dashboard-accent: var(--memory-color);
  --dashboard-accent-soft: color-mix(in srgb, var(--dashboard-accent) 18%, transparent);
  --dashboard-accent-border: color-mix(in srgb, var(--dashboard-accent) 34%, transparent);
  --memory-bar-total: oklch(0.72 0.20 145);
  --memory-bar-used: oklch(0.70 0.18 50);
  --memory-bar-vcp: oklch(0.78 0.15 230);
}

.memory-layout {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 18px;
}

.memory-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px;
  border-radius: var(--radius-md, 12px);
  border: 1px solid var(--border-color);
  background:
    linear-gradient(180deg, oklch(1 0 0 / 0.04), oklch(1 0 0 / 0.015)),
    var(--accent-bg);
}

.memory-summary-value {
  font-size: var(--font-size-display);
  font-weight: 700;
  color: var(--primary-text);
  line-height: 1.1;
}

.memory-summary-label {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  line-height: 1.4;
  word-break: break-word;
}

.memory-bars {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-height: 0;
}

.memory-bar-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.memory-bar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.memory-bar-label {
  font-size: var(--font-size-helper);
  font-weight: 600;
  color: var(--primary-text);
}

.memory-bar-value {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  font-variant-numeric: tabular-nums;
  text-align: right;
  word-break: break-word;
}

.memory-bar-track {
  position: relative;
  width: 100%;
  height: 10px;
  border-radius: 999px;
  background: var(--tertiary-bg);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
}

.memory-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

.memory-bar-fill::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, white 25%, transparent) 50%,
    transparent 100%
  );
  opacity: 0.5;
}

.memory-bar-fill--total {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--memory-bar-total) 70%, transparent),
    var(--memory-bar-total)
  );
}

.memory-bar-fill--used {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--memory-bar-used) 70%, transparent),
    var(--memory-bar-used)
  );
}

.memory-bar-fill--vcp {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--memory-bar-vcp) 70%, transparent),
    var(--memory-bar-vcp)
  );
}

/* 断点 1: ≥520px - 放大字号 */
@container dashboard-card (min-width: 520px) {
  .memory-summary {
    padding: 14px 18px;
  }

  .memory-summary-value {
    font-size: var(--font-size-metric-primary);
  }

  .memory-summary-label {
    font-size: var(--font-size-body);
  }

  .memory-bar-label {
    font-size: var(--font-size-body);
  }

  .memory-bar-value {
    font-size: var(--font-size-helper);
  }

  .memory-bar-track {
    height: 12px;
  }

  .memory-bars {
    gap: 16px;
  }
}

/* 断点 2: ≤360px - 紧凑布局 */
@container dashboard-card (max-width: 360px) {
  .memory-summary {
    padding: 8px 10px;
  }

  .memory-summary-value {
    font-size: var(--font-size-metric-secondary);
  }

  .memory-summary-label {
    font-size: var(--font-size-caption);
  }

  .memory-bar-label {
    font-size: var(--font-size-caption);
  }

  .memory-bar-value {
    font-size: var(--font-size-caption);
  }

  .memory-bar-track {
    height: 8px;
  }

  .memory-bars {
    gap: 10px;
  }
}

/* 断点 3: ≤280px - 极简模式 */
@container dashboard-card (max-width: 280px) {
  .memory-summary {
    padding: 6px 8px;
  }

  .memory-summary-value {
    font-size: var(--font-size-title);
  }

  .memory-bar-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .memory-bar-value {
    text-align: left;
  }

  .memory-bar-track {
    height: 6px;
  }

  .memory-bars {
    gap: 8px;
  }
}
</style>
