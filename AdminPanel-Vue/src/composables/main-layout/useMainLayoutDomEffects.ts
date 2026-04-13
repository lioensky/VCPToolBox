import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from "vue";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { showMessage } from "@/utils";
import { createLogger } from "@/utils/logger";
import type { MainLayoutControls } from "./useMainLayoutControls";

const logger = createLogger("MainLayout");
const MOBILE_LAYOUT_MEDIA_QUERY = "(max-width: 768px)";

interface MainLayoutDomEffectsOptions {
  route: RouteLocationNormalizedLoaded;
  appStore: {
    ensurePluginsLoaded: () => Promise<unknown>;
  };
  contentRef: Ref<HTMLElement | null>;
  controls: Pick<
    MainLayoutControls,
    | "closeAllMenus"
    | "closeMobileMenu"
    | "closeCommandPalette"
    | "closeTransientUi"
    | "enterImmersiveMode"
    | "exitImmersiveMode"
    | "isCommandPaletteOpen"
    | "isImmersiveMode"
    | "openCommandPalette"
  >;
}

export function useMainLayoutDomEffects({
  route,
  appStore,
  contentRef,
  controls,
}: MainLayoutDomEffectsOptions) {
  const showBackToTop = ref(false);

  let originalBodyOverflow = "";
  let brandElement: Element | null = null;
  let mobileLayoutQuery: MediaQueryList | null = null;
  let logoClickCount = 0;
  let logoClickTimer: number | null = null;

  function scrollToTop() {
    if (contentRef.value) {
      contentRef.value.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function handleScroll() {
    showBackToTop.value = (contentRef.value?.scrollTop || 0) > 300;
  }

  function clearLogoClickTimer(): void {
    if (logoClickTimer !== null) {
      globalThis.clearTimeout(logoClickTimer);
      logoClickTimer = null;
    }
  }

  function syncViewportHeight(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const viewportHeight = Math.round(
      window.visualViewport?.height ?? window.innerHeight
    );
    document.documentElement.style.setProperty(
      "--app-viewport-height",
      `${viewportHeight}px`
    );
  }

  function syncResponsiveLayoutState(): void {
    syncViewportHeight();

    if (typeof window === "undefined") {
      return;
    }

    if (!window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches) {
      controls.closeMobileMenu();
    }
  }

  function syncImmersiveDomState(enabled: boolean): void {
    if (typeof document === "undefined") {
      return;
    }

    document.documentElement.classList.toggle("ui-hidden-immersive", enabled);
  }

  function handleLogoClick(): void {
    logoClickCount += 1;

    if (logoClickCount === 1) {
      logoClickTimer = window.setTimeout(() => {
        logoClickCount = 0;
        logoClickTimer = null;
      }, 3000);
      return;
    }

    if (logoClickCount >= 5) {
      logoClickCount = 0;
      clearLogoClickTimer();
      controls.enterImmersiveMode();
    }
  }

  function handleClickOutside(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest(".dropdown")) {
      controls.closeAllMenus();
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === "k") {
      event.preventDefault();
      controls.openCommandPalette();
      return;
    }

    if (event.key !== "Escape") {
      return;
    }

    if (controls.isCommandPaletteOpen.value) {
      controls.closeCommandPalette();
      return;
    }

    if (controls.isImmersiveMode.value) {
      controls.exitImmersiveMode();
    }

    controls.closeAllMenus();
    controls.closeMobileMenu();
  }

  function handleViewportChange(): void {
    syncResponsiveLayoutState();
  }

  async function initializePluginNavigation() {
    try {
      await appStore.ensurePluginsLoaded();
    } catch (error) {
      logger.error("Failed to load plugin navigation:", error);
      showMessage(
        "Plugin list failed to load; using default navigation.",
        "warning"
      );
    }
  }

  async function initializeDomBindings() {
    if (typeof document === "undefined") {
      return;
    }

    originalBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    mobileLayoutQuery = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY);

    if (typeof mobileLayoutQuery.addEventListener === "function") {
      mobileLayoutQuery.addEventListener("change", handleViewportChange);
    } else {
      mobileLayoutQuery.addListener(handleViewportChange);
    }

    await nextTick();
    contentRef.value?.addEventListener("scroll", handleScroll, {
      passive: true,
    });

    brandElement = document.querySelector(".brand");
    brandElement?.addEventListener("click", handleLogoClick);

    handleScroll();
    syncResponsiveLayoutState();
    syncImmersiveDomState(controls.isImmersiveMode.value);
  }

  watch(
    () => route.fullPath,
    () => {
      controls.closeTransientUi();
      if (contentRef.value) {
        contentRef.value.scrollTop = 0;
      }
      showBackToTop.value = false;
    }
  );

  watch(controls.isImmersiveMode, (enabled) => {
    syncImmersiveDomState(enabled);
  });

  onMounted(() => {
    void initializePluginNavigation();
    void initializeDomBindings();
  });

  onUnmounted(() => {
    contentRef.value?.removeEventListener("scroll", handleScroll);

    if (typeof document !== "undefined") {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleKeydown);
      document.body.style.overflow = originalBodyOverflow;
      syncImmersiveDomState(false);
    }

    if (typeof window !== "undefined") {
      window.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
    }

    if (mobileLayoutQuery) {
      if (typeof mobileLayoutQuery.removeEventListener === "function") {
        mobileLayoutQuery.removeEventListener("change", handleViewportChange);
      } else {
        mobileLayoutQuery.removeListener(handleViewportChange);
      }
      mobileLayoutQuery = null;
    }

    brandElement?.removeEventListener("click", handleLogoClick);
    brandElement = null;
    logoClickCount = 0;
    clearLogoClickTimer();
  });

  return {
    showBackToTop,
    scrollToTop,
  };
}
