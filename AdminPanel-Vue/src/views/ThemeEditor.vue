<template>
  <section class="config-section active-section theme-lab">
    <!-- Hero -->
    <header class="page-hero card">
      <div>
        <span class="eyebrow theme-lab__eyebrow">Theme Editor</span>
        <h2>主题编辑器</h2>
        <p class="description">
          自定义面板外观：选择预设主题配色、逐项调整颜色变量、设置自定义背景图片，或编写自定义 CSS 样式覆盖。
        </p>
      </div>

      <div class="theme-lab__hero-actions">
        <button class="btn-secondary" type="button" @click="handleImport">
          <span class="material-symbols-outlined">upload</span>
          导入
        </button>
        <button class="btn-secondary" type="button" @click="handleExport">
          <span class="material-symbols-outlined">download</span>
          导出
        </button>
        <button class="btn-secondary" type="button" @click="handleReset">
          <span class="material-symbols-outlined">restart_alt</span>
          恢复默认
        </button>
        <button class="btn-primary" type="button" @click="handleSave">
          <span class="material-symbols-outlined">save</span>
          保存主题
        </button>
      </div>
    </header>

    <!-- Tab Pills -->
    <section class="card theme-lab__controls">
      <div class="theme-lab__filter-row" role="group" aria-label="主题编辑分区切换">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          class="filter-pill"
          :class="{ active: activeSection === section.id }"
          :aria-pressed="activeSection === section.id"
          @click="activeSection = section.id"
        >
          <span class="material-symbols-outlined">{{ section.icon }}</span>
          <span>{{ section.label }}</span>
        </button>
      </div>
    </section>

    <!-- Theme (Preset + Colors) -->
    <section v-if="activeSection === 'theme'" class="theme-lab__section">
      <div class="theme-lab__section-header">
        <h3>预设主题</h3>
        <p>选择一套预设配色方案，快速切换面板风格。</p>
      </div>

      <div class="theme-lab__preset-grid">
        <article
          v-for="preset in presets"
          :key="preset.id"
          class="preset-card card"
          :class="{ 'preset-card--active': currentPresetId === preset.id }"
          @click="applyPreset(preset)"
        >
          <div class="preset-card__preview" :style="getPresetPreviewStyle(preset)">
            <div class="preset-card__swatches">
              <span
                v-for="(color, idx) in getPresetSwatches(preset)"
                :key="idx"
                class="preset-card__swatch"
                :style="{ backgroundColor: color }"
              ></span>
            </div>
          </div>

          <div class="preset-card__body">
            <div class="preset-card__identity">
              <span class="material-symbols-outlined preset-card__icon">{{ preset.icon }}</span>
              <div>
                <h4 class="preset-card__label">{{ preset.label }}</h4>
                <p class="preset-card__desc">{{ preset.description }}</p>
              </div>
            </div>
            <span
              v-if="currentPresetId === preset.id"
              class="material-symbols-outlined preset-card__check"
            >check_circle</span>
          </div>
        </article>
      </div>

      <template v-if="userThemes.length > 0">
        <div class="theme-lab__section-header" style="margin-top: var(--space-5)">
          <h3>我的主题</h3>
          <p>之前保存的自定义主题配置。</p>
        </div>

        <div class="theme-lab__preset-grid">
          <article
            v-for="ut in userThemes"
            :key="ut.id"
            class="preset-card card"
            :class="{ 'preset-card--active': currentPresetId === ut.id }"
            @click="applyUserTheme(ut)"
          >
            <div class="preset-card__preview preset-card__preview--user">
              <span class="material-symbols-outlined preset-card__user-icon">brush</span>
            </div>

            <div class="preset-card__body">
              <div class="preset-card__identity">
                <span class="material-symbols-outlined preset-card__icon">bookmark</span>
                <div>
                  <h4 class="preset-card__label">{{ ut.name }}</h4>
                  <p class="preset-card__desc">{{ formatDate(ut.createdAt) }}</p>
                </div>
              </div>
              <div class="preset-card__actions">
                <span
                  v-if="currentPresetId === ut.id"
                  class="material-symbols-outlined preset-card__check"
                >check_circle</span>
                <button
                  class="preset-card__delete"
                  title="删除此主题"
                  @click.stop="deleteUserTheme(ut.id)"
                >
                  <span class="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          </article>
        </div>
      </template>

      <div class="theme-lab__save-theme-row">
        <button class="btn-secondary" type="button" @click="openSaveAsDialog">
          <span class="material-symbols-outlined">add</span>
          将当前配置保存为主题
        </button>
      </div>

      <div class="theme-lab__section-split" aria-hidden="true"></div>

      <div class="theme-lab__section-header">
        <h3>配色方案</h3>
        <p>逐项调整各类 CSS 变量颜色。点击色块可打开取色器，也可手动输入 OKLCH、HEX 或任意 CSS 颜色值。</p>
      </div>

      <div class="theme-lab__coverage" role="status" aria-live="polite">
        <span class="theme-lab__coverage-tag">
          全局变量
          <strong>{{ globalVarStats.total }}</strong>
        </span>
        <span class="theme-lab__coverage-tag">
          分组卡片
          <strong>{{ globalVarStats.cards }}</strong>
        </span>
        <span class="theme-lab__coverage-tag">
          可调变量
          <strong>{{ globalVarStats.editable }}</strong>
        </span>
        <span class="theme-lab__coverage-tag">
          受保护变量
          <strong>{{ globalVarStats.locked }}</strong>
        </span>
      </div>

      <article
        v-for="group in integratedColorGroupCards"
        :key="group.id"
        class="color-group card"
      >
        <header class="color-group__header">
          <div class="color-group__title-row">
            <span class="material-symbols-outlined">{{ group.icon }}</span>
            <h3>{{ group.label }}</h3>
          </div>
          <div class="color-group__header-actions">
            <span class="color-group__count">{{ group.totalCount }} 项</span>
            <button
              type="button"
              class="group-collapse-toggle"
              :class="{ 'is-collapsed': isColorGroupCollapsed(group.id) }"
              :aria-expanded="!isColorGroupCollapsed(group.id)"
              :aria-controls="getColorGroupContentId(group.id)"
              @click="toggleColorGroupCollapsed(group.id)"
            >
              <span>{{ isColorGroupCollapsed(group.id) ? "展开" : "折叠" }}</span>
              <span class="material-symbols-outlined group-collapse-icon">expand_more</span>
            </button>
          </div>
        </header>

        <div
          class="color-group-collapse"
          :class="{ 'is-collapsed': isColorGroupCollapsed(group.id) }"
        >
          <div class="color-group-content-shell">
            <div :id="getColorGroupContentId(group.id)" class="color-group-content">
              <p v-if="group.description" class="color-group__hint">{{ group.description }}</p>

              <div v-if="group.editableBuiltinVariables.length > 0" class="color-group__list">
                <div
                  v-for="v in group.editableBuiltinVariables"
                  :key="v.name"
                  class="color-row"
                  :class="{ 'color-row--changed': !!draft.colorOverrides[v.cssVar] }"
                >
                  <div class="color-row__copy">
                    <label :for="`color-${v.name}`" class="color-row__label">{{ v.label }}</label>
                    <code class="color-row__var">{{ v.cssVar }}</code>
                  </div>
                  <div class="color-row__controls">
                    <template v-if="!v.inputType">
                      <div class="color-row__swatch-wrap">
                        <div
                          class="color-row__swatch"
                          :style="{ backgroundColor: getEffectiveColor(v) }"
                          title="点击打开取色器"
                          @click="openColorPicker(v)"
                        ></div>
                        <input
                          :ref="(el) => setPickerRef(v.name, el as HTMLInputElement)"
                          type="color"
                          class="color-row__picker"
                          :value="cssColorToHex(getEffectiveColor(v))"
                          @input="onPickerInput(v.cssVar, ($event.target as HTMLInputElement).value)"
                        >
                      </div>
                      <input
                        :id="`color-${v.name}`"
                        type="text"
                        class="color-row__input"
                        :value="draft.colorOverrides[v.cssVar] || ''"
                        :placeholder="getCurrentDefault(v)"
                        @input="onColorInput(v.cssVar, ($event.target as HTMLInputElement).value)"
                      >
                    </template>
                    <template v-else>
                      <input
                        :id="`color-${v.name}`"
                        type="text"
                        class="color-row__input color-row__input--wide"
                        :value="draft.colorOverrides[v.cssVar] || ''"
                        :placeholder="getCurrentDefault(v)"
                        @input="onColorInput(v.cssVar, ($event.target as HTMLInputElement).value)"
                      >
                    </template>
                    <button
                      v-if="draft.colorOverrides[v.cssVar]"
                      class="color-row__reset"
                      title="恢复此项默认值"
                      @click="resetSingleColor(v.cssVar)"
                    >
                      <span class="material-symbols-outlined">close</span>
                    </button>
                  </div>
                </div>
              </div>

              <div v-if="group.editableFlexibleVariables.length > 0" class="color-group__list">
                <div
                  v-for="cssVar in group.editableFlexibleVariables"
                  :key="cssVar"
                  class="color-row"
                  :class="{ 'color-row--changed': !!draft.colorOverrides[cssVar] }"
                >
                  <div class="color-row__copy">
                    <span class="color-row__label">{{ formatGlobalVarLabel(cssVar) }}</span>
                    <code class="color-row__var">{{ cssVar }}</code>
                  </div>

                  <div class="color-row__controls">
                    <input
                      type="text"
                      class="color-row__input color-row__input--wide"
                      :value="draft.colorOverrides[cssVar] || ''"
                      :placeholder="getGlobalVarDefault(cssVar)"
                      @input="onColorInput(cssVar, ($event.target as HTMLInputElement).value)"
                    >
                    <button
                      v-if="draft.colorOverrides[cssVar]"
                      class="color-row__reset"
                      title="恢复此项默认值"
                      @click="resetSingleColor(cssVar)"
                    >
                      <span class="material-symbols-outlined">close</span>
                    </button>
                  </div>
                </div>
              </div>

              <div v-if="group.lockedVariables.length > 0" class="color-group__locked">
                <p class="color-group__locked-title">
                  以下变量属于结构/行为级 token，为避免布局和交互异常，默认锁定不在此处直接调节。
                </p>
                <ul class="color-group__locked-list">
                  <li v-for="item in group.lockedVariables" :key="item.cssVar">
                    <span class="material-symbols-outlined">lock</span>
                    <div>
                      <code>{{ item.cssVar }}</code>
                      <p>{{ item.reason }}</p>
                    </div>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </article>
    </section>

    <!-- Background -->
    <section v-if="activeSection === 'background'" class="theme-lab__section">
      <div class="theme-lab__section-header">
        <h3>自定义背景图片</h3>
        <p>输入图片 URL 或上传本地图片设置全局背景。支持网络图片地址，以及返回图片资源的 API 地址。留空则使用默认渐变背景。</p>
      </div>

      <article class="card theme-lab__bg-panel">
        <div class="theme-lab__bg-input-row">
          <label class="search-field">
            <span class="material-symbols-outlined">image</span>
            <input
              type="text"
              :value="draft.backgroundImage"
              placeholder="https://example.com/background.jpg"
              @input="onBgInput(($event.target as HTMLInputElement).value)"
            >
          </label>
          <button class="btn-secondary" type="button" @click="triggerFileUpload">
            <span class="material-symbols-outlined">upload_file</span>
            本地上传
          </button>
          <input
            ref="fileInputRef"
            type="file"
            accept="image/*"
            class="theme-lab__file-input"
            @change="onFileSelected"
          >
          <button
            v-if="draft.backgroundImage"
            class="btn-secondary"
            type="button"
            @click="clearBg"
          >
            <span class="material-symbols-outlined">close</span>
            清除
          </button>
        </div>

        <div class="theme-lab__bg-meta">
          <p class="theme-lab__bg-hint">
            支持 <code>http/https</code> 网络源（包含返回图片流的 API，如 <code>https://picsum.photos/1600/900</code>）和本地上传。
            若 API 返回 JSON，请将其中图片字段对应的 URL 填入此处。
          </p>
          <button
            v-if="draft.backgroundImage"
            class="btn-secondary"
            type="button"
            :disabled="bgSourceChecking"
            @click="checkBackgroundSource"
          >
            <span class="material-symbols-outlined">network_check</span>
            {{ bgSourceChecking ? '检测中…' : '检测网络源可用性' }}
          </button>
        </div>

        <p
          v-if="bgSourceCheckMessage"
          class="theme-lab__bg-check"
          :class="`theme-lab__bg-check--${bgSourceCheckState}`"
        >
          {{ bgSourceCheckMessage }}
        </p>

        <div v-if="draft.backgroundImage" class="theme-lab__bg-preview">
          <div class="theme-lab__bg-preview-img" :style="bgPreviewStyle">
            <div class="theme-lab__bg-preview-overlay">
              <span class="material-symbols-outlined">visibility</span>
              背景预览
            </div>
          </div>
        </div>
      </article>
    </section>

    <!-- Advanced CSS -->
    <section v-if="activeSection === 'advanced'" class="theme-lab__section">
      <div class="theme-lab__section-header">
        <h3>自定义 CSS</h3>
        <p>编写自定义 CSS 样式，可覆盖面板中的任何样式。修改将实时预览。</p>
      </div>

      <article class="card theme-lab__css-panel">
        <div class="theme-lab__css-editor-wrap">
          <div class="theme-lab__css-bar">
            <span class="theme-lab__css-lang">CSS</span>
            <span class="theme-lab__css-lines">{{ cssLineCount }} 行</span>
          </div>
          <textarea
            class="theme-lab__css-editor"
            :value="draft.customCss"
            placeholder="/* 在此输入自定义 CSS */&#10;&#10;body {&#10;  /* 自定义样式 */&#10;}"
            spellcheck="false"
            @input="onCssInput(($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </div>

        <details class="theme-lab__css-tips">
          <summary>
            <span class="material-symbols-outlined">lightbulb</span>
            CSS 参考提示
          </summary>
          <div class="theme-lab__css-tips-body">
            <h4>全局 CSS 变量</h4>
            <p>以下变量可在 <code>:root</code> 中覆盖，影响整个面板：</p>
            <ul>
              <li><code>--primary-bg</code> — 主背景色</li>
              <li><code>--secondary-bg</code> — 次背景色（卡片等）</li>
              <li><code>--highlight-text</code> — 强调色/主题色</li>
              <li><code>--primary-text</code> / <code>--secondary-text</code> — 文字色</li>
              <li><code>--border-color</code> — 边框颜色</li>
              <li><code>--button-bg</code> — 按钮背景色</li>
              <li><code>--radius-sm</code> / <code>--radius-md</code> / <code>--radius-lg</code> — 圆角</li>
            </ul>

            <h4>修改全局风格示例</h4>
            <p>例：修改整体圆角风格为方角：</p>
            <pre>:root {
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 6px;
  --radius-xl: 8px;
}</pre>

            <h4>针对特定页面定制样式</h4>
            <p>每个页面的根组件上带有 <code>data-page</code> 属性，可以用属性选择器精准定位某个页面：</p>
            <pre>/* 仅在仪表盘页面隐藏面包屑 */
[data-page="Dashboard"] .breadcrumb {
  display: none;
}

/* 仅在日志页面使用等宽字体 */
[data-page="ServerLogViewer"] .card {
  font-family: var(--font-mono);
  font-size: 13px;
}</pre>

            <h4>可用的页面名称</h4>
            <p>以下是常用的 <code>data-page</code> 值：</p>
            <ul class="theme-lab__page-names">
              <li><code>Dashboard</code> — 仪表盘</li>
              <li><code>BaseConfig</code> — 基础配置</li>
              <li><code>ServerLogViewer</code> — 服务日志</li>
              <li><code>PluginsHub</code> — 插件中心</li>
              <li><code>ScheduleManager</code> — 定时任务</li>
              <li><code>ThemeEditor</code> — 主题编辑器</li>
            </ul>
            <p>如需查看完整列表，可在浏览器开发者工具中检查页面元素的 <code>data-page</code> 属性。</p>

            <h4>定制布局组件</h4>
            <p>可以对侧边栏、顶栏等全局组件进行样式覆盖：</p>
            <pre>/* 修改侧边栏宽度 */
.admin-layout .sidebar {
  width: 280px;
}

/* 隐藏顶栏阴影 */
.admin-layout .topbar {
  box-shadow: none;
}

/* 修改卡片样式 */
.card {
  backdrop-filter: blur(10px);
  background: oklch(0.18 0.015 230 / 0.6);
}</pre>
          </div>
        </details>
      </article>
    </section>

    <!-- Import Dialog -->
    <BaseModal v-model="showImportDialog" aria-label="导入主题配置">
      <template #default="{ overlayAttrs, panelAttrs, panelRef }">
        <div v-bind="overlayAttrs" class="theme-lab__modal-overlay">
          <div :ref="panelRef" v-bind="panelAttrs" class="theme-lab__modal">
            <h3>导入主题配置</h3>
            <p class="description">粘贴之前导出的 JSON 主题配置。</p>
            <textarea
              v-model="importJson"
              class="theme-lab__import-editor"
              placeholder="粘贴 JSON 配置…"
              spellcheck="false"
            ></textarea>
            <div class="theme-lab__modal-actions">
              <button class="btn-secondary" type="button" @click="showImportDialog = false">取消</button>
              <button class="btn-primary" type="button" @click="confirmImport">确认导入</button>
            </div>
          </div>
        </div>
      </template>
    </BaseModal>

    <!-- Save As Theme Dialog -->
    <BaseModal v-model="showSaveAsDialog" aria-label="保存为我的主题">
      <template #default="{ overlayAttrs, panelAttrs, panelRef }">
        <div v-bind="overlayAttrs" class="theme-lab__modal-overlay">
          <div :ref="panelRef" v-bind="panelAttrs" class="theme-lab__modal">
            <h3>保存为我的主题</h3>
            <p class="description">为当前配置命名，方便日后复用。</p>
            <input
              v-model="saveAsName"
              type="text"
              class="theme-lab__save-name-input"
              placeholder="输入主题名称…"
              maxlength="30"
              @keydown.enter="confirmSaveAs"
            >
            <div class="theme-lab__modal-actions">
              <button class="btn-secondary" type="button" @click="showSaveAsDialog = false">取消</button>
              <button class="btn-primary" type="button" :disabled="!saveAsName.trim()" @click="confirmSaveAs">保存</button>
            </div>
          </div>
        </div>
      </template>
    </BaseModal>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import BaseModal from '@/components/ui/BaseModal.vue'
import {
  FULL_PRESET_THEMES,
  THEME_COLOR_GROUPS,
  applyThemeVars,
  applyCustomCss,
  applyBackgroundImage,
  clearAllCustomizations,
  loadThemeSnapshot,
  saveThemeSnapshot,
  exportThemeJson,
  importThemeJson,
  applyFullTheme,
  loadUserThemes,
  saveUserThemes,
  type FullPresetTheme,
  type ThemeColorVariable,
  type ThemeSnapshot,
  type UserTheme,
} from '@/features/theme-editor/themeEngine'
import { showMessage } from '@/utils'
import { askConfirm } from '@/platform/feedback/feedbackBus'
import { useAppStore } from '@/stores/app'

// -- Section definitions --

interface SectionDef {
  id: string
  label: string
  icon: string
}

const sections: SectionDef[] = [
  { id: 'theme', label: '主题与配色', icon: 'palette' },
  { id: 'background', label: '背景图片', icon: 'wallpaper' },
  { id: 'advanced', label: '高级自定义', icon: 'code' },
]

const activeSection = ref('theme')

// -- Data sources --

const presets = FULL_PRESET_THEMES
const colorGroups = THEME_COLOR_GROUPS
const appStore = useAppStore()

const savedSnapshot = loadThemeSnapshot()
savedSnapshot.backgroundImage = normalizeBackgroundSource(savedSnapshot.backgroundImage)
const draft = reactive<ThemeSnapshot>(savedSnapshot)
const originalSnapshot = ref<ThemeSnapshot>(JSON.parse(JSON.stringify(savedSnapshot)))
const currentPresetId = ref<string | null>(draft.activePresetId)

const showImportDialog = ref(false)
const importJson = ref('')
const showSaveAsDialog = ref(false)
const saveAsName = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)

// -- User themes --

const userThemes = ref<UserTheme[]>(loadUserThemes())

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function openSaveAsDialog() {
  saveAsName.value = ''
  showSaveAsDialog.value = true
}

function confirmSaveAs() {
  const name = saveAsName.value.trim()
  if (!name) return

  const newTheme: UserTheme = {
    id: `user-${Date.now()}`,
    name,
    snapshot: { ...draft, colorOverrides: { ...draft.colorOverrides } },
    createdAt: Date.now(),
  }
  userThemes.value.push(newTheme)
  saveUserThemes(userThemes.value)
  showSaveAsDialog.value = false
  showMessage(`主题"${name}"已保存`, 'success')
}

function applyUserTheme(ut: UserTheme) {
  currentPresetId.value = ut.id
  draft.activePresetId = ut.id
  draft.colorOverrides = { ...ut.snapshot.colorOverrides }
  draft.customCss = ut.snapshot.customCss
  draft.backgroundImage = normalizeBackgroundSource(ut.snapshot.backgroundImage)
  resetBgSourceCheck()
  applyFullTheme(draft)
}

async function deleteUserTheme(id: string) {
  if (!(await askConfirm({
    message: '确定删除此自定义主题吗？',
    danger: true,
    confirmText: '删除',
  }))) return

  userThemes.value = userThemes.value.filter(t => t.id !== id)
  saveUserThemes(userThemes.value)
  if (currentPresetId.value === id) {
    currentPresetId.value = null
    draft.activePresetId = null
  }
  showMessage('已删除', 'success')
}

// -- Color picker refs --

const pickerRefs = new Map<string, HTMLInputElement>()

function setPickerRef(name: string, el: HTMLInputElement | null) {
  if (el) {
    pickerRefs.set(name, el)
  } else {
    pickerRefs.delete(name)
  }
}

// -- Cached canvas for color conversion --

let _cachedCtx: CanvasRenderingContext2D | null = null
function getCachedCtx(): CanvasRenderingContext2D | null {
  if (_cachedCtx) return _cachedCtx
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  _cachedCtx = canvas.getContext('2d')
  return _cachedCtx
}

// -- Computed --

const cssLineCount = computed(() => {
  if (!draft.customCss) return 0
  return draft.customCss.split('\n').length
})

type BgSourceCheckState = 'idle' | 'checking' | 'success' | 'error'

const bgSourceCheckState = ref<BgSourceCheckState>('idle')
const bgSourceCheckMessage = ref('')
const bgSourceChecking = computed(() => bgSourceCheckState.value === 'checking')

function normalizeBackgroundSource(rawValue: string): string {
  const trimmed = rawValue.trim()
  if (!trimmed) return ''

  const urlMatch = trimmed.match(/^url\((.*)\)$/i)
  if (!urlMatch) {
    return trimmed.replace(/^['"]|['"]$/g, '')
  }

  return urlMatch[1].trim().replace(/^['"]|['"]$/g, '')
}

function isNetworkBackgroundSource(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function resetBgSourceCheck() {
  bgSourceCheckState.value = 'idle'
  bgSourceCheckMessage.value = ''
}

const bgPreviewStyle = computed(() => {
  const normalized = normalizeBackgroundSource(draft.backgroundImage)
  if (!normalized) return { background: 'none' }
  const safeUrl = normalized.replace(/["\\]/g, '\\$&')
  return {
    backgroundImage: `url("${safeUrl}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  }
})

const isDirty = computed(() => {
  return JSON.stringify(draft) !== JSON.stringify(originalSnapshot.value)
})

const globalCssVars = ref<string[]>([])

interface GlobalVariableCategory {
  id: string
  label: string
  icon: string
  order: number
  description?: string
}

interface LockedVariableItem {
  cssVar: string
  reason: string
}

interface IntegratedColorGroupCard {
  id: string
  label: string
  icon: string
  description?: string
  editableBuiltinVariables: ThemeColorVariable[]
  editableFlexibleVariables: string[]
  lockedVariables: LockedVariableItem[]
  editableCount: number
  totalCount: number
}

const COLLAPSED_COLOR_GROUP_STORAGE_KEY = 'theme-editor:collapsed-color-groups'

const LOCKED_THEME_VAR_RULES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^--z-index-/,
    reason: '控制浮层和消息层级，误改容易导致弹窗/抽屉被遮挡。',
  },
  {
    pattern: /^--app-(top-bar-height|viewport-height)$/,
    reason: '属于全局布局基线，调整后可能造成页面裁切或滚动异常。',
  },
  {
    pattern: /^--space-/,
    reason: '属于全局间距体系，建议通过设计系统统一维护，避免局部布局错位。',
  },
  {
    pattern: /^--font-(fluid|size|mono)/,
    reason: '属于全局排版体系，误改会导致字号层级和可读性失衡。',
  },
  {
    pattern: /^--transition-/,
    reason: '属于交互动效节奏，误改会造成反馈迟滞或突变。',
  },
  {
    pattern: /^--switch-/,
    reason: '属于开关控件结构尺寸，误改会导致可点击区域和视觉错位。',
  },
]

const EXTRA_CATEGORY_DEFINITIONS: GlobalVariableCategory[] = [
  { id: 'typography', label: '字体与字号', icon: 'text_fields', order: 100 },
  { id: 'spacing', label: '间距体系', icon: 'straighten', order: 101 },
  { id: 'layering', label: '层级管理', icon: 'layers', order: 102 },
  { id: 'switch', label: '开关控件', icon: 'toggle_on', order: 103 },
  { id: 'shadow', label: '阴影系统', icon: 'shadow', order: 104 },
  { id: 'motion', label: '动效与模糊', icon: 'animation', order: 105 },
  { id: 'dashboard', label: '仪表盘视觉', icon: 'data_thresholding', order: 106 },
  { id: 'surface', label: '表面与叠层', icon: 'layers_clear', order: 107 },
  { id: 'layout', label: '布局系统', icon: 'dashboard_customize', order: 108 },
  { id: 'misc', label: '其它变量', icon: 'category', order: 999 },
]

const builtinCategoryDefinitions = computed<GlobalVariableCategory[]>(() => {
  return colorGroups.map((group, index) => ({
    id: group.id,
    label: group.label,
    icon: group.icon,
    order: index,
  }))
})

const categoryDefinitionMap = computed(() => {
  const map = new Map<string, GlobalVariableCategory>()
  for (const category of builtinCategoryDefinitions.value) {
    map.set(category.id, category)
  }
  for (const category of EXTRA_CATEGORY_DEFINITIONS) {
    map.set(category.id, category)
  }
  return map
})

const categoryOrder = computed(() => {
  return Array.from(categoryDefinitionMap.value.values())
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(category => category.id)
})

const builtinVariableMap = computed(() => {
  const map = new Map<string, { groupId: string; variable: ThemeColorVariable }>()
  for (const group of colorGroups) {
    for (const variable of group.variables) {
      map.set(variable.cssVar, {
        groupId: group.id,
        variable,
      })
    }
  }
  return map
})

function resolveGlobalVariableCategoryId(cssVar: string): string {
  const builtin = builtinVariableMap.value.get(cssVar)
  if (builtin) return builtin.groupId

  const name = cssVar.replace(/^--/, '')
  const lower = name.toLowerCase()

  if (lower.includes('radius') || lower.includes('rounded')) {
    return 'radius'
  }

  if (lower.includes('scrollbar')) {
    return 'scrollbar'
  }

  if (/(success|warning|danger|error|status)/.test(lower)) {
    return 'status'
  }

  if (/(border|divider|stroke|outline)/.test(lower)) {
    return 'border'
  }

  if (/(text|typography)/.test(lower)) {
    return 'text'
  }

  if (/(bg|background)/.test(lower)) {
    return 'background'
  }

  if (/(accent|highlight|button|color|light|dark)/.test(lower)) {
    return 'accent'
  }

  if (lower.startsWith('font-')) {
    return 'typography'
  }

  if (lower.startsWith('space-') || /(spacing|gap|padding|margin)/.test(lower)) {
    return 'spacing'
  }

  if (lower.startsWith('z-index-')) {
    return 'layering'
  }

  if (lower.startsWith('switch-')) {
    return 'switch'
  }

  if (lower.includes('shadow')) {
    return 'shadow'
  }

  if (lower.startsWith('transition-') || /(blur|duration|easing|animation|motion)/.test(lower)) {
    return 'motion'
  }

  if (lower.startsWith('dashboard-') || /(cpu|memory|orbit|star|sun|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune)/.test(lower)) {
    return 'dashboard'
  }

  if (lower.startsWith('surface-') || lower.startsWith('overlay-') || lower.startsWith('focus-')) {
    return 'surface'
  }

  if (lower.startsWith('app-') || /(layout|sidebar|topbar)/.test(lower)) {
    return 'layout'
  }

  return 'misc'
}

function getThemeVarAdjustmentPolicy(cssVar: string): {
  editable: boolean
  reason: string
} {
  for (const rule of LOCKED_THEME_VAR_RULES) {
    if (rule.pattern.test(cssVar)) {
      return {
        editable: false,
        reason: rule.reason,
      }
    }
  }

  return {
    editable: true,
    reason: '',
  }
}

const integratedColorGroupCards = computed<IntegratedColorGroupCard[]>(() => {
  type GroupCollector = {
    editableBuiltinVariables: ThemeColorVariable[]
    editableFlexibleVariables: string[]
    lockedVariables: LockedVariableItem[]
    seenBuiltinVars: Set<string>
  }

  const collectors = new Map<string, GroupCollector>()
  const ensureCollector = (groupId: string): GroupCollector => {
    const existing = collectors.get(groupId)
    if (existing) return existing
    const next: GroupCollector = {
      editableBuiltinVariables: [],
      editableFlexibleVariables: [],
      lockedVariables: [],
      seenBuiltinVars: new Set<string>(),
    }
    collectors.set(groupId, next)
    return next
  }

  for (const cssVar of globalCssVars.value) {
    const groupId = resolveGlobalVariableCategoryId(cssVar)
    const collector = ensureCollector(groupId)
    const builtin = builtinVariableMap.value.get(cssVar)
    if (builtin) {
      if (!collector.seenBuiltinVars.has(builtin.variable.cssVar)) {
        collector.seenBuiltinVars.add(builtin.variable.cssVar)
        collector.editableBuiltinVariables.push(builtin.variable)
      }
      continue
    }

    const adjustmentPolicy = getThemeVarAdjustmentPolicy(cssVar)
    if (adjustmentPolicy.editable) {
      collector.editableFlexibleVariables.push(cssVar)
      continue
    }

    collector.lockedVariables.push({
      cssVar,
      reason: adjustmentPolicy.reason,
    })
  }

  const cards: IntegratedColorGroupCard[] = []
  for (const groupId of categoryOrder.value) {
    const collector = collectors.get(groupId)
    if (!collector) continue
    const definition = categoryDefinitionMap.value.get(groupId)
    const editableBuiltinVariables = [...collector.editableBuiltinVariables].sort((a, b) =>
      a.label.localeCompare(b.label)
    )
    const editableFlexibleVariables = [...collector.editableFlexibleVariables].sort((a, b) =>
      a.localeCompare(b)
    )
    const lockedVariables = [...collector.lockedVariables].sort((a, b) =>
      a.cssVar.localeCompare(b.cssVar)
    )
    const editableCount = editableBuiltinVariables.length + editableFlexibleVariables.length
    const totalCount = editableCount + lockedVariables.length

    if (totalCount === 0) continue

    cards.push({
      id: groupId,
      label: definition?.label || '其它变量',
      icon: definition?.icon || 'category',
      description: definition?.description,
      editableBuiltinVariables,
      editableFlexibleVariables,
      lockedVariables,
      editableCount,
      totalCount,
    })
  }

  return cards
})

const globalVarStats = computed(() => {
  const total = globalCssVars.value.length
  const editable = integratedColorGroupCards.value.reduce(
    (count, group) => count + group.editableCount,
    0
  )
  const locked = integratedColorGroupCards.value.reduce(
    (count, group) => count + group.lockedVariables.length,
    0
  )

  return {
    total,
    grouped: editable + locked,
    editable,
    locked,
    cards: integratedColorGroupCards.value.length,
  }
})

function isBrowserEnvironment(): boolean {
  return typeof window !== 'undefined'
}

function readCollapsedColorGroups(): Record<string, boolean> {
  if (!isBrowserEnvironment()) {
    return {}
  }

  try {
    const rawValue = window.localStorage.getItem(COLLAPSED_COLOR_GROUP_STORAGE_KEY)
    if (!rawValue) {
      return {}
    }

    const parsed = JSON.parse(rawValue) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const normalized: Record<string, boolean> = {}
    for (const [groupId, collapsed] of Object.entries(parsed)) {
      if (typeof collapsed === 'boolean') {
        normalized[groupId] = collapsed
      }
    }

    return normalized
  } catch {
    return {}
  }
}

function persistCollapsedColorGroups(value: Record<string, boolean>): void {
  if (!isBrowserEnvironment()) {
    return
  }

  window.localStorage.setItem(COLLAPSED_COLOR_GROUP_STORAGE_KEY, JSON.stringify(value))
}

const collapsedColorGroups = ref<Record<string, boolean>>(readCollapsedColorGroups())

function isColorGroupCollapsed(groupId: string): boolean {
  return collapsedColorGroups.value[groupId] ?? false
}

function toggleColorGroupCollapsed(groupId: string): void {
  collapsedColorGroups.value = {
    ...collapsedColorGroups.value,
    [groupId]: !isColorGroupCollapsed(groupId),
  }
}

function getColorGroupContentId(groupId: string): string {
  return `theme-color-group-content-${groupId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function refreshGlobalCssVars() {
  const style = getComputedStyle(document.documentElement)
  const vars: string[] = []
  for (let i = 0; i < style.length; i += 1) {
    const prop = style.item(i)
    if (prop.startsWith('--')) {
      vars.push(prop)
    }
  }
  globalCssVars.value = Array.from(new Set(vars)).sort((a, b) => a.localeCompare(b))
}

function formatGlobalVarLabel(cssVar: string): string {
  return cssVar.replace(/^--/, '').replace(/-/g, ' ')
}

function getGlobalVarDefault(cssVar: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
  return value || '(当前无默认值)'
}

// -- Preset themes --

function getPresetAccentColor(preset: FullPresetTheme): string {
  return preset.colors['--highlight-text-dark'] || 'oklch(0.75 0.14 230)'
}

function getPresetButtonColor(preset: FullPresetTheme): string {
  return preset.colors['--button-bg-dark'] || 'oklch(0.68 0.16 230)'
}

function getPresetPreviewStyle(preset: FullPresetTheme) {
  const accent = getPresetAccentColor(preset)
  return {
    background: `linear-gradient(135deg, oklch(0.04 0.012 230) 0%, oklch(0.12 0.02 230) 100%)`,
    borderBottom: `3px solid ${accent}`,
  }
}

function getPresetSwatches(preset: FullPresetTheme): string[] {
  const accent = getPresetAccentColor(preset)
  const button = getPresetButtonColor(preset)
  const bg = preset.colors['--accent-bg-dark'] || 'oklch(0.30 0.08 230)'
  return [accent, button, bg]
}

function applyPreset(preset: FullPresetTheme) {
  currentPresetId.value = preset.id
  draft.activePresetId = preset.id
  draft.colorOverrides = { ...preset.colors }
  draft.customCss = preset.customCss || ''
  draft.backgroundImage = normalizeBackgroundSource(preset.backgroundImage || '')
  resetBgSourceCheck()
  applyFullTheme(draft)
}

// -- Color editing --

function getCurrentDefault(v: ThemeColorVariable): string {
  return appStore.theme === 'dark' ? v.defaultDark : v.defaultLight
}

function getEffectiveColor(v: ThemeColorVariable): string {
  return draft.colorOverrides[v.cssVar] || getCurrentDefault(v)
}

/** Convert any CSS color string to hex using cached canvas context */
function cssColorToHex(cssColor: string): string {
  try {
    const ctx = getCachedCtx()
    if (!ctx) return '#000000'
    ctx.fillStyle = '#000000' // reset
    ctx.fillStyle = cssColor
    return ctx.fillStyle
  } catch {
    return '#000000'
  }
}

function openColorPicker(v: ThemeColorVariable) {
  const picker = pickerRefs.get(v.name)
  if (picker) {
    picker.click()
  }
}

/** 获取当前预设覆盖的 CSS 变量集合 */
function getPresetVarNames(): Set<string> {
  const active = FULL_PRESET_THEMES.find(p => p.id === currentPresetId.value)
  if (!active) return new Set()
  return new Set(Object.keys(active.colors))
}

function onPickerInput(cssVar: string, hexValue: string) {
  // 只有修改了预设关心的变量时才清除预设标记
  if (getPresetVarNames().has(cssVar) || currentPresetId.value?.startsWith('user-')) {
    currentPresetId.value = null
    draft.activePresetId = null
  }
  draft.colorOverrides[cssVar] = hexValue
  applyThemeVars({ [cssVar]: hexValue })
}

function onColorInput(cssVar: string, value: string) {
  if (getPresetVarNames().has(cssVar) || currentPresetId.value?.startsWith('user-')) {
    currentPresetId.value = null
    draft.activePresetId = null
  }
  if (value.trim()) {
    draft.colorOverrides[cssVar] = value.trim()
  } else {
    delete draft.colorOverrides[cssVar]
  }
  applyThemeVars({ [cssVar]: value.trim() || '' })
  if (!value.trim()) {
    document.documentElement.style.removeProperty(cssVar)
  }
}

function resetSingleColor(cssVar: string) {
  delete draft.colorOverrides[cssVar]
  document.documentElement.style.removeProperty(cssVar)
  if (getPresetVarNames().has(cssVar) || currentPresetId.value?.startsWith('user-')) {
    currentPresetId.value = null
    draft.activePresetId = null
  }
}

// -- Background image --

let bgDebounceTimer: ReturnType<typeof setTimeout> | undefined

function onBgInput(value: string) {
  const normalized = normalizeBackgroundSource(value)
  draft.backgroundImage = normalized
  resetBgSourceCheck()
  clearTimeout(bgDebounceTimer)
  bgDebounceTimer = setTimeout(() => {
    applyBackgroundImage(normalized)
  }, 300)
}

function probeImageSource(url: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false

    const finish = (handler: () => void) => {
      if (settled) return
      settled = true
      image.onload = null
      image.onerror = null
      handler()
    }

    const timer = window.setTimeout(() => {
      finish(() => reject(new Error('timeout')))
    }, timeoutMs)

    image.onload = () => {
      window.clearTimeout(timer)
      finish(() => resolve())
    }

    image.onerror = () => {
      window.clearTimeout(timer)
      finish(() => reject(new Error('load failed')))
    }

    image.src = url
  })
}

async function checkBackgroundSource() {
  const source = normalizeBackgroundSource(draft.backgroundImage)
  if (!source) {
    showMessage('请先输入背景地址', 'error')
    return
  }

  if (!isNetworkBackgroundSource(source)) {
    bgSourceCheckState.value = 'error'
    bgSourceCheckMessage.value = '当前内容不是 http/https 网络源，已按本地或内联资源处理。'
    return
  }

  bgSourceCheckState.value = 'checking'
  bgSourceCheckMessage.value = '正在检测网络源可用性…'

  try {
    await probeImageSource(source)
    bgSourceCheckState.value = 'success'
    bgSourceCheckMessage.value = '网络源可访问，支持图片直链与返回图片流的 API 地址。'
  } catch {
    bgSourceCheckState.value = 'error'
    bgSourceCheckMessage.value = '网络源检测失败：可能受防盗链/CORS/鉴权限制，请改用可公开访问 URL 或先本地上传。'
  }
}

function clearBg() {
  draft.backgroundImage = ''
  applyBackgroundImage('')
  resetBgSourceCheck()
}

function triggerFileUpload() {
  fileInputRef.value?.click()
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  if (!file.type.startsWith('image/')) {
    showMessage('请选择图片文件', 'error')
    return
  }

  if (file.size > 10 * 1024 * 1024) {
    showMessage('图片大小不能超过 10MB', 'error')
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result as string
    draft.backgroundImage = dataUrl
    applyBackgroundImage(dataUrl)
    resetBgSourceCheck()
    showMessage('背景图片已加载（预览中，点击保存以持久化）', 'success')
  }
  reader.onerror = () => {
    showMessage('读取图片失败', 'error')
  }
  reader.readAsDataURL(file)

  input.value = ''
}

// -- CSS editing --

let cssDebounceTimer: ReturnType<typeof setTimeout> | undefined

function onCssInput(value: string) {
  draft.customCss = value
  clearTimeout(cssDebounceTimer)
  cssDebounceTimer = setTimeout(() => {
    applyCustomCss(value)
  }, 300)
}

// -- Save / Reset / Import / Export --

function handleSave() {
  const ok = saveThemeSnapshot({ ...draft })
  if (!ok) {
    showMessage('保存失败：背景图片过大无法存储到本地，请使用 URL 方式设置背景', 'error')
    return
  }
  originalSnapshot.value = JSON.parse(JSON.stringify(draft))
  showMessage('主题已保存', 'success')
}

async function handleReset() {
  if (!(await askConfirm({
    message: '确定恢复为默认主题吗？所有自定义配置将被清除。',
    danger: true,
    confirmText: '恢复默认',
  }))) return

  clearAllCustomizations()
  draft.colorOverrides = {}
  draft.customCss = ''
  draft.backgroundImage = ''
  draft.activePresetId = null
  currentPresetId.value = null
  resetBgSourceCheck()
  originalSnapshot.value = JSON.parse(JSON.stringify(draft))
  showMessage('已恢复默认主题', 'success')
}

function handleExport() {
  const json = exportThemeJson({ ...draft })
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'vcp-theme.json'
  a.click()
  URL.revokeObjectURL(url)
  showMessage('主题配置已导出', 'success')
}

function handleImport() {
  importJson.value = ''
  showImportDialog.value = true
}

function confirmImport() {
  const snapshot = importThemeJson(importJson.value)
  if (!snapshot) {
    showMessage('无效的主题配置 JSON', 'error')
    return
  }
  draft.colorOverrides = snapshot.colorOverrides
  draft.customCss = snapshot.customCss
  draft.backgroundImage = normalizeBackgroundSource(snapshot.backgroundImage)
  draft.activePresetId = snapshot.activePresetId
  currentPresetId.value = snapshot.activePresetId
  resetBgSourceCheck()
  applyFullTheme(draft)
  showImportDialog.value = false
  showMessage('主题配置已导入（预览中，点击保存以持久化）', 'success')
}

// -- Lifecycle & guards --

watch(() => appStore.theme, () => {
  applyFullTheme(draft)
  refreshGlobalCssVars()
})

watch(
  collapsedColorGroups,
  (value) => {
    persistCollapsedColorGroups(value)
  },
  { deep: true }
)

watch(
  integratedColorGroupCards,
  (groups) => {
    const validGroupIds = new Set(groups.map((group) => group.id))
    const normalized: Record<string, boolean> = {}
    let hasInvalidGroup = false

    for (const [groupId, collapsed] of Object.entries(collapsedColorGroups.value)) {
      if (validGroupIds.has(groupId)) {
        normalized[groupId] = collapsed
        continue
      }

      hasInvalidGroup = true
    }

    if (hasInvalidGroup) {
      collapsedColorGroups.value = normalized
    }
  },
  { immediate: true }
)

onMounted(() => {
  refreshGlobalCssVars()
})

onBeforeRouteLeave(async () => {
  if (!isDirty.value) return true

  const confirmed = await askConfirm({
    message: '当前主题有未保存的更改，是否丢弃？',
    confirmText: '丢弃更改',
    danger: true,
  })

  if (confirmed) {
    // 恢复为上次保存的状态
    applyFullTheme(originalSnapshot.value)
    return true
  }
  return false
})

onUnmounted(() => {
  clearTimeout(cssDebounceTimer)
  clearTimeout(bgDebounceTimer)
  pickerRefs.clear()
  _cachedCtx = null
})
</script>

<style scoped>
/* Layout */
.theme-lab {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* Hero eyebrow override (margin only) */
.theme-lab__eyebrow {
  margin-bottom: var(--space-3);
}

.theme-lab__hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: flex-end;
}

/* Tab controls */
.theme-lab__controls {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.theme-lab__filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

/* Section shared */
.theme-lab__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.theme-lab__section-header h3 {
  font-size: var(--font-size-title);
  margin-bottom: var(--space-2);
}

.theme-lab__section-header p {
  color: var(--secondary-text);
  max-width: 64ch;
}

.theme-lab__section-split {
  height: 1px;
  width: 100%;
  background: var(--border-color);
  margin: var(--space-2) 0;
}

.theme-lab__coverage {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.theme-lab__coverage-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  background: var(--surface-overlay-soft);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
}

.theme-lab__coverage-tag strong {
  color: var(--primary-text);
  font-weight: 700;
}

/* Preset grid */
.theme-lab__preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-4);
}

.preset-card {
  cursor: pointer;
  padding: 0;
  overflow: hidden;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    transform var(--transition-fast);
}

.preset-card:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 50%, var(--border-color));
  box-shadow: 0 4px 20px color-mix(in srgb, var(--highlight-text) 10%, transparent);
  transform: translateY(-2px);
}

.preset-card--active {
  border-color: var(--highlight-text);
  box-shadow:
    0 0 0 1px var(--highlight-text),
    0 4px 20px color-mix(in srgb, var(--highlight-text) 16%, transparent);
}

.preset-card__preview {
  height: 72px;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preset-card__preview--user {
  background: var(--tertiary-bg);
}

.preset-card__user-icon {
  font-size: var(--font-size-display);
  color: var(--secondary-text);
  opacity: 0.5;
}

.preset-card__swatches {
  display: flex;
  gap: 8px;
  align-items: center;
}

.preset-card__swatch {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid oklch(1 0 0 / 0.15);
}

.preset-card__body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-3) var(--space-4);
}

.preset-card__identity {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.preset-card__icon {
  font-size: var(--font-size-display);
  color: var(--secondary-text);
  flex-shrink: 0;
}

.preset-card__label {
  font-weight: 600;
  font-size: var(--font-size-body);
  margin: 0;
}

.preset-card__desc {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  margin: 2px 0 0;
}

.preset-card__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.preset-card__check {
  color: var(--highlight-text);
  font-size: var(--font-size-display);
  flex-shrink: 0;
}

.preset-card__delete {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  color: var(--secondary-text);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.preset-card__delete:hover {
  color: var(--danger-color);
  background: var(--danger-bg);
}

.preset-card__delete .material-symbols-outlined {
  font-size: var(--font-size-emphasis);
}

.theme-lab__save-theme-row {
  display: flex;
  justify-content: center;
  padding-top: var(--space-2);
}

/* Color groups */
.color-group__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: 0;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-color);
}

.color-group__header-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.color-group__title-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.color-group__title-row .material-symbols-outlined {
  font-size: var(--font-size-section-icon);
  color: var(--highlight-text);
}

.color-group__title-row h3 {
  font-size: var(--font-size-title);
  margin: 0;
}

.color-group__count {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  background: var(--surface-overlay-soft);
  padding: 4px 10px;
  border-radius: var(--radius-full);
}

.group-collapse-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--secondary-bg);
  color: var(--secondary-text);
  cursor: pointer;
  transition:
    color 0.2s ease,
    background-color 0.2s ease,
    border-color 0.2s ease;
}

.group-collapse-toggle:hover {
  color: var(--primary-text);
  background: color-mix(in srgb, var(--button-bg) 10%, transparent);
  border-color: color-mix(in srgb, var(--button-bg) 28%, transparent);
}

.group-collapse-toggle:focus-visible {
  border-color: color-mix(in srgb, var(--button-bg) 44%, var(--border-color));
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.group-collapse-icon {
  font-size: var(--font-size-title);
  line-height: 1;
  transition: transform 0.24s ease;
}

.group-collapse-toggle.is-collapsed .group-collapse-icon {
  transform: rotate(-90deg);
}

.color-group-collapse {
  display: grid;
  grid-template-rows: 1fr;
  transition:
    grid-template-rows 0.24s ease,
    opacity 0.24s ease;
}

.color-group-collapse.is-collapsed {
  grid-template-rows: 0fr;
  opacity: 0.7;
}

.color-group-content-shell {
  overflow: hidden;
  min-height: 0;
}

.color-group-content {
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-4);
}

.color-group__hint {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.color-group__list {
  display: grid;
  gap: 0;
}

.color-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 0.7fr);
  gap: var(--space-4);
  align-items: center;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  transition: background-color var(--transition-fast);
}

.color-row:hover {
  background: var(--surface-overlay-soft);
}

.color-row--changed {
  background: var(--info-bg);
}

.color-row__copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.color-row__label {
  font-size: var(--font-size-body);
  font-weight: 500;
}

.color-row__var {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
  font-family: var(--font-mono);
  background: var(--tertiary-bg);
  padding: 1px 6px;
  border-radius: 3px;
  display: inline-block;
  max-width: max-content;
}

.color-row__controls {
  display: flex;
  align-items: stretch;
  gap: var(--space-3);
}

.color-row__swatch-wrap {
  position: relative;
  width: 44px;
  min-width: 44px;
  height: 40px;
  flex-shrink: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--input-bg);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.color-row__swatch {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
  cursor: pointer;
  transition: filter var(--transition-fast);
}

.color-row__swatch:hover {
  filter: brightness(1.03);
}

.color-row__swatch-wrap:focus-within {
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.color-row__picker {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: none;
  padding: 0;
}

.color-row__input {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--primary-text);
  font-size: var(--font-size-helper);
  font-family: var(--font-mono);
}

.color-row__input--wide {
  max-width: min(100%, 240px);
}

.color-row__input:focus-visible {
  border-color: var(--highlight-text);
  box-shadow: 0 0 0 2px var(--focus-ring);
  outline: none;
}

.color-group__locked {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px dashed var(--warning-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning-bg) 62%, transparent);
}

.color-group__locked-title {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.6;
}

.color-group__locked-list {
  display: grid;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
  margin: 0;
}

.color-group__locked-list li {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: start;
}

.color-group__locked-list .material-symbols-outlined {
  font-size: var(--font-size-emphasis);
  color: var(--warning-color);
}

.color-group__locked-list code {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  color: var(--primary-text);
  background: var(--surface-overlay-soft);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
}

.color-group__locked-list p {
  margin: 6px 0 0;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  line-height: 1.55;
}

.color-row__reset {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  color: var(--secondary-text);
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.color-row__reset:hover {
  color: var(--danger-color);
  background: var(--danger-bg);
}

.color-row__reset .material-symbols-outlined {
  font-size: var(--font-size-emphasis);
}

/* Background image */
.theme-lab__bg-input-row {
  display: flex;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.theme-lab__bg-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.theme-lab__bg-hint {
  margin: 0;
  max-width: 72ch;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.theme-lab__bg-check {
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-size: var(--font-size-helper);
}

.theme-lab__bg-check--success {
  color: var(--success-text);
  background: var(--success-bg);
  border-color: var(--success-border);
}

.theme-lab__bg-check--error {
  color: var(--danger-text);
  background: var(--danger-bg);
  border-color: var(--danger-border);
}

.theme-lab__bg-check--checking {
  color: var(--info-text);
  background: var(--info-bg);
  border-color: var(--info-border);
}

.theme-lab__file-input {
  display: none;
}

.theme-lab__bg-preview {
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--border-color);
}

.theme-lab__bg-preview-img {
  width: 100%;
  height: 200px;
  position: relative;
}

.theme-lab__bg-preview-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  background: oklch(0 0 0 / 0.3);
  color: oklch(1 0 0);
  font-size: var(--font-size-body);
  font-weight: 500;
}

/* CSS editor */
.theme-lab__css-editor-wrap {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  overflow: hidden;
  margin-bottom: var(--space-4);
}

.theme-lab__css-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  background: var(--surface-overlay-soft);
  border-bottom: 1px solid var(--border-color);
}

.theme-lab__css-lang {
  font-size: var(--font-size-caption);
  font-weight: 700;
  color: var(--highlight-text);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.theme-lab__css-lines {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
}

.theme-lab__css-editor {
  width: 100%;
  min-height: 300px;
  padding: var(--space-3);
  background: var(--input-bg);
  border: none;
  color: var(--primary-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-helper);
  line-height: 1.6;
  resize: vertical;
  tab-size: 2;
}

.theme-lab__css-editor:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.theme-lab__css-editor:focus:not(:focus-visible) {
  outline: none;
}

.theme-lab__css-tips {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.theme-lab__css-tips summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  background: var(--surface-overlay-soft);
  transition: background-color var(--transition-fast);
}

.theme-lab__css-tips summary:hover {
  background: var(--surface-overlay);
}

.theme-lab__css-tips summary .material-symbols-outlined {
  font-size: var(--font-size-emphasis);
  color: var(--warning-color);
}

.theme-lab__css-tips-body {
  padding: var(--space-4);
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  line-height: 1.8;
}

.theme-lab__css-tips-body h4 {
  font-size: var(--font-size-body);
  color: var(--primary-text);
  margin: var(--space-4) 0 var(--space-2);
}

.theme-lab__css-tips-body h4:first-child {
  margin-top: 0;
}

.theme-lab__css-tips-body p {
  margin-bottom: var(--space-2);
}

.theme-lab__css-tips-body ul {
  list-style: none;
  padding: 0;
  margin-bottom: var(--space-3);
}

.theme-lab__css-tips-body li {
  padding: 2px 0;
}

.theme-lab__css-tips-body li::before {
  content: "\2022";
  color: var(--highlight-text);
  margin-right: var(--space-2);
}

.theme-lab__css-tips-body .theme-lab__page-names {
  column-count: 2;
  column-gap: var(--space-5);
}

.theme-lab__css-tips-body code {
  font-family: var(--font-mono);
  background: var(--tertiary-bg);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: var(--font-size-caption);
}

.theme-lab__css-tips-body pre {
  background: var(--tertiary-bg);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  line-height: 1.6;
}

/* Import dialog (uses global .modal-backdrop + .modal-panel) */
.theme-lab__modal-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-index-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--overlay-backdrop-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.theme-lab__modal {
  width: 100%;
  max-width: 560px;
  max-height: min(calc(100vh - var(--space-8)), 900px);
  overflow: auto;
  padding: var(--space-5);
  background: var(--secondary-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--overlay-panel-shadow);
}

.theme-lab__modal h3 {
  font-size: var(--font-size-title);
  margin-bottom: var(--space-2);
}

.theme-lab__import-editor {
  width: 100%;
  min-height: 200px;
  padding: var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-helper);
  resize: vertical;
  margin-bottom: var(--space-4);
}

.theme-lab__import-editor:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.theme-lab__import-editor:focus:not(:focus-visible) {
  border-color: var(--highlight-text);
  outline: none;
}

.theme-lab__save-name-input {
  width: 100%;
  padding: var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
  font-size: var(--font-size-body);
  margin-bottom: var(--space-4);
}

.theme-lab__save-name-input:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.theme-lab__save-name-input:focus:not(:focus-visible) {
  border-color: var(--highlight-text);
  outline: none;
}

.theme-lab__modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* Responsive */
@media (max-width: 768px) {
  .theme-lab__hero-actions {
    justify-content: stretch;
  }

  .theme-lab__hero-actions button {
    flex: 1;
    min-width: 0;
    justify-content: center;
  }

  .theme-lab__preset-grid {
    grid-template-columns: 1fr;
  }

  .color-group__header {
    flex-direction: column;
    align-items: flex-start;
  }

  .color-group__header-actions {
    width: 100%;
    justify-content: space-between;
  }

  .color-row {
    grid-template-columns: 1fr;
    gap: var(--space-2);
    padding: var(--space-3);
  }

  .color-row__controls {
    flex-wrap: wrap;
  }

  .color-row__input,
  .color-row__input--wide {
    max-width: 100%;
  }

  .theme-lab__bg-input-row {
    flex-direction: column;
  }

  .theme-lab__bg-meta {
    flex-direction: column;
    align-items: stretch;
  }

  .theme-lab__filter-row {
    gap: var(--space-2);
  }

  .theme-lab__css-tips-body .theme-lab__page-names {
    column-count: 1;
  }
}

@media (max-width: 480px) {
  .theme-lab__hero-actions {
    flex-direction: column;
  }

  .theme-lab__hero-actions button {
    width: 100%;
    justify-content: center;
  }

  .preset-card__body {
    padding: var(--space-2) var(--space-3);
  }
}
</style>
