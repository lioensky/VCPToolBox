/**
 * 通用 API 类型定义
 */

/**
 * 通用 API 响应结构
 */
export interface ApiResponse<T = unknown> {
  /** 是否成功 */
  success: boolean
  /** 响应数据 */
  data?: T
  /** 消息 */
  message?: string
  /** 错误信息 */
  error?: string
  /** 错误代码 */
  code?: string | number
}

/**
 * 分页响应结构
 */
export interface PaginatedResponse<T> {
  /** 数据列表 */
  items: T[]
  /** 总数量 */
  total: number
  /** 当前页码 */
  page: number
  /** 每页数量 */
  pageSize: number
  /** 总页数 */
  totalPages: number
}

/**
 * 分页请求参数
 */
export interface PaginationParams {
  /** 当前页码 */
  page?: number
  /** 每页数量 */
  pageSize?: number
  /** 排序字段 */
  sortBy?: string
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc'
}

/**
 * 搜索参数
 */
export interface SearchParams {
  /** 搜索关键词 */
  query?: string
  /** 搜索字段 */
  fields?: string[]
  /** 过滤条件 */
  filters?: Record<string, unknown>
}
