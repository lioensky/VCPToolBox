<template>
  <input
    ref="inputRef"
    v-bind="$attrs"
    :class="inputClass"
    :value="modelValue ?? ''"
    :disabled="disabled"
    :aria-invalid="invalid || undefined"
    @input="handleInput"
    @change="emit('change', $event)"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null;
    size?: "sm" | "md" | "lg";
    disabled?: boolean;
    invalid?: boolean;
    modelModifiers?: {
      trim?: boolean;
      number?: boolean;
    };
  }>(),
  {
    modelValue: "",
    size: "md",
    disabled: false,
    invalid: false,
    modelModifiers: () => ({}),
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: string | number];
  input: [event: Event];
  change: [event: Event];
}>();

const inputRef = ref<HTMLInputElement | null>(null);

const inputClass = computed(() => [
  "ui-input",
  `ui-input--${props.size}`,
  {
    "ui-input--invalid": props.invalid,
  },
]);

function handleInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  let value: string | number = target.value;

  if (props.modelModifiers.trim) {
    value = value.trim();
  }

  if (props.modelModifiers.number) {
    const numericValue = Number(value);
    value = Number.isNaN(numericValue) ? value : numericValue;
  }

  emit("update:modelValue", value);
  emit("input", event);
}

function focus(): void {
  inputRef.value?.focus();
}

function select(): void {
  inputRef.value?.select();
}

defineExpose({ focus, select });
</script>

<style scoped>
.ui-input {
  width: 100%;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--border-color) 92%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 42%, transparent);
  color: var(--primary-text);
  font: inherit;
  outline: none;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    opacity var(--transition-fast);
}

.ui-input--sm {
  height: 28px;
  padding: 0 9px;
  font-size: var(--font-size-helper);
}

.ui-input--md {
  height: 32px;
  padding: 0 10px;
  font-size: var(--font-size-helper);
}

.ui-input--lg {
  height: 36px;
  padding: 0 12px;
  font-size: var(--font-size-body);
}

.ui-input::placeholder {
  color: var(--secondary-text);
}

.ui-input:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--highlight-text) 34%, var(--border-color));
  background: color-mix(in srgb, var(--primary-text) 2.5%, transparent);
}

.ui-input:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--primary-bg) 56%, transparent);
}

.ui-input--invalid,
.ui-input[aria-invalid="true"] {
  border-color: var(--danger-color);
}

.ui-input:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .ui-input {
    transition: none;
  }
}
</style>
