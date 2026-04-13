<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="全局跳转"
      @click="emit('close')"
    >
      <div class="command-panel" @click.stop>
        <header class="command-header">
          <div>
            <p class="command-eyebrow">Global Jump</p>
            <h2>页面、插件、最近访问都在这里</h2>
          </div>
          <button
            type="button"
            class="command-close"
            aria-label="关闭全局跳转"
            @click="emit('close')"
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>

        <label class="command-search">
          <span class="material-symbols-outlined">search</span>
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="search"
            placeholder="搜索页面、插件、最近访问..."
            aria-label="搜索页面、插件、最近访问"
            aria-controls="global-command-results"
            :aria-activedescendant="activeDescendantId"
            autocomplete="off"
            @keydown="handleInputKeydown"
          />
        </label>

        <div class="command-hints">
          <span>↑ ↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>

        <section
          v-if="resultSections.length === 0"
          class="command-empty"
          aria-live="polite"
        >
          <span class="material-symbols-outlined">travel_explore</span>
          <h3>没有匹配的结果</h3>
          <p>换个关键词试试，或者直接打开插件中心继续找。</p>
        </section>

        <div v-else id="global-command-results" class="command-results" role="listbox">
          <section
            v-for="section in indexedSections"
            :key="section.id"
            class="command-section"
          >
            <header class="command-section-header">
              <span>{{ section.title }}</span>
              <span>{{ section.items.length }}</span>
            </header>

            <button
              v-for="item in section.items"
              :id="getOptionId(item.index)"
              :key="item.id"
              type="button"
              class="command-item"
              :class="{ active: item.index === activeIndex }"
              role="option"
              :aria-selected="item.index === activeIndex"
              :data-command-index="item.index"
              @mouseenter="activeIndex = item.index"
              @click="runEntry(item)"
            >
              <span class="command-item-icon material-symbols-outlined">
                {{ item.icon }}
              </span>

              <span class="command-item-copy">
                <span class="command-item-topline">
                  <strong>{{ item.label }}</strong>
                  <span class="command-kind">
                    {{ kindLabelMap[item.kind] }}
                  </span>
                </span>
                <span class="command-item-subtitle">{{ item.subtitle }}</span>
              </span>

              <span class="command-item-badges">
                <span
                  v-for="badge in item.badges.slice(0, 2)"
                  :key="`${item.id}-${badge}`"
                  class="command-badge"
                >
                  {{ badge }}
                </span>
              </span>
            </button>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import type { NavItem } from "@/stores/app";
import type { PluginInfo } from "@/types/api.plugin";
import type { CommandPaletteEntryKind } from "@/utils/commandPalette";
import {
  buildCommandPaletteIndex,
  buildCommandPaletteSectionsFromIndex,
} from "@/utils/commandPalette";
import type {
  NavigationUsageMap,
  RecentVisit,
} from "@/composables/useRecentVisits";

interface Props {
  isOpen: boolean;
  navItems: readonly NavItem[];
  plugins: readonly PluginInfo[];
  recentVisits: readonly RecentVisit[];
  navigationUsage: Readonly<NavigationUsageMap>;
  pinnedPluginNames: readonly string[];
}

interface IndexedCommandItem {
  id: string;
  kind: CommandPaletteEntryKind;
  label: string;
  subtitle: string;
  icon: string;
  target: string;
  pluginName?: string;
  badges: string[];
  index: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "navigateTo", target: string, pluginName?: string): void;
}>();

const kindLabelMap: Record<CommandPaletteEntryKind, string> = {
  recent: "最近",
  page: "页面",
  plugin: "插件",
};

const searchInputRef = ref<HTMLInputElement | null>(null);
const searchQuery = ref("");
const activeIndex = ref(0);
let previousFocusedElement: HTMLElement | null = null;

const paletteIndex = computed(() => {
  if (!props.isOpen) {
    return null;
  }

  return buildCommandPaletteIndex({
    navItems: props.navItems,
    plugins: props.plugins,
    recentVisits: props.recentVisits,
    navigationUsage: props.navigationUsage,
    pinnedPluginNames: props.pinnedPluginNames,
  });
});

const resultSections = computed(() => {
  if (!props.isOpen || !paletteIndex.value) {
    return [];
  }

  return buildCommandPaletteSectionsFromIndex(paletteIndex.value, {
    query: searchQuery.value,
  });
});

const indexedSections = computed(() => {
  let index = 0;

  return resultSections.value.map((section) => ({
    ...section,
    items: section.items.map<IndexedCommandItem>((item) => ({
      ...item,
      index: index++,
    })),
  }));
});

const flatResults = computed(() =>
  indexedSections.value.flatMap((section) => section.items)
);

const activeDescendantId = computed(() =>
  flatResults.value[activeIndex.value]
    ? getOptionId(activeIndex.value)
    : undefined
);

function getOptionId(index: number): string {
  return `command-palette-option-${index}`;
}

function scrollActiveItemIntoView() {
  nextTick(() => {
    const activeItem = document.querySelector<HTMLElement>(
      `[data-command-index="${activeIndex.value}"]`
    );
    activeItem?.scrollIntoView({ block: "nearest" });
  });
}

function moveSelection(delta: number) {
  if (flatResults.value.length === 0) {
    activeIndex.value = -1;
    return;
  }

  if (activeIndex.value < 0) {
    activeIndex.value = 0;
    scrollActiveItemIntoView();
    return;
  }

  const nextIndex =
    (activeIndex.value + delta + flatResults.value.length) %
    flatResults.value.length;

  activeIndex.value = nextIndex;
  scrollActiveItemIntoView();
}

function runEntry(item: { target: string; pluginName?: string }) {
  emit("navigateTo", item.target, item.pluginName);
  emit("close");
}

function handleInputKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveSelection(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      moveSelection(-1);
      break;
    case "Home":
      event.preventDefault();
      activeIndex.value = flatResults.value.length > 0 ? 0 : -1;
      scrollActiveItemIntoView();
      break;
    case "End":
      event.preventDefault();
      activeIndex.value = flatResults.value.length - 1;
      scrollActiveItemIntoView();
      break;
    case "Enter": {
      const activeItem = flatResults.value[activeIndex.value];
      if (!activeItem) {
        return;
      }
      event.preventDefault();
      runEntry(activeItem);
      break;
    }
    case "Escape":
      event.preventDefault();
      emit("close");
      break;
    default:
      break;
  }
}

watch(
  () => props.isOpen,
  async (isOpen) => {
    if (isOpen) {
      previousFocusedElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      searchQuery.value = "";
      activeIndex.value = 0;
      await nextTick();
      searchInputRef.value?.focus();
      return;
    }

    searchQuery.value = "";
    activeIndex.value = 0;
    previousFocusedElement?.focus?.();
    previousFocusedElement = null;
  }
);

watch(
  flatResults,
  (results) => {
    activeIndex.value = results.length > 0 ? 0 : -1;
  },
  { immediate: true }
);

onUnmounted(() => {
  previousFocusedElement = null;
});
</script>

<style scoped>
.command-palette {
  position: fixed;
  inset: 0;
  z-index: 10002;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: clamp(20px, 6vh, 56px) 16px 24px;
  background:
    radial-gradient(
      circle at top center,
      color-mix(in srgb, var(--highlight-text) 22%, transparent),
      transparent 36%
    ),
    var(--overlay-backdrop-strong);
  backdrop-filter: blur(18px);
}

.command-panel {
  width: min(880px, 100%);
  max-height: min(82vh, 760px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--button-bg) 26%, var(--border-color));
  border-radius: 28px;
  background:
    linear-gradient(180deg, var(--surface-overlay-strong), transparent 24%),
    color-mix(in srgb, var(--secondary-bg) 92%, var(--primary-bg));
  box-shadow:
    var(--overlay-panel-shadow),
    inset 0 1px 0 var(--surface-overlay-strong);
}

.command-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 24px 10px;
}

.command-eyebrow {
  margin: 0 0 8px;
  font-size: var(--font-size-caption);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--highlight-text);
}

.command-header h2 {
  margin: 0;
  font-size: var(--font-size-title);
  line-height: 1.2;
}

.command-close {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--surface-overlay-soft);
  color: var(--secondary-text);
  cursor: pointer;
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}

.command-close:hover {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--button-bg) 40%, transparent);
}

.command-close:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 50%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.command-search {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 24px;
  padding: 0 18px;
  border: 1px solid color-mix(in srgb, var(--button-bg) 22%, var(--border-color));
  border-radius: 22px;
  background: var(--surface-overlay-soft);
}

.command-search:focus-within {
  border-color: color-mix(in srgb, var(--button-bg) 48%, transparent);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.command-search .material-symbols-outlined {
  color: var(--highlight-text);
}

.command-search input {
  width: 100%;
  padding: 16px 0;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--primary-text);
  font-size: var(--font-size-body);
}

.command-search input:focus {
  outline: none;
}

.command-hints {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  padding: 10px 24px 18px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.command-results {
  overflow-y: auto;
  padding: 0 12px 18px;
}

.command-section + .command-section {
  margin-top: 8px;
}

.command-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.command-item {
  width: 100%;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  padding: 14px 12px;
  border: 1px solid transparent;
  border-radius: 18px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    background-color 0.18s ease;
}

.command-item:hover,
.command-item.active {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--button-bg) 28%, var(--border-color));
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--highlight-text) 22%, transparent), transparent 62%),
    var(--surface-overlay-soft);
}

.command-item:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 50%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.command-item-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: color-mix(in srgb, var(--button-bg) 18%, transparent);
  color: var(--highlight-text);
}

.command-item-copy {
  min-width: 0;
}

.command-item-topline {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.command-item-topline strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-body);
}

.command-kind {
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--surface-overlay-strong);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.command-item-subtitle {
  display: block;
  margin-top: 5px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-item-badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.command-badge {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--surface-overlay-strong);
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  white-space: nowrap;
}

.command-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 24px 48px;
  text-align: center;
}

.command-empty .material-symbols-outlined {
  font-size: var(--font-size-icon-empty);
  color: var(--secondary-text);
}

.command-empty h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
}

.command-empty p {
  margin: 0;
  color: var(--secondary-text);
}

@media (max-width: 768px) {
  .command-palette {
    padding-top: 18px;
  }

  .command-panel {
    max-height: calc(var(--app-viewport-height, 100vh) - 36px);
    border-radius: 24px;
  }

  .command-header,
  .command-search,
  .command-hints {
    margin-left: 16px;
    margin-right: 16px;
    padding-left: 0;
    padding-right: 0;
  }

  .command-header {
    padding: 20px 0 10px;
  }

  .command-item {
    grid-template-columns: 40px minmax(0, 1fr);
  }

  .command-item-badges {
    grid-column: 2;
    justify-content: flex-start;
  }
}

@media (max-width: 520px) {
  .command-item-topline {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }

  .command-search input {
    font-size: var(--font-size-body);
  }
}
</style>
