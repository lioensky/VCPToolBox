/**
 * 新闻相关类型定义
 */

/**
 * 新闻项
 */
export interface NewsItem {
  /** 标题 */
  title: string
  /** 链接 */
  url?: string | null
  /** 来源 */
  source: string
  /** 发布时间 */
  timestamp?: string
  /** 摘要 */
  summary?: string
}

/**
 * 新闻响应
 */
export interface NewsResponse {
  /** 是否成功 */
  success: boolean
  /** 新闻列表 */
  data: NewsItem[]
  /** 消息 */
  message?: string
}
