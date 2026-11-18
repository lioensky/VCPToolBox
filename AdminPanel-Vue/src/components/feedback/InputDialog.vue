<template>
  <Teleport to="body">
    <Transition name="input-dialog-fade">
      <div
        v-if="modelValue"
        class="input-dialog-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        @click.self="handleCancel"
        @keydown.esc="handleCancel"
      >
        <div class="input-dialog-panel">
          <h3 class="input-dialog-title">{{ title }}</h3>
          <p v-if="message" class="input-dialog-message">{{ message }}</p>

          <UiTextarea
            v-if="multiline"
            ref="inputEl"
            class="input-dialog-control"
            :model-value="modelInputValue"
            :placeholder="placeholder"
            rows="6"
            @update:model-value="onInput(String($event))"
            @keydown.ctrl.enter.prevent="handleConfirm"
            @keydown.meta.enter.prevent="handleConfirm"
          />
          <UiInput
            v-else
            ref="inputEl"
            class="input-dialog-control"
            type="text"
            :model-value="modelInputValue"
            :placeholder="placeholder"
            @update:model-value="onInput(String($event))"
            @keydown.enter.prevent="handleConfirm"
          />

          <p v-if="error" class="input-dialog-error">{{ error }}</p>

          <div class="input-dialog-actions">
            <UiButton
              variant="secondary"
              type="button"
              @click="handleCancel"
            >
              {{ cancelText || "取消" }}
            </UiButton>
            <UiButton
              variant="primary"
              type="button"
              @click="handleConfirm"
            >
              {{ confirmText || "确定" }}
            </UiButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiTextarea from "@/components/ui/UiTextarea.vue";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    message?: string;
    placeholder?: string;
    inputValue: string;
    confirmText?: string;
    cancelText?: string;
    multiline?: boolean;
    error?: string;
  }>(),
  {
    title: "请输入",
    message: "",
    placeholder: "",
    confirmText: "确定",
    cancelText: "取消",
    multiline: false,
    error: "",
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  "update:inputValue": [value: string];
  confirm: [];
  cancel: [];
}>();

const inputEl = ref<InstanceType<typeof UiInput> | InstanceType<typeof UiTextarea> | null>(null);
const modelInputValue = ref(props.inputValue);

watch(
  () => props.inputValue,
  (next) => {
    modelInputValue.value = next;
  }
);

watch(
  () => props.modelValue,
  async (visible) => {
    if (visible) {
      await nextTick();
      inputEl.value?.focus();
      inputEl.value && "select" in inputEl.value && inputEl.value.select();
    }
  }
);

function onInput(value: string): void {
  modelInputValue.value = value;
  emit("update:inputValue", value);
}

function handleConfirm(): void {
  emit("confirm");
}

function handleCancel(): void {
  emit("cancel");
  emit("update:modelValue", false);
}
</script>

<style scoped>
.input-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-index-modal) + 1);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-backdrop-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.input-dialog-panel {
  background: color-mix(in srgb, var(--primary-bg) 84%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
  border-radius: var(--radius-lg);
  padding: 24px;
  min-width: 360px;
  max-width: 520px;
  width: min(90vw, 520px);
  box-shadow: var(--overlay-panel-shadow);
}

.input-dialog-title {
  margin: 0 0 10px;
  font-size: 1.1rem;
  color: var(--primary-text);
}

.input-dialog-message {
  margin: 0 0 14px;
  color: var(--secondary-text);
  line-height: 1.5;
  font-size: var(--font-size-body);
}

.input-dialog-control :deep(.ui-textarea),
.input-dialog-control.ui-textarea {
  min-height: 120px;
}

.input-dialog-error {
  margin: 8px 0 0;
  color: var(--danger-color);
  font-size: var(--font-size-helper);
}

.input-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.input-dialog-fade-enter-active,
.input-dialog-fade-leave-active {
  transition: opacity var(--transition-fast);
}

.input-dialog-fade-enter-from,
.input-dialog-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .input-dialog-fade-enter-active,
  .input-dialog-fade-leave-active {
    transition: none !important;
  }
}
</style>
