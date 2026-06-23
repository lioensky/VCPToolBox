<template>
  <div class="top-bar-search">
    <span class="material-symbols-outlined search-icon" aria-hidden="true">search</span>
    <input
      ref="searchInputRef"
      type="search"
      :value="modelValue"
      placeholder="筛选侧栏入口..."
      aria-label="筛选侧栏入口"
      autocomplete="off"
      @input="onInput"
      @keydown.ctrl.k.prevent="emit('openCommandPalette')"
      @keydown.meta.k.prevent="emit('openCommandPalette')"
    />
    <button
      type="button"
      class="search-shortcut"
      title="打开全局跳转"
      @click="emit('openCommandPalette')"
    >
      Ctrl+K
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "openCommandPalette"): void;
}>();

const searchInputRef = ref<HTMLInputElement | null>(null);

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit("update:modelValue", value);
}

function focusInput() {
  searchInputRef.value?.focus();
}

defineExpose({
  focusInput,
});
</script>

<style scoped>
.top-bar-search {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 360px;
}

.search-icon {
  position: absolute;
  left: 12px;
  color: var(--secondary-text);
  font-size: var(--font-size-emphasis);
  pointer-events: none;
}

.top-bar-search input {
  width: 100%;
  padding: 8px 74px 8px 40px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background-color: var(--input-bg);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    background-color var(--transition-fast);
}

.top-bar-search input::placeholder {
  color: var(--secondary-text);
}

.top-bar-search input:focus-visible {
  outline: none;
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.top-bar-search input:focus:not(:focus-visible) {
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.search-shortcut {
  position: absolute;
  right: 6px;
  padding: 3px 7px;
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  background: var(--accent-bg);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.search-shortcut:hover {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--button-bg) 24%, transparent);
}

@media (max-width: 768px) {
  .top-bar-search {
    display: none;
  }
}
</style>
