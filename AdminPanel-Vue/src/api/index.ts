/**
 * API 层导出总入口
 * 
 * @example
 * ```typescript
 * import { diaryApi, systemApi, weatherApi } from '@/api'
 * 
 * // 获取日记列表
 * const diaries = await diaryApi.getDiaryList()
 * 
 * // 获取系统资源
 * const resources = await systemApi.getSystemResources()
 * 
 * // 获取天气
 * const weather = await weatherApi.getWeather()
 * ```
 */

// 日记管理 API
export { diaryApi } from './diary'
export type * from './diary'

// 系统监控 API
export { systemApi } from './system'
export type * from './system'

// 天气 API
export { weatherApi } from './weather'
export type * from './weather'

// 新闻 API
export { newsApi } from './news'
export type * from './news'

// 插件管理 API
export { pluginApi } from './plugin'
export type * from './plugin'

// Agent 管理 API
export { agentApi } from './agent'
export type * from './agent'

export { adminConfigApi } from './admin-config'
export type * from './admin-config'

export { authApi } from './auth'
export type * from './auth'

export { mediaCacheApi } from './media-cache'
export type * from './media-cache'

export { newApiMonitorApi } from './newapi-monitor'
export type * from './newapi-monitor'

export { placeholderApi } from './placeholder'
export type * from './placeholder'

export { ragApi } from './rag'
export type * from './rag'

export { scheduleApi } from './schedule'
export type * from './schedule'

export { dreamApi } from './dream'
export type * from './dream'

export { toolboxApi } from './toolbox'
export type * from './toolbox'

export { tvsApi } from './tvs'
export type * from './tvs'

export { toolListApi } from './toolList'
export type * from './toolList'

export { dynamicToolsApi } from './dynamicTools'
export type * from './dynamicTools'

export { vcptavernApi } from './vcptavern'
export type * from './vcptavern'

export { forumApi } from './forum'
export type * from './forum'

export { forumAssistantApi } from './forum-assistant'
export type * from './forum-assistant'
