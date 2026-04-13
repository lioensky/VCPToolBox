import { computed } from "vue";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";
import {
  resolveAppNavigationLocation,
  resolveAppRouteTitle,
} from "@/app/routes/manifest";
import {
  recordNavigationVisit,
  useNavigationUsage,
  useRecentVisits,
} from "@/composables/useRecentVisits";
import type { NavItem } from "@/stores/app";
import type { PluginInfo } from "@/types/api.plugin";

interface MainLayoutNavigationOptions {
  router: Router;
  route: RouteLocationNormalizedLoaded;
  appStore: {
    navItems: readonly NavItem[];
    plugins: readonly PluginInfo[];
  };
  closeTransientUi: () => void;
}

export function useMainLayoutNavigation({
  router,
  route,
  appStore,
  closeTransientUi,
}: MainLayoutNavigationOptions) {
  const recentVisits = useRecentVisits();
  const navigationUsage = useNavigationUsage();

  const currentPageTitle = computed(
    () =>
      resolveAppRouteTitle(route, {
        navItems: appStore.navItems,
        plugins: appStore.plugins,
      }) || "Dashboard"
  );

  function navigateTo(target: string, pluginName?: string) {
    const nextNavigationState = recordNavigationVisit({
      target,
      navItems: appStore.navItems,
      plugins: appStore.plugins,
      recentVisits: recentVisits.value,
      navigationUsage: navigationUsage.value,
      pluginName,
    });

    recentVisits.value = nextNavigationState.recentVisits;
    navigationUsage.value = nextNavigationState.navigationUsage;

    void router.push(resolveAppNavigationLocation(target, pluginName));
    closeTransientUi();
  }

  return {
    currentPageTitle,
    recentVisits,
    navigationUsage,
    navigateTo,
  };
}
