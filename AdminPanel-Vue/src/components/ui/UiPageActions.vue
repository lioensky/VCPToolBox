<template>
  <div class="ui-page-actions" v-bind="$attrs">
    <slot />
  </div>
</template>

<script setup lang="ts">
defineOptions({ inheritAttrs: false });
</script>

<style scoped>
.ui-page-actions {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
