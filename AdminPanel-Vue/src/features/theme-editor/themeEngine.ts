/**
 * 主题引擎
 *
 * 管理自定义主题 CSS 变量的持久化与应用。
 * 支持预设主题、颜色覆盖、自定义背景图和自定义 CSS。
 */

const STORAGE_KEY_COLORS = 'customTheme'
const STORAGE_KEY_CSS = 'customThemeCss'
const STORAGE_KEY_BG_IMAGE = 'customThemeBgImage'
const STORAGE_KEY_ACTIVE_PRESET = 'customThemeActivePreset'
const STORAGE_KEY_USER_THEMES = 'customThemeUserThemes'
const INJECTED_CSS_ID = 'vcp-custom-theme-css'
const INJECTED_BG_ID = 'vcp-custom-theme-bg'

// ── 类型定义 ──

export interface CustomThemeVars {
  [varName: string]: string
}

export interface ThemeSnapshot {
  colorOverrides: Record<string, string>
  customCss: string
  backgroundImage: string
  activePresetId: string | null
}

export interface UserTheme {
  id: string
  name: string
  snapshot: ThemeSnapshot
  createdAt: number
}

// ── 安全的 localStorage 写入 ──

function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (e) {
    console.error(`[ThemeEngine] localStorage 写入失败 (key=${key}):`, e)
    return false
  }
}

// ── 完整预设主题 ──

export interface FullPresetTheme {
  id: string
  label: string
  description: string
  icon: string
  colors: Record<string, string>
  backgroundImage?: string
  customCss?: string
}

/**
 * 根据色相生成完整的主题色覆盖变量
 * 保持与默认主题一致的亮度/色度结构，只改变色相
 */
function hueColors(h: number): Record<string, string> {
  return {
    '--highlight-text-dark': `oklch(0.75 0.14 ${h})`,
    '--highlight-text-light': `oklch(0.45 0.14 ${h})`,
    '--accent-bg-dark': `oklch(0.30 0.08 ${h})`,
    '--accent-bg-light': `oklch(0.92 0.04 ${h})`,
    '--button-bg-dark': `oklch(0.68 0.16 ${h})`,
    '--button-bg-light': `oklch(0.68 0.16 ${h})`,
    '--button-hover-bg-dark': `oklch(0.60 0.18 ${h})`,
    '--button-hover-bg-light': `oklch(0.60 0.18 ${h})`,
  }
}

export const FULL_PRESET_THEMES: FullPresetTheme[] = [
  {
    id: 'default-blue',
    label: '深空蓝',
    description: '默认主题，深邃的宇宙蓝色调',
    icon: 'rocket_launch',
    colors: {},
  },
  {
    id: 'midnight-purple',
    label: '午夜紫',
    description: '神秘优雅的紫色调',
    icon: 'dark_mode',
    colors: hueColors(270),
  },
  {
    id: 'aurora-green',
    label: '极光绿',
    description: '生机盎然的绿色极光',
    icon: 'forest',
    colors: hueColors(155),
  },
  {
    id: 'sunset-orange',
    label: '日落橙',
    description: '温暖的橙色黄昏',
    icon: 'wb_twilight',
    colors: hueColors(30),
  },
  {
    id: 'cherry-red',
    label: '樱花红',
    description: '热烈绽放的红色',
    icon: 'local_florist',
    colors: hueColors(0),
  },
  {
    id: 'ocean-cyan',
    label: '海洋青',
    description: '清澈透明的海洋色调',
    icon: 'waves',
    colors: hueColors(190),
  },
  {
    id: 'rose-pink',
    label: '玫瑰粉',
    description: '浪漫柔和的粉色',
    icon: 'favorite',
    colors: hueColors(310),
  },
  {
    id: 'golden-amber',
    label: '琥珀金',
    description: '华贵典雅的金色',
    icon: 'diamond',
    colors: hueColors(60),
  },
]

// ── 可编辑的颜色变量分组定义 ──

export interface ThemeColorVariable {
  name: string
  label: string
  cssVar: string
  defaultDark: string
  defaultLight: string
  /** 非颜色类型的变量 (如 px 值)，使用文本输入而非取色器 */
  inputType?: 'text'
}

export interface ThemeColorGroup {
  id: string
  label: string
  icon: string
  variables: ThemeColorVariable[]
}

export const THEME_COLOR_GROUPS: ThemeColorGroup[] = [
  {
    id: 'accent',
    label: '强调色',
    icon: 'palette',
    variables: [
      {
        name: 'highlight-text-dark',
        label: '高亮色（暗色）',
        cssVar: '--highlight-text-dark',
        defaultDark: 'oklch(0.75 0.14 230)',
        defaultLight: 'oklch(0.75 0.14 230)',
      },
      {
        name: 'highlight-text-light',
        label: '高亮色（亮色）',
        cssVar: '--highlight-text-light',
        defaultDark: 'oklch(0.45 0.14 230)',
        defaultLight: 'oklch(0.45 0.14 230)',
      },
      {
        name: 'button-bg-dark',
        label: '按钮色（暗色）',
        cssVar: '--button-bg-dark',
        defaultDark: 'oklch(0.68 0.16 230)',
        defaultLight: 'oklch(0.68 0.16 230)',
      },
      {
        name: 'button-bg-light',
        label: '按钮色（亮色）',
        cssVar: '--button-bg-light',
        defaultDark: 'oklch(0.68 0.16 230)',
        defaultLight: 'oklch(0.68 0.16 230)',
      },
      {
        name: 'button-hover-bg-dark',
        label: '按钮悬停（暗色）',
        cssVar: '--button-hover-bg-dark',
        defaultDark: 'oklch(0.60 0.18 230)',
        defaultLight: 'oklch(0.60 0.18 230)',
      },
      {
        name: 'on-accent-text',
        label: '强调色上文字',
        cssVar: '--on-accent-text',
        defaultDark: 'oklch(1 0 0)',
        defaultLight: 'oklch(1 0 0)',
      },
    ],
  },
  {
    id: 'background',
    label: '背景色',
    icon: 'layers',
    variables: [
      {
        name: 'primary-bg-dark',
        label: '主背景（暗色）',
        cssVar: '--primary-bg-dark',
        defaultDark: 'oklch(0.04 0.012 230)',
        defaultLight: 'oklch(0.04 0.012 230)',
      },
      {
        name: 'primary-bg-light',
        label: '主背景（亮色）',
        cssVar: '--primary-bg-light',
        defaultDark: 'oklch(0.96 0.008 230)',
        defaultLight: 'oklch(0.96 0.008 230)',
      },
      {
        name: 'secondary-bg-dark',
        label: '次背景（暗色）',
        cssVar: '--secondary-bg-dark',
        defaultDark: 'oklch(0.18 0.015 230 / 0.85)',
        defaultLight: 'oklch(0.18 0.015 230 / 0.85)',
      },
      {
        name: 'secondary-bg-light',
        label: '次背景（亮色）',
        cssVar: '--secondary-bg-light',
        defaultDark: 'oklch(0.99 0.005 230 / 0.9)',
        defaultLight: 'oklch(0.99 0.005 230 / 0.9)',
      },
      {
        name: 'tertiary-bg-dark',
        label: '三级背景（暗色）',
        cssVar: '--tertiary-bg-dark',
        defaultDark: 'oklch(0.25 0.012 230 / 0.6)',
        defaultLight: 'oklch(0.25 0.012 230 / 0.6)',
      },
      {
        name: 'input-bg-dark',
        label: '输入框背景（暗色）',
        cssVar: '--input-bg-dark',
        defaultDark: 'oklch(0.25 0.012 230 / 0.8)',
        defaultLight: 'oklch(0.25 0.012 230 / 0.8)',
      },
      {
        name: 'accent-bg-dark',
        label: '强调背景（暗色）',
        cssVar: '--accent-bg-dark',
        defaultDark: 'oklch(0.75 0.14 230 / 0.1)',
        defaultLight: 'oklch(0.75 0.14 230 / 0.1)',
      },
    ],
  },
  {
    id: 'text',
    label: '文字色',
    icon: 'format_color_text',
    variables: [
      {
        name: 'primary-text-dark',
        label: '主文字色（暗色）',
        cssVar: '--primary-text-dark',
        defaultDark: 'oklch(0.96 0.008 230)',
        defaultLight: 'oklch(0.96 0.008 230)',
      },
      {
        name: 'primary-text-light',
        label: '主文字色（亮色）',
        cssVar: '--primary-text-light',
        defaultDark: 'oklch(0.15 0.015 230)',
        defaultLight: 'oklch(0.15 0.015 230)',
      },
      {
        name: 'secondary-text-dark',
        label: '次文字色（暗色）',
        cssVar: '--secondary-text-dark',
        defaultDark: 'oklch(0.65 0.015 230)',
        defaultLight: 'oklch(0.65 0.015 230)',
      },
      {
        name: 'secondary-text-light',
        label: '次文字色（亮色）',
        cssVar: '--secondary-text-light',
        defaultDark: 'oklch(0.50 0.018 230)',
        defaultLight: 'oklch(0.50 0.018 230)',
      },
    ],
  },
  {
    id: 'border',
    label: '边框与分割',
    icon: 'border_style',
    variables: [
      {
        name: 'border-color-dark',
        label: '边框色（暗色）',
        cssVar: '--border-color-dark',
        defaultDark: 'oklch(1 0 0 / 0.08)',
        defaultLight: 'oklch(1 0 0 / 0.08)',
      },
      {
        name: 'border-color-light',
        label: '边框色（亮色）',
        cssVar: '--border-color-light',
        defaultDark: 'oklch(0 0 0 / 0.06)',
        defaultLight: 'oklch(0 0 0 / 0.06)',
      },
    ],
  },
  {
    id: 'status',
    label: '状态色',
    icon: 'traffic',
    variables: [
      {
        name: 'success-color-dark',
        label: '成功色',
        cssVar: '--success-color-dark',
        defaultDark: 'oklch(0.55 0.20 145)',
        defaultLight: 'oklch(0.55 0.20 145)',
      },
      {
        name: 'warning-color-dark',
        label: '警告色',
        cssVar: '--warning-color-dark',
        defaultDark: 'oklch(0.75 0.18 85)',
        defaultLight: 'oklch(0.75 0.18 85)',
      },
      {
        name: 'danger-color-dark',
        label: '危险色',
        cssVar: '--danger-color-dark',
        defaultDark: 'oklch(0.55 0.22 25)',
        defaultLight: 'oklch(0.55 0.22 25)',
      },
    ],
  },
  {
    id: 'scrollbar',
    label: '滚动条',
    icon: 'swap_vert',
    variables: [
      {
        name: 'scrollbar-thumb-dark',
        label: '滚动条滑块（暗色）',
        cssVar: '--scrollbar-thumb-dark',
        defaultDark: 'oklch(0.30 0.015 230)',
        defaultLight: 'oklch(0.30 0.015 230)',
      },
      {
        name: 'scrollbar-thumb-light',
        label: '滚动条滑块（亮色）',
        cssVar: '--scrollbar-thumb-light',
        defaultDark: 'oklch(0.80 0.012 230)',
        defaultLight: 'oklch(0.80 0.012 230)',
      },
    ],
  },
  {
    id: 'radius',
    label: '圆角',
    icon: 'rounded_corner',
    variables: [
      {
        name: 'radius-sm',
        label: '小圆角',
        cssVar: '--radius-sm',
        defaultDark: '6px',
        defaultLight: '6px',
        inputType: 'text',
      },
      {
        name: 'radius-md',
        label: '中圆角',
        cssVar: '--radius-md',
        defaultDark: '10px',
        defaultLight: '10px',
        inputType: 'text',
      },
      {
        name: 'radius-lg',
        label: '大圆角',
        cssVar: '--radius-lg',
        defaultDark: '14px',
        defaultLight: '14px',
        inputType: 'text',
      },
      {
        name: 'radius-xl',
        label: '超大圆角',
        cssVar: '--radius-xl',
        defaultDark: '20px',
        defaultLight: '20px',
        inputType: 'text',
      },
    ],
  },
]

// ── 持久化读写 ──

export function loadSavedThemeVars(): CustomThemeVars {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COLORS)
    if (!raw) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function saveThemeVars(vars: CustomThemeVars): void {
  safeSetItem(STORAGE_KEY_COLORS, JSON.stringify(vars))
}

export function loadCustomCss(): string {
  return localStorage.getItem(STORAGE_KEY_CSS) || ''
}

export function saveCustomCss(css: string): void {
  if (css.trim()) {
    safeSetItem(STORAGE_KEY_CSS, css)
  } else {
    localStorage.removeItem(STORAGE_KEY_CSS)
  }
}

export function loadBackgroundImage(): string {
  return localStorage.getItem(STORAGE_KEY_BG_IMAGE) || ''
}

export function saveBackgroundImage(url: string): boolean {
  const normalized = normalizeBackgroundSource(url)
  if (normalized) {
    return safeSetItem(STORAGE_KEY_BG_IMAGE, normalized)
  } else {
    localStorage.removeItem(STORAGE_KEY_BG_IMAGE)
    return true
  }
}

export function loadActivePresetId(): string | null {
  return localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET)
}

export function saveActivePresetId(id: string | null): void {
  if (id) {
    safeSetItem(STORAGE_KEY_ACTIVE_PRESET, id)
  } else {
    localStorage.removeItem(STORAGE_KEY_ACTIVE_PRESET)
  }
}

// ── 用户自定义主题 ──

export function loadUserThemes(): UserTheme[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER_THEMES)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveUserThemes(themes: UserTheme[]): boolean {
  return safeSetItem(STORAGE_KEY_USER_THEMES, JSON.stringify(themes))
}

// ── 快照导入/导出 ──

export function loadThemeSnapshot(): ThemeSnapshot {
  return {
    colorOverrides: loadSavedThemeVars(),
    customCss: loadCustomCss(),
    backgroundImage: loadBackgroundImage(),
    activePresetId: loadActivePresetId(),
  }
}

export function saveThemeSnapshot(snapshot: ThemeSnapshot): boolean {
  saveThemeVars(snapshot.colorOverrides)
  saveCustomCss(snapshot.customCss)
  const bgOk = saveBackgroundImage(snapshot.backgroundImage)
  saveActivePresetId(snapshot.activePresetId)
  return bgOk
}

export function exportThemeJson(snapshot: ThemeSnapshot): string {
  return JSON.stringify(snapshot, null, 2)
}

/** CSS 自定义属性正则：以 -- 开头 */
const CSS_VAR_RE = /^--[\w-]+$/

export function importThemeJson(json: string): ThemeSnapshot | null {
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null

    // 过滤 colorOverrides，只允许合法 CSS 自定义属性
    let colorOverrides: Record<string, string> = {}
    if (typeof parsed.colorOverrides === 'object' && parsed.colorOverrides !== null) {
      for (const [key, value] of Object.entries(parsed.colorOverrides)) {
        if (CSS_VAR_RE.test(key) && typeof value === 'string') {
          colorOverrides[key] = value
        }
      }
    }

    return {
      colorOverrides,
      customCss: typeof parsed.customCss === 'string' ? parsed.customCss : '',
      backgroundImage: typeof parsed.backgroundImage === 'string' ? parsed.backgroundImage : '',
      activePresetId: typeof parsed.activePresetId === 'string' ? parsed.activePresetId : null,
    }
  } catch {
    return null
  }
}

// ── DOM 应用 ──

export function applyThemeVars(vars: CustomThemeVars): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(vars)) {
    if (value && CSS_VAR_RE.test(name)) {
      root.style.setProperty(name, value)
    }
  }
}

export function clearThemeVars(): void {
  localStorage.removeItem(STORAGE_KEY_COLORS)
  const root = document.documentElement
  for (const name of Array.from(root.style)) {
    if (name.startsWith('--')) {
      root.style.removeProperty(name)
    }
  }
}

export function applyCustomCss(css: string): void {
  let el = document.getElementById(INJECTED_CSS_ID)
  if (!css.trim()) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = INJECTED_CSS_ID
    document.head.appendChild(el)
  }
  el.textContent = css
}

export function clearCustomCss(): void {
  document.getElementById(INJECTED_CSS_ID)?.remove()
  localStorage.removeItem(STORAGE_KEY_CSS)
}

/**
 * 应用背景图片
 * 目标是 .admin-layout 而非 body，因为 .admin-layout 有不透明背景色会遮盖 body
 */
function normalizeBackgroundSource(rawValue: string): string {
  const trimmed = rawValue.trim()
  if (!trimmed) return ''

  const urlMatch = trimmed.match(/^url\((.*)\)$/i)
  if (!urlMatch) {
    return trimmed.replace(/^['"]|['"]$/g, '')
  }

  return urlMatch[1].trim().replace(/^['"]|['"]$/g, '')
}

export function applyBackgroundImage(url: string): void {
  const normalized = normalizeBackgroundSource(url)
  let el = document.getElementById(INJECTED_BG_ID)
  if (!normalized) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = INJECTED_BG_ID
    document.head.appendChild(el)
  }
  const safeUrl = normalized.replace(/["\\]/g, '\\$&')
  el.textContent = `.admin-layout { background-image: url("${safeUrl}") !important; background-size: cover !important; background-position: center !important; background-attachment: fixed !important; }`
}

export function clearBackgroundImage(): void {
  document.getElementById(INJECTED_BG_ID)?.remove()
  localStorage.removeItem(STORAGE_KEY_BG_IMAGE)
}

/**
 * 应用完整的主题快照到 DOM
 */
export function applyFullTheme(snapshot: ThemeSnapshot): void {
  clearThemeVars()
  if (Object.keys(snapshot.colorOverrides).length > 0) {
    applyThemeVars(snapshot.colorOverrides)
  }
  applyCustomCss(snapshot.customCss)
  applyBackgroundImage(snapshot.backgroundImage)
}

/**
 * 清除所有主题自定义
 */
export function clearAllCustomizations(): void {
  clearThemeVars()
  clearCustomCss()
  clearBackgroundImage()
  localStorage.removeItem(STORAGE_KEY_ACTIVE_PRESET)
}

/**
 * 启动时应用保存的自定义主题（由 app store 调用）
 */
export function applyActiveTheme(): void {
  if (typeof window === 'undefined') return
  const snapshot = loadThemeSnapshot()
  applyFullTheme(snapshot)
}
