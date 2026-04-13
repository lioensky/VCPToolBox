<template>
  <header class="top-bar">
    <div class="top-bar-content">
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
        <button
          class="sidebar-collapse-toggle"
          @click="toggleSidebarCollapse"
          aria-label="折叠侧边栏"
          :title="isSidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
        >
          <span class="material-symbols-outlined" aria-hidden="true">
            {{ isSidebarCollapsed ? "chevron_right" : "chevron_left" }}
          </span>
        </button>
        <button
          type="button"
          class="brand"
          @click="goToDashboard"
          aria-label="返回仪表盘"
        >
          <span class="server-title">VCPToolBox</span>
        </button>
      </div>

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
              <span class="material-symbols-outlined">{{
                theme === "dark" ? "light_mode" : "dark_mode"
              }}</span>
              <span>{{ theme === "dark" ? "切换亮色" : "切换暗色" }}</span>
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
import { useAppStore } from "@/stores/app";
import { useAuthStore } from "@/stores/auth";
import { showMessage, createLogger } from "@/utils";

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
  appStore.setTheme(theme.value === "dark" ? "light" : "dark");
  emit("closeAllMenus");
}

function toggleAnimations() {
  appStore.toggleAnimations();
  emit("closeAllMenus");
}

async function restartServer() {
  if (!confirm("您确定要重启服务器吗？")) return;
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
  if (!confirm("确定要退出登录吗？")) return;
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
  height: var(--app-top-bar-height, 60px);
  background-color: var(--secondary-bg);
  backdrop-filter: var(--glass-blur, blur(12px));
  -webkit-backdrop-filter: var(--glass-blur, blur(12px));
  border-bottom: 1px solid var(--border-color);
  z-index: 1000;
  display: flex;
  align-items: center;
  padding: 0 20px;
}

.top-bar-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  max-width: 1800px;
  margin: 0 auto;
}

.top-bar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mobile-menu-toggle,
.sidebar-collapse-toggle {
  display: none;
  background: none;
  border: none;
  color: var(--primary-text);
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  transition: background-color 0.2s;
}

.mobile-menu-toggle:hover,
.sidebar-collapse-toggle:hover {
  background-color: var(--accent-bg);
}

.mobile-menu-toggle:focus-visible,
.sidebar-collapse-toggle:focus-visible,
.brand:focus-visible,
.icon-button:focus-visible,
.user-avatar-btn:focus-visible,
.dropdown-item:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .top-bar {
    padding: 0 12px;
  }

  .top-bar-left {
    min-width: 0;
    flex: 1;
    gap: 8px;
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
    padding: 0 10px;
  }

  .top-bar-left {
    gap: 6px;
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

.sidebar-collapse-toggle {
  display: block;
  /* 侧边栏收缩后宽度 72px，图标中心点在 36px 位置
     顶栏 padding-left 为 20px，按钮宽度约 32px
     按钮中心点需要对齐 36px，即按钮左边缘应在 36px - 16px = 20px
     由于顶栏已有 20px padding，margin-left 设为 0 即可对齐 */
  margin-left: 0;
}

@media (max-width: 768px) {
  .sidebar-collapse-toggle {
    display: none;
  }
}

@media (min-width: 769px) {
  .sidebar-collapse-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

.brand {
  display: flex;
  align-items: center;
  gap: 0;
  cursor: pointer;
  margin-left: 8px;
  background: none;
  border: 0;
  padding: 0;
  color: inherit;
}

.server-title {
  font-size: var(--font-size-title);
  font-weight: 700;
  color: var(--primary-text);
  letter-spacing: 0.5px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon-button {
  background: none;
  border: none;
  color: var(--primary-text);
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
  position: relative;
}

.icon-button:hover {
  background-color: var(--accent-bg);
}

.notification-btn .notification-badge {
  position: absolute;
  top: 6px;
  right: 6px;
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
  margin-top: 8px;
  background-color: var(--tertiary-bg);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  min-width: 200px;
  box-shadow: var(--overlay-panel-shadow);
  opacity: 0;
  visibility: hidden;
  transform: translateY(-10px);
  transition:
    opacity var(--transition-fast),
    visibility var(--transition-fast),
    transform var(--transition-fast);
}

.dropdown-open .dropdown-menu {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.dropdown-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  font-weight: 600;
  color: var(--primary-text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 16px;
  background: none;
  border: none;
  color: var(--primary-text);
  cursor: pointer;
  font-size: var(--font-size-body);
  transition: background-color 0.2s;
  white-space: nowrap;
  text-align: left;
}

.dropdown-item:hover {
  background-color: var(--accent-bg);
}

.dropdown-item.danger {
  color: var(--danger-color);
}

.dropdown-item.danger:hover {
  background-color: var(--danger-bg);
}

.dropdown-divider {
  height: 1px;
  background-color: var(--border-color);
  margin: 4px 0;
}

.user-avatar-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--accent-bg);
  border: 2px solid var(--border-color);
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.user-avatar-btn:hover {
  border-color: var(--highlight-text);
  background-color: var(--button-bg);
  color: var(--on-accent-text);
}
</style>
