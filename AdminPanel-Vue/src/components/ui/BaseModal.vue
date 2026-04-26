<template>
  <Teleport :to="teleportTo">
    <Transition :name="transitionName">
      <slot
        v-if="modelValue"
        :overlay-attrs="overlayAttrs"
        :panel-attrs="panelAttrs"
        :panel-ref="setPanelRef"
      />
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import type { ComponentPublicInstance } from "vue";

type ModalRole = "dialog" | "alertdialog";
type ModalCloseReason = "backdrop" | "escape";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    teleportTo?: string;
    transitionName?: string;
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    trapFocus?: boolean;
    lockScroll?: boolean;
    role?: ModalRole;
    ariaLabel?: string;
    ariaLabelledby?: string;
  }>(),
  {
    teleportTo: "body",
    transitionName: "base-modal-fade",
    closeOnBackdrop: true,
    closeOnEscape: true,
    trapFocus: true,
    lockScroll: true,
    role: "dialog",
    ariaLabel: undefined,
    ariaLabelledby: undefined,
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  close: [reason: ModalCloseReason];
}>();

const panelEl = ref<HTMLElement | null>(null);
let previousActiveElement: HTMLElement | null = null;
let previousBodyOverflow = "";
let bodyScrollLocked = false;

function setPanelRef(el: Element | ComponentPublicInstance | null): void {
  panelEl.value = el instanceof HTMLElement ? el : null;
}

const overlayAttrs = computed(() => ({
  class: "base-modal-overlay",
  role: props.role,
  "aria-modal": true,
  "aria-label": props.ariaLabel,
  "aria-labelledby": props.ariaLabelledby,
  onClick: handleBackdropClick,
  onKeydown: handleKeydown,
}));

const panelAttrs = computed(() => ({
  tabindex: -1,
}));

function getFocusableElements(): HTMLElement[] {
  if (!panelEl.value) {
    return [];
  }

  const selector = [
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  return Array.from(panelEl.value.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hasAttribute("disabled")
  );
}

function focusInitialElement(): void {
  const focusables = getFocusableElements();
  if (focusables.length > 0) {
    focusables[0].focus();
    return;
  }

  panelEl.value?.focus();
}

function lockBodyScroll(): void {
  if (!props.lockScroll || bodyScrollLocked || typeof document === "undefined") {
    return;
  }

  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  bodyScrollLocked = true;
}

function unlockBodyScroll(): void {
  if (!props.lockScroll || !bodyScrollLocked || typeof document === "undefined") {
    return;
  }

  document.body.style.overflow = previousBodyOverflow;
  bodyScrollLocked = false;
}

function closeModal(reason: ModalCloseReason): void {
  emit("update:modelValue", false);
  emit("close", reason);
}

function handleBackdropClick(event: MouseEvent): void {
  if (event.target !== event.currentTarget) {
    return;
  }

  if (!props.closeOnBackdrop) {
    return;
  }

  closeModal("backdrop");
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.closeOnEscape) {
    event.preventDefault();
    closeModal("escape");
    return;
  }

  if (event.key !== "Tab" || !props.trapFocus) {
    return;
  }

  const focusableElements = getFocusableElements();
  if (focusableElements.length === 0) {
    event.preventDefault();
    panelEl.value?.focus();
    return;
  }

  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];
  const activeElement = document.activeElement as HTMLElement | null;
  const isInsidePanel = Boolean(activeElement && panelEl.value?.contains(activeElement));

  if (event.shiftKey) {
    if (!isInsidePanel || activeElement === firstFocusable) {
      event.preventDefault();
      lastFocusable.focus();
    }
    return;
  }

  if (!isInsidePanel || activeElement === lastFocusable) {
    event.preventDefault();
    firstFocusable.focus();
  }
}

watch(
  () => props.modelValue,
  async (visible) => {
    if (visible) {
      previousActiveElement =
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      lockBodyScroll();
      await nextTick();
      focusInitialElement();
      return;
    }

    unlockBodyScroll();

    if (previousActiveElement) {
      previousActiveElement.focus();
      previousActiveElement = null;
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  unlockBodyScroll();
});
</script>

<style>
.base-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-index-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-backdrop-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  overscroll-behavior: contain;
}

.base-modal-fade-enter-active,
.base-modal-fade-leave-active {
  transition: opacity var(--transition-fast);
}

.base-modal-fade-enter-from,
.base-modal-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .base-modal-fade-enter-active,
  .base-modal-fade-leave-active {
    transition: none !important;
  }
}
</style>
