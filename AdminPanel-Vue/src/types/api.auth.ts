/**
 * 认证相关类型定义
 */

/**
 * 登录请求
 */
export interface LoginRequest {
  /** 用户名 */
  username: string
  /** 密码 */
  password: string
}

/**
 * 登录响应
 */
export interface LoginResponse {
  /** 是否成功 */
  success: boolean
  /** 认证令牌 */
  token?: string
  /** 消息 */
  message?: string
}

/**
 * 认证检查结果
 */
export interface AuthCheckResponse {
  /** 是否已认证 */
  authenticated: boolean
  /** 用户信息 */
  user?: {
    username: string
    role?: string
  }
}

/**
 * 用户认证码响应
 */
export interface UserAuthCodeResponse {
  /** 认证码 */
  code: string
}
