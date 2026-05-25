<template>
  <Teleport to="body">
    <Transition name="confirm-dialog-fade">
      <div
        v-if="modelValue"
        class="confirm-dialog-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        @click.self="handleCancel"
      >
        <div class="confirm-dialog-panel" ref="panelEl">
          <h3 class="confirm-dialog-title">{{ title }}</h3>
          <p class="confirm-dialog-message">{{ message }}</p>
          <div class="confirm-dialog-actions">
            <button
              class="btn-secondary"
              type="button"
              @click="handleCancel"
            >
              {{ cancelText || '取消' }}
            </button>
            <button
              :class="danger ? 'btn-danger' : 'btn-primary'"
              type="button"
              ref="confirmBtn"
              @click="handleConfirm"
            >
              {{ confirmText || '确定' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: boolean
  title?: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}>(), {
  title: '确认操作',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  cancel: []
}>()

const confirmBtn = ref<HTMLButtonElement | null>(null)

watch(() => props.modelValue, async (visible) => {
  if (visible) {
    await nextTick()
    confirmBtn.value?.focus()
  }
})

function handleConfirm() {
  emit('confirm')
  emit('update:modelValue', false)
}

function handleCancel() {
  emit('cancel')
  emit('update:modelValue', false)
}
</script>

<style scoped>
.confirm-dialog-overlay {
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

.confirm-dialog-panel {
  background: var(--secondary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 24px;
  min-width: 340px;
  max-width: 480px;
  box-shadow: var(--overlay-panel-shadow);
}

.confirm-dialog-title {
  margin: 0 0 12px;
  font-size: 1.1rem;
}

.confirm-dialog-message {
  margin: 0 0 20px;
  color: var(--secondary-text);
  line-height: 1.5;
}

.confirm-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btn-danger {
  background: var(--danger-color);
  color: var(--on-accent-text);
  border: none;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--font-size-body);
}

.btn-danger:hover {
  filter: brightness(1.1);
}

.confirm-dialog-fade-enter-active,
.confirm-dialog-fade-leave-active {
  transition: opacity var(--transition-fast);
}

.confirm-dialog-fade-enter-from,
.confirm-dialog-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .confirm-dialog-fade-enter-active,
  .confirm-dialog-fade-leave-active {
    transition: none !important;
  }
}
</style>
