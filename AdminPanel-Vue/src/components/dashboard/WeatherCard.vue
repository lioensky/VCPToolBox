<template>
  <div class="dashboard-card-shell dashboard-card-shell--sky weather-card">
    <h3 class="dashboard-card-title">天气预报</h3>
    <div class="weather-container">
      <div class="weather-current">
        <div class="current-main">
          <span class="material-symbols-outlined weather-icon-large">{{
            data.icon
          }}</span>
          <div class="current-temp-box">
            <div class="temp-row">
              <span class="temp">{{ data.temp }}</span>
              <span class="unit">°C</span>
            </div>
            <div class="text">{{ data.text }}</div>
          </div>
        </div>
        <div class="current-details">
          <div class="dashboard-card-panel detail-item">
            <span class="material-symbols-outlined">humidity_percentage</span>
            <span>{{ data.humidity }}%</span>
          </div>
          <div class="dashboard-card-panel detail-item">
            <span class="material-symbols-outlined">air</span>
            <span>{{ data.wind }}</span>
          </div>
          <div class="dashboard-card-panel detail-item">
            <span class="material-symbols-outlined">compress</span>
            <span>{{ data.pressure }} hPa</span>
          </div>
        </div>
      </div>
      <div class="weather-forecast">
        <div
          v-for="day in data.forecast"
          :key="day.fxDate"
          class="dashboard-card-panel forecast-item"
        >
          <span class="forecast-date">{{ day.dayName }}</span>
          <span class="material-symbols-outlined forecast-icon">{{
            day.icon
          }}</span>
          <span class="forecast-temp">{{ day.tempMin }}°/{{ day.tempMax }}°</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DashboardWeatherDisplay } from "@/dashboard/types";

defineProps<{
  data: DashboardWeatherDisplay;
}>();
</script>

<style scoped>
@import "./dashboard-card.css";

/* 统一 Container Query 断点系统 */
/* 断点：768px (桌面), 520px (平板), 420px (小屏), 360px (大屏手机), 280px (小屏手机) */

.weather-card {
  min-height: 280px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.weather-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 16px;
  overflow: hidden;
  --weather-icon-large-size: clamp(2.75rem, 2.1rem + 2.4vw, 4rem);
  --weather-temp-size: clamp(2.1rem, 1.6rem + 1.8vw, 3rem);
  --weather-detail-icon-size: clamp(0.95rem, 0.85rem + 0.35vw, 1.125rem);
  --weather-forecast-icon-size: clamp(1.35rem, 1.05rem + 1.2vw, 2rem);
}

.weather-current {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.current-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 16px;
}

.weather-icon-large {
  font-size: var(--weather-icon-large-size) !important;
  color: var(--highlight-text);
  filter: drop-shadow(
    0 0 20px color-mix(in srgb, var(--highlight-text) 42%, transparent)
  );
  animation: weather-icon-float 3s ease-in-out infinite;
}

@keyframes weather-icon-float {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-5px);
  }
}

.current-temp-box {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.temp-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.temp {
  font-size: var(--weather-temp-size);
  font-weight: 700;
  line-height: 1;
  letter-spacing: -1px;
  color: var(--primary-text);
}

.unit {
  font-size: var(--font-size-emphasis);
  color: var(--secondary-text);
}

.text {
  margin-top: 4px;
  font-size: var(--font-size-body);
  text-transform: capitalize;
  overflow-wrap: anywhere;
  color: var(--secondary-text);
}

.current-details {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(116px, 1fr));
  min-width: 0;
  width: 100%;
  gap: 8px;
}

.detail-item {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  gap: 8px;
  padding: 8px 10px;
  font-size: var(--font-size-helper);
  overflow-wrap: anywhere;
  text-align: center;
  color: var(--secondary-text);
}

.detail-item .material-symbols-outlined {
  font-size: var(--weather-detail-icon-size);
  color: var(--highlight-text);
}

.weather-forecast {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  flex: 1;
  align-content: start;
  gap: 10px;
  padding-top: 2px;
  padding-bottom: 4px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--highlight-text) 32%, transparent)
    transparent;
}

.weather-forecast::-webkit-scrollbar {
  width: 4px;
}

.weather-forecast::-webkit-scrollbar-track {
  background: transparent;
}

.weather-forecast::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--highlight-text) 32%, transparent);
  border-radius: 2px;
}

.forecast-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 86px;
  padding: 12px 10px;
}

.forecast-date {
  font-size: var(--font-size-helper);
  font-weight: 600;
  color: var(--primary-text);
}

.forecast-icon {
  font-size: var(--weather-forecast-icon-size) !important;
  color: var(--highlight-text);
}

.forecast-temp {
  font-size: var(--font-size-body);
  font-weight: 600;
  color: var(--secondary-text);
}

/* 断点 1: ≥520px - 双列布局 */
@container dashboard-card (min-width: 520px) {
  .weather-container {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 0.8fr);
    align-items: stretch;
    gap: 16px;
  }

  .weather-current {
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 14px;
    padding-right: 16px;
    padding-bottom: 0;
    border-right: 1px solid var(--border-color);
    border-bottom: 0;
    overflow: visible;
  }

  .current-main,
  .current-temp-box {
    width: 100%;
  }

  .current-details {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: 100%;
    gap: 10px;
  }

  .detail-item {
    padding: 10px 12px;
  }

  .weather-forecast {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-content: stretch;
    gap: 12px;
    padding-top: 0;
  }

  .forecast-item {
    min-height: 100px;
    padding: 12px 10px;
  }
}

/* 断点 2: ≤420px - 紧凑布局 */
@container dashboard-card (max-width: 420px) {
  .weather-container {
    --weather-icon-large-size: clamp(2.35rem, 2rem + 1.4vw, 3.25rem);
    --weather-temp-size: clamp(1.85rem, 1.55rem + 1vw, 2.5rem);
    --weather-forecast-icon-size: clamp(1.15rem, 1rem + 0.7vw, 1.625rem);
  }

  .weather-current {
    gap: 14px;
    padding-bottom: 14px;
  }

  .current-main {
    gap: 12px;
  }

  .text {
    font-size: var(--font-size-helper);
  }

  .current-details {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .detail-item {
    padding: 8px 10px;
    font-size: var(--font-size-helper);
  }

  .weather-forecast {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 7px;
  }

  .forecast-item {
    min-height: 76px;
    gap: 5px;
    padding: 9px 8px;
  }

  .forecast-date,
  .forecast-temp {
    font-size: var(--font-size-caption);
  }

}

/* 断点 3: ≤360px - 单列详情 */
@container dashboard-card (max-width: 360px) {
  .weather-container {
    --weather-icon-large-size: clamp(2rem, 1.7rem + 1.2vw, 2.75rem);
    --weather-temp-size: clamp(1.7rem, 1.5rem + 0.8vw, 2.2rem);
    --weather-forecast-icon-size: clamp(1rem, 0.9rem + 0.5vw, 1.5rem);
  }

  .weather-current {
    gap: 12px;
    padding-bottom: 12px;
  }

  .text {
    font-size: var(--font-size-helper);
  }

  .current-details {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .detail-item {
    padding: 7px 8px;
    font-size: var(--font-size-caption);
  }

  .detail-item .material-symbols-outlined {
    font-size: var(--font-size-body);
  }

  .weather-forecast {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }

  .forecast-item {
    min-height: 72px;
    gap: 4px;
    padding: 8px 6px;
  }

  .forecast-date,
  .forecast-temp {
    font-size: var(--font-size-caption);
  }

}

/* 断点 4: ≤280px - 极简模式 */
@container dashboard-card (max-width: 280px) {
  .weather-container {
    --weather-icon-large-size: clamp(1.8rem, 1.6rem + 0.8vw, 2.5rem);
    --weather-temp-size: clamp(1.55rem, 1.45rem + 0.5vw, 2rem);
    --weather-forecast-icon-size: clamp(0.95rem, 0.85rem + 0.45vw, 1.375rem);
  }

  .weather-container {
    gap: 12px;
  }

  .current-main {
    gap: 10px;
  }

  .text {
    font-size: var(--font-size-helper);
  }

  .detail-item {
    padding: 6px 8px;
    font-size: var(--font-size-caption);
  }

  .detail-item .material-symbols-outlined {
    font-size: var(--font-size-helper);
  }

  .weather-forecast {
    gap: 5px;
  }

  .forecast-item {
    min-height: 68px;
    gap: 3px;
    padding: 6px 4px;
  }

  .forecast-date,
  .forecast-temp {
    font-size: var(--font-size-caption);
  }

}
</style>
