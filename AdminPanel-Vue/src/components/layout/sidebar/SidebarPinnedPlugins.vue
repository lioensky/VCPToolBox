<template>
  <div
    v-if="pinnedPlugins.length > 0 && (!isSidebarCollapsed || isHoveringSidebar)"
    class="pinned-plugins"
    :class="{ 'sidebar-collapsed': isSidebarCollapsed && !isHoveringSidebar }"
  >
    <div
      class="pinned-header"
      :class="{ 'fade-label-hidden': isSidebarCollapsed && !isHoveringSidebar }"
    >
      <span class="pinned-title">
        <span class="material-symbols-outlined">keep</span>
        <span>固定插件</span>
      </span>
    </div>

    <nav
      v-show="!isSidebarCollapsed || isHoveringSidebar"
      class="pinned-nav"
      aria-label="固定插件"
    >
      <a
        v-for="plugin in pinnedPlugins"
        :key="plugin.pluginName"
        href="#"
        class="pinned-item"
        :title="plugin.label"
        @click.prevent="$emit('navigateTo', plugin.target, plugin.pluginName)"
      >
        <span class="material-symbols-outlined">{{ plugin.icon }}</span>
        <span class="pinned-label">{{ plugin.label }}</span>
      </a>
    </nav>
  </div>
</template>

<script setup lang="ts">
interface PinnedPluginItem {
  target: string;
  label: string;
  icon: string;
  pluginName: string;
}

defineProps<{
  pinnedPlugins: PinnedPluginItem[];
  isSidebarCollapsed: boolean;
  isHoveringSidebar: boolean;
}>();

defineEmits<{
  (e: "navigateTo", target: string, pluginName: string): void;
}>();
</script>

<style scoped>
.pinned-plugins {
  margin-top: auto;
  padding: 16px;
  border-top: 1px solid var(--border-color);
  transition: padding 0.25s ease;
}

.pinned-plugins.sidebar-collapsed {
  padding: 16px 10px;
}

.pinned-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  transition: opacity 0.25s ease, transform 0.25s ease;
  overflow: hidden;
}

.pinned-header.fade-label-hidden {
  opacity: 0;
  transform: translateX(-10px);
  pointer-events: none;
}

.pinned-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
}

.pinned-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pinned-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: var(--secondary-text);
  text-decoration: none;
  border-radius: 8px;
  transition: background-color 0.2s ease, color 0.2s ease;
  overflow: hidden;
  white-space: nowrap;
}

.pinned-item:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.pinned-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
