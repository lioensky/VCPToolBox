import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as VueModule from "vue";

const mockedNavigationState = vi.hoisted(() => ({
  recentVisits: { value: [] as Array<Record<string, unknown>> },
  navigationUsage: {
    value: {} as Record<string, { count: number; lastVisitedAt: number }>,
  },
  recordNavigationVisit: vi.fn(
    ({
      recentVisits,
      navigationUsage,
    }: {
      recentVisits: Array<Record<string, unknown>>;
      navigationUsage: Record<string, { count: number; lastVisitedAt: number }>;
    }) => ({
      recentVisits: [...recentVisits],
      navigationUsage: { ...navigationUsage },
    })
  ),
}));

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof VueModule>("vue");
  return {
    ...actual,
    onMounted: () => {},
    onUnmounted: () => {},
  };
});

import { useMainLayoutState } from "@/composables/useMainLayoutState";

const mockPush = vi.fn();

const mockRoute = {
  path: "/dashboard",
  name: "Dashboard",
  params: {} as Record<string, string>,
  fullPath: "/dashboard",
};

const mockAppStore = {
  navItems: [
    { target: "dashboard", label: "Dashboard" },
    { pluginName: "demo", label: "Demo Plugin" },
  ],
  plugins: [],
  pinnedPluginNames: [],
  loadPlugins: vi.fn(),
  markPluginsLoaded: vi.fn(),
};

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useRoute: () => mockRoute,
}));

vi.mock("@/stores/app", () => ({
  useAppStore: () => mockAppStore,
}));

vi.mock("@/composables/useRecentVisits", () => ({
  useRecentVisits: () => mockedNavigationState.recentVisits,
  useNavigationUsage: () => mockedNavigationState.navigationUsage,
  recordNavigationVisit: mockedNavigationState.recordNavigationVisit,
}));

vi.mock("@/utils", () => ({
  showMessage: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("useMainLayoutState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedNavigationState.recentVisits.value = [];
    mockedNavigationState.navigationUsage.value = {};
    mockRoute.path = "/dashboard";
    mockRoute.name = "Dashboard";
    mockRoute.params = {};
    mockRoute.fullPath = "/dashboard";
    mockAppStore.navItems = [
      { target: "dashboard", label: "Dashboard" },
      { pluginName: "demo", label: "Demo Plugin" },
    ];
    mockAppStore.plugins = [];
    mockAppStore.pinnedPluginNames = [];
  });

  it("computes page title and handles navigation side effects", () => {
    const state = useMainLayoutState();

    expect(state.currentPageTitle.value).toBe("仪表盘");

    state.toggleMobileMenu();
    state.toggleSystemMenu();
    state.openCommandPalette();

    state.navigateTo("base-config");

    expect(mockPush).toHaveBeenCalledWith({ name: "BaseConfig" });
    expect(mockedNavigationState.recordNavigationVisit).toHaveBeenCalledWith(
      expect.objectContaining({ target: "base-config" })
    );
    expect(state.isMobileMenuOpen.value).toBe(false);
    expect(state.isSystemMenuOpen.value).toBe(false);
    expect(state.isUserMenuOpen.value).toBe(false);
    expect(state.isCommandPaletteOpen.value).toBe(false);
  });

  it("resolves plugin title when route name is PluginConfig", () => {
    mockRoute.path = "/plugin/demo/config";
    mockRoute.fullPath = "/plugin/demo/config";
    mockRoute.name = "PluginConfig";
    mockRoute.params = { pluginName: "demo" };

    const state = useMainLayoutState();

    expect(state.currentPageTitle.value).toBe("Demo Plugin");

    state.navigateTo("ignored", "demo");
    expect(mockPush).toHaveBeenCalledWith({
      name: "PluginConfig",
      params: { pluginName: "demo" },
    });
  });

  it("resets hover-enabled flag after sidebar expands back", () => {
    const state = useMainLayoutState();

    state.toggleSidebarCollapse();
    state.isHoverEnabled.value = true;
    state.toggleSidebarCollapse();

    expect(state.isSidebarCollapsed.value).toBe(false);
    expect(state.isHoverEnabled.value).toBe(false);
  });

  it("handles mobile menu, dropdowns, and command palette consistently", () => {
    const state = useMainLayoutState();

    expect(state.isMobileMenuOpen.value).toBe(false);
    state.toggleMobileMenu();
    expect(state.isMobileMenuOpen.value).toBe(true);

    state.toggleSystemMenu();
    expect(state.isSystemMenuOpen.value).toBe(true);
    expect(state.isUserMenuOpen.value).toBe(false);

    state.toggleUserMenu();
    expect(state.isUserMenuOpen.value).toBe(true);
    expect(state.isSystemMenuOpen.value).toBe(false);

    state.openCommandPalette();
    expect(state.isCommandPaletteOpen.value).toBe(true);

    state.closeCommandPalette();
    state.closeMobileMenu();
    expect(state.isMobileMenuOpen.value).toBe(false);

    state.toggleSidebarCollapse();
    const collapsedState = state.isSidebarCollapsed.value;

    state.toggleMobileMenu();
    state.closeMobileMenu();

    expect(state.isSidebarCollapsed.value).toBe(collapsedState);
  });
});
