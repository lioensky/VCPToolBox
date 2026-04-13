<template>
  <div class="dashboard-card-shell dashboard-card-shell--amber calendar-card">
    <h3 class="dashboard-card-title">即将进行的日程</h3>
    <div v-if="loading" class="dashboard-card-empty calendar-loading">
      <span class="loading-spinner"></span>
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
        <div class="dashboard-card-panel schedule-time">
          <span class="schedule-date">{{ schedule.date }}</span>
          <span class="schedule-clock">{{ schedule.time }}</span>
        </div>
        <div class="schedule-content">{{ schedule.content }}</div>
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
      .slice(0, 5);
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
  min-height: 220px;
}

.loading-spinner {
  display: inline-block;
  width: 32px;
  height: 32px;
  margin-bottom: 12px;
  border: 3px solid var(--border-color);
  border-top-color: var(--highlight-text);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.calendar-widget {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 12px;
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
  display: flex;
  min-width: 0;
  gap: 12px;
  padding: 10px 12px 10px 15px;
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 60px;
  padding: 8px;
  box-shadow: none;
}

.schedule-date {
  font-size: var(--font-size-helper);
  font-weight: 500;
  color: var(--secondary-text);
}

.schedule-clock {
  font-size: var(--font-size-emphasis);
  font-weight: 700;
  color: var(--primary-text);
}

.schedule-content {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  font-size: var(--font-size-body);
  line-height: 1.5;
  overflow-wrap: anywhere;
  color: var(--primary-text);
}

/* 断点 1: ≥520px - 网格布局 */
@container dashboard-card (min-width: 520px) {
  .calendar-widget {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
}

/* 断点 2: ≤420px - 垂直布局 */
@container dashboard-card (max-width: 420px) {
  .schedule-item {
    flex-direction: column;
    align-items: stretch;
  }

  .schedule-time {
    flex-direction: row;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-width: 0;
  }

  .schedule-content {
    align-items: flex-start;
  }
}

/* 断点 3: ≤280px - 紧凑模式 */
@container dashboard-card (max-width: 280px) {
  .calendar-widget {
    gap: 10px;
  }

  .schedule-item {
    gap: 10px;
    padding: 10px;
  }

  .schedule-time {
    padding: 6px 8px;
  }

  .schedule-date,
  .schedule-content {
    font-size: var(--font-size-helper);
  }

  .schedule-clock {
    font-size: var(--font-size-body);
  }
}
</style>
