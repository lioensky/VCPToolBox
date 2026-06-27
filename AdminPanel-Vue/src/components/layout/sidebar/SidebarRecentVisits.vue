<template>
  <div
    v-if="recentVisits.length > 0"
    class="recent-visits"
    :class="{ 'sidebar-collapsed': isSidebarCollapsed && !isHoveringSidebar }"
  >
    <button
      type="button"
      class="recent-menu-button"
      :class="{ 'fade-label-hidden': isSidebarCollapsed && !isHoveringSidebar }"
      :aria-expanded="!isRecentVisitsCollapsed"
      @click="$emit('toggleRecent')"
    >
      <span class="material-symbols-outlined">history</span>
      <span class="recent-label">最近访问</span>
      <span class="material-symbols-outlined recent-chevron" :class="{ open: !isRecentVisitsCollapsed }">
        chevron_right
      </span>
    </button>

    <div class="recent-collapsible" :class="{ open: !isRecentVisitsCollapsed }">
      <nav class="recent-nav">
        <a
          v-for="item in recentVisits"
          :key="`${item.target}-${item.pluginName || ''}`"
          href="#"
          class="recent-menu-button"
          :class="{ 'sidebar-collapsed': isSidebarCollapsed && !isHoveringSidebar }"
          :title="item.label"
          @click.prevent="$emit('navigateTo', item.target, item.pluginName)"
        >
          <span class="material-symbols-outlined">{{ item.icon || 'extension' }}</span>
          <span class="recent-label">{{ item.label }}</span>
        </a>
      </nav>
    </div>
  </div>
</template>

<script setup lang="ts">
interface RecentVisitItem {
  target: string
  label: string
  icon?: string
  pluginName?: string
}

defineProps<{
  recentVisits: readonly RecentVisitItem[]
  isSidebarCollapsed: boolean
  isHoveringSidebar: boolean
  isRecentVisitsCollapsed: boolean
}>()

defineEmits<{
  (e: 'toggleRecent'): void
  (e: 'navigateTo', target: string, pluginName?: string): void
}>()
</script>

<style scoped>
.recent-visits {
  /* 右侧多预留 8px 对齐下方 NavList 滚动条占用的宽度，使 hover 行右边缘齐平 */
  padding: 4px 8px 0;
  margin-right: 8px;
  transition: padding 0.25s ease;
}

.recent-visits.sidebar-collapsed {
  padding: 4px 0 0 8px;
  width: 40px;
  margin-right: 0;
  box-sizing: border-box;
}

.recent-menu-button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  margin-bottom: 0;
  padding: 8px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--primary-text);
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
  line-height: 1.25;
  text-align: left;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    opacity 0.25s ease,
    transform 0.25s ease;
  outline: none;
}

.recent-menu-button:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.recent-menu-button:focus-visible {
  box-shadow: 0 0 0 2px var(--focus-ring);
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.recent-menu-button.fade-label-hidden,
.recent-menu-button.sidebar-collapsed {
  gap: 0;
  padding: 8px;
  width: 32px;
  min-width: 0;
  max-width: none;
  justify-content: center;
  box-sizing: border-box;
}

.recent-menu-button.fade-label-hidden .recent-label,
.recent-menu-button.fade-label-hidden .recent-chevron,
.recent-menu-button.sidebar-collapsed .recent-label {
  max-width: 0;
  opacity: 0;
  transform: translateX(-6px);
  pointer-events: none;
}

.recent-collapsible {
  display: grid;
  grid-template-rows: 0fr;
  overflow: hidden;
  opacity: 0;
  transition:
    grid-template-rows 300ms ease-out,
    opacity 180ms ease-out;
}

.recent-collapsible.open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.recent-chevron {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 16px;
  line-height: 1;
  opacity: 0.72;
  transition: transform 200ms ease;
}

.recent-chevron.open {
  transform: rotate(90deg);
}

.recent-nav {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.recent-menu-button .material-symbols-outlined {
  flex-shrink: 0;
  font-size: 16px;
  line-height: 1;
}

.recent-label {
  display: flex;
  min-width: 0;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition:
    max-width 0.28s ease,
    opacity 0.2s ease,
    transform 0.24s ease;
}
</style>
