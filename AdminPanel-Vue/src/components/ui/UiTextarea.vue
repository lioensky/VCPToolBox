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

function focus(options?: FocusOptions): void {
  textareaRef.value?.focus(options);
}

function setSelectionRange(start: number, end: number): void {
  textareaRef.value?.setSelectionRange(start, end);
}

function getSelectionRange(): { start: number; end: number } {
  return {
    start: textareaRef.value?.selectionStart ?? 0,
    end: textareaRef.value?.selectionEnd ?? 0,
  };
}

function getScrollPosition(): { top: number; left: number } {
  return {
    top: textareaRef.value?.scrollTop ?? 0,
    left: textareaRef.value?.scrollLeft ?? 0,
  };
}

function setScrollPosition(position: { top: number; left: number }): void {
  if (!textareaRef.value) return;
  textareaRef.value.scrollTop = position.top;
  textareaRef.value.scrollLeft = position.left;
}

defineExpose({
  focus,
  getScrollPosition,
  getSelectionRange,
  setScrollPosition,
  setSelectionRange,
});
</script>

<style scoped>
.ui-textarea {
  display: block;
  width: 100%;
  min-width: 0;
  max-height: 384px;
  overflow-y: auto;
  border: 1px solid color-mix(in srgb, var(--border-color) 92%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-bg) 42%, transparent);
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
  border-color: color-mix(in srgb, var(--highlight-text) 34%, var(--border-color));
  background: color-mix(in srgb, var(--primary-text) 2.5%, transparent);
}

.ui-textarea:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
  border-color: var(--highlight-text);
  background: color-mix(in srgb, var(--primary-bg) 56%, transparent);
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
