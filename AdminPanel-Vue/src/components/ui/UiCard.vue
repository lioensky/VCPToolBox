<template>
  <section :class="cardClass">
    <header v-if="hasHeader" :class="headerClass">
      <div class="ui-card__heading">
        <slot name="icon" />
        <div class="ui-card__title-group">
          <h3 v-if="title" class="ui-card__title">{{ title }}</h3>
          <slot v-else name="title" />
          <p v-if="description" class="ui-card__description">{{ description }}</p>
          <slot v-else name="description" />
        </div>
      </div>
      <div v-if="$slots.action" class="ui-card__action">
        <slot name="action" />
      </div>
    </header>

    <div class="ui-card__content">
      <slot />
    </div>

    <footer v-if="$slots.footer" class="ui-card__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, useSlots } from "vue";

const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    size?: "sm" | "md";
    variant?: "default" | "subtle" | "flat";
    divided?: boolean;
  }>(),
  {
    title: "",
    description: "",
    size: "md",
    variant: "default",
    divided: false,
  }
);

const slots = useSlots();

const hasHeader = computed(
  () =>
    Boolean(props.title) ||
    Boolean(props.description) ||
    Boolean(slots.title) ||
    Boolean(slots.description) ||
    Boolean(slots.icon) ||
    Boolean(slots.action)
);

const cardClass = computed(() => [
  "ui-card",
  `ui-card--${props.size}`,
  `ui-card--${props.variant}`,
  {
    "ui-card--divided": props.divided,
  },
]);

const headerClass = computed(() => [
  "ui-card__header",
  {
    "ui-card__header--with-description": Boolean(props.description) || Boolean(slots.description),
  },
]);
</script>

<style scoped>
.ui-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  color: var(--primary-text);
}

.ui-card--md {
  gap: var(--space-4);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
}

.ui-card--sm {
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
}

.ui-card--default {
  border: 1px solid var(--border-color);
  background:
    linear-gradient(135deg, var(--surface-overlay-soft), transparent),
    var(--secondary-bg);
}

.ui-card--subtle {
  border: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
  background: var(--tertiary-bg);
}

.ui-card--flat {
  border: 1px solid transparent;
  background: transparent;
}

.ui-card__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: center;
}

.ui-card__header--with-description {
  align-items: flex-start;
}

.ui-card--divided .ui-card__header {
  margin-bottom: calc(var(--space-2) * -1);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-color);
}

.ui-card__heading {
  display: flex;
  min-width: 0;
  gap: var(--space-2);
  align-items: flex-start;
}

.ui-card__title-group {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.ui-card__title {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-body);
  font-weight: 700;
  line-height: 1.25;
}

.ui-card__description {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.ui-card__action {
  justify-self: end;
}

.ui-card__content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--space-4);
}

.ui-card--sm .ui-card__content {
  gap: var(--space-3);
}

.ui-card__footer {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin: 0 calc(var(--space-4) * -1) calc(var(--space-4) * -1);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--primary-text) 4%, transparent);
}

.ui-card--sm .ui-card__footer {
  margin: 0 calc(var(--space-3) * -1) calc(var(--space-3) * -1);
  padding: var(--space-2) var(--space-3);
}
</style>
