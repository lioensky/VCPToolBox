<template>
  <span v-if="dirty" class="ui-dirty-indicator" role="status">
    <span class="ui-dirty-indicator__dot" aria-hidden="true" />
    {{ label }}
  </span>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    dirty?: boolean;
    label?: string;
  }>(),
  {
    dirty: false,
    label: "未保存",
  }
);
</script>

<style scoped>
.ui-dirty-indicator {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--warning-color) 34%, var(--border-color));
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--warning-color) 12%, transparent);
  color: var(--warning-color);
  font-size: var(--font-size-caption);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.ui-dirty-indicator__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: currentColor;
}
</style>
