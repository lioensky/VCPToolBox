<template>
  <div class="ui-empty-state">
    <div v-if="$slots.icon" class="ui-empty-state__icon" aria-hidden="true">
      <slot name="icon" />
    </div>
    <div class="ui-empty-state__text">
      <strong v-if="title" class="ui-empty-state__title">{{ title }}</strong>
      <p v-if="description" class="ui-empty-state__description">{{ description }}</p>
      <slot />
    </div>
    <div v-if="$slots.action" class="ui-empty-state__action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
  }>(),
  {
    title: "",
    description: "",
  }
);
</script>

<style scoped>
.ui-empty-state {
  display: grid;
  min-height: 160px;
  place-items: center;
  gap: var(--space-3);
  padding: var(--space-6);
  color: var(--secondary-text);
  text-align: center;
}

.ui-empty-state__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  background: var(--accent-bg);
  color: var(--primary-text);
}

.ui-empty-state__icon :deep(.material-symbols-outlined) {
  font-size: 20px;
  line-height: 1;
}

.ui-empty-state__text {
  display: grid;
  gap: 4px;
}

.ui-empty-state__title {
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.ui-empty-state__description {
  max-width: 460px;
  margin: 0;
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.ui-empty-state__action {
  display: inline-flex;
  align-items: center;
}
</style>
