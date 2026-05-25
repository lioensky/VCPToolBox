<template>
  <label
    :class="[
      'app-checkbox',
      {
        'app-checkbox--checked': modelValue,
        'app-checkbox--disabled': disabled,
      },
    ]"
  >
    <input
      :id="inputId"
      :name="name"
      class="app-checkbox__input"
      type="checkbox"
      :aria-label="ariaLabel"
      :checked="modelValue"
      :disabled="disabled"
      @change="handleChange"
    />
    <span
      :class="[
        'app-checkbox__indicator',
        'app-check-indicator',
        { 'app-check-indicator--active': modelValue },
      ]"
      aria-hidden="true"
    >
      {{ modelValue ? '✓' : '' }}
    </span>
    <slot v-if="hasSlot" />
    <span v-else-if="label" class="app-checkbox__label">{{ label }}</span>
  </label>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    label?: string
    disabled?: boolean
    inputId?: string
    name?: string
    ariaLabel?: string
  }>(),
  {
    label: '',
    disabled: false,
    inputId: undefined,
    name: undefined,
    ariaLabel: undefined,
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'change', value: boolean): void
}>()

const slots = useSlots()
const hasSlot = computed(() => Boolean(slots.default))

function handleChange(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  emit('update:modelValue', checked)
  emit('change', checked)
}
</script>

<style scoped>
.app-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  min-width: 0;
  position: relative;
}

.app-checkbox--disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.app-checkbox__input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  border: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  clip-path: inset(50%);
}

.app-checkbox__label {
  min-width: 0;
}

.app-checkbox__indicator {
  flex-shrink: 0;
}

.app-checkbox__input:focus-visible + .app-checkbox__indicator {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.app-checkbox--disabled .app-checkbox__input {
  cursor: not-allowed;
}

.app-checkbox--disabled .app-checkbox__indicator {
  opacity: 0.8;
}
</style>
