<template>
  <section :class="groupClass" data-settings-span="full">
    <div v-if="hasHeader" class="ui-settings-group__header">
      <div class="ui-settings-group__title-block">
        <h4 v-if="title" class="ui-settings-group__title">{{ title }}</h4>
        <slot v-else name="title" />
        <p v-if="description" class="ui-settings-group__description">{{ description }}</p>
        <slot v-else name="description" />
      </div>
      <div v-if="$slots.action" class="ui-settings-group__action">
        <slot name="action" />
      </div>
    </div>

    <div class="ui-settings-group__content">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, useSlots } from "vue";

const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    inset?: boolean;
    disabled?: boolean;
  }>(),
  {
    title: "",
    description: "",
    inset: false,
    disabled: false,
  }
);

const slots = useSlots();

const hasHeader = computed(
  () => Boolean(props.title) || Boolean(props.description) || Boolean(slots.title) || Boolean(slots.description) || Boolean(slots.action)
);

const groupClass = computed(() => [
  "ui-settings-group",
  {
    "ui-settings-group--inset": props.inset,
    "ui-settings-group--disabled": props.disabled,
  },
]);
</script>

<style scoped>
.ui-settings-group {
  display: grid;
  min-width: 0;
  gap: var(--space-3);
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--primary-text) 3%, transparent);
}

.ui-settings-group--disabled {
  opacity: 0.62;
}

.ui-settings-group__header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.ui-settings-group__title-block {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.ui-settings-group__title {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
  line-height: 1.3;
}

.ui-settings-group__description {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.ui-settings-group__action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
}

.ui-settings-group__content {
  min-width: 0;
}

.ui-settings-group--inset .ui-settings-group__content {
  margin-left: var(--space-2);
  padding-left: var(--space-3);
  border-left: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
}
</style>
