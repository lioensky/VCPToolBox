<template>
  <label
    :class="[
      'app-switch',
      'switch-row',
      'switch-toggle',
      { 'app-switch--disabled': disabled },
    ]"
  >
    <input
      :id="inputId"
      :name="name"
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="handleChange"
    />
    <span v-if="hasLabel"><slot>{{ label }}</slot></span>
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
  }>(),
  {
    label: '',
    disabled: false,
    inputId: undefined,
    name: undefined,
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'change', value: boolean): void
}>()

const slots = useSlots()
const hasLabel = computed(() => Boolean(props.label) || Boolean(slots.default))

function handleChange(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  emit('update:modelValue', checked)
  emit('change', checked)
}
</script>

<style scoped>
.app-switch--disabled {
  opacity: 0.6;
}

.app-switch--disabled input[type='checkbox'] {
  cursor: not-allowed;
}
</style>
