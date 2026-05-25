<template>
  <button
    type="button"
    class="drag-handle"
    :aria-label="label"
    :title="label"
  >
    <slot>☰</slot>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  label?: string;
}>();
</script>

<style scoped>
.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-body);
  cursor: grab;
  user-select: none;
  touch-action: none;
  transition: color 0.2s ease, background-color 0.2s ease;
}

.drag-handle:hover {
  color: var(--primary-text);
  background: var(--accent-bg);
}

.drag-handle:active {
  cursor: grabbing;
}
</style>
