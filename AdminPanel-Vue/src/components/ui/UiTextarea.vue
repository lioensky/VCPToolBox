<template>
  <textarea
    ref="textareaRef"
    v-bind="$attrs"
    :class="textareaClass"
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
    size?: "sm" | "md";
    disabled?: boolean;
    invalid?: boolean;
    resize?: "none" | "vertical" | "both";
  }>(),
  {
    modelValue: "",
    size: "md",
    disabled: false,
    invalid: false,
    resize: "vertical",
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  input: [event: Event];
  change: [event: Event];
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);

const textareaClass = computed(() => [
  "ui-textarea",
  `ui-textarea--${props.size}`,
  `ui-textarea--resize-${props.resize}`,
  {
    "ui-textarea--invalid": props.invalid,
  },
]);

function handleInput(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  emit("update:modelValue", value);
  emit("input", event);
}

function focus(): void {
  textareaRef.value?.focus();
}

defineExpose({ focus });
</script>

<style scoped>
.ui-textarea {
  display: block;
  width: 100%;
  min-width: 0;
  max-height: 384px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--primary-text);
  font: inherit;
  line-height: 1.5;
  outline: none;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    opacity var(--transition-fast);
}

.ui-textarea--sm {
  min-height: 64px;
  padding: 8px 10px;
  font-size: var(--font-size-helper);
}

.ui-textarea--md {
  min-height: 86px;
  padding: 10px 12px;
  font-size: var(--font-size-helper);
}

.ui-textarea--resize-none {
  resize: none;
}

.ui-textarea--resize-vertical {
  resize: vertical;
}

.ui-textarea--resize-both {
  resize: both;
}

.ui-textarea::placeholder {
  color: var(--secondary-text);
}

.ui-textarea:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--highlight-text) 42%, var(--border-color));
}

.ui-textarea:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-color: var(--highlight-text);
}

.ui-textarea--invalid,
.ui-textarea[aria-invalid="true"] {
  border-color: var(--danger-color);
}

.ui-textarea:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .ui-textarea {
    transition: none;
  }
}
</style>
