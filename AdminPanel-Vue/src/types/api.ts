/**
 * API 相关类型聚合导出
 *
 * 说明：
 * - 按领域拆分到独立文件，降低单文件复杂度
 * - 保留本入口以兼容现有 `@/types/api` 导入
 */

export type * from './api.common'
export type * from './api.system'
export type * from './api.auth'
export type * from './api.agent'
export type * from './api.admin-config'
export type * from './api.weather'
export type * from './api.news'
export type * from './api.plugin'
export type * from './api.log'
export type * from './api.error'

export { createAppError } from './api.error'
