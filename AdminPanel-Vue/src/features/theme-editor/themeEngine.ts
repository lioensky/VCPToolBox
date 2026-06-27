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
const STORAGE_KEY_THEME_MODE = 'theme'
const STORAGE_KEY_RADIUS = 'customThemeRadius'
const STORAGE_KEY_SCALE = 'customThemeScale'
const STORAGE_KEY_FONT = 'customThemeFont'
const STORAGE_KEY_CONTENT_LAYOUT = 'customThemeContentLayout'
const STORAGE_KEY_SHELL_LAYOUT = 'customThemeShellLayout'
const INJECTED_CSS_ID = 'vcp-custom-theme-css'
const INJECTED_BG_ID = 'vcp-custom-theme-bg'

// ── 类型定义 ──

export interface CustomThemeVars {
  [varName: string]: string
}

export type ThemeMode = 'dark' | 'light'
export type ThemeRadius = 'default' | 'none' | 'sm' | 'md' | 'lg' | 'xl'
export type ThemeScale = 'default' | 'sm' | 'lg' | 'xl'
export type ThemeFont = 'default' | 'sans' | 'serif'
export type ThemeContentLayout = 'full' | 'centered'
export type ThemeShellLayout = 'inset' | 'sidebar'

export const THEME_MODE_OPTIONS: Array<{ id: ThemeMode; label: string; description: string; icon: string }> = [
  { id: 'dark', label: '暗色', description: '深色玻璃拟态界面', icon: 'dark_mode' },
  { id: 'light', label: '亮色', description: '柔和亮色界面', icon: 'light_mode' },
]

export const THEME_RADIUS_OPTIONS: Array<{ id: ThemeRadius; label: string; description: string; preview: string }> = [
  { id: 'default', label: '默认', description: '12 / 18 / 26 / 34px', preview: '34px' },
  { id: 'none', label: '直角', description: '0 / 0 / 0 / 0px', preview: '0' },
  { id: 'sm', label: '小', description: '4 / 6 / 8 / 12px', preview: '8px' },
  { id: 'md', label: '中', description: '6 / 10 / 14 / 20px', preview: '18px' },
  { id: 'lg', label: '大', description: '8 / 12 / 18 / 26px', preview: '30px' },
  { id: 'xl', label: '圆润', description: '12 / 18 / 26 / 34px', preview: '34px' },
]

export const THEME_SCALE_OPTIONS: Array<{ id: ThemeScale; label: string; description: string }> = [
  { id: 'default', label: '默认', description: '当前面板密度' },
  { id: 'sm', label: '紧凑', description: '减少间距，适合高频操作' },
  { id: 'lg', label: '舒展', description: '增加呼吸感' },
  { id: 'xl', label: '宽松', description: '更大的字号与间距' },
]

export const THEME_FONT_OPTIONS: Array<{ id: ThemeFont; label: string; description: string }> = [
  { id: 'default', label: '默认', description: '使用当前面板字体' },
  { id: 'sans', label: '无衬线', description: '清晰的管理面板风格' },
  { id: 'serif', label: '衬线', description: '更具编辑感的标题与正文' },
]

export const THEME_CONTENT_LAYOUT_OPTIONS: Array<{ id: ThemeContentLayout; label: string; description: string }> = [
  { id: 'full', label: '铺满', description: '使用当前全宽内容布局' },
  { id: 'centered', label: '居中', description: '限制内容宽度，适合阅读配置' },
]

export const THEME_SHELL_LAYOUT_OPTIONS: Array<{ id: ThemeShellLayout; label: string; description: string }> = [
  { id: 'inset', label: '内嵌', description: '内容面板嵌入灰色外壳，保留圆角层次' },
  { id: 'sidebar', label: '侧边栏', description: '传统贴边侧栏，右侧内容面板直角铺满' },
]

export interface ThemeSnapshot {
  colorOverrides: Record<string, string>
  customCss: string
  backgroundImage: string
  activePresetId: string | null
  themeMode: ThemeMode
  radius: ThemeRadius
  scale: ThemeScale
  font: ThemeFont
  contentLayout: ThemeContentLayout
  shellLayout: ThemeShellLayout
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
  swatches?: string[]
  defaultRadius?: ThemeRadius
  defaultFont?: Exclude<ThemeFont, 'default'>
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
    swatches: ['oklch(0.75 0.14 230)', 'oklch(0.68 0.16 230)', 'oklch(0.30 0.08 230)'],
  },
  {
    id: 'midnight-purple',
    label: '午夜紫',
    description: '神秘优雅的紫色调',
    icon: 'dark_mode',
    colors: hueColors(270),
    swatches: ['oklch(0.75 0.14 270)', 'oklch(0.68 0.16 270)', 'oklch(0.30 0.08 270)'],
  },
  {
    id: 'aurora-green',
    label: '极光绿',
    description: '生机盎然的绿色极光',
    icon: 'forest',
    colors: hueColors(155),
    swatches: ['oklch(0.75 0.14 155)', 'oklch(0.68 0.16 155)', 'oklch(0.30 0.08 155)'],
  },
  {
    id: 'sunset-orange',
    label: '日落橙',
    description: '温暖的橙色黄昏',
    icon: 'wb_twilight',
    colors: hueColors(30),
    swatches: ['oklch(0.75 0.14 30)', 'oklch(0.68 0.16 30)', 'oklch(0.30 0.08 30)'],
  },
  {
    id: 'cherry-red',
    label: '樱花红',
    description: '热烈绽放的红色',
    icon: 'local_florist',
    colors: hueColors(0),
    swatches: ['oklch(0.75 0.14 0)', 'oklch(0.68 0.16 0)', 'oklch(0.30 0.08 0)'],
  },
  {
    id: 'ocean-cyan',
    label: '海洋青',
    description: '清澈透明的海洋色调',
    icon: 'waves',
    colors: hueColors(190),
    swatches: ['oklch(0.75 0.14 190)', 'oklch(0.68 0.16 190)', 'oklch(0.30 0.08 190)'],
  },
  {
    id: 'rose-pink',
    label: '玫瑰粉',
    description: '浪漫柔和的粉色',
    icon: 'favorite',
    colors: hueColors(310),
    swatches: ['oklch(0.75 0.14 310)', 'oklch(0.68 0.16 310)', 'oklch(0.30 0.08 310)'],
  },
  {
    id: 'golden-amber',
    label: '琥珀金',
    description: '华贵典雅的金色',
    icon: 'diamond',
    colors: hueColors(60),
    swatches: ['oklch(0.75 0.14 60)', 'oklch(0.68 0.16 60)', 'oklch(0.30 0.08 60)'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: '暖米色画布与陶土强调色',
    icon: 'auto_awesome',
    colors: {},
    swatches: ['oklch(0.984 0.005 95)', 'oklch(0.685 0.142 38)', 'oklch(0.92 0.03 72)'],
    defaultRadius: 'lg',
    defaultFont: 'serif',
  },
  {
    id: 'rose-garden',
    label: 'Rose Garden',
    description: '玫瑰花园般的红粉主题',
    icon: 'local_florist',
    colors: {},
    swatches: ['oklch(0.5827 0.2418 12.23)', 'oklch(0.8131 0.1129 5.67)', 'oklch(0.93 0.04 12)'],
    defaultRadius: 'xl',
  },
  {
    id: 'lake-view',
    label: 'Lake View',
    description: '湖水与薄雾青绿色调',
    icon: 'water',
    colors: {},
    swatches: ['oklch(0.765 0.177 163.22)', 'oklch(0.551 0.0899 200.52)', 'oklch(0.92 0.035 180)'],
    defaultRadius: 'md',
  },
  {
    id: 'ocean-breeze',
    label: 'Ocean Breeze',
    description: '蓝紫海风主题',
    icon: 'sailing',
    colors: {},
    swatches: ['oklch(0.5461 0.2152 262.88)', 'oklch(0.5854 0.2041 277.12)', 'oklch(0.92 0.03 250)'],
    defaultRadius: 'sm',
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

function readOption<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key)
  return value && allowed.includes(value as T) ? (value as T) : fallback
}

function saveOption<T extends string>(key: string, value: T, fallback: T): void {
  if (value === fallback) {
    localStorage.removeItem(key)
    return
  }
  safeSetItem(key, value)
}

export function loadThemeMode(): ThemeMode {
  return readOption(STORAGE_KEY_THEME_MODE, ['dark', 'light'] as const, 'dark')
}

export function saveThemeMode(mode: ThemeMode): void {
  saveOption(STORAGE_KEY_THEME_MODE, mode, 'dark')
}

export function loadThemeRadius(): ThemeRadius {
  return readOption(STORAGE_KEY_RADIUS, ['default', 'none', 'sm', 'md', 'lg', 'xl'] as const, 'default')
}

export function saveThemeRadius(radius: ThemeRadius): void {
  saveOption(STORAGE_KEY_RADIUS, radius, 'default')
}

export function loadThemeScale(): ThemeScale {
  return readOption(STORAGE_KEY_SCALE, ['default', 'sm', 'lg', 'xl'] as const, 'default')
}

export function saveThemeScale(scale: ThemeScale): void {
  saveOption(STORAGE_KEY_SCALE, scale, 'default')
}

export function loadThemeFont(): ThemeFont {
  return readOption(STORAGE_KEY_FONT, ['default', 'sans', 'serif'] as const, 'default')
}

export function saveThemeFont(font: ThemeFont): void {
  saveOption(STORAGE_KEY_FONT, font, 'default')
}

export function loadThemeContentLayout(): ThemeContentLayout {
  return readOption(STORAGE_KEY_CONTENT_LAYOUT, ['full', 'centered'] as const, 'full')
}

export function saveThemeContentLayout(layout: ThemeContentLayout): void {
  saveOption(STORAGE_KEY_CONTENT_LAYOUT, layout, 'full')
}

export function loadThemeShellLayout(): ThemeShellLayout {
  return readOption(STORAGE_KEY_SHELL_LAYOUT, ['inset', 'sidebar'] as const, 'inset')
}

export function saveThemeShellLayout(layout: ThemeShellLayout): void {
  saveOption(STORAGE_KEY_SHELL_LAYOUT, layout, 'inset')
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
    themeMode: loadThemeMode(),
    radius: loadThemeRadius(),
    scale: loadThemeScale(),
    font: loadThemeFont(),
    contentLayout: loadThemeContentLayout(),
    shellLayout: loadThemeShellLayout(),
  }
}

export function saveThemeSnapshot(snapshot: ThemeSnapshot): boolean {
  saveThemeVars(snapshot.colorOverrides)
  saveCustomCss(snapshot.customCss)
  const bgOk = saveBackgroundImage(snapshot.backgroundImage)
  saveActivePresetId(snapshot.activePresetId)
  saveThemeMode(snapshot.themeMode)
  saveThemeRadius(snapshot.radius)
  saveThemeScale(snapshot.scale)
  saveThemeFont(snapshot.font)
  saveThemeContentLayout(snapshot.contentLayout)
  saveThemeShellLayout(snapshot.shellLayout)
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
      themeMode: ['dark', 'light'].includes(parsed.themeMode) ? parsed.themeMode : loadThemeMode(),
      radius: ['default', 'none', 'sm', 'md', 'lg', 'xl'].includes(parsed.radius) ? parsed.radius : 'default',
      scale: ['default', 'sm', 'lg', 'xl'].includes(parsed.scale) ? parsed.scale : 'default',
      font: ['default', 'sans', 'serif'].includes(parsed.font) ? parsed.font : 'default',
      contentLayout: ['full', 'centered'].includes(parsed.contentLayout) ? parsed.contentLayout : 'full',
      shellLayout: ['inset', 'sidebar'].includes(parsed.shellLayout) ? parsed.shellLayout : 'inset',
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

function setBodyAttribute(name: string, value: string | null): void {
  if (typeof document === 'undefined') return
  const targets = [document.documentElement, document.body].filter(Boolean)
  for (const target of targets) {
    if (value) {
      target.setAttribute(name, value)
    } else {
      target.removeAttribute(name)
    }
  }
}

function resolvePresetDefaults(presetId: string | null) {
  return FULL_PRESET_THEMES.find((preset) => preset.id === presetId)
}

export function applyThemePreferences(snapshot: Pick<ThemeSnapshot, 'activePresetId' | 'radius' | 'scale' | 'font' | 'contentLayout' | 'shellLayout'>): void {
  const preset = resolvePresetDefaults(snapshot.activePresetId)
  setBodyAttribute('data-theme-preset', snapshot.activePresetId && snapshot.activePresetId !== 'default-blue' ? snapshot.activePresetId : null)
  setBodyAttribute('data-theme-radius', snapshot.radius === 'default' ? 'xl' : snapshot.radius)
  setBodyAttribute('data-theme-scale', snapshot.scale === 'default' ? null : snapshot.scale)
  setBodyAttribute('data-theme-font', snapshot.font === 'default' ? preset?.defaultFont || null : snapshot.font)
  setBodyAttribute('data-theme-content-layout', snapshot.contentLayout === 'full' ? null : snapshot.contentLayout)
  setBodyAttribute('data-theme-shell-layout', snapshot.shellLayout === 'inset' ? null : snapshot.shellLayout)
}

export function clearThemePreferences(): void {
  setBodyAttribute('data-theme-preset', null)
  setBodyAttribute('data-theme-radius', null)
  setBodyAttribute('data-theme-scale', null)
  setBodyAttribute('data-theme-font', null)
  setBodyAttribute('data-theme-content-layout', null)
  setBodyAttribute('data-theme-shell-layout', null)
  localStorage.removeItem(STORAGE_KEY_THEME_MODE)
  localStorage.removeItem(STORAGE_KEY_RADIUS)
  localStorage.removeItem(STORAGE_KEY_SCALE)
  localStorage.removeItem(STORAGE_KEY_FONT)
  localStorage.removeItem(STORAGE_KEY_CONTENT_LAYOUT)
  localStorage.removeItem(STORAGE_KEY_SHELL_LAYOUT)
}

/**
 * 应用完整的主题快照到 DOM
 */
export function applyFullTheme(snapshot: ThemeSnapshot): void {
  clearThemeVars()
  if (Object.keys(snapshot.colorOverrides).length > 0) {
    applyThemeVars(snapshot.colorOverrides)
  }
  applyThemePreferences(snapshot)
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
  clearThemePreferences()
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
