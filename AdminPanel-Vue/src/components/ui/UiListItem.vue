<template>
  <button
    v-if="clickable"
    v-bind="$attrs"
    :class="itemClass"
    type="button"
    role="listitem"
    :aria-current="active ? 'true' : undefined"
  >
    <span v-if="$slots.leading" class="ui-list-item__leading">
      <slot name="leading" />
    </span>
    <span class="ui-list-item__body">
      <span class="ui-list-item__title">{{ title }}</span>
      <span v-if="description" class="ui-list-item__description">{{ description }}</span>
      <slot name="description" />
    </span>
    <span v-if="$slots.trailing" class="ui-list-item__trailing">
      <slot name="trailing" />
    </span>
  </button>

  <div v-else v-bind="$attrs" :class="itemClass" role="listitem">
    <span v-if="$slots.leading" class="ui-list-item__leading">
      <slot name="leading" />
    </span>
    <span class="ui-list-item__body">
      <span class="ui-list-item__title">{{ title }}</span>
      <span v-if="description" class="ui-list-item__description">{{ description }}</span>
      <slot name="description" />
    </span>
    <span v-if="$slots.trailing" class="ui-list-item__trailing">
      <slot name="trailing" />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    active?: boolean;
    clickable?: boolean;
    density?: "default" | "compact";
  }>(),
  {
    description: "",
    active: false,
    clickable: true,
    density: "default",
  }
);

const itemClass = computed(() => [
  "ui-list-item",
  `ui-list-item--${props.density}`,
  {
    "ui-list-item--active": props.active,
    "ui-list-item--clickable": props.clickable,
  },
]);
</script>

<style scoped>
.ui-list-item {
  width: 100%;
  display: flex;
  min-width: 0;
  align-items: center;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--input-bg);
  color: var(--primary-text);
  text-align: left;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.ui-list-item--default {
  min-height: 48px;
  gap: var(--space-3);
  padding: var(--space-3);
}

.ui-list-item--compact {
  min-height: 40px;
  gap: var(--space-2);
  padding: 8px 10px;
}

.ui-list-item--clickable {
  cursor: pointer;
}

.ui-list-item--clickable:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 36%, var(--border-color));
  background: var(--accent-bg);
}

.ui-list-item--active {
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--highlight-text) 14%, var(--input-bg));
}

.ui-list-item:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.ui-list-item__leading,
.ui-list-item__trailing {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
}

.ui-list-item__body {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: 3px;
}

.ui-list-item__title,
.ui-list-item__description {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ui-list-item__title {
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 700;
  line-height: 1.25;
}

.ui-list-item__description {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.35;
}

@media (prefers-reduced-motion: reduce) {
  .ui-list-item {
    transition: none;
  }
}
</style>
