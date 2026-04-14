<template>
  <div
    class="admin-layout"
    :class="{
      'ui-hidden-immersive': isImmersiveMode,
      'sidebar-collapsed': isSidebarCollapsed,
    }"
  >
    <SolarSystemBg />

    <!-- 顶栏组件（包裹在过渡容器中） -->
    <div class="immersive-fade immersive-fade--topbar">
      <TopBar
        :is-mobile-menu-open="isMobileMenuOpen"
        :is-sidebar-collapsed="isSidebarCollapsed"
        :is-system-menu-open="isSystemMenuOpen"
        :is-user-menu-open="isUserMenuOpen"
        :has-notifications="hasNotifications"
        @toggleMobileMenu="toggleMobileMenu"
        @toggleSidebarCollapse="toggleSidebarCollapse"
        @toggleSystemMenu="toggleSystemMenu"
        @toggleUserMenu="toggleUserMenu"
        @closeAllMenus="closeAllMenus"
      />
    </div>

    <div class="container">
      <!-- 侧边栏组件（包裹在过渡容器中） -->
      <div class="immersive-fade immersive-fade--sidebar">
        <Sidebar
          :is-mobile-menu-open="isMobileMenuOpen"
          :is-sidebar-collapsed="isSidebarCollapsed"
          :is-hovering-sidebar="isHoveringSidebar"
          :is-hover-enabled="isHoverEnabled"
          :recent-visits="recentVisits"
          @navigate-to="navigateTo"
          @open-command-palette="openCommandPalette"
          @update:is-hovering-sidebar="isHoveringSidebar = $event"
        />
      </div>

      <!-- 侧边栏遮罩层 (移动端) -->
      <div
        class="sidebar-overlay"
        :class="{ active: isMobileMenuOpen }"
        @click="closeMobileMenu"
      ></div>

      <!-- 主内容区 -->
      <main ref="contentRef" class="content" id="config-details-container">
        <!-- 面包屑组件 -->
        <Breadcrumb />

        <section class="unified-page-header">
          <h1>{{ currentPageTitle }}</h1>
        </section>

        <!-- 返回顶部按钮 -->
        <button
          v-show="showBackToTop"
          type="button"
          @click="scrollToTop"
          class="back-to-top-btn"
          aria-label="返回顶部"
          :title="'返回顶部'"
        >
          <span class="material-symbols-outlined">keyboard_arrow_up</span>
        </button>

        <!-- 路由视图 -->
        <router-view v-slot="{ Component, route }">
          <transition name="fade" mode="out-in">
            <component :is="Component" :key="route.fullPath" />
          </transition>
        </router-view>
      </main>
    </div>

    <FeedbackHost />

    <!-- 退出沉浸模式按钮 -->
    <Transition name="immersive-exit-btn">
      <button
        v-if="isImmersiveMode"
        id="exit-immersive-button"
        class="exit-immersive-button"
        @click="exitImmersiveMode"
      >
        <span class="material-symbols-outlined">close_fullscreen</span>
        <span>退出沉浸模式</span>
      </button>
    </Transition>

    <!-- 点击外部关闭下拉菜单的遮罩 -->
    <div
      v-if="isSystemMenuOpen || isUserMenuOpen"
      class="dropdown-backdrop"
      @click="closeAllMenus"
    ></div>

    <GlobalCommandPalette
      :is-open="isCommandPaletteOpen"
      :nav-items="navItems"
      :plugins="plugins"
      :recent-visits="recentVisits"
      :navigation-usage="navigationUsage"
      :pinned-plugin-names="pinnedPluginNames"
      @close="closeCommandPalette"
      @navigate-to="navigateTo"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import FeedbackHost from "@/components/feedback/FeedbackHost.vue";
import SolarSystemBg from "@/components/SolarSystemBg.vue";
import GlobalCommandPalette from "@/components/layout/GlobalCommandPalette.vue";
import TopBar from "@/components/layout/TopBar.vue";
import Sidebar from "@/components/layout/Sidebar.vue";
import Breadcrumb from "@/components/layout/Breadcrumb.vue";
import { useMainLayoutState } from "@/composables/useMainLayoutState";
import { useAppStore } from "@/stores/app";

const appStore = useAppStore();
const {
  isMobileMenuOpen,
  isImmersiveMode,
  isSidebarCollapsed,
  isHoveringSidebar,
  isHoverEnabled,
  isCommandPaletteOpen,
  isSystemMenuOpen,
  isUserMenuOpen,
  hasNotifications,
  showBackToTop,
  contentRef,
  recentVisits,
  navigationUsage,
  currentPageTitle,
  navigateTo,
  openCommandPalette,
  closeCommandPalette,
  toggleMobileMenu,
  closeMobileMenu,
  toggleSidebarCollapse,
  toggleSystemMenu,
  toggleUserMenu,
  closeAllMenus,
  exitImmersiveMode,
  scrollToTop,
} = useMainLayoutState();

const navItems = computed(() => appStore.navItems);
const plugins = computed(() => appStore.plugins);
const pinnedPluginNames = computed(() => appStore.pinnedPluginNames);

void contentRef;
</script>

<style scoped>
.admin-layout {
  position: relative;
  height: var(--app-viewport-height, 100vh);
  overflow: hidden;
  background-color: var(--primary-bg);
  color: var(--primary-text);
  transition:
    background-color var(--transition-normal),
    color var(--transition-normal);
}

.container {
  display: flex;
  position: relative;
  z-index: 1;
  height: calc(
    var(--app-viewport-height, 100vh) - var(--app-top-bar-height, 60px)
  );
  margin-top: var(--app-top-bar-height, 60px);
  transition: opacity 1.8s cubic-bezier(0.4, 0, 0.2, 1);
}

.content {
  flex-grow: 1;
  padding: 30px 40px;
  box-sizing: border-box;
  overflow-y: auto;
  height: 100%;
  /* 不在默认态设置 identity transform，避免创建 stacking context */
  opacity: 1;
  transition:
    opacity 1.6s cubic-bezier(0.4, 0, 0.2, 1),
    transform 2s cubic-bezier(0.4, 0, 0.2, 1),
    filter 1.8s ease;
}

.sidebar-overlay {
  position: fixed;
  top: var(--app-top-bar-height, 60px);
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--overlay-backdrop);
  z-index: 998;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--transition-normal),
    visibility var(--transition-normal);
}

.sidebar-overlay.active {
  opacity: 1;
  visibility: visible;
}

/* 返回顶部按钮 */
.back-to-top-btn {
  position: fixed;
  bottom: 30px;
  right: 30px;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background-color: var(--button-bg);
  color: var(--on-accent-text);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-overlay-soft);
  transition:
    background-color var(--transition-normal),
    transform var(--transition-normal),
    box-shadow var(--transition-normal);
  z-index: 100;
}

.back-to-top-btn:hover {
  background-color: var(--button-hover-bg);
  transform: translateY(-4px);
  box-shadow: var(--overlay-panel-shadow);
}

.back-to-top-btn:focus-visible,
.exit-immersive-button:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 3px;
}


/* ── 沉浸观星模式 ── */

/* 过渡包裹层：在正常状态定义 transition，确保状态切换时动画触发 */
.immersive-fade {
  opacity: 1;
  /* 不在默认态设置 identity transform/filter，避免创建 stacking context
     导致移动端 sidebar(position:fixed; z-index:999) 被 dashboard 卡片遮挡。
     CSS transition 可以正确地从 none 过渡到具体值。 */
  transition:
    opacity 1.8s cubic-bezier(0.4, 0, 0.2, 1),
    transform 2s cubic-bezier(0.4, 0, 0.2, 1),
    filter 1.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.immersive-fade--topbar {
  position: relative;
  z-index: 1000;
}

.immersive-fade--sidebar {
  display: flex;
  flex-shrink: 0;
  height: 100%;
}

/* 沉浸状态：UI 元素"浮起 → 模糊 → 消散" */
.ui-hidden-immersive .immersive-fade--topbar {
  opacity: 0;
  transform: translateY(-24px);
  filter: blur(10px);
  pointer-events: none;
}

.ui-hidden-immersive .immersive-fade--sidebar {
  opacity: 0;
  transform: translateX(-16px);
  filter: blur(10px);
  pointer-events: none;
}

.ui-hidden-immersive .content {
  opacity: 0;
  transform: scale(0.97) translateY(16px);
  filter: blur(6px);
  pointer-events: none;
}

.ui-hidden-immersive .container {
  pointer-events: none;
}

.ui-hidden-immersive .sidebar-overlay {
  display: none;
}

/* 退出沉浸模式按钮 */
.exit-immersive-button {
  position: fixed;
  top: 20px;
  right: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background-color: var(--overlay-frost-bg);
  color: var(--primary-text);
  border: 1px solid var(--overlay-frost-border);
  border-radius: 20px;
  cursor: pointer;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--shadow-overlay-soft);
  transition:
    background-color var(--transition-normal),
    border-color var(--transition-normal),
    box-shadow var(--transition-normal);
  z-index: 10001;
}

.exit-immersive-button:hover {
  background-color: var(--surface-overlay-strong);
  border-color: color-mix(in srgb, var(--highlight-text) 44%, transparent);
  box-shadow: 0 4px 24px color-mix(in srgb, var(--highlight-text) 18%, transparent);
}

/* 退出按钮的入场/离场动画：延迟出现，优雅消失 */
.immersive-exit-btn-enter-active {
  transition: opacity 0.8s ease 1.2s, transform 0.8s cubic-bezier(0.4, 0, 0.2, 1) 1.2s;
}

.immersive-exit-btn-leave-active {
  transition: opacity 0.4s ease, transform 0.4s ease;
}

.immersive-exit-btn-enter-from {
  opacity: 0;
  transform: translateY(-12px);
}

.immersive-exit-btn-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 下拉菜单遮罩 */
.dropdown-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 998;
}

.unified-page-header h1 {
  font-size: var(--font-size-title);
  line-height: 1.25;
}

/* 淡入淡出动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--transition-normal);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .content {
    padding: 14px;
  }

  .unified-page-header {
    margin: 0 0 14px;
    padding: 12px 14px;
  }

  .unified-page-header h1 {
    font-size: var(--font-size-emphasis);
  }

  .back-to-top-btn {
    right: 16px;
    bottom: 16px;
    width: 44px;
    height: 44px;
  }

}

@media (max-width: 480px) {
  .content {
    padding: 12px;
  }

  .unified-page-header {
    margin-bottom: 12px;
    padding: 10px 12px;
    border-radius: 12px;
  }

  .unified-page-header h1 {
    font-size: var(--font-size-body);
    line-height: 1.35;
  }

  .back-to-top-btn {
    right: 12px;
    bottom: 12px;
    width: 44px;
    height: 44px;
  }

  .back-to-top-btn .material-symbols-outlined {
    font-size: var(--font-size-title);
  }

  .exit-immersive-button {
    top: 12px;
    right: 12px;
    gap: 6px;
    padding: 8px 14px;
    font-size: var(--font-size-helper);
  }
}
</style>
