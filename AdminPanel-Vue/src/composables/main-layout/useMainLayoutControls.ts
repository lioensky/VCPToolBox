import { ref } from "vue";

export function useMainLayoutControls() {
  const isMobileMenuOpen = ref(false);
  const isImmersiveMode = ref(false);
  const isSidebarCollapsed = ref(false);
  const isHoveringSidebar = ref(false);
  const isHoverEnabled = ref(false);
  const isCommandPaletteOpen = ref(false);
  const isSystemMenuOpen = ref(false);
  const isUserMenuOpen = ref(false);
  const hasNotifications = ref(false);

  function openCommandPalette() {
    isCommandPaletteOpen.value = true;
    closeMobileMenu();
    closeAllMenus();
  }

  function closeCommandPalette() {
    isCommandPaletteOpen.value = false;
  }

  function toggleMobileMenu() {
    isMobileMenuOpen.value = !isMobileMenuOpen.value;
  }

  function closeMobileMenu() {
    isMobileMenuOpen.value = false;
  }

  function toggleSidebarCollapse() {
    isSidebarCollapsed.value = !isSidebarCollapsed.value;
    if (!isSidebarCollapsed.value) {
      isHoverEnabled.value = false;
    }
  }

  function toggleSystemMenu() {
    isSystemMenuOpen.value = !isSystemMenuOpen.value;
    isUserMenuOpen.value = false;
  }

  function toggleUserMenu() {
    isUserMenuOpen.value = !isUserMenuOpen.value;
    isSystemMenuOpen.value = false;
  }

  function closeAllMenus() {
    isSystemMenuOpen.value = false;
    isUserMenuOpen.value = false;
  }

  function closeTransientUi() {
    closeCommandPalette();
    closeMobileMenu();
    closeAllMenus();
  }

  function enterImmersiveMode() {
    isImmersiveMode.value = true;
  }

  function exitImmersiveMode() {
    isImmersiveMode.value = false;
  }

  return {
    isMobileMenuOpen,
    isImmersiveMode,
    isSidebarCollapsed,
    isHoveringSidebar,
    isHoverEnabled,
    isCommandPaletteOpen,
    isSystemMenuOpen,
    isUserMenuOpen,
    hasNotifications,
    openCommandPalette,
    closeCommandPalette,
    toggleMobileMenu,
    closeMobileMenu,
    toggleSidebarCollapse,
    toggleSystemMenu,
    toggleUserMenu,
    closeAllMenus,
    closeTransientUi,
    enterImmersiveMode,
    exitImmersiveMode,
  };
}

export type MainLayoutControls = ReturnType<typeof useMainLayoutControls>;
