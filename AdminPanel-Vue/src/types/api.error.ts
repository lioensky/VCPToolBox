/**
 * 错误处理相关类型定义
 */

/**
 * 通用错误接口
 */
export interface AppError extends Error {
  /** 错误代码 */
  code?: string | number
  /** 错误详情 */
  details?: unknown
  /** HTTP 状态码 */
  status?: number
  /** 错误原因（用于错误链） */
  cause?: unknown
}

/**
 * API 错误响应
 */
export interface ApiErrorResponse {
  /** 错误消息 */
  message: string
  /** 错误代码 */
  code?: string | number
  /** 错误详情 */
  details?: Record<string, unknown>
}

/**
 * 创建应用错误
 */
export function createAppError(
  message: string,
  options?: {
    code?: string | number
    details?: unknown
    status?: number
    cause?: unknown
  }
): AppError {
  const error = new Error(message) as AppError
  if (options) {
    error.code = options.code
    error.details = options.details
    error.status = options.status
    if (options.cause) {
      ;(error as unknown as AppError).cause = options.cause
    }
  }
  return error
}
