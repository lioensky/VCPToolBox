<template>
  <div :class="fieldClass" :data-invalid="invalid || undefined">
    <div v-if="hasLabelRow" class="ui-field__label-row">
      <label v-if="label" class="ui-field__label" :for="forId">
        {{ label }}
        <span v-if="required" class="ui-field__required" aria-hidden="true">*</span>
      </label>
      <slot v-else name="label" />
      <div v-if="$slots.action" class="ui-field__action">
        <slot name="action" />
      </div>
    </div>

    <slot />

    <p v-if="description && !error" class="ui-field__description">{{ description }}</p>
    <slot v-else-if="!error" name="description" />
    <p v-if="error" class="ui-field__error" role="alert">{{ error }}</p>
    <slot v-else name="error" />
  </div>
</template>

<script setup lang="ts">
import { computed, useSlots } from "vue";

const props = withDefaults(
  defineProps<{
    label?: string;
    description?: string;
    error?: string;
    forId?: string;
    required?: boolean;
    invalid?: boolean;
    orientation?: "vertical" | "horizontal";
    size?: "md" | "sm";
  }>(),
  {
    label: "",
    description: "",
    error: "",
    forId: undefined,
    required: false,
    invalid: false,
    orientation: "vertical",
    size: "md",
  }
);

const slots = useSlots();

const hasLabelRow = computed(() => Boolean(props.label) || Boolean(slots.label) || Boolean(slots.action));

const fieldClass = computed(() => [
  "ui-field",
  `ui-field--${props.orientation}`,
  `ui-field--${props.size}`,
  {
    "ui-field--invalid": props.invalid || Boolean(props.error),
  },
]);
</script>

<style scoped>
.ui-field {
  display: flex;
  min-width: 0;
  gap: var(--space-2);
  color: var(--primary-text);
}

.ui-field--vertical {
  flex-direction: column;
}

.ui-field--horizontal {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.ui-field--sm {
  gap: 6px;
}

.ui-field__label-row {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.ui-field__label {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-weight: 600;
  line-height: 1.25;
}

.ui-field__required,
.ui-field__error {
  color: var(--danger-color);
}

.ui-field__action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
}

.ui-field__description,
.ui-field__error {
  margin: 0;
  font-size: var(--font-size-helper);
  line-height: 1.45;
}

.ui-field__description {
  color: var(--secondary-text);
}

.ui-field--horizontal .ui-field__label-row {
  flex: 1 1 45%;
  justify-content: flex-start;
}

.ui-field--horizontal :deep(.ui-input),
.ui-field--horizontal :deep(.ui-select),
.ui-field--horizontal :deep(.ui-textarea) {
  flex: 1 1 auto;
}
</style>
