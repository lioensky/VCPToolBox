import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from "vue-router";
import type { PluginInfo } from "@/types/api.plugin";

export type AppRouteGroup =
  | "core"
  | "agentContent"
  | "knowledge"
  | "toolsPlugins";

export type AppRouteId =
  | "login"
  | "dashboard"
  | "base-config"
  | "dynamic-tools-manager"
  | "daily-notes-manager"
  | "vcp-forum"
  | "image-cache-editor"
  | "emoji-gallery"
  | "semantic-groups-editor"
  | "vcptavern-editor"
  | "agent-files-editor"
  | "agent-assistant-config"
  | "forum-assistant-config"
  | "agent-scores"
  | "toolbox-manager"
  | "tvs-files-editor"
  | "tool-list-editor"
  | "preprocessor-order-manager"
  | "tool-approval-manager"
  | "thinking-chains-editor"
  | "rag-tuning"
  | "schedule-manager"
  | "dream-manager"
  | "server-log-viewer"
  | "placeholder-viewer"
  | "plugins"
  | "plugin-store"
  | "plugin-config";

export interface AppRouteMeta {
  id: AppRouteId;
  routeName: string;
  path: string;
  title: string;
  icon?: string;
  requiresAuth: boolean;
  navGroup?: AppRouteGroup;
  showInSidebar: boolean;
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
  core: "核心",
  agentContent: "Agent & 内容",
  knowledge: "知识 & RAG",
  toolsPlugins: "工具 & 插件",
};

export const APP_ROUTE_MANIFEST: readonly AppRouteMeta[] = [
  {
    id: "login",
    routeName: "Login",
    path: "/login",
    title: "登录",
    icon: "login",
    requiresAuth: false,
    showInSidebar: false,
  },
  // ── 核心 ──
  {
    id: "dashboard",
    routeName: "Dashboard",
    path: "/dashboard",
    title: "仪表盘",
    icon: "dashboard",
    requiresAuth: true,
    navGroup: "core",
    showInSidebar: true,
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
  },
  // ── Agent & 内容 ──
  {
    id: "agent-files-editor",
    routeName: "AgentFilesEditor",
    path: "/agent-files-editor",
    title: "Agent 管理器",
    icon: "smart_toy",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "agent-assistant-config",
    routeName: "AgentAssistantConfig",
    path: "/agent-assistant-config",
    title: "Agent 通讯配置",
    icon: "diversity_3",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "forum-assistant-config",
    routeName: "ForumAssistantConfig",
    path: "/forum-assistant-config",
    title: "任务派发中心",
    icon: "assignment",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "agent-scores",
    routeName: "AgentScores",
    path: "/agent-scores",
    title: "Agent 积分排行榜",
    icon: "leaderboard",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "dream-manager",
    routeName: "DreamManager",
    path: "/dream-manager",
    title: "梦境审批",
    icon: "nights_stay",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "schedule-manager",
    routeName: "ScheduleManager",
    path: "/schedule-manager",
    title: "日程管理",
    icon: "calendar_month",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "vcptavern-editor",
    routeName: "VcptavernEditor",
    path: "/vcptavern-editor",
    title: "VCPTavern 预设编辑",
    icon: "casino",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "vcp-forum",
    routeName: "VcpForum",
    path: "/vcp-forum",
    title: "VCP 论坛",
    icon: "forum",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "emoji-gallery",
    routeName: "EmojiGallery",
    path: "/emoji-gallery",
    title: "表情包画廊",
    icon: "mood",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  {
    id: "image-cache-editor",
    routeName: "ImageCacheEditor",
    path: "/image-cache-editor",
    title: "多媒体 Base64 编辑器",
    icon: "photo_library",
    requiresAuth: true,
    navGroup: "agentContent",
    showInSidebar: true,
  },
  // ── 知识 & RAG ──
  {
    id: "daily-notes-manager",
    routeName: "DailyNotesManager",
    path: "/daily-notes-manager",
    title: "日记知识库管理",
    icon: "description",
    requiresAuth: true,
    navGroup: "knowledge",
    showInSidebar: true,
  },
  {
    id: "semantic-groups-editor",
    routeName: "SemanticGroupsEditor",
    path: "/semantic-groups-editor",
    title: "语义组编辑器",
    icon: "hub",
    requiresAuth: true,
    navGroup: "knowledge",
    showInSidebar: true,
  },
  {
    id: "thinking-chains-editor",
    routeName: "ThinkingChainsEditor",
    path: "/thinking-chains-editor",
    title: "思维链编辑器",
    icon: "psychology",
    requiresAuth: true,
    navGroup: "knowledge",
    showInSidebar: true,
  },
  {
    id: "rag-tuning",
    routeName: "RagTuning",
    path: "/rag-tuning",
    title: "浪潮 RAG 调参",
    icon: "tune",
    requiresAuth: true,
    navGroup: "knowledge",
    showInSidebar: true,
  },
  // ── 工具 & 插件 ──
  {
    id: "dynamic-tools-manager",
    routeName: "DynamicToolsManager",
    path: "/dynamic-tools-manager",
    title: "动态工具清单",
    icon: "dynamic_feed",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "toolbox-manager",
    routeName: "ToolboxManager",
    path: "/toolbox-manager",
    title: "Toolbox 管理器",
    icon: "inventory_2",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "tvs-files-editor",
    routeName: "TvsFilesEditor",
    path: "/tvs-files-editor",
    title: "高级变量编辑器",
    icon: "data_object",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "tool-list-editor",
    routeName: "ToolListEditor",
    path: "/tool-list-editor",
    title: "工具列表配置编辑器",
    icon: "construction",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "preprocessor-order-manager",
    routeName: "PreprocessorOrderManager",
    path: "/preprocessor-order-manager",
    title: "预处理器顺序管理",
    icon: "sort",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "tool-approval-manager",
    routeName: "ToolApprovalManager",
    path: "/tool-approval-manager",
    title: "插件调用审核管理",
    icon: "verified_user",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "plugins",
    routeName: "PluginsHub",
    path: "/plugins",
    title: "插件中心",
    icon: "extension",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "plugin-store",
    routeName: "PluginStore",
    path: "/plugin-store",
    title: "插件商店",
    icon: "storefront",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "placeholder-viewer",
    routeName: "PlaceholderViewer",
    path: "/placeholder-viewer",
    title: "占位符查看器",
    icon: "view_list",
    requiresAuth: true,
    navGroup: "toolsPlugins",
    showInSidebar: true,
  },
  {
    id: "plugin-config",
    routeName: "PluginConfig",
    path: "/plugin/:pluginName/config",
    title: "插件配置",
    icon: "extension",
    requiresAuth: true,
    showInSidebar: false,
  },
] as const;

export const APP_DEFAULT_ROUTE_ID: AppRouteId = "dashboard";

const APP_ROUTE_BY_ID = new Map(
  APP_ROUTE_MANIFEST.map((route) => [route.id, route] as const)
);

const APP_ROUTE_IDS = new Set(APP_ROUTE_MANIFEST.map((route) => route.id));

const APP_ROUTE_BY_NAME = new Map(
  APP_ROUTE_MANIFEST.map((route) => [route.routeName, route] as const)
);

const APP_ROUTE_BY_PATH = new Map(
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

export function resolveAppRouteTitle(
  route: RouteLocationNormalizedLoaded,
  context?: {
    navItems?: readonly AppNavItem[];
    plugins?: readonly PluginInfo[];
  }
): string | undefined {
  const namedRoute = getAppRouteMetaByRouteName(route.name);
  if (namedRoute) {
    if (namedRoute.id === "plugin-config" && context?.plugins) {
      const pluginNameParam = route.params.pluginName;
      const pluginName =
        typeof pluginNameParam === "string" ? pluginNameParam : undefined;
      if (pluginName) {
        const plugin = context.plugins.find(
          (item) => (item.manifest.name || item.name) === pluginName
        );
        if (plugin) {
          const displayName =
            plugin.manifest.displayName?.trim() ||
            plugin.manifest.name ||
            plugin.name;
          return `${namedRoute.title} · ${displayName}`;
        }
      }
    }
    return namedRoute.title;
  }

  const navItem = context?.navItems?.find((item) => item.target === route.path);
  if (navItem?.label) {
    return navItem.label;
  }

  return getAppRouteMetaByPath(route.path)?.title;
}

export function resolveAppNavigationLocation(
  target: string,
  pluginName?: string
): RouteLocationRaw {
  if (pluginName) {
    return {
      name: getAppRouteMetaById("plugin-config").routeName,
      params: { pluginName },
    };
  }

  const pluginTargetMatch = target.match(/^plugin-(.+)-config$/);
  if (pluginTargetMatch) {
    return {
      name: getAppRouteMetaById("plugin-config").routeName,
      params: { pluginName: pluginTargetMatch[1] },
    };
  }

  if (isAppRouteId(target)) {
    return { name: getAppRouteMetaById(target).routeName };
  }

  return { path: `/${target}` };
}
