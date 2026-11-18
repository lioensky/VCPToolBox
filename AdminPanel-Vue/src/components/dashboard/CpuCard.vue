<template>
  <div class="dashboard-card-shell dashboard-card-shell--sky cpu-card">
    <h3 class="dashboard-card-title">CPU 使用率</h3>
    <div class="status-card-content">
      <div class="progress-circle">
        <svg width="120" height="120" viewBox="0 0 120 120">
          <circle class="progress-bg" cx="60" cy="60" r="54"></circle>
          <circle
            class="progress-bar"
            cx="60"
            cy="60"
            r="54"
            :style="{ strokeDashoffset }"
          ></circle>
        </svg>
        <span class="progress-text">{{ usage.toFixed(1) }}%</span>
      </div>
      <div class="info-section">
        <p class="info-text">{{ info }}</p>
        <p class="info-text-secondary">
          <span v-if="temperatureText">温度：{{ temperatureText }} <br /></span>
          <template v-if="platform || arch">
            平台：{{ platform }} <br />
            架构：{{ arch }}
          </template>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  usage: number;
  info: string;
  platform?: string;
  arch?: string;
  temperature?: {
    value: number;
    unit?: string;
    source?: string;
  } | null;
}>();

const circumference = 2 * Math.PI * 54;
const strokeDashoffset = computed(() => {
  return circumference - (circumference * props.usage) / 100;
});

const temperatureText = computed(() => {
  const temperature = props.temperature;
  if (!temperature || !Number.isFinite(temperature.value)) {
    return "";
  }

  const unit = temperature.unit || "°C";
  const source = temperature.source ? ` · ${temperature.source}` : "";
  return `${temperature.value.toFixed(1)} ${unit}${source}`;
});
</script>

<style scoped>
@import "./dashboard-card.css";

/* 统一 Container Query 断点系统 */
/* 断点：768px (桌面), 520px (平板), 420px (小屏), 360px (大屏手机), 280px (小屏手机) */

.cpu-card {
  --dashboard-accent: var(--cpu-color);
  --dashboard-accent-soft: color-mix(in srgb, var(--dashboard-accent) 18%, transparent);
  --dashboard-accent-border: color-mix(in srgb, var(--dashboard-accent) 34%, transparent);
}

.status-card-content {
  display: flex;
  align-items: center;
  flex: 1;
  min-height: 0;
  min-width: 0;
  gap: 20px;
  /* 文字始终在圆环右边，保持横向布局 */
  flex-direction: row;
}

.progress-circle {
  position: relative;
  width: 120px;
  height: 120px;
  flex-shrink: 0;
}

.progress-circle svg {
  transform: rotate(-90deg);
}

.progress-bg {
  fill: none;
  stroke: var(--tertiary-bg);
  stroke-width: 10;
}

.progress-bar {
  fill: none;
  stroke: var(--dashboard-accent);
  stroke-width: 10;
  stroke-linecap: round;
  /* 使用 CSS 变量计算圆环周长: 2 * π * 54 ≈ 339.292 */
  --circle-circumference: 339.292;
  stroke-dasharray: var(--circle-circumference);
  transition: stroke-dashoffset 0.5s ease-out;
}

.progress-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: var(--font-size-display);
  font-weight: 700;
  color: var(--primary-text);
}

.info-section {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding-top: 0;
  text-align: left;
}

.info-text {
  margin: 0;
  font-size: var(--font-size-body);
  line-height: 1.4;
  word-break: break-word;
  color: var(--secondary-text);
}

.info-text-secondary {
  margin-top: 8px;
  font-size: var(--font-size-helper);
  line-height: 1.5;
  word-break: break-word;
  color: var(--secondary-text);
  opacity: 0.8;
}

/* 断点 1: ≥520px - 放大圆环与字号 */
@container dashboard-card (min-width: 520px) {
  .progress-circle {
    width: 128px;
    height: 128px;
  }

  .progress-circle svg {
    width: 128px;
    height: 128px;
  }

  .progress-text {
    font-size: var(--font-size-metric-primary);
  }

  .info-text-secondary {
    margin-top: 10px;
  }
}

/* 断点 2: ≤360px - 缩小圆环，保持横向 */
@container dashboard-card (max-width: 360px) {
  .status-card-content {
    gap: 14px;
  }

  .progress-circle {
    width: 96px;
    height: 96px;
    flex-shrink: 0;
  }

  .progress-circle svg {
    width: 96px;
    height: 96px;
  }

  .progress-text {
    font-size: var(--font-size-metric-secondary);
  }

  .info-text {
    font-size: var(--font-size-helper);
  }

  .info-text-secondary {
    font-size: var(--font-size-caption);
    margin-top: 6px;
  }
}

/* 断点 3: ≤280px - 极简模式，仍保持横向 */
@container dashboard-card (max-width: 280px) {
  .status-card-content {
    gap: 10px;
  }

  .progress-circle {
    width: 80px;
    height: 80px;
  }

  .progress-circle svg {
    width: 80px;
    height: 80px;
  }

  .progress-text {
    font-size: var(--font-size-title);
  }

  .info-text {
    font-size: var(--font-size-caption);
  }

  .info-text-secondary {
    font-size: var(--font-size-caption);
    margin-top: 4px;
  }
}
</style>
