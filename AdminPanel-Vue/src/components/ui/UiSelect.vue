<template>
  <select
    ref="selectRef"
    v-bind="$attrs"
    :class="selectClass"
    :value="modelValue ?? ''"
    :disabled="disabled"
    :aria-invalid="invalid || undefined"
    @change="handleChange"
  >
    <slot />
  </select>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null;
    size?: "sm" | "md";
    disabled?: boolean;
    invalid?: boolean;
    modelModifiers?: {
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
  change: [event: Event];
}>();

const selectRef = ref<HTMLSelectElement | null>(null);

const selectClass = computed(() => [
  "ui-select",
  `ui-select--${props.size}`,
  {
    "ui-select--invalid": props.invalid,
  },
]);

function handleChange(event: Event): void {
  const target = event.target as HTMLSelectElement;
  let value: string | number = target.value;

  if (props.modelModifiers.number) {
    const numericValue = Number(value);
    value = Number.isNaN(numericValue) ? value : numericValue;
  }

  emit("update:modelValue", value);
  emit("change", event);
}

function focus(): void {
  selectRef.value?.focus();
}

defineExpose({ focus });
</script>

<style scoped>
.ui-select {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--primary-text);
  font: inherit;
  outline: none;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    opacity var(--transition-fast);
}

.ui-select--sm {
  height: 28px;
  padding: 0 28px 0 9px;
  font-size: var(--font-size-helper);
}

.ui-select--md {
  height: 32px;
  padding: 0 30px 0 10px;
  font-size: var(--font-size-helper);
}

.ui-select:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--highlight-text) 42%, var(--border-color));
}

.ui-select:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-color: var(--highlight-text);
}

.ui-select--invalid,
.ui-select[aria-invalid="true"] {
  border-color: var(--danger-color);
}

.ui-select:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .ui-select {
    transition: none;
  }
}
</style>
