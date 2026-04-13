<template>
  <section class="config-section active-section">
    <div class="schedule-manager-container">
      <div class="schedule-left-panel">
        <div class="calendar-container card">
          <div class="calendar-header">
            <button type="button" @click="prevMonth" class="icon-btn" aria-label="上个月" title="上个月">
              <span class="material-symbols-outlined">chevron_left</span>
            </button>
            <h3 id="current-month-year">{{ currentMonthYear }}</h3>
            <button type="button" @click="nextMonth" class="icon-btn" aria-label="下个月" title="下个月">
              <span class="material-symbols-outlined">chevron_right</span>
            </button>
          </div>
          <div id="calendar-grid" class="calendar-grid">
            <button
              v-for="day in calendarDays"
              :key="day.date.toString()"
              :class="[
                'calendar-day',
                {
                  today: day.isToday,
                  selected: day.isSelected,
                  'other-month': day.isOtherMonth,
                },
              ]"
              @click="selectDay(day)"
              @keydown.enter="selectDay(day)"
              @keydown.space.prevent="selectDay(day)"
              :aria-label="`选择 ${day.day} 日${day.hasSchedules ? '，有日程' : ''}`"
              :tabindex="day.isOtherMonth ? -1 : 0"
            >
              <span class="day-number">{{ day.day }}</span>
              <div v-if="day.hasSchedules" class="schedule-indicator"></div>
            </button>
          </div>
        </div>
        <div class="add-schedule-form card">
          <h3>添加日程</h3>
          <div class="form-group">
            <label for="new-schedule-time">时间</label>
            <input
              id="new-schedule-time"
              v-model="newSchedule.time"
              type="datetime-local"
            />
          </div>
          <div class="form-group">
            <label for="new-schedule-content">内容</label>
            <textarea
              id="new-schedule-content"
              v-model="newSchedule.content"
              rows="3"
              placeholder="描述日程内容…"
            ></textarea>
          </div>
          <button @click="addSchedule" class="btn-primary">添加</button>
        </div>
      </div>
      <div class="schedule-right-panel">
        <div class="schedule-list-container card">
          <div class="list-header">
            <h3>日程列表</h3>
            <div class="list-filters">
              <button
                @click="filterType = 'all'"
                :class="['filter-btn', { active: filterType === 'all' }]"
              >
                全部
              </button>
              <button
                @click="filterType = 'upcoming'"
                :class="['filter-btn', { active: filterType === 'upcoming' }]"
              >
                即将进行
              </button>
            </div>
          </div>
          <div id="schedule-list" class="schedule-list">
            <div v-if="filteredSchedules.length === 0" class="empty-msg">
              <span class="material-symbols-outlined empty-icon">event_busy</span>
              <p>暂无日程</p>
              <p class="empty-hint">在上方日历中选择日期添加新日程</p>
            </div>
            <div
              v-else
              v-for="schedule in filteredSchedules"
              :key="schedule.id"
              class="schedule-item"
            >
              <div class="schedule-time">{{ formatScheduleTime(schedule.time) }}</div>
              <div class="schedule-content">{{ schedule.content }}</div>
              <button
                @click="deleteSchedule(schedule.id)"
                class="btn-danger btn-sm"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { scheduleApi } from "@/api";
import { showMessage } from "@/utils";

interface Schedule {
  id: string;
  time: string;
  content: string;
}

interface CalendarDay {
  date: Date;
  day: number;
  isToday: boolean;
  isSelected: boolean;
  isOtherMonth: boolean;
  hasSchedules: boolean;
}

const currentDate = ref(new Date());
const selectedDate = ref<Date | null>(null);
const schedules = ref<Schedule[]>([]);
const newSchedule = ref({ time: "", content: "" });
const filterType = ref<"all" | "upcoming">("all");

const currentMonthYear = computed(() =>
  currentDate.value.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
  })
);

const calendarDays = computed(() => {
  const year = currentDate.value.getFullYear();
  const month = currentDate.value.getMonth();
  const firstDay = new Date(year, month, 1);
  const startDay = new Date(year, month, 1 - firstDay.getDay());
  const today = new Date();
  const days: CalendarDay[] = [];

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(startDay);
    date.setDate(startDay.getDate() + index);

    days.push({
      date: new Date(date),
      day: date.getDate(),
      isToday: date.toDateString() === today.toDateString(),
      isSelected: selectedDate.value?.toDateString() === date.toDateString(),
      isOtherMonth: date.getMonth() !== month,
      hasSchedules: schedules.value.some(
        (schedule) => new Date(schedule.time).toDateString() === date.toDateString()
      ),
    });
  }

  return days;
});

const filteredSchedules = computed(() => {
  const now = new Date();
  return schedules.value.filter((schedule) => {
    const scheduleDate = new Date(schedule.time);
    const matchesFilter =
      filterType.value !== "upcoming" || scheduleDate.getTime() >= now.getTime();
    const matchesSelectedDay =
      !selectedDate.value ||
      scheduleDate.toDateString() === selectedDate.value.toDateString();
    return matchesFilter && matchesSelectedDay;
  });
});

function prevMonth() {
  currentDate.value = new Date(
    currentDate.value.getFullYear(),
    currentDate.value.getMonth() - 1,
    1
  );
}

function nextMonth() {
  currentDate.value = new Date(
    currentDate.value.getFullYear(),
    currentDate.value.getMonth() + 1,
    1
  );
}

function selectDay(day: CalendarDay) {
  selectedDate.value =
    selectedDate.value?.toDateString() === day.date.toDateString()
      ? null
      : day.date;
}

function formatScheduleTime(time: string): string {
  const date = new Date(time);
  return date.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadSchedules() {
  try {
    const data = await scheduleApi.getSchedules(
      {
        showLoader: false,
        loadingKey: "schedule.list.load",
      }
    );
    schedules.value = data.sort(
      (left, right) =>
        new Date(left.time).getTime() - new Date(right.time).getTime()
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to load schedules:", error);
    showMessage(`加载日程失败：${errorMessage}`, "error");
  }
}

async function addSchedule() {
  if (!newSchedule.value.time || !newSchedule.value.content.trim()) {
    showMessage("请同时填写时间和内容。", "error");
    return;
  }

  try {
    await scheduleApi.createSchedule(
      {
        time: newSchedule.value.time,
        content: newSchedule.value.content.trim(),
      },
      {
        loadingKey: "schedule.create",
      }
    );
    showMessage("日程已添加。", "success");
    newSchedule.value = { time: "", content: "" };
    await loadSchedules();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`添加日程失败：${errorMessage}`, "error");
  }
}

async function deleteSchedule(id: string) {
  if (!confirm("确定删除这条日程吗？")) return;

  try {
    await scheduleApi.deleteSchedule(
      id,
      {
        loadingKey: "schedule.delete",
      }
    );
    showMessage("日程已删除。", "success");
    await loadSchedules();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    showMessage(`删除日程失败：${errorMessage}`, "error");
  }
}

function initializeCalendarWidget(containerId?: string, isDashboard = false) {
  if (isDashboard && containerId) {
    void loadSchedules();
  }
}

defineExpose({ initializeCalendarWidget });

onMounted(() => {
  void loadSchedules();
});
</script>

<style scoped>
.schedule-manager-container {
  display: grid;
  grid-template-columns: 400px 1fr;
  gap: 24px;
}

.calendar-container {
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.calendar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-4);
}

.calendar-header h3 {
  margin: 0;
  font-size: var(--font-size-title);
}

.icon-btn {
  background: var(--tertiary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  min-width: 40px;
  min-height: 40px;
  padding: 8px 10px;
  cursor: pointer;
  color: var(--primary-text);
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.icon-btn:hover {
  background: var(--accent-bg);
  border-color: color-mix(in srgb, var(--button-bg) 34%, var(--border-color));
}

.icon-btn:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--space-1);
}

.calendar-day {
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  position: relative;
  transition: background 0.2s ease;
  /* Button reset styles */
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  line-height: normal;
}

.calendar-day:hover {
  background: var(--accent-bg);
}

.calendar-day.today {
  background: var(--button-bg);
  color: var(--on-accent-text);
}

.calendar-day.selected {
  border: 2px solid var(--highlight-text);
}

.calendar-day.other-month {
  opacity: 0.4;
}

.calendar-day:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.day-number {
  font-size: var(--font-size-body);
  font-weight: 500;
}

.schedule-indicator {
  width: 4px;
  height: 4px;
  background: var(--highlight-text);
  border-radius: 50%;
  margin-top: 4px;
}

.add-schedule-form {
  padding: 16px;
}

.add-schedule-form h3 {
  margin-top: 0;
  margin-bottom: var(--space-4);
}

.add-schedule-form .form-group {
  margin-bottom: var(--space-3);
}

.add-schedule-form label {
  display: block;
  margin-bottom: var(--space-2);
  font-size: var(--font-size-helper);
}

.add-schedule-form input,
.add-schedule-form textarea {
  width: 100%;
  padding: 8px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
}

.schedule-list-container {
  padding: 16px;
}

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-4);
}

.list-header h3 {
  margin: 0;
}

.list-filters {
  display: flex;
  gap: 8px;
}

.filter-btn {
  padding: 6px 12px;
  background: var(--tertiary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-helper);
  cursor: pointer;
  color: var(--primary-text);
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    color 0.2s ease;
}

.filter-btn:hover {
  background: var(--accent-bg);
  border-color: color-mix(in srgb, var(--button-bg) 34%, var(--border-color));
}

.filter-btn.active {
  background: var(--button-bg);
  color: var(--on-accent-text);
  border-color: var(--button-bg);
  box-shadow: 0 4px 10px color-mix(in srgb, var(--button-bg) 26%, transparent);
}

.filter-btn:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.schedule-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 500px;
  overflow-y: auto;
}

.schedule-item {
  background: var(--tertiary-bg);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  display: flex;
  gap: 12px;
  align-items: center;
}

.schedule-time {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  min-width: 100px;
}

.schedule-content {
  flex: 1;
  font-size: var(--font-size-body);
}

.empty-msg {
  text-align: center;
  padding: var(--space-8) var(--space-4);
  color: var(--secondary-text);
}

.empty-msg .empty-icon {
  display: block;
  font-size: var(--font-size-icon-empty);
  opacity: 0.3;
  margin-bottom: var(--space-3);
  color: var(--highlight-text);
}

.empty-hint {
  font-size: var(--font-size-helper);
  opacity: 0.7;
  max-width: 45ch;
  margin-inline: auto;
}

@media (max-width: 1024px) {
  .schedule-manager-container {
    grid-template-columns: 1fr;
  }
}
</style>
