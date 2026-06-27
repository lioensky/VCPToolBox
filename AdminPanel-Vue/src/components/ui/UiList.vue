<template>
  <div :class="listClass" role="list">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    density?: "default" | "compact";
  }>(),
  {
    density: "default",
  }
);

const listClass = computed(() => ["ui-list", `ui-list--${props.density}`]);
</script>

<style scoped>
.ui-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.ui-list--default {
  gap: var(--space-2);
}

.ui-list--compact {
  gap: 6px;
}
</style>
