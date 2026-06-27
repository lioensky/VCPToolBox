<template>
  <div :class="toolbarClass">
    <div class="ui-toolbar__main">
      <slot />
    </div>
    <div v-if="$slots.actions" class="ui-toolbar__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    align?: "start" | "center";
    density?: "default" | "compact";
  }>(),
  {
    align: "center",
    density: "default",
  }
);

const toolbarClass = computed(() => ["ui-toolbar", `ui-toolbar--${props.align}`, `ui-toolbar--${props.density}`]);
</script>

<style scoped>
.ui-toolbar {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  justify-content: space-between;
}

.ui-toolbar--center {
  align-items: center;
}

.ui-toolbar--start {
  align-items: flex-start;
}

.ui-toolbar--default {
  gap: var(--space-3);
}

.ui-toolbar--compact {
  gap: var(--space-2);
}

.ui-toolbar__main,
.ui-toolbar__actions {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
}

.ui-toolbar__main {
  flex: 1 1 auto;
  gap: var(--space-2);
}

.ui-toolbar__actions {
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-left: auto;
}
</style>
