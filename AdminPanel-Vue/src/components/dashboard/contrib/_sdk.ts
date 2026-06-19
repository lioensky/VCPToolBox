/**
 * 第三方仪表盘卡片 SDK（白名单）
 *
 * 设计目标：
 *   - 第三方贡献的卡片**只能**通过本 SDK 访问后端数据；
 *   - 仅暴露后端**已存在**的"读取/查询"类 API，避免误调写操作；
 *   - 所有调用复用现有 `admin_api/*` 鉴权通道，**无需后端改动**；
 *   - SDK 是构建期静态导入，第三方卡 import 不到的方法 = 不可调用。
 *
 * 命名约定：
 *   - 命名空间按数据域划分（system / weather / news / newApiMonitor / schedule / ...）；
 *   - 仅暴露 `get* / list*` 类方法；任何 `save / delete / restart / activate /
 *     deactivate / create / update` 等修改类方法一律不进 SDK。
 *
 * 安全 & 鉴权：
 *   - 所有方法的底层都是 `requestWithUi` / `executeRequest`，自动携带 Cookie；
 *   - 后端 `/admin_api/*` 路由本身已经过 [`adminPanelRoutes.js`](routes/adminPanelRoutes.js) 的鉴权中间件，
 *     第三方卡无法绕过；
 *   - 即使第三方卡作恶（例如尝试 import @/api/* 的写方法），项目根 ESLint 中
 *     `no-restricted-imports` 规则会在 contrib/ 子树阻止该 import（见 docs/DASHBOARD_CONTRIB_GUIDE.md）。
 *
 * 扩展原则：
 *   - 当社区呼声较高地需要某个新的"只读"端点时，先在对应 `@/api/*.ts` 添加方法，
 *     然后再在本 SDK 中"暴露"该方法即可；不要直接放行写操作。
 *
 * 详见：docs/DASHBOARD_CONTRIB_GUIDE.md
 */

import {
  systemApi,
  weatherApi,
  newsApi,
  newApiMonitorApi,
  scheduleApi,
} from "@/api";

// ─── 通用工具 / Composables ───────────────────────────────────────────
import { usePolling } from "@/composables/usePolling";
import { useRequest } from "@/composables/useRequest";
import { createLogger } from "@/utils/logger";
import { sanitizeExternalUrl } from "@/utils/url";

// ─── 类型透传（避免第三方卡 import 私有类型路径） ──────────────────────
export type {
  NewApiMonitorSummary,
  NewApiMonitorTrendItem,
  NewApiMonitorModelItem,
  NewApiMonitorQuery,
} from "@/api/newapi-monitor";
export type { Schedule } from "@/api/schedule";
export type { NewsItem } from "@/types/api.news";
export type {
  SystemResources,
  PM2Process,
  ServerLogResponse,
  ServerLogQuery,
} from "@/types/api.system";
export type { WeatherData, DailyWeather, HourlyWeather } from "@/api/weather";

/**
 * 卡片 SDK：所有可用的后端数据访问入口。
 *
 * 用法：
 * ```ts
 * import { cardSdk } from "@/components/dashboard/contrib/_sdk";
 *
 * const sys = await cardSdk.system.getSystemResources();
 * const weather = await cardSdk.weather.getWeather();
 *
 * const polling = cardSdk.utils.usePolling(async () => {
 *   data.value = await cardSdk.system.getSystemResources();
 * }, { interval: 5000, immediate: true });
 * ```
 */
export const cardSdk = {
  /** 系统监控（CPU/内存/进程/日志/Node 信息） */
  system: {
    /** 获取 CPU、内存、Node 进程信息 */
    getSystemResources: systemApi.getSystemResources,
    /** 获取 PM2 受管进程列表 */
    getPM2Processes: systemApi.getPM2Processes,
    /** 获取完整 server.log */
    getServerLog: systemApi.getServerLog,
    /** 增量拉取 server.log（基于 offset） */
    getIncrementalServerLog: systemApi.getIncrementalServerLog,
    // 注意：以下 systemApi 方法**不在白名单内**：
    //   restartServer / saveMultiModalConfig / saveOneRingConfig /
    //   saveBridgeHijackConfig / saveBridgeProfile / deleteBridgeProfile /
    //   activateBridgeProfile / deactivateBridgeProfile / logout
  },

  /** 天气（来自 WeatherReporter 插件） */
  weather: {
    getWeather: weatherApi.getWeather,
  },

  /** 热点新闻聚合 */
  news: {
    /** 原始热点条目（按 source 平铺，最多返回所有源） */
    getNews: newsApi.getNews,
    /** 按来源分组、限量返回（适合卡片展示） */
    getGroupedNews: newsApi.getGroupedNews,
  },

  /** NewAPI 调用监控（如未配置 NewAPI 上游则返回空/异常） */
  newApiMonitor: {
    getSummary: newApiMonitorApi.getSummary,
    getTrend: newApiMonitorApi.getTrend,
    getModels: newApiMonitorApi.getModels,
    /** 一次性拉取 summary/trend/models 三件套 */
    getDashboardSnapshot: newApiMonitorApi.getDashboardSnapshot,
  },

  /** 日程列表（只读） */
  schedule: {
    getSchedules: scheduleApi.getSchedules,
    // 不暴露 createSchedule / deleteSchedule
  },

  /** 通用前端工具（轮询、请求封装、日志、URL 净化） */
  utils: {
    /** 标准轮询 hook，会在卡片卸载时自动停止 */
    usePolling,
    /** 单次请求 hook，提供 loading/error/data 状态封装 */
    useRequest,
    /** 创建带前缀的日志器（便于在控制台过滤定位） */
    createLogger,
    /** 净化外链 URL（防 XSS / 协议劫持） */
    sanitizeExternalUrl,
  },
} as const;

export type CardSdk = typeof cardSdk;