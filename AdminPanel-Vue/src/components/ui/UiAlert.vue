<template>
  <div :class="alertClass" role="status">
    <span v-if="$slots.icon" class="ui-alert__icon" aria-hidden="true">
      <slot name="icon" />
    </span>
    <div class="ui-alert__content">
      <strong v-if="title" class="ui-alert__title">{{ title }}</strong>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    variant?: "info" | "success" | "warning" | "danger";
    title?: string;
  }>(),
  {
    variant: "info",
    title: "",
  }
);

const alertClass = computed(() => ["ui-alert", `ui-alert--${props.variant}`]);
</script>

<style scoped>
.ui-alert {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.ui-alert--info {
  border-color: color-mix(in srgb, var(--highlight-text) 42%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 12%, transparent);
  color: var(--primary-text);
}

.ui-alert--success {
  border-color: color-mix(in srgb, var(--success-color) 52%, var(--border-color));
  background: color-mix(in srgb, var(--success-color) 12%, transparent);
  color: var(--success-color);
}

.ui-alert--warning {
  border-color: color-mix(in srgb, var(--warning-color) 58%, var(--border-color));
  background: color-mix(in srgb, var(--warning-color) 14%, transparent);
  color: var(--warning-color);
}

.ui-alert--danger {
  border-color: var(--danger-border);
  background: var(--danger-bg);
  color: var(--danger-color);
}

.ui-alert__icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

.ui-alert__icon :deep(.material-symbols-outlined) {
  font-size: 18px;
  line-height: 1;
}

.ui-alert__content {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ui-alert__title {
  color: currentColor;
  font-weight: 700;
}
</style>
