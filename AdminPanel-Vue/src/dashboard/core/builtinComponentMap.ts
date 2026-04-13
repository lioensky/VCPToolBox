import { defineAsyncComponent, type Component } from "vue";

export const builtinComponentMap: Record<string, Component> = {
  weather: defineAsyncComponent(() => import("@/components/dashboard/WeatherCard.vue")),
  "newapi-monitor": defineAsyncComponent(() => import("@/components/dashboard/NewApiMonitorCard.vue")),
  cpu: defineAsyncComponent(() => import("@/components/dashboard/CpuCard.vue")),
  memory: defineAsyncComponent(() => import("@/components/dashboard/MemoryCard.vue")),
  process: defineAsyncComponent(() => import("@/components/dashboard/ProcessCard.vue")),
  news: defineAsyncComponent(() => import("@/components/dashboard/NewsCard.vue")),
  "node-info": defineAsyncComponent(() => import("@/components/dashboard/NodeInfoCard.vue")),
  calendar: defineAsyncComponent(() => import("@/components/dashboard/CalendarCard.vue")),
  "activity-chart": defineAsyncComponent(() => import("@/components/dashboard/ActivityChartCard.vue")),
};
