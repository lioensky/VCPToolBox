<template>
  <section :class="sectionClass">
    <header v-if="hasHeader" class="ui-section__header">
      <div class="ui-section__title-block">
        <h3 v-if="title" class="ui-section__title">{{ title }}</h3>
        <slot v-else name="title" />
        <p v-if="description" class="ui-section__description">{{ description }}</p>
        <slot v-else name="description" />
      </div>
      <div v-if="$slots.action" class="ui-section__action">
        <slot name="action" />
      </div>
    </header>
    <div class="ui-section__content">
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
    spacing?: "sm" | "md" | "lg";
  }>(),
  {
    title: "",
    description: "",
    spacing: "md",
  }
);

const slots = useSlots();
const hasHeader = computed(() => Boolean(props.title) || Boolean(props.description) || Boolean(slots.title) || Boolean(slots.description) || Boolean(slots.action));
const sectionClass = computed(() => ["ui-section", `ui-section--${props.spacing}`]);
</script>

<style scoped>
.ui-section {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.ui-section--sm {
  gap: var(--space-2);
}

.ui-section--md {
  gap: var(--space-3);
}

.ui-section--lg {
  gap: var(--space-4);
}

.ui-section__header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.ui-section__title-block {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.ui-section__title {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 700;
  line-height: 1.3;
}

.ui-section__description {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.ui-section__action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
}

.ui-section__content {
  min-width: 0;
}
</style>
