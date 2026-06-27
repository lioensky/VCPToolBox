<template>
  <header class="top-bar" :class="{ 'sidebar-collapsed': isSidebarCollapsed }">
    <div class="top-bar-content">
      <!-- 左列：折叠开关 + 品牌，宽度对齐侧栏 -->
      <div class="top-bar-left">
        <button
          id="mobile-menu-toggle"
          class="mobile-menu-toggle"
          @click="toggleMobileMenu"
          aria-label="切换导航菜单"
          :aria-expanded="isMobileMenuOpen"
        >
          <span class="material-symbols-outlined" aria-hidden="true">menu</span>
        </button>
        <UiIconButton
          class="sidebar-collapse-toggle"
          :label="isSidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
          :title="isSidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
          @click="toggleSidebarCollapse"
        >
          <svg
            class="sidebar-trigger-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M4 5.75C4 4.78 4.78 4 5.75 4h12.5C19.22 4 20 4.78 20 5.75v12.5c0 .97-.78 1.75-1.75 1.75H5.75C4.78 20 4 19.22 4 18.25V5.75Z" />
            <path d="M9.5 4.5v15" />
            <path d="m15 9-3 3 3 3" />
          </svg>
        </UiIconButton>
        <button
          type="button"
          class="brand"
          @click="goToDashboard"
          aria-label="返回仪表盘"
        >
          <img
            class="brand-logo"
            :src="topbarLogoUrl"
            alt=""
            aria-hidden="true"
          />
          <span class="server-title">VCPToolBox</span>
        </button>
      </div>

      <!-- 中列：面包屑 -->
      <div class="top-bar-center">
        <Breadcrumb compact />
      </div>

      <!-- 右列：通知 + 系统菜单 + 用户菜单 -->
      <div class="header-actions">
        <!-- 通知图标（预留） -->
        <button
          class="icon-button notification-btn"
          :aria-label="hasNotifications ? '系统通知（有新通知）' : '系统通知'"
          :title="hasNotifications ? '有新通知' : '系统通知'"
        >
          <span class="material-symbols-outlined" aria-hidden="true"
            >notifications</span
          >
          <span v-if="hasNotifications" class="notification-badge"></span>
        </button>

        <!-- 系统菜单下拉 -->
        <div class="dropdown" :class="{ 'dropdown-open': isSystemMenuOpen }">
          <button
            class="icon-button system-menu-btn"
            @click="toggleSystemMenu"
            aria-label="系统菜单"
            aria-haspopup="true"
            :aria-expanded="isSystemMenuOpen"
          >
            <span class="material-symbols-outlined" aria-hidden="true"
              >settings</span
            >
          </button>
          <div class="dropdown-menu system-dropdown">
            <div class="dropdown-header">系统控制</div>
            <button @click="toggleAnimations" class="dropdown-item">
              <span class="material-symbols-outlined">{{
                animationsEnabled ? "animation" : "toggle_off"
              }}</span>
              <span>{{ animationsEnabled ? "关闭动画" : "开启动画" }}</span>
            </button>
            <button @click="toggleTheme" class="dropdown-item">
              <span class="material-symbols-outlined">{{ themeToggleIcon }}</span>
              <span>{{ themeToggleLabel }}</span>
            </button>
            <div class="dropdown-divider"></div>
            <button @click="restartServer" class="dropdown-item danger">
              <span class="material-symbols-outlined">restart_alt</span>
              <span>重启服务器</span>
            </button>
          </div>
        </div>

        <!-- 用户头像下拉 -->
        <div class="dropdown" :class="{ 'dropdown-open': isUserMenuOpen }">
          <button
            class="user-avatar-btn"
            @click="toggleUserMenu"
            aria-label="用户菜单"
            aria-haspopup="true"
            :aria-expanded="isUserMenuOpen"
          >
            <span class="material-symbols-outlined">account_circle</span>
          </button>
          <div class="dropdown-menu user-dropdown">
            <div class="dropdown-header">
              <span class="material-symbols-outlined"
                >admin_panel_settings</span
              >
              <span>管理员</span>
            </div>
            <div class="dropdown-divider"></div>
            <button @click="logout" class="dropdown-item danger">
              <span class="material-symbols-outlined">logout</span>
              <span>退出登录</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { systemApi } from "@/api";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { useAppStore } from "@/stores/app";
import { useAuthStore } from "@/stores/auth";
import { showMessage, createLogger } from "@/utils";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import Breadcrumb from "@/components/layout/Breadcrumb.vue";
import topbarLogoUrl from "@/assets/topbar-logo.png";

interface Props {
  isMobileMenuOpen: boolean;
  isSidebarCollapsed: boolean;
  isSystemMenuOpen: boolean;
  isUserMenuOpen: boolean;
  hasNotifications: boolean;
}

// 使用 _props 忽略未使用警告
const _props = defineProps<Props>();

interface Emits {
  (e: "toggleMobileMenu"): void;
  (e: "toggleSidebarCollapse"): void;
  (e: "toggleSystemMenu"): void;
  (e: "toggleUserMenu"): void;
  (e: "closeAllMenus"): void;
}

const emit = defineEmits<Emits>();

const router = useRouter();
const appStore = useAppStore();
const authStore = useAuthStore();

const theme = computed(() => appStore.theme);
const themeToggleIcon = computed(() => {
  if (theme.value === "dark") return "light_mode";
  return "dark_mode";
});
const themeToggleLabel = computed(() => {
  if (theme.value === "dark") return "切换亮色";
  return "切换暗色";
});
const animationsEnabled = computed(() => appStore.animationsEnabled);
const logger = createLogger("TopBar");

function toggleMobileMenu() {
  emit("toggleMobileMenu");
}

function toggleSidebarCollapse() {
  emit("toggleSidebarCollapse");
}

function toggleSystemMenu() {
  emit("toggleSystemMenu");
}

function toggleUserMenu() {
  emit("toggleUserMenu");
}

function toggleTheme() {
  const nextTheme = theme.value === "dark" ? "light" : "dark";
  appStore.setTheme(nextTheme);
  emit("closeAllMenus");
}

function toggleAnimations() {
  appStore.toggleAnimations();
  emit("closeAllMenus");
}

async function restartServer() {
  if (!(await askConfirm({
    message: "您确定要重启服务器吗？",
    danger: true,
    confirmText: "重启",
  }))) return;
  try {
    showMessage("正在发送重启服务器命令...", "info");
    const response = await systemApi.restartServer();
    const message =
      ((response as Record<string, unknown>)?.message as string) ||
      "服务器重启命令已发送。请稍后检查服务器状态。";
    showMessage(message, "success", 5000);
  } catch (error) {
    logger.error("Restart server failed:", error);
  }
  emit("closeAllMenus");
}

async function logout() {
  if (!(await askConfirm("确定要退出登录吗？"))) return;
  try {
    await systemApi.logout();
    authStore.logout();
    router.push({ name: "Login" });
  } catch (error) {
    logger.error("Logout failed:", error);
  }
  emit("closeAllMenus");
}

function goToDashboard() {
  router.push({ name: "Dashboard" });
}
</script>

<style scoped>
.top-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--app-top-bar-height, 48px);
  background-color: var(--app-shell-bg);
  color: var(--primary-text);
  border-bottom: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  padding: 0 8px;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

:global(html:not([data-theme-shell-layout]) .top-bar),
:global(html[data-theme-shell-layout="inset"] .top-bar) {
  background-color: var(--app-shell-bg);
}

:global(html[data-theme-shell-layout="sidebar"] .top-bar) {
  background-color: var(--app-shell-bg);
}

/* 三列网格：左列对齐侧栏宽度，折叠时切图标宽度 */
.top-bar-content {
  display: grid;
  grid-template-columns:
    var(--app-sidebar-width, 280px)
    minmax(0, 1fr)
    auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  transition: grid-template-columns 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.top-bar.sidebar-collapsed .top-bar-content {
  grid-template-columns:
    var(--app-sidebar-width-icon, 72px)
    minmax(0, 1fr)
    auto;
}

.top-bar-left {
  display: flex;
  align-items: center;
  gap: 0;
  flex: 0 0 auto;
  min-width: 0;
  height: 32px;
  box-sizing: border-box;
  padding-left: 8px;
}

.mobile-menu-toggle {
  display: none;
  background: none;
  border: none;
  color: var(--primary-text);
  cursor: pointer;
  padding: 0;
  border-radius: 8px;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

/* 折叠开关由 UiIconButton 提供视觉，此处仅控制显隐 */
.sidebar-collapse-toggle {
  display: inline-flex;
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
}

.mobile-menu-toggle:hover,
.sidebar-collapse-toggle:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.mobile-menu-toggle:focus-visible,
.sidebar-collapse-toggle:focus-visible,
.brand:focus-visible,
.icon-button:focus-visible,
.user-avatar-btn:focus-visible,
.dropdown-item:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--highlight-text) 64%, var(--border-color));
  background: var(--accent-bg);
}

.sidebar-trigger-icon {
  width: 18px;
  height: 18px;
  color: currentColor;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 中列：搜索 + 面包屑 */
.top-bar-center {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
  height: 32px;
}

/* 右列 */
.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  justify-self: end;
  height: 32px;
}

@media (max-width: 768px) {
  .top-bar {
    padding: 0 12px;
  }

  .top-bar-content {
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
  }

  .top-bar.sidebar-collapsed .top-bar-content {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .top-bar-left {
    min-width: 0;
    flex: 1;
    gap: 4px;
  }

  .mobile-menu-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
  }

  .sidebar-collapse-toggle {
    display: none;
  }

  .brand {
    margin-left: 0;
    min-width: 0;
    flex: 1;
  }

  .server-title {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-size-body);
  }

  .top-bar-center {
    /* 移动端搜索框已隐藏，仅留面包屑 */
    gap: 0;
  }

  .header-actions {
    gap: 4px;
    flex-shrink: 0;
  }

  .icon-button,
  .user-avatar-btn {
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .dropdown-menu {
    max-width: min(280px, calc(100vw - 16px));
    right: 0;
  }
}

@media (max-width: 480px) {
  .top-bar {
    padding: 0 8px;
  }

  /* 超窄屏隐藏中列面包屑，让品牌标题与操作按钮有足够空间 */
  .top-bar-content {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .top-bar-center {
    display: none;
  }

  .top-bar-left {
    gap: 4px;
  }

  .brand {
    gap: 8px;
  }

  .server-title {
    max-width: 84px;
    font-size: var(--font-size-helper);
    letter-spacing: 0.2px;
  }

  .header-actions {
    gap: 2px;
  }

  .icon-button,
  .mobile-menu-toggle,
  .user-avatar-btn {
    min-width: 44px;
    min-height: 44px;
    padding: 8px;
  }

  .icon-button .material-symbols-outlined,
  .mobile-menu-toggle .material-symbols-outlined,
  .user-avatar-btn .material-symbols-outlined {
    font-size: var(--font-size-title);
  }

  .dropdown-menu {
    margin-top: 6px;
    min-width: 180px;
    max-width: min(240px, calc(100vw - 12px));
  }

  .dropdown-header,
  .dropdown-item {
    padding-left: 12px;
    padding-right: 12px;
  }
}

.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  margin-left: 0;
  height: 32px;
  padding: 0;
  border-radius: 8px;
  background: transparent;
  border: 0;
  color: inherit;
  min-width: 0;
}

.brand-logo {
  display: block;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  object-fit: contain;
  border-radius: 4px;
}

.top-bar.sidebar-collapsed .brand {
  display: none;
}

.server-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--primary-text);
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
  background: transparent;
  border: 0;
  color: var(--primary-text);
  cursor: pointer;
  padding: 0;
  border-radius: 8px;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
  position: relative;
}

.icon-button .material-symbols-outlined,
.mobile-menu-toggle .material-symbols-outlined,
.user-avatar-btn .material-symbols-outlined {
  font-size: 18px;
  line-height: 1;
}

.icon-button:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.dropdown-open > .icon-button,
.dropdown-open > .user-avatar-btn {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.notification-btn .notification-badge {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 8px;
  height: 8px;
  background-color: var(--danger-color);
  border-radius: 50%;
  border: 2px solid var(--secondary-bg);
}

.dropdown {
  position: relative;
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background-color: var(--tertiary-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  min-width: 168px;
  padding: 4px;
  box-shadow: var(--shadow-overlay-soft);
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px) scale(0.98);
  transform-origin: top right;
  transition:
    opacity var(--transition-fast),
    visibility var(--transition-fast),
    transform var(--transition-fast);
}

.dropdown-open .dropdown-menu {
  opacity: 1;
  visibility: visible;
  transform: translateY(0) scale(1);
}

.dropdown-header {
  padding: 4px 6px;
  border-bottom: 0;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--secondary-text);
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.35;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 28px;
  padding: 4px 6px;
  background: none;
  border: none;
  color: var(--primary-text);
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 400;
  line-height: 1.35;
  transition: background-color 0.2s;
  white-space: nowrap;
  text-align: left;
  border-radius: 6px;
}

.dropdown-item .material-symbols-outlined,
.dropdown-header .material-symbols-outlined {
  flex-shrink: 0;
  font-size: 16px;
  line-height: 1;
}

.dropdown-item:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.dropdown-item.danger {
  color: var(--danger-color);
}

.dropdown-item.danger:hover {
  background-color: color-mix(in srgb, var(--danger-color) 14%, transparent);
}

.dropdown-divider {
  height: 1px;
  background-color: var(--border-color);
  margin: 4px -4px;
}

.user-avatar-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: transparent;
  border: 0;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.user-avatar-btn:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}
</style>
