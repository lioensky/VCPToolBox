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
      v-if="modelValue"
      type="button"
      class="search-clear"
      aria-label="清空筛选"
      @click="emit('update:modelValue', '')"
    >
      <span class="material-symbols-outlined" aria-hidden="true">close</span>
    </button>
    <button
      v-else
      type="button"
      class="search-shortcut"
      title="打开全局跳转"
      @click="emit('openCommandPalette')"
    >
      <span>Ctrl</span>
      <span>K</span>
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
  height: 32px;
  color: var(--primary-text);
  border-radius: var(--radius-md);
  background: transparent;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.top-bar-search:hover,
.top-bar-search:focus-within {
  background-color: var(--accent-bg);
}

.search-icon {
  position: absolute;
  left: 8px;
  color: var(--primary-text);
  font-size: 16px;
  line-height: 1;
  pointer-events: none;
  transition: color 0.2s ease;
}

.top-bar-search input {
  width: 100%;
  height: 32px;
  padding: 0 56px 0 32px;
  border: 0;
  border-radius: var(--radius-md);
  background-color: transparent;
  color: var(--primary-text);
  font-size: 0.875rem;
  line-height: 32px;
  outline: none;
}

.top-bar-search input::placeholder {
  color: var(--primary-text);
  opacity: 1;
}

.top-bar-search input:focus-visible {
  outline: none;
}

.top-bar-search:has(input:focus-visible) {
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.search-shortcut {
  position: absolute;
  right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 20px;
  padding: 0 4px;
  font-size: 0.6875rem;
  line-height: 1;
  color: var(--primary-text);
  background: color-mix(in srgb, var(--primary-text) 8%, transparent);
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: var(--font-mono, ui-monospace, monospace);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast),
    opacity var(--transition-fast);
}

.search-shortcut:hover {
  color: var(--primary-text);
  background-color: color-mix(in srgb, var(--primary-text) 14%, transparent);
}

.search-clear {
  position: absolute;
  right: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--secondary-text);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.search-clear .material-symbols-outlined {
  font-size: 16px;
  line-height: 1;
}

.search-clear:hover {
  color: var(--primary-text);
  background: var(--accent-bg);
}
</style>
