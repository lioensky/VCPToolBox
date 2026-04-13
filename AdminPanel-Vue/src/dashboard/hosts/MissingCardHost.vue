<template>
  <div class="dashboard-card-shell dashboard-card-shell--rose missing-card">
    <div class="dashboard-card-header">
      <div>
        <h3 class="dashboard-card-title">{{ resolvedTitle }}</h3>
        <p class="dashboard-card-subtitle">
          {{ resolvedMessage }}
        </p>
      </div>
      <span class="dashboard-card-badge">Missing</span>
    </div>
    <div class="dashboard-card-panel missing-card-body">
      <p>类型：{{ instance.typeId }}</p>
      <p>实例：{{ instance.instanceId }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DashboardCardInstance } from "@/dashboard/core/types";

const props = defineProps<{
  instance: DashboardCardInstance;
  title?: string;
  message?: string;
}>();

const resolvedTitle = computed(
  () => props.title || props.instance.typeId.split(".").pop() || "Unavailable Card"
);
const resolvedMessage = computed(
  () => props.message || "来源插件不可用，可移除或等待恢复。"
);
</script>

<style scoped>
@import "@/components/dashboard/dashboard-card.css";

.missing-card-body {
  padding: 16px 18px;
  color: var(--secondary-text);
}

.missing-card-body p {
  margin: 0;
  word-break: break-all;
}

.missing-card-body p + p {
  margin-top: 8px;
}
</style>
