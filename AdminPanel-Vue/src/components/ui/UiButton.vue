<template>
  <button
    ref="buttonRef"
    v-bind="$attrs"
    :class="buttonClass"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="ui-button__spinner" aria-hidden="true" />
    <span v-if="$slots.leading" class="ui-button__icon ui-button__icon--leading">
      <slot name="leading" />
    </span>
    <span class="ui-button__content">
      <slot />
    </span>
    <span v-if="$slots.trailing" class="ui-button__icon ui-button__icon--trailing">
      <slot name="trailing" />
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

defineOptions({ inheritAttrs: false });

type UiButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "link";
type UiButtonSize = "xs" | "sm" | "md" | "lg";

const props = withDefaults(
  defineProps<{
    variant?: UiButtonVariant;
    size?: UiButtonSize;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    loading?: boolean;
    block?: boolean;
  }>(),
  {
    variant: "primary",
    size: "md",
    type: "button",
    disabled: false,
    loading: false,
    block: false,
  }
);

const buttonRef = ref<HTMLButtonElement | null>(null);

const buttonClass = computed(() => [
  "ui-button",
  `ui-button--${props.variant}`,
  `ui-button--${props.size}`,
  {
    "ui-button--block": props.block,
    "ui-button--loading": props.loading,
  },
]);

function focus(): void {
  buttonRef.value?.focus();
}

defineExpose({ focus });
</script>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--primary-text);
  font: inherit;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.ui-button--md {
  height: 32px;
  gap: 6px;
  padding: 0 10px;
  font-size: var(--font-size-helper);
}

.ui-button--xs {
  height: 24px;
  gap: 4px;
  padding: 0 8px;
  font-size: var(--font-size-caption);
}

.ui-button--sm {
  height: 28px;
  gap: 5px;
  padding: 0 10px;
  font-size: var(--font-size-helper);
}

.ui-button--lg {
  height: 36px;
  gap: 8px;
  padding: 0 12px;
  font-size: var(--font-size-body);
}

.ui-button--block {
  width: 100%;
}

.ui-button--primary {
  border-color: var(--button-bg);
  background: var(--button-bg);
  color: var(--on-accent-text);
}

.ui-button--primary:hover:not(:disabled) {
  border-color: var(--button-hover-bg);
  background: var(--button-hover-bg);
}

.ui-button--secondary {
  border-color: color-mix(in srgb, var(--highlight-text) 24%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 12%, transparent);
  color: var(--primary-text);
}

.ui-button--secondary:hover:not(:disabled),
.ui-button--outline:hover:not(:disabled),
.ui-button--ghost:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--highlight-text) 42%, var(--border-color));
  background: var(--accent-bg);
  color: var(--primary-text);
}

.ui-button--outline {
  border-color: var(--border-color);
  background: transparent;
  color: var(--primary-text);
}

.ui-button--ghost {
  border-color: transparent;
  background: transparent;
  color: var(--secondary-text);
}

.ui-button--danger {
  border-color: var(--danger-border);
  background: var(--danger-bg);
  color: var(--danger-color);
}

.ui-button--danger:hover:not(:disabled) {
  border-color: var(--danger-color);
  background: var(--danger-color);
  color: var(--on-accent-text);
}

.ui-button--link {
  height: auto;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--highlight-text);
}

.ui-button--link:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.ui-button:active:not(:disabled) {
  transform: translateY(1px);
}

.ui-button:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ui-button__content {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ui-button__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.ui-button__icon :deep(.material-symbols-outlined) {
  font-size: 18px;
  line-height: 1;
}

.ui-button__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--radius-full);
  animation: ui-button-spin 0.8s linear infinite;
}

@keyframes ui-button-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-button {
    transition: none;
  }

  .ui-button:active:not(:disabled) {
    transform: none;
  }

  .ui-button__spinner {
    animation: none;
  }
}
</style>
