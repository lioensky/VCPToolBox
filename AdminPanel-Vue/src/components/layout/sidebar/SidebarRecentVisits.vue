<template>
  <div
    v-if="recentVisits.length > 0 && (!isSidebarCollapsed || isHoveringSidebar)"
    class="recent-visits"
    :class="{ 'sidebar-collapsed': isSidebarCollapsed && !isHoveringSidebar }"
  >
    <button
      type="button"
      class="recent-header recent-toggle"
      :class="{ 'fade-label-hidden': isSidebarCollapsed && !isHoveringSidebar }"
      :aria-expanded="!isRecentVisitsCollapsed"
      @click="$emit('toggleRecent')"
    >
      <span class="recent-title">
        <span class="material-symbols-outlined">history</span>
        <span>最近访问</span>
      </span>
      <span class="material-symbols-outlined recent-chevron">
        {{ isRecentVisitsCollapsed ? 'expand_more' : 'expand_less' }}
      </span>
    </button>

    <nav v-show="!isRecentVisitsCollapsed && !isSidebarCollapsed || isHoveringSidebar" class="recent-nav">
      <a
        v-for="item in recentVisits"
        :key="`${item.target}-${item.pluginName || ''}`"
        href="#"
        class="recent-item"
        :class="{ 'sidebar-collapsed': isSidebarCollapsed && !isHoveringSidebar }"
        :title="item.label"
        @click.prevent="$emit('navigateTo', item.target, item.pluginName)"
      >
        <span class="material-symbols-outlined">{{ item.icon || 'extension' }}</span>
        <span class="recent-label">{{ item.label }}</span>
      </a>
    </nav>
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
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  transition: padding 0.25s ease;
}

.recent-visits.sidebar-collapsed {
  padding: 16px 10px;
}

.recent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  transition: opacity 0.25s ease, transform 0.25s ease;
  overflow: hidden;
}

.recent-header.fade-label-hidden {
  opacity: 0;
  transform: translateX(-10px);
  pointer-events: none;
}

.recent-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
}

.recent-toggle {
  width: 100%;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.recent-toggle:hover {
  color: var(--primary-text);
}

.recent-chevron {
  font-size: var(--font-size-emphasis);
}

.recent-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: var(--secondary-text);
  text-decoration: none;
  border-radius: 8px;
  transition: background-color 0.2s ease, color 0.2s ease, opacity 0.25s ease, transform 0.25s ease;
  font-size: var(--font-size-body);
  overflow: hidden;
  white-space: nowrap;
}

.recent-item.sidebar-collapsed {
  justify-content: center;
  padding: 8px;
}

.recent-item.sidebar-collapsed .material-symbols-outlined {
  margin: 0;
}

.recent-item.sidebar-collapsed .recent-label {
  opacity: 0;
  transform: translateX(-10px);
  pointer-events: none;
}

.recent-item:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}
</style>
