<template>
  <section class="ui-danger-zone" data-settings-span="full">
    <div class="ui-danger-zone__content">
      <h3 class="ui-danger-zone__title">{{ title }}</h3>
      <p v-if="description" class="ui-danger-zone__description">{{ description }}</p>
      <slot name="description" />
    </div>
    <div v-if="$slots.action" class="ui-danger-zone__action">
      <slot name="action" />
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
  }>(),
  {
    title: "危险操作",
    description: "",
  }
);
</script>

<style scoped>
.ui-danger-zone {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--danger-color) 36%, var(--border-color));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--danger-color) 8%, transparent);
}

.ui-danger-zone__content {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.ui-danger-zone__title {
  margin: 0;
  color: var(--danger-color);
  font-size: var(--font-size-helper);
  font-weight: 700;
  line-height: 1.35;
}

.ui-danger-zone__description {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.ui-danger-zone__action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
}

@media (max-width: 640px) {
  .ui-danger-zone {
    align-items: stretch;
    flex-direction: column;
  }

  .ui-danger-zone__action {
    justify-content: flex-start;
  }
}
</style>
