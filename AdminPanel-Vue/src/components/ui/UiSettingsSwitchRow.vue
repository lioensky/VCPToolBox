<template>
  <div :class="rowClass" data-settings-span="full">
    <div class="ui-settings-switch-row__content">
      <div class="ui-settings-switch-row__label">{{ label }}</div>
      <p v-if="description" class="ui-settings-switch-row__description">{{ description }}</p>
      <slot name="description" />
    </div>
    <AppSwitch
      :model-value="modelValue"
      :disabled="disabled"
      :input-id="inputId"
      :name="name"
      :aria-label="label"
      @update:model-value="emit('update:modelValue', $event)"
      @change="emit('change', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import AppSwitch from "@/components/ui/AppSwitch.vue";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    label: string;
    description?: string;
    disabled?: boolean;
    inputId?: string;
    name?: string;
    density?: "default" | "compact";
  }>(),
  {
    description: "",
    disabled: false,
    inputId: undefined,
    name: undefined,
    density: "default",
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  change: [value: boolean];
}>();

const rowClass = computed(() => [
  "ui-settings-switch-row",
  `ui-settings-switch-row--${props.density}`,
  {
    "ui-settings-switch-row--disabled": props.disabled,
  },
]);
</script>

<style scoped>
.ui-settings-switch-row {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.ui-settings-switch-row--default {
  padding: 10px 0;
}

.ui-settings-switch-row--compact {
  padding: 8px 0;
}

.ui-settings-switch-row--disabled {
  opacity: 0.6;
}

.ui-settings-switch-row__content {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.ui-settings-switch-row__label {
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
  line-height: 1.3;
}

.ui-settings-switch-row__description {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.45;
}
</style>
