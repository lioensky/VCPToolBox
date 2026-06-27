<template>
  <span :class="badgeClass">
    <span v-if="$slots.leading" class="ui-badge__icon">
      <slot name="leading" />
    </span>
    <slot />
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    variant?: "default" | "secondary" | "success" | "warning" | "danger" | "info" | "outline";
  }>(),
  {
    variant: "default",
  }
);

const badgeClass = computed(() => ["ui-badge", `ui-badge--${props.variant}`]);
</script>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  max-width: 100%;
  height: 20px;
  gap: 4px;
  padding: 0 8px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ui-badge--default {
  background: var(--button-bg);
  color: var(--on-accent-text);
}

.ui-badge--secondary {
  background: var(--accent-bg);
  color: var(--primary-text);
}

.ui-badge--success {
  background: color-mix(in srgb, var(--success-color) 16%, transparent);
  color: var(--success-color);
}

.ui-badge--warning {
  background: color-mix(in srgb, var(--warning-color) 16%, transparent);
  color: var(--warning-color);
}

.ui-badge--danger {
  background: var(--danger-bg);
  color: var(--danger-color);
}

.ui-badge--info {
  background: color-mix(in srgb, var(--highlight-text) 16%, transparent);
  color: var(--highlight-text);
}

.ui-badge--outline {
  border-color: var(--border-color);
  background: transparent;
  color: var(--primary-text);
}

.ui-badge__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.ui-badge__icon :deep(.material-symbols-outlined) {
  font-size: 14px;
  line-height: 1;
}
</style>
