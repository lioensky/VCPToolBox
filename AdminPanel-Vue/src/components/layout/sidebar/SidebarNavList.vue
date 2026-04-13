<template>
  <nav id="plugin-nav" ref="navRef" @scroll="handleNavScroll">
    <div v-if="shouldVirtualize" :style="{ height: `${totalHeight}px`, position: 'relative' }">
      <ul :style="{ transform: `translateY(${offsetY}px)` }">
      <template v-for="item in filteredNavItems" :key="item.category ? `category-${item.category}` : `nav-${item.target || item.pluginName || item.label}`">
        <li v-if="item.category" class="nav-category" :class="{ 'fade-label-hidden': !isExpandedState }">
          {{ item.category }}
        </li>
        <li v-else>
          <a
            href="#"
            :data-target="item.target"
            :class="{ active: isActiveRoute(item.target, item.pluginName), 'sidebar-collapsed': isSidebarCollapsed && !isHoveringSidebar }"
            :title="isSidebarCollapsed && !isHoveringSidebar ? item.label : ''"
            @click.prevent="$emit('navigateTo', item.target, item.pluginName)"
          >
            <span class="material-symbols-outlined">{{ item.icon || 'extension' }}</span>
            <span class="nav-label">
              {{ item.label }}
              <span v-if="item.pluginName" class="plugin-original-name">
                ({{ item.pluginName }})
              </span>
              <span v-if="!item.enabled && item.pluginName" class="plugin-disabled-badge">
                (已禁用)
              </span>
            </span>
          </a>
        </li>
      </template>
      </ul>
    </div>
    <ul v-else>
      <template v-for="item in filteredNavItems" :key="item.category ? `category-${item.category}` : `nav-${item.target || item.pluginName || item.label}`">
        <li v-if="item.category" class="nav-category" :class="{ 'fade-label-hidden': !isExpandedState }">
          {{ item.category }}
        </li>
        <li v-else>
          <a
            href="#"
            :data-target="item.target"
            :class="{ active: isActiveRoute(item.target, item.pluginName), 'sidebar-collapsed': isSidebarCollapsed && !isHoveringSidebar }"
            :title="isSidebarCollapsed && !isHoveringSidebar ? item.label : ''"
            @click.prevent="$emit('navigateTo', item.target, item.pluginName)"
          >
            <span class="material-symbols-outlined">{{ item.icon || 'extension' }}</span>
            <span class="nav-label">
              {{ item.label }}
              <span v-if="item.pluginName" class="plugin-original-name">
                ({{ item.pluginName }})
              </span>
              <span v-if="!item.enabled && item.pluginName" class="plugin-disabled-badge">
                (已禁用)
              </span>
            </span>
          </a>
        </li>
      </template>
    </ul>
  </nav>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useVirtualScroll } from '@/composables/useVirtualScroll'

interface NavItem {
  category?: string
  target?: string
  label?: string
  icon?: string
  pluginName?: string
  enabled?: boolean
}

const props = defineProps<{
  filteredNavItems: NavItem[]
  isExpandedState: boolean
  isSidebarCollapsed: boolean
  isHoveringSidebar: boolean
  isActiveRoute: (target: string | undefined, pluginName?: string) => boolean
}>()

defineEmits<{
  (e: 'navigateTo', target: string | undefined, pluginName?: string): void
}>()

const shouldVirtualize = computed(() => (
  props.filteredNavItems.length > 80 &&
  props.filteredNavItems.every((item) => !item.category)
))
const navOverscan = computed(() => (props.filteredNavItems.length > 200 ? 14 : 8))
const navRef = ref<HTMLElement | null>(null)
const navHeight = ref(560)

function updateNavHeight() {
  const measured = navRef.value?.clientHeight ?? 560
  navHeight.value = Math.max(280, measured)
}

const {
  onScroll,
  setScrollTop,
  visibleItems,
  totalHeight,
  offsetY
} = useVirtualScroll(
  computed(() => (shouldVirtualize.value ? props.filteredNavItems : props.filteredNavItems)),
  {
    itemHeight: 56,
    containerHeight: computed(() => navHeight.value),
    overscan: computed(() => navOverscan.value)
  }
)

function handleNavScroll(event: Event) {
  const target = event.target as HTMLElement
  // 限制滚动位置，防止超出底部
  const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight)
  if (target.scrollTop > maxScroll) {
    target.scrollTop = maxScroll
  }
  onScroll(event)
}

const filteredNavItems = computed(() => {
  if (!shouldVirtualize.value) return props.filteredNavItems
  return visibleItems.value.map((entry) => entry.item)
})

onMounted(() => {
  updateNavHeight()
  window.addEventListener('resize', updateNavHeight)
})

watch(
  () => props.filteredNavItems.length,
  () => {
    if (!shouldVirtualize.value || !navRef.value) return
    const maxScrollTop = Math.max(0, totalHeight.value - navHeight.value)
    const clamped = Math.min(navRef.value.scrollTop, maxScrollTop)
    navRef.value.scrollTop = clamped
    setScrollTop(clamped)
  }
)

onUnmounted(() => {
  window.removeEventListener('resize', updateNavHeight)
})
</script>

<style scoped>
#plugin-nav {
  flex-grow: 1;
  overflow-y: auto;
  padding: 16px;
}

#plugin-nav ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

/* 虚拟滚动模式下，为 ul 添加底部内边距防止最后一项被截断 */
#plugin-nav > div > ul {
  padding-bottom: 56px; /* 等于一个项目的高度 */
}

#plugin-nav li a {
  display: flex;
  align-items: center;
  gap: 15px;
  color: var(--secondary-text);
  padding: 12px 16px;
  text-decoration: none;
  border-radius: 12px;
  margin-bottom: 4px;
  transition: background-color 0.2s ease, color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  font-size: var(--font-size-body);
  border: 1px solid transparent;
  overflow: hidden;
}

#plugin-nav li a:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
  transform: translateX(4px);
}

#plugin-nav li a:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

#plugin-nav li a.active {
  background-color: var(--button-bg);
  color: var(--on-accent-text);
  font-weight: 600;
  box-shadow: var(--shadow-overlay-soft);
}

#plugin-nav li a.sidebar-collapsed {
  justify-content: center;
  gap: 0;
  padding: 12px;
}

#plugin-nav li a.sidebar-collapsed .material-symbols-outlined {
  margin: 0;
}

#plugin-nav li.nav-category {
  padding: 15px 15px 5px;
  font-size: var(--font-size-helper);
  color: var(--primary-text);
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.5px;
  opacity: 1;
  transform: translateX(0);
  transition: opacity 0.25s ease, transform 0.25s ease, padding 0.25s ease;
  overflow: hidden;
  white-space: nowrap;
}

.nav-category.fade-label-hidden {
  opacity: 0;
  transform: translateX(-10px);
  padding-left: 10px;
  padding-right: 10px;
  pointer-events: none;
}

.nav-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  max-width: 220px;
  opacity: 1;
  transform: translateX(0);
  transition: max-width 0.28s ease, opacity 0.2s ease, transform 0.24s ease;
}

a.sidebar-collapsed .nav-label {
  max-width: 0;
  opacity: 0;
  transform: translateX(-6px);
  pointer-events: none;
}

.plugin-original-name {
  font-size: var(--font-size-caption);
  opacity: 0.6;
  font-weight: normal;
}

.plugin-disabled-badge {
  font-size: var(--font-size-caption);
  color: var(--danger-color);
  font-weight: normal;
}
</style>
