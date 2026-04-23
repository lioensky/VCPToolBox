import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from "vue-router";
import type { PluginInfo } from "@/types/api.plugin";

export type AppRouteGroup =
  | "core"
  | "agent"
  | "tools"
  | "rag"
  | "plugins"
  | "other";

interface AppRouteDefinition {
  id: string;
  routeName: string;
  path: string;
  title: string;
  icon?: string;
  requiresAuth: boolean;
  navGroup?: AppRouteGroup;
  showInSidebar: boolean;
  component: () => Promise<unknown>;
}

export interface AppNavItem {
  target?: string;
  label?: string;
  icon?: string;
  category?: string;
  pluginName?: string;
  enabled?: boolean;
}

const NAV_GROUP_LABELS: Record<AppRouteGroup, string> = {
  core: "———— 核 心 功 能 ————",
  agent: "———— Agent 相 关 ————",
  tools: "———— 工 具 相 关 ————",
  rag: "———— RAG 相 关 ————",
  plugins: "———— 插 件 中 心 ————",
  other: "———— 其 他 ————",
};

export const APP_ROUTE_MANIFEST = [
  {
    id: "login",
    routeName: "Login",
    path: "/login",
    title: "登录",
    icon: "login",
    requiresAuth: false,
    showInSidebar: false,
    component: () => import("@/views/Login.vue"),
  },
  {
    id: "dashboard",
    routeName: "Dashboard",
    path: "/dashboard",
    title: "仪表盘",
    icon: "dashboard",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/Dashboard.vue"),
  },
  {
    id: "base-config",
    routeName: "BaseConfig",
    path: "/base-config",
    title: "全局基础配置",
    icon: "settings",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/BaseConfig.vue"),
  },
  {
    id: "daily-notes-manager",
    routeName: "DailyNotesManager",
    path: "/daily-notes-manager",
    title: "日记知识库管理",
    icon: "description",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/DailyNotesManager.vue"),
  },
  {
    id: "vcp-forum",
    routeName: "VcpForum",
    path: "/vcp-forum",
    title: "VCP 论坛",
    icon: "forum",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/VcpForum.vue"),
  },
  {
    id: "forum-assistant-config",
    routeName: "ForumAssistantConfig",
    path: "/forum-assistant-config",
    title: "任务派发中心",
    icon: "explore",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/ForumAssistantConfig.vue"),
  },
  {
    id: "image-cache-editor",
    routeName: "ImageCacheEditor",
    path: "/image-cache-editor",
    title: "多媒体 Base64 编辑器",
    icon: "photo_library",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/ImageCacheEditor.vue"),
  },
  {
    id: "semantic-groups-editor",
    routeName: "SemanticGroupsEditor",
    path: "/semantic-groups-editor",
    title: "语义组编辑器",
    icon: "hub",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/SemanticGroupsEditor.vue"),
  },
  {
    id: "vcptavern-editor",
    routeName: "VcptavernEditor",
    path: "/vcptavern-editor",
    title: "VCPTavern 预设编辑",
    icon: "casino",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/VcptavernEditor.vue"),
  },
  {
    id: "sarprompt-editor",
    routeName: "SarPromptEditor",
    path: "/sarprompt-editor",
    title: "多模型提示词管理",
    icon: "psychology_alt",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/SarPromptEditor.vue"),
  },
  {
    id: "schedule-manager",
    routeName: "ScheduleManager",
    path: "/schedule-manager",
    title: "日程管理",
    icon: "calendar_month",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/ScheduleManager.vue"),
  },
  {
    id: "dream-manager",
    routeName: "DreamManager",
    path: "/dream-manager",
    title: "梦境审批",
    icon: "nights_stay",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/DreamManager.vue"),
  },
  {
    id: "server-log-viewer",
    routeName: "ServerLogViewer",
    path: "/server-log-viewer",
    title: "服务器日志",
    icon: "terminal",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
    component: () => import("@/views/ServerLogViewer.vue"),
  },
  {
    id: "agent-files-editor",
    routeName: "AgentFilesEditor",
    path: "/agent-files-editor",
    title: "Agent 管理器",
    icon: "smart_toy",
    requiresAuth: true,
    navGroup: "agent",
    showInSidebar: true,
    component: () => import("@/views/AgentFilesEditor.vue"),
  },
  {
    id: "agent-assistant-config",
    routeName: "AgentAssistantConfig",
    path: "/agent-assistant-config",
    title: "Agent 助手配置",
    icon: "diversity_3",
    requiresAuth: true,
    navGroup: "agent",
    showInSidebar: true,
    component: () => import("@/views/AgentAssistantConfig.vue"),
  },
  {
    id: "agent-scores",
    routeName: "AgentScores",
    path: "/agent-scores",
    title: "Agent 积分排行榜",
    icon: "leaderboard",
    requiresAuth: true,
    navGroup: "agent",
    showInSidebar: true,
    component: () => import("@/views/AgentScores.vue"),
  },
  {
    id: "toolbox-manager",
    routeName: "ToolboxManager",
    path: "/toolbox-manager",
    title: "Toolbox 管理器",
    icon: "inventory_2",
    requiresAuth: true,
    navGroup: "tools",
    showInSidebar: true,
    component: () => import("@/views/ToolboxManager.vue"),
  },
  {
    id: "tvs-files-editor",
    routeName: "TvsFilesEditor",
    path: "/tvs-files-editor",
    title: "高级变量编辑器",
    icon: "data_object",
    requiresAuth: true,
    navGroup: "tools",
    showInSidebar: true,
    component: () => import("@/views/TvsFilesEditor.vue"),
  },
  {
    id: "tool-list-editor",
    routeName: "ToolListEditor",
    path: "/tool-list-editor",
    title: "工具列表配置编辑器",
    icon: "construction",
    requiresAuth: true,
    navGroup: "tools",
    showInSidebar: true,
    component: () => import("@/views/ToolListEditor.vue"),
  },
  {
    id: "dynamic-tools-manager",
    routeName: "DynamicToolsManager",
    path: "/dynamic-tools-manager",
    title: "动态工具清单",
    icon: "dynamic_feed",
    requiresAuth: true,
    navGroup: "tools",
    showInSidebar: true,
    component: () => import("@/views/DynamicToolsManager.vue"),
  },
  {
    id: "preprocessor-order-manager",
    routeName: "PreprocessorOrderManager",
    path: "/preprocessor-order-manager",
    title: "预处理器顺序管理",
    icon: "sort",
    requiresAuth: true,
    navGroup: "tools",
    showInSidebar: true,
    component: () => import("@/views/PreprocessorOrderManager.vue"),
  },
  {
    id: "tool-approval-manager",
    routeName: "ToolApprovalManager",
    path: "/tool-approval-manager",
    title: "插件调用审核管理",
    icon: "verified_user",
    requiresAuth: true,
    navGroup: "tools",
    showInSidebar: true,
    component: () => import("@/views/ToolApprovalManager.vue"),
  },
  {
    id: "thinking-chains-editor",
    routeName: "ThinkingChainsEditor",
    path: "/thinking-chains-editor",
    title: "思维链编辑器",
    icon: "psychology",
    requiresAuth: true,
    navGroup: "rag",
    showInSidebar: true,
    component: () => import("@/views/ThinkingChainsEditor.vue"),
  },
  {
    id: "rag-tuning",
    routeName: "RagTuning",
    path: "/rag-tuning",
    title: "浪潮 RAG 调参",
    icon: "tune",
    requiresAuth: true,
    navGroup: "rag",
    showInSidebar: true,
    component: () => import("@/views/RagTuning.vue"),
  },
  {
    id: "placeholder-viewer",
    routeName: "PlaceholderViewer",
    path: "/placeholder-viewer",
    title: "占位符查看器",
    icon: "view_list",
    requiresAuth: true,
    navGroup: "other",
    showInSidebar: true,
    component: () => import("@/views/PlaceholderViewer.vue"),
  },
  {
    id: "plugins",
    routeName: "PluginsHub",
    path: "/plugins",
    title: "插件中心",
    icon: "extension",
    requiresAuth: true,
    navGroup: "plugins",
    showInSidebar: true,
    component: () => import("@/views/PluginsHub.vue"),
  },
  {
    id: "plugin-config",
    routeName: "PluginConfig",
    path: "/plugin/:pluginName/config",
    title: "插件配置",
    icon: "extension",
    requiresAuth: true,
    showInSidebar: false,
    component: () => import("@/views/PluginConfig.vue"),
  },
] as const satisfies readonly AppRouteDefinition[];

export type AppRouteId = (typeof APP_ROUTE_MANIFEST)[number]["id"];
export type AppRouteMeta = (typeof APP_ROUTE_MANIFEST)[number];

export const APP_DEFAULT_ROUTE_ID: AppRouteId = "dashboard";

const APP_ROUTE_BY_ID = new Map<AppRouteId, AppRouteMeta>(
  APP_ROUTE_MANIFEST.map((route) => [route.id, route] as const)
);

const APP_ROUTE_IDS = new Set<AppRouteId>(
  APP_ROUTE_MANIFEST.map((route) => route.id)
);

const APP_ROUTE_BY_NAME = new Map<string, AppRouteMeta>(
  APP_ROUTE_MANIFEST.map((route) => [route.routeName, route] as const)
);

const APP_ROUTE_BY_PATH = new Map<string, AppRouteMeta>(
  APP_ROUTE_MANIFEST.map((route) => [route.path, route] as const)
);

export function getAppRouteMetaById(routeId: AppRouteId): AppRouteMeta {
  return APP_ROUTE_BY_ID.get(routeId) ?? APP_ROUTE_BY_ID.get(APP_DEFAULT_ROUTE_ID)!;
}

export function isAppRouteId(value: string): value is AppRouteId {
  return APP_ROUTE_IDS.has(value as AppRouteId);
}

export function getAppRouteMetaByRouteName(
  routeName: string | symbol | null | undefined
): AppRouteMeta | undefined {
  if (typeof routeName !== "string") {
    return undefined;
  }

  return APP_ROUTE_BY_NAME.get(routeName);
}

export function getAppRouteMetaByPath(path: string): AppRouteMeta | undefined {
  return APP_ROUTE_BY_PATH.get(path);
}

export function getAppRoutePath(routeId: AppRouteId): string {
  return getAppRouteMetaById(routeId).path;
}

export function getAppRouteTitle(routeId: AppRouteId): string {
  return getAppRouteMetaById(routeId).title;
}

function getLegacyPluginNavLabel(
  pluginName: string,
  navItems: readonly AppNavItem[] = []
): string | undefined {
  return navItems.find(
    (item) => item.pluginName === pluginName && item.label
  )?.label;
}

function getPluginRouteLabel(
  pluginName: string,
  plugins: readonly PluginInfo[] = [],
  navItems: readonly AppNavItem[] = []
): string {
  if (!pluginName) {
    return "Plugin Config";
  }

  const plugin = plugins.find(
    (item) => item.manifest.name === pluginName || item.name === pluginName
  );

  return (
    plugin?.manifest.displayName?.trim() ||
    getLegacyPluginNavLabel(pluginName, navItems) ||
    pluginName
  );
}

export function buildSidebarNavItems(): AppNavItem[] {
  const items: AppNavItem[] = [];
  let lastGroup: AppRouteGroup | undefined;

  for (const route of APP_ROUTE_MANIFEST) {
    if (!route.showInSidebar || !route.navGroup) {
      continue;
    }

    if (route.navGroup !== lastGroup) {
      items.push({ category: NAV_GROUP_LABELS[route.navGroup] });
      lastGroup = route.navGroup;
    }

    items.push({
      target: route.id,
      label: route.title,
      icon: route.icon,
    });
  }

  return items;
}

export function resolveAppNavigationLocation(
  target: string,
  pluginName?: string
): RouteLocationRaw {
  if (pluginName) {
    return {
      name: "PluginConfig",
      params: { pluginName },
    };
  }

  if (isAppRouteId(target)) {
    return {
      name: getAppRouteMetaById(target).routeName,
    };
  }

  if (target.startsWith("/")) {
    return { path: target };
  }

  return { path: `/${target}` };
}

export function resolveAppRouteTitle(
  route: RouteLocationNormalizedLoaded,
  options: {
    plugins?: readonly PluginInfo[];
    navItems?: readonly AppNavItem[];
  } = {}
): string | undefined {
  const namedRoute = getAppRouteMetaByRouteName(route.name);
  if (namedRoute) {
    if (namedRoute.routeName === "PluginConfig") {
      return getPluginRouteLabel(
        String(route.params.pluginName || ""),
        options.plugins,
        options.navItems
      );
    }

    return namedRoute.title;
  }

  if (route.name === "PluginConfig") {
    return getPluginRouteLabel(
      String(route.params.pluginName || ""),
      options.plugins,
      options.navItems
    );
  }

  const fallbackTitle = getAppRouteMetaByPath(route.path)?.title;
  if (fallbackTitle) {
    return fallbackTitle;
  }

  const pathTarget = route.path.replace(/^\//, "").split("/")[0] || "dashboard";
  return options.navItems?.find(
    (item) => item.target === pathTarget && item.label
  )?.label;
}
