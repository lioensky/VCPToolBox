/**
 * 天气相关类型定义
 */

/**
 * 小时天气预报
 */
export interface HourlyWeather {
  /** 预报时间 */
  fxTime: string
  /** 温度 */
  temp: string
  /** 天气图标代码 */
  icon: string
  /** 天气描述 */
  text: string
  /** 湿度 */
  humidity: string
  /** 风向 */
  windDir: string
  /** 风力等级 */
  windScale: string
  /** 气压 */
  pressure: string
}

/**
 * 每日天气预报
 */
export interface DailyWeather {
  /** 预报日期 */
  fxDate: string
  /** 最高温度 */
  tempMax: string
  /** 最低温度 */
  tempMin: string
  /** 白天天气图标代码 */
  iconDay: string
  /** 白天天气描述 */
  textDay: string
  /** 夜间天气图标代码 */
  iconNight: string
  /** 夜间天气描述 */
  textNight: string
}

/**
 * 天气数据响应
 */
export interface WeatherResponse {
  /** 小时预报列表 */
  hourly: HourlyWeather[]
  /** 每日预报列表 */
  daily: DailyWeather[]
  /** 更新时间 */
  updateTime?: string
}
