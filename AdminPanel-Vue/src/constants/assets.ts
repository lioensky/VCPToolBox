/**
 * 资源路径常量
 * 统一管理项目中的静态资源路径
 */

/**
 * 图片资源
 */
export const IMAGES = {
  /** VCP Logo（主 Logo） */
  LOGO: '/VCPLogo2.png',
  /** VCP Logo（AdminPanel 专用） */
  LOGO_ADMIN: '/AdminPanel/VCPLogo2.png'
} as const

/**
 * 图标资源
 */
export const ICONS = {
  /** 网站 favicon */
  FAVICON: '/AdminPanel/favicon.ico'
} as const

/**
 * 字体资源
 */
export const FONTS = {
  /** Material Symbols 字体 */
  MATERIAL_SYMBOLS: '/AdminPanel/MaterialSymbols.woff2'
} as const

/**
 * 默认导出
 */
export default {
  IMAGES,
  ICONS,
  FONTS
}
