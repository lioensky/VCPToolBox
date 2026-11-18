<template>
  <button
    :type="type"
    class="ui-icon-button"
    :class="[`ui-icon-button--${size}`, { 'ui-icon-button--active': active }]"
    :disabled="disabled"
    :aria-label="label"
    :title="title"
    :aria-expanded="ariaExpanded"
    :aria-haspopup="ariaHaspopup"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    title?: string;
    disabled?: boolean;
    size?: "sm" | "md";
    type?: "button" | "submit" | "reset";
    active?: boolean;
    ariaExpanded?: boolean;
    ariaHaspopup?: "true" | "false" | "menu" | "dialog" | "listbox";
  }>(),
  {
    title: undefined,
    disabled: false,
    size: "md",
    type: "button",
    active: false,
    ariaExpanded: undefined,
    ariaHaspopup: undefined,
  }
);
</script>

<style scoped>
.ui-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--secondary-text);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.ui-icon-button--md {
  width: 32px;
  height: 32px;
  font-size: var(--font-size-body);
}

.ui-icon-button--sm {
  width: 28px;
  height: 28px;
  font-size: var(--font-size-helper);
}

.ui-icon-button:hover {
  color: var(--primary-text);
  background: var(--accent-bg);
}

.ui-icon-button--active {
  color: var(--primary-text);
  background: var(--accent-bg);
}

.ui-icon-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ui-icon-button:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .ui-icon-button--md {
    width: 44px;
    height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-icon-button {
    transition: none;
  }
}
</style>
