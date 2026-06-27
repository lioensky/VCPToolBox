<template>
  <div :class="frameClass">
    <table class="ui-table-frame__table">
      <slot />
    </table>
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

const frameClass = computed(() => ["ui-table-frame", `ui-table-frame--${props.density}`]);
</script>

<style scoped>
.ui-table-frame {
  width: 100%;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--secondary-bg);
}

.ui-table-frame__table {
  width: 100%;
  min-width: 640px;
  border-collapse: collapse;
  font-size: var(--font-size-helper);
}

.ui-table-frame :deep(th),
.ui-table-frame :deep(td) {
  border-bottom: 1px solid var(--border-color);
  text-align: left;
  vertical-align: middle;
}

.ui-table-frame--default :deep(th),
.ui-table-frame--default :deep(td) {
  padding: var(--space-3);
}

.ui-table-frame--compact :deep(th),
.ui-table-frame--compact :deep(td) {
  padding: 8px;
}

.ui-table-frame :deep(th) {
  height: 40px;
  color: var(--secondary-text);
  font-weight: 600;
}

.ui-table-frame :deep(td) {
  color: var(--primary-text);
}

.ui-table-frame :deep(tbody tr:hover) {
  background: color-mix(in srgb, var(--primary-text) 4%, transparent);
}

.ui-table-frame :deep(tbody tr:last-child td) {
  border-bottom: 0;
}
</style>
