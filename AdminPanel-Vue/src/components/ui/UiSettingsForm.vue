<template>
  <form v-if="as === 'form'" :class="formClass">
    <slot />
  </form>
  <div v-else :class="formClass">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    as?: "form" | "div";
    columns?: 1 | 2;
    gap?: "sm" | "md" | "lg";
  }>(),
  {
    as: "form",
    columns: 2,
    gap: "md",
  }
);

const formClass = computed(() => [
  "ui-settings-form",
  `ui-settings-form--cols-${props.columns}`,
  `ui-settings-form--gap-${props.gap}`,
]);
</script>

<style scoped>
.ui-settings-form {
  display: grid;
  min-width: 0;
  align-items: start;
}

.ui-settings-form--cols-1 {
  grid-template-columns: minmax(0, 1fr);
}

.ui-settings-form--cols-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ui-settings-form--gap-sm {
  gap: var(--space-4);
}

.ui-settings-form--gap-md {
  gap: var(--space-5) var(--space-5);
}

.ui-settings-form--gap-lg {
  gap: var(--space-6) var(--space-5);
}

.ui-settings-form :deep([data-settings-span="full"]),
.ui-settings-form :deep(.ui-settings-switch-row),
.ui-settings-form :deep(.ui-settings-group),
.ui-settings-form :deep(.ui-textarea) {
  grid-column: 1 / -1;
}

@media (max-width: 900px) {
  .ui-settings-form--cols-2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
