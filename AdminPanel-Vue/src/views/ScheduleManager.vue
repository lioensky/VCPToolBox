<template>
  <section class="config-section active-section">
    <div class="schedule-manager-container">
      <div class="schedule-left-panel">
        <UiCard class="calendar-container" size="sm" variant="subtle">
          <UiToolbar density="compact">
            <template #default>
              <UiIconButton label="上个月" title="上个月" size="sm" @click="prevMonth">
                <span class="material-symbols-outlined">chevron_left</span>
              </UiIconButton>
              <h3 id="current-month-year" class="calendar-title">{{ currentMonthYear }}</h3>
              <UiIconButton label="下个月" title="下个月" size="sm" @click="nextMonth">
                <span class="material-symbols-outlined">chevron_right</span>
              </UiIconButton>
            </template>
          </UiToolbar>
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
        </UiCard>
        <UiCard
          class="add-schedule-form"
          title="添加日程"
          description="创建一条带时间的提醒事项。"
          size="sm"
          variant="subtle"
          divided
        >
          <UiSettingsForm as="div" :columns="1" gap="sm">
            <UiField label="时间" for-id="new-schedule-time" size="sm">
              <UiInput
                id="new-schedule-time"
                v-model="newSchedule.time"
                size="sm"
                type="datetime-local"
              />
            </UiField>
            <UiField label="内容" for-id="new-schedule-content" size="sm">
              <UiTextarea
                id="new-schedule-content"
                v-model="newSchedule.content"
                size="sm"
                rows="3"
                placeholder="描述日程内容…"
              />
            </UiField>
          </UiSettingsForm>
          <template #footer>
            <div class="card-footer-actions">
              <UiButton size="sm" type="button" @click="addSchedule">添加</UiButton>
            </div>
          </template>
        </UiCard>
      </div>
      <div class="schedule-right-panel">
        <UiCard class="schedule-list-container" size="sm" variant="subtle" divided>
          <template #title>日程列表</template>
          <template #action>
            <div class="list-filters" role="group" aria-label="日程筛选">
              <UiButton
                type="button"
                size="sm"
                :variant="filterType === 'all' ? 'secondary' : 'ghost'"
                @click="filterType = 'all'"
              >
                全部
              </UiButton>
              <UiButton
                type="button"
                size="sm"
                :variant="filterType === 'upcoming' ? 'secondary' : 'ghost'"
                @click="filterType = 'upcoming'"
              >
                即将进行
              </UiButton>
            </div>
          </template>
          <div id="schedule-list" class="schedule-list">
            <UiEmptyState
              v-if="filteredSchedules.length === 0"
              title="暂无日程"
              description="在左侧日历中选择日期并添加新日程。"
            >
              <template #icon>
                <span class="material-symbols-outlined">event_busy</span>
              </template>
            </UiEmptyState>
            <div
              v-else
              v-for="schedule in filteredSchedules"
              :key="schedule.id"
              class="schedule-item"
            >
              <div class="schedule-time">{{ formatScheduleTime(schedule.time) }}</div>
              <div class="schedule-content">{{ schedule.content }}</div>
              <UiButton
                type="button"
                variant="danger"
                size="sm"
                @click="deleteSchedule(schedule.id)"
              >
                删除
              </UiButton>
            </div>
          </div>
        </UiCard>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { scheduleApi } from "@/api";
import UiButton from "@/components/ui/UiButton.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiField from "@/components/ui/UiField.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSettingsForm from "@/components/ui/UiSettingsForm.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";
import UiToolbar from "@/components/ui/UiToolbar.vue";
import { askConfirm } from "@/platform/feedback/feedbackBus";
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
  if (!(await askConfirm({
    message: "确定删除这条日程吗？",
    danger: true,
    confirmText: "删除",
  }))) return;

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
  gap: var(--space-4);
}

.calendar-container {
  margin-bottom: var(--space-4);
}

.calendar-title {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 700;
  line-height: 1.25;
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
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  position: relative;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
  /* Button reset styles */
  background: transparent;
  font: inherit;
  color: inherit;
  line-height: normal;
}

.calendar-day:hover {
  background: var(--accent-bg);
}

.calendar-day.today {
  border-color: color-mix(in srgb, var(--highlight-text) 56%, transparent);
  color: var(--highlight-text);
}

.calendar-day.selected {
  background: var(--button-bg);
  border-color: var(--button-bg);
  color: var(--on-accent-text);
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
  margin-top: var(--space-1);
}

.calendar-day.selected .schedule-indicator {
  background: currentColor;
}

.card-footer-actions {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: flex-end;
}

.list-filters {
  display: flex;
  gap: var(--space-2);
}

.schedule-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-height: 500px;
  overflow-y: auto;
}

.schedule-item {
  display: flex;
  min-height: 44px;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-2) 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
}

.schedule-item:last-child {
  border-bottom: 0;
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

@media (max-width: 1024px) {
  .schedule-manager-container {
    grid-template-columns: 1fr;
  }
}
</style>
