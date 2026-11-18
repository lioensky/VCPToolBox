<template>
  <label class="numeric-field">
    <span class="numeric-field__heading">
      <strong>{{ label }}</strong>
      <code>{{ formattedValue }}</code>
    </span>
    <small v-if="description">{{ description }}</small>
    <span class="numeric-field__controls">
      <input
        type="range"
        :value="modelValue"
        :min="min"
        :max="max"
        :step="step"
        :aria-label="`${label} 滑杆`"
        @input="emitValue"
      />
      <UiInput
        :model-value="modelValue"
        type="number"
        :min="min"
        :max="max"
        :step="step"
        :aria-label="`${label} 数值输入`"
        @update:model-value="emitNumericValue"
      />
    </span>
  </label>
</template>

<script setup lang="ts">
import { computed } from "vue";
import UiInput from "@/components/ui/UiInput.vue";

const props = defineProps<{
  label: string;
  description?: string;
  modelValue: number;
  min: number;
  max: number;
  step: number;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: number];
}>();

const formattedValue = computed(() => {
  if (Number.isInteger(props.modelValue)) return String(props.modelValue);
  return props.modelValue.toFixed(props.step < 0.01 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "");
});

function normalize(value: number): number {
  if (!Number.isFinite(value)) return props.modelValue;
  const clamped = Math.min(props.max, Math.max(props.min, value));
  return props.step >= 1 ? Math.round(clamped) : clamped;
}

function emitValue(event: Event): void {
  emit("update:modelValue", normalize(Number((event.target as HTMLInputElement).value)));
}

function emitNumericValue(value: string | number): void {
  emit("update:modelValue", normalize(Number(value)));
}
</script>

<style scoped>
.numeric-field {
  display: grid;
  gap: 7px;
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--border-color) 68%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1.5%, transparent);
}

.numeric-field__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.numeric-field__heading strong {
  font-size: var(--font-size-body);
}

.numeric-field__heading code {
  color: var(--highlight-text);
  font-family: "Consolas", "Monaco", monospace;
}

.numeric-field small {
  min-height: 2.8em;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.4;
}

.numeric-field__controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 86px;
  gap: var(--space-2);
  align-items: center;
}

.numeric-field__controls input[type="range"] {
  width: 100%;
  margin: 0;
  accent-color: var(--highlight-text);
}

.numeric-field__controls :deep(.ui-input) {
  text-align: right;
  font-family: "Consolas", "Monaco", monospace;
}

@media (max-width: 480px) {
  .numeric-field__controls {
    grid-template-columns: 1fr;
  }
}
</style>