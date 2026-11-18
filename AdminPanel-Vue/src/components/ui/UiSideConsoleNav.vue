<template>
  <nav class="ui-side-console-nav" v-bind="$attrs">
    <div v-if="label" class="ui-side-console-nav__category">{{ label }}</div>

    <div
      v-for="item in items"
      :key="item.id"
      class="ui-side-console-nav__group"
      :class="{ 'is-open': isOpen(item) }"
    >
      <div
        :class="[
          'ui-side-console-nav__group-row',
          { 'is-active': item.active },
        ]"
      >
        <button
          type="button"
          class="ui-side-console-nav__group-trigger"
          :title="item.title || item.label"
          @click="emit('itemClick', item)"
        >
          <span>{{ item.label }}</span>
        </button>
        <small v-if="item.meta">{{ item.meta }}</small>
        <button
          type="button"
          class="ui-side-console-nav__expand-btn"
          :class="{
            'is-open': isOpen(item),
            'is-placeholder': !hasChildren(item),
          }"
          :aria-label="hasChildren(item)
            ? (isOpen(item) ? '收起子设置项' : '展开子设置项')
            : '跳转到该分组'"
          @click.stop="handleToggle(item)"
        >
          <span class="material-symbols-outlined">chevron_right</span>
        </button>
      </div>

      <div
        v-if="isOpen(item) && hasChildren(item)"
        class="ui-side-console-nav__sub-list"
      >
        <button
          v-for="child in item.children"
          :key="child.id"
          type="button"
          :class="[
            'ui-side-console-nav__sub-btn',
            { 'is-active': child.active },
          ]"
          :title="child.title || child.label"
          @click="emit('childClick', item, child)"
        >
          <span>{{ child.label }}</span>
          <small v-if="child.meta">{{ child.meta }}</small>
        </button>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
defineOptions({ inheritAttrs: false });

export interface UiSideConsoleNavChild {
  id: string;
  label: string;
  title?: string;
  meta?: string;
  active?: boolean;
}

export interface UiSideConsoleNavItem {
  id: string;
  label: string;
  title?: string;
  meta?: string;
  active?: boolean;
  children?: UiSideConsoleNavChild[];
}

const props = withDefaults(
  defineProps<{
    label?: string;
    items: UiSideConsoleNavItem[];
    openIds?: string[];
  }>(),
  {
    label: "操作台",
    openIds: () => [],
  }
);

const emit = defineEmits<{
  itemClick: [item: UiSideConsoleNavItem];
  childClick: [item: UiSideConsoleNavItem, child: UiSideConsoleNavChild];
  toggle: [item: UiSideConsoleNavItem];
}>();

function hasChildren(item: UiSideConsoleNavItem): boolean {
  return Array.isArray(item.children) && item.children.length > 0;
}

function isOpen(item: UiSideConsoleNavItem): boolean {
  return props.openIds.includes(item.id);
}

function handleToggle(item: UiSideConsoleNavItem): void {
  if (!hasChildren(item)) {
    emit("itemClick", item);
    return;
  }

  emit("toggle", item);
}
</script>

<style scoped>
.ui-side-console-nav {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  width: 100%;
  padding: 0 0 8px;
  overflow-y: auto;
  box-sizing: border-box;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--secondary-text) 30%, transparent) transparent;
}

.ui-side-console-nav::-webkit-scrollbar {
  width: 8px;
}

.ui-side-console-nav::-webkit-scrollbar-track {
  background: transparent;
}

.ui-side-console-nav::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: var(--radius-full);
  background-color: color-mix(in srgb, var(--secondary-text) 30%, transparent);
  background-clip: padding-box;
}

.ui-side-console-nav::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--secondary-text) 50%, transparent);
}

.ui-side-console-nav__category {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  color: color-mix(in srgb, var(--secondary-text) 72%, transparent);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.25;
  overflow: hidden;
  text-transform: uppercase;
  white-space: nowrap;
}

.ui-side-console-nav__group {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.ui-side-console-nav__sub-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0 0 var(--space-1) 14px;
  padding-left: 10px;
  border-left: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
}

.ui-side-console-nav__group-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 4px 0 8px;
  border-radius: var(--radius-md);
  color: var(--primary-text);
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
  overflow: hidden;
}

.ui-side-console-nav__group-row:hover,
.ui-side-console-nav__group-row.is-active {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.ui-side-console-nav__group-row.is-active .ui-side-console-nav__group-trigger {
  font-weight: 500;
}

.ui-side-console-nav__group-trigger {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
  line-height: 1.25;
  text-align: left;
  outline: none;
}

.ui-side-console-nav__group-trigger > span,
.ui-side-console-nav__sub-btn > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-side-console-nav__group-row small,
.ui-side-console-nav__sub-btn small {
  color: var(--secondary-text);
  flex-shrink: 0;
  font-size: var(--font-size-caption);
}

.ui-side-console-nav__expand-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--secondary-text);
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.ui-side-console-nav__expand-btn:hover,
.ui-side-console-nav__expand-btn:focus-visible {
  background: color-mix(in srgb, var(--primary-text) 4%, transparent);
  color: var(--primary-text);
  outline: none;
}

.ui-side-console-nav__expand-btn.is-placeholder {
  color: transparent;
}

.ui-side-console-nav__expand-btn.is-placeholder:hover,
.ui-side-console-nav__expand-btn.is-placeholder:focus-visible {
  background: transparent;
  color: transparent;
}

.ui-side-console-nav__expand-btn .material-symbols-outlined {
  font-size: 16px;
  line-height: 1;
  transition: transform 0.2s ease;
}

.ui-side-console-nav__expand-btn.is-open .material-symbols-outlined {
  transform: rotate(90deg);
}

.ui-side-console-nav__sub-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--secondary-text);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1.25;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    font-weight 0.2s ease;
  text-align: left;
  text-decoration: none;
  outline: none;
  overflow: hidden;
}

.ui-side-console-nav__sub-btn:hover,
.ui-side-console-nav__sub-btn.is-active {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.ui-side-console-nav__sub-btn.is-active {
  font-weight: 500;
}

.ui-side-console-nav__sub-btn:focus-visible,
.ui-side-console-nav__group-trigger:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .ui-side-console-nav__group-row,
  .ui-side-console-nav__expand-btn,
  .ui-side-console-nav__expand-btn .material-symbols-outlined,
  .ui-side-console-nav__sub-btn {
    transition: none;
  }
}
</style>
