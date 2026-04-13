/**
 * 日志相关类型定义
 */

/**
 * 日志行
 */
export interface LogLine {
  /** 时间戳 */
  timestamp: string
  /** 日志级别 */
  level: 'info' | 'warn' | 'error' | 'debug'
  /** 日志内容 */
  message: string
  /** 模块名称 */
  module?: string
}

/**
 * 日志响应
 */
export interface LogResponse {
  /** 日志文件路径 */
  path: string
  /** 日志内容 */
  content: string
  /** 日志行数 */
  lines: number
  /** 文件大小（字节） */
  size: number
  /** 最后修改时间 */
  lastModified: string
}

/**
 * 日志查询参数
 */
export interface LogQueryParams {
  /** 日志文件路径 */
  path?: string
  /** 起始行 */
  start?: number
  /** 结束行 */
  end?: number
  /** 过滤级别 */
  level?: string
  /** 搜索关键词 */
  search?: string
}
