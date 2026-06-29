<template>
  <div
    class="admin-layout"
    :class="{
      'ui-hidden-immersive': isImmersiveMode,
      'sidebar-collapsed': isSidebarCollapsed,
    }"
  >
    <a class="skip-link" href="#config-details-container">跳到主要内容</a>

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
          :sidebar-search-query="sidebarSearchQuery"
          @navigate-to="navigateTo"
          @open-command-palette="openCommandPalette"
          @update:is-hovering-sidebar="isHoveringSidebar = $event"
          @update:sidebarSearchQuery="sidebarSearchQuery = $event"
        />
      </div>

      <!-- 侧边栏遮罩层 (移动端) -->
      <div
        class="sidebar-overlay"
        :class="{ active: isMobileMenuOpen }"
        @click="closeMobileMenu"
      ></div>

      <!-- 主内容区 -->
      <main class="content">
        <section class="unified-page-header">
          <h1>{{ currentPageTitle }}</h1>
          <div
            id="page-header-actions"
            ref="pageHeaderActionsRef"
            class="unified-page-header__actions"
          ></div>
        </section>

        <!-- 返回顶部按钮 -->
        <button
          v-show="showBackToTop && !isDashboardPage"
          type="button"
          @click="scrollToTop"
          class="back-to-top-btn"
          aria-label="返回顶部"
          :title="'返回顶部'"
        >
          <span class="material-symbols-outlined">keyboard_arrow_up</span>
        </button>

        <div ref="contentRef" class="content-scroll-region" id="config-details-container">
          <!-- 路由视图 -->
          <router-view v-if="isPageHeaderActionsReady" v-slot="{ Component, route }">
            <component :is="Component" :key="route.fullPath" :data-page="String(route.name || '')" />
          </router-view>
        </div>
      </main>
    </div>

    <FeedbackHost />
    <NotificationsDrawer />

    <!-- 沉浸观星模式彩蛋文本 -->
    <Transition name="immersive-easter-quote">
      <p v-if="isImmersiveMode" class="immersive-easter-quote" aria-live="polite">
        让智能链接灵魂与星空。——By VCP
      </p>
    </Transition>

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
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import FeedbackHost from "@/components/feedback/FeedbackHost.vue";
import SolarSystemBg from "@/components/SolarSystemBg.vue";
import GlobalCommandPalette from "@/components/layout/GlobalCommandPalette.vue";
import TopBar from "@/components/layout/TopBar.vue";
import Sidebar from "@/components/layout/Sidebar.vue";
import NotificationsDrawer from "@/components/layout/NotificationsDrawer.vue";
import { useMainLayoutState } from "@/composables/useMainLayoutState";
import { useAppStore } from "@/stores/app";
import { useNotificationsStore } from "@/stores/notifications";

const route = useRoute();
const appStore = useAppStore();
const notificationsStore = useNotificationsStore();
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
  sidebarSearchQuery,
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
const isDashboardPage = computed(() => route.name === "Dashboard");
const pageHeaderActionsRef = ref<HTMLElement | null>(null);
const isPageHeaderActionsReady = ref(false);

onMounted(async () => {
  await nextTick();
  isPageHeaderActionsReady.value = pageHeaderActionsRef.value !== null;
  void notificationsStore.connect();
});

onBeforeUnmount(() => {
  notificationsStore.disconnect();
});

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

.skip-link {
  position: absolute;
  top: -100%;
  left: 12px;
  z-index: 10004;
  padding: 10px 20px;
  background: var(--button-bg);
  color: var(--on-accent-text);
  border-radius: var(--radius-md);
  font-weight: 600;
  font-size: var(--font-size-helper);
  text-decoration: none;
  transition: top 0.2s ease;
}

.skip-link:focus {
  top: 12px;
}

.container {
  display: flex;
  position: relative;
  z-index: 1;
  height: calc(
    var(--app-viewport-height, 100vh) - var(--app-top-bar-height, 48px)
  );
  margin-top: var(--app-top-bar-height, 48px);
  background: var(--app-shell-bg);
  transition: opacity 1.8s cubic-bezier(0.4, 0, 0.2, 1);
}

.admin-layout.sidebar-collapsed .container {
  gap: 12px;
}

.content {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  box-sizing: border-box;
  border: 0;
  overflow: hidden;
  height: 100%;
  background: var(--app-content-bg);
  clip-path: inset(0 round var(--radius-xl));
  /* 白色主画布；星空保持在全局最底层 */
  /* 不在默认态设置 identity transform，避免创建 stacking context */
  opacity: 1;
  transition:
    opacity 1.6s cubic-bezier(0.4, 0, 0.2, 1),
    transform 2s cubic-bezier(0.4, 0, 0.2, 1),
    filter 1.8s ease,
    border-color var(--transition-fast);
}

.content-scroll-region {
  flex: 1 1 auto;
  min-height: 0;
  padding: 6px 16px 16px;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--secondary-text) 12%, transparent)
    transparent;
}

.content-scroll-region:hover {
  scrollbar-color: color-mix(in srgb, var(--secondary-text) 28%, transparent)
    transparent;
}

.content-scroll-region::-webkit-scrollbar {
  width: 14px;
  height: 14px;
}

.content-scroll-region::-webkit-scrollbar-track {
  background: transparent;
}

.content-scroll-region::-webkit-scrollbar-button,
.content-scroll-region::-webkit-scrollbar-button:single-button,
.content-scroll-region::-webkit-scrollbar-button:vertical:start,
.content-scroll-region::-webkit-scrollbar-button:vertical:end,
.content-scroll-region::-webkit-scrollbar-button:vertical:decrement,
.content-scroll-region::-webkit-scrollbar-button:vertical:increment {
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  display: none;
  width: 0;
  height: 0;
}

.content-scroll-region::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--secondary-text) 10%, transparent);
  background-clip: content-box;
  border: 3px solid transparent;
  border-block-width: 18px;
  border-radius: 999px;
}

.content-scroll-region:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--secondary-text) 26%, transparent);
}

.content-scroll-region:hover::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--secondary-text) 42%, transparent);
}

:global(html:not([data-theme-shell-layout]) .container),
:global(html[data-theme-shell-layout="inset"] .container) {
  padding: 4px 8px 4px 0;
}

:global(html:not([data-theme-shell-layout]) .content),
:global(html[data-theme-shell-layout="inset"] .content) {
  height: calc(100% - 8px);
  margin: 0 0 0 0;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-overlay-soft);
}

:global(html[data-theme-shell-layout="sidebar"] .container) {
  padding: 0;
  background: transparent;
}

:global(html[data-theme-shell-layout="sidebar"] .content) {
  height: 100%;
  border: 0;
  border-radius: 0;
  clip-path: inset(0 round 0);
  box-shadow: none;
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

/* 沉浸模式彩蛋文本 */
.immersive-easter-quote {
  position: fixed;
  left: 50%;
  bottom: clamp(72px, 12vh, 132px);
  z-index: 10000;
  margin: 0;
  padding: 12px 22px;
  max-width: min(720px, calc(100vw - 48px));
  transform: translateX(-50%);
  color: color-mix(in srgb, var(--primary-text) 88%, var(--highlight-text));
  font-size: clamp(18px, 2.8vw, 30px);
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.7;
  text-align: center;
  text-wrap: balance;
  text-shadow:
    0 0 18px color-mix(in srgb, var(--highlight-text) 34%, transparent),
    0 0 42px color-mix(in srgb, var(--primary-bg) 92%, transparent);
  pointer-events: none;
  user-select: none;
}

.immersive-easter-quote-enter-active {
  transition:
    opacity 2.4s cubic-bezier(0.22, 1, 0.36, 1) 0.8s,
    transform 2.8s cubic-bezier(0.22, 1, 0.36, 1) 0.8s,
    filter 2.4s ease 0.8s;
}

.immersive-easter-quote-leave-active {
  transition:
    opacity 0.5s ease,
    transform 0.5s ease,
    filter 0.5s ease;
}

.immersive-easter-quote-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(18px) scale(0.98);
  filter: blur(16px);
}

.immersive-easter-quote-enter-to,
.immersive-easter-quote-leave-from {
  opacity: 1;
  transform: translateX(-50%) translateY(0) scale(1);
  filter: blur(0);
}

.immersive-easter-quote-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px) scale(0.99);
  filter: blur(10px);
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

.unified-page-header {
  position: relative;
  z-index: 20;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 20px 16px 12px;
  overflow: visible;
}

.unified-page-header h1 {
  position: relative;
  z-index: 1;
  min-width: 0;
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.35;
}

.unified-page-header__actions {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  min-height: 36px;
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
    padding: 0;
  }

  .content-scroll-region {
    padding: 4px 12px 12px;
  }

  .unified-page-header {
    padding: 12px 12px 10px;
  }

  .unified-page-header h1 {
    font-size: 1rem;
  }

  .unified-page-header__actions {
    min-height: 32px;
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
    padding: 0;
  }

  .content-scroll-region {
    padding: 4px 12px 12px;
  }

  .unified-page-header {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-2);
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

  .immersive-easter-quote {
    bottom: 84px;
    max-width: calc(100vw - 28px);
    padding: 10px 14px;
    letter-spacing: 0.04em;
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
