<template>
  <div class="dashboard-card-shell dashboard-card-shell--amber calendar-card">
    <h3 class="dashboard-card-title">即将进行的日程</h3>
    <div v-if="loading" class="dashboard-card-empty calendar-loading">
      <span class="loading-spinner loading-spinner--sm loading-spinner--mb-3"></span>
      <p>正在加载日程...</p>
    </div>
    <div v-else-if="upcomingSchedules.length === 0" class="dashboard-card-empty calendar-empty">
      <p>暂无即将进行的日程。</p>
    </div>
    <div v-else class="calendar-widget">
      <div
        v-for="schedule in upcomingSchedules"
        :key="schedule.id"
        class="dashboard-card-panel schedule-item"
      >
        <div class="schedule-time">
          <span class="schedule-date">{{ schedule.date }}</span>
          <span class="schedule-clock">{{ schedule.time }}</span>
        </div>
        <div class="schedule-content" :title="schedule.content">{{ schedule.content }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { scheduleApi } from "@/api";
import { createLogger } from "@/utils";

interface ScheduleItem {
  id: string;
  date: string;
  time: string;
  content: string;
  dateTime: Date;
}

const loading = ref(true);
const upcomingSchedules = ref<ScheduleItem[]>([]);
const logger = createLogger("CalendarCard");

async function loadUpcomingSchedules() {
  loading.value = true;
  try {
    const schedules = await scheduleApi.getSchedules();
    const now = new Date();

    upcomingSchedules.value = schedules
      .map((schedule) => {
        const dateTime = new Date(schedule.time);
        return {
          id: schedule.id,
          date: dateTime.toLocaleDateString("zh-CN", {
            month: "short",
            day: "numeric",
          }),
          time: dateTime.toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          content: schedule.content,
          dateTime,
        };
      })
      .filter((schedule) => schedule.dateTime.getTime() >= now.getTime())
      .sort((left, right) => left.dateTime.getTime() - right.dateTime.getTime())
      .slice(0, 10);
  } catch (error) {
    logger.error("Failed to load schedules:", error);
    upcomingSchedules.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadUpcomingSchedules();
});
</script>

<style scoped>
@import "./dashboard-card.css";

/* 统一 Container Query 断点系统 */
/* 断点：768px (桌面), 520px (平板), 420px (小屏), 360px (大屏手机), 280px (小屏手机) */

.calendar-card {
  --dashboard-accent: var(--warning-color);
  --dashboard-accent-soft: color-mix(in srgb, var(--dashboard-accent) 18%, transparent);
  --dashboard-accent-border: color-mix(in srgb, var(--dashboard-accent) 34%, transparent);
}

.calendar-loading,
.calendar-empty {
  min-height: 140px;
}

.calendar-widget {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 8px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--dashboard-accent-border) transparent;
}

.calendar-widget::-webkit-scrollbar {
  width: 4px;
}

.calendar-widget::-webkit-scrollbar-track {
  background: transparent;
}

.calendar-widget::-webkit-scrollbar-thumb {
  background: var(--dashboard-accent-border);
  border-radius: 2px;
}

.schedule-item {
  display: grid;
  grid-template-columns: minmax(78px, auto) minmax(0, 1fr);
  min-width: 0;
  gap: 8px;
  align-items: center;
  padding: 7px 10px 7px 13px;
  position: relative;
}

.schedule-item::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  background: var(--dashboard-accent);
  border-radius: 1.5px;
}

.schedule-time {
  display: inline-flex;
  min-width: 0;
  align-items: baseline;
  justify-content: flex-start;
  gap: 6px;
  white-space: nowrap;
}

.schedule-date {
  font-size: var(--font-size-helper);
  font-weight: 600;
  color: var(--secondary-text);
}

.schedule-clock {
  font-size: var(--font-size-helper);
  font-weight: 700;
  color: var(--primary-text);
}

.schedule-content {
  min-width: 0;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 断点 1: ≥520px - 保持单列紧凑列表，避免宽卡片被切成左右两块导致扫描效率下降 */
@container dashboard-card (min-width: 520px) {
  .schedule-item {
    grid-template-columns: minmax(88px, auto) minmax(0, 1fr);
  }
}

/* 断点 2: ≤360px - 极窄卡片压缩时间列 */
@container dashboard-card (max-width: 360px) {
  .schedule-item {
    grid-template-columns: minmax(68px, auto) minmax(0, 1fr);
    gap: 6px;
    padding: 6px 8px 6px 11px;
  }

  .schedule-time {
    gap: 4px;
  }

  .schedule-date {
    font-size: 11px;
  }
}
</style>
