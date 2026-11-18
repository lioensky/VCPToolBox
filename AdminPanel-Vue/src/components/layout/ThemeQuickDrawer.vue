<template>
  <Teleport to="body">
    <Transition name="theme-quick-drawer">
      <div
        v-if="open"
        class="theme-quick"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-quick-title"
        @keydown.esc="emitClose"
      >
        <button
          class="theme-quick__scrim"
          type="button"
          aria-label="关闭快捷外观"
          @click="emitClose"
        />

        <aside class="theme-quick__panel">
          <header class="theme-quick__header">
            <div>
              <h2 id="theme-quick-title">快捷外观</h2>
              <p>快速调整面板外观与布局偏好。</p>
            </div>
            <UiIconButton label="关闭快捷外观" title="关闭" @click="emitClose">
              <span class="material-symbols-outlined" aria-hidden="true">close</span>
            </UiIconButton>
          </header>

          <div class="theme-quick__body">
            <section class="theme-quick__section">
              <h3>预设主题</h3>
              <div class="theme-quick__preset-grid">
                <button
                  v-for="preset in presets"
                  :key="preset.id"
                  type="button"
                  class="theme-quick__preset"
                  :class="{ 'theme-quick__preset--active': activePresetId === preset.id }"
                  @click="applyPreset(preset)"
                >
                  <span class="theme-quick__preset-swatches" aria-hidden="true">
                    <span
                      v-for="(color, index) in getPresetSwatches(preset)"
                      :key="index"
                      :style="{ backgroundColor: color }"
                    />
                  </span>
                  <span class="theme-quick__preset-label">{{ preset.label }}</span>
                  <span class="theme-quick__check material-symbols-outlined" aria-hidden="true">check_circle</span>
                </button>
              </div>
            </section>

            <section class="theme-quick__section">
              <h3>外观</h3>
              <div class="theme-quick__grid theme-quick__grid--two">
                <button
                  v-for="item in themeModeOptions"
                  :key="item.id"
                  type="button"
                  class="theme-quick__choice theme-quick__choice--icon"
                  :class="{ 'theme-quick__choice--active': settings.themeMode === item.id }"
                  @click="updateQuickSetting('themeMode', item.id)"
                >
                  <span class="theme-quick__preview" aria-hidden="true">
                    <span class="material-symbols-outlined">{{ item.icon }}</span>
                  </span>
                  <span>{{ item.label }}</span>
                  <span class="theme-quick__check material-symbols-outlined" aria-hidden="true">check_circle</span>
                </button>
              </div>
            </section>

            <section class="theme-quick__section">
              <h3>圆角</h3>
              <div class="theme-quick__grid theme-quick__grid--three">
                <button
                  v-for="item in radiusOptions"
                  :key="item.id"
                  type="button"
                  class="theme-quick__choice theme-quick__choice--radius"
                  :class="{ 'theme-quick__choice--active': settings.radius === item.id }"
                  @click="updateQuickSetting('radius', item.id)"
                >
                  <span class="theme-quick__radius-preview" aria-hidden="true">
                    <span :style="{ borderTopLeftRadius: item.preview }" />
                  </span>
                  <span>{{ item.label }}</span>
                  <small>{{ item.description }}</small>
                  <span class="theme-quick__check material-symbols-outlined" aria-hidden="true">check_circle</span>
                </button>
              </div>
            </section>

            <section class="theme-quick__section">
              <h3>密度</h3>
              <div class="theme-quick__grid theme-quick__grid--two">
                <button
                  v-for="item in scaleOptions"
                  :key="item.id"
                  type="button"
                  class="theme-quick__choice"
                  :class="{ 'theme-quick__choice--active': settings.scale === item.id }"
                  @click="updateQuickSetting('scale', item.id)"
                >
                  <span>{{ item.label }}</span>
                  <small>{{ item.description }}</small>
                  <span class="theme-quick__check material-symbols-outlined" aria-hidden="true">check_circle</span>
                </button>
              </div>
            </section>

            <section class="theme-quick__section">
              <h3>字体</h3>
              <div class="theme-quick__grid theme-quick__grid--three">
                <button
                  v-for="item in fontOptions"
                  :key="item.id"
                  type="button"
                  class="theme-quick__choice"
                  :class="{ 'theme-quick__choice--active': settings.font === item.id }"
                  @click="updateQuickSetting('font', item.id)"
                >
                  <span>{{ item.label }}</span>
                  <small>{{ item.description }}</small>
                  <span class="theme-quick__check material-symbols-outlined" aria-hidden="true">check_circle</span>
                </button>
              </div>
            </section>

            <section class="theme-quick__section">
              <h3>布局</h3>
              <div class="theme-quick__grid theme-quick__grid--two">
                <button
                  v-for="item in contentLayoutOptions"
                  :key="item.id"
                  type="button"
                  class="theme-quick__choice"
                  :class="{ 'theme-quick__choice--active': settings.contentLayout === item.id }"
                  @click="updateQuickSetting('contentLayout', item.id)"
                >
                  <span>{{ item.label }}</span>
                  <small>{{ item.description }}</small>
                  <span class="theme-quick__check material-symbols-outlined" aria-hidden="true">check_circle</span>
                </button>
              </div>
            </section>

            <section class="theme-quick__section">
              <h3>外壳</h3>
              <div class="theme-quick__grid theme-quick__grid--two">
                <button
                  v-for="item in shellLayoutOptions"
                  :key="item.id"
                  type="button"
                  class="theme-quick__choice"
                  :class="{ 'theme-quick__choice--active': settings.shellLayout === item.id }"
                  @click="updateQuickSetting('shellLayout', item.id)"
                >
                  <span>{{ item.label }}</span>
                  <small>{{ item.description }}</small>
                  <span class="theme-quick__check material-symbols-outlined" aria-hidden="true">check_circle</span>
                </button>
              </div>
            </section>
          </div>

          <footer class="theme-quick__footer">
            <UiButton variant="outline" size="lg" block @click="openThemeEditor">
              <template #leading>
                <span class="material-symbols-outlined">tune</span>
              </template>
              打开完整主题编辑器
            </UiButton>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import UiButton from "@/components/ui/UiButton.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import { useAppStore } from "@/stores/app";
import {
  applyActiveTheme,
  FULL_PRESET_THEMES,
  loadActivePresetId,
  loadThemeQuickSettings,
  notifyThemeSettingsChanged,
  saveActivePresetId,
  saveThemeQuickSettings,
  THEME_CONTENT_LAYOUT_OPTIONS,
  THEME_FONT_OPTIONS,
  THEME_MODE_OPTIONS,
  THEME_RADIUS_OPTIONS,
  THEME_SCALE_OPTIONS,
  THEME_SHELL_LAYOUT_OPTIONS,
  type FullPresetTheme,
  type ThemeQuickSettings,
} from "@/features/theme-editor/themeEngine";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const router = useRouter();
const appStore = useAppStore();

const themeModeOptions = THEME_MODE_OPTIONS;
const radiusOptions = THEME_RADIUS_OPTIONS;
const scaleOptions = THEME_SCALE_OPTIONS;
const fontOptions = THEME_FONT_OPTIONS;
const contentLayoutOptions = THEME_CONTENT_LAYOUT_OPTIONS;
const shellLayoutOptions = THEME_SHELL_LAYOUT_OPTIONS;
const presets = FULL_PRESET_THEMES;

const settings = reactive<ThemeQuickSettings>(loadThemeQuickSettings());
const activePresetId = ref(loadActivePresetId() || "default-blue");

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    Object.assign(settings, loadThemeQuickSettings());
    activePresetId.value = loadActivePresetId() || "default-blue";
  }
);

function updateQuickSetting<K extends keyof ThemeQuickSettings>(
  key: K,
  value: ThemeQuickSettings[K]
) {
  settings[key] = value;
  saveThemeQuickSettings(settings);

  if (key === "themeMode") {
    appStore.setTheme(settings.themeMode);
  }

  applyActiveTheme();
  notifyThemeSettingsChanged();
}

function getPresetSwatches(preset: FullPresetTheme): string[] {
  if (preset.swatches?.length) {
    return preset.swatches.slice(0, 3);
  }

  return [
    preset.colors["--highlight-text-dark"] || "oklch(0.75 0.14 230)",
    preset.colors["--button-bg-dark"] || "oklch(0.68 0.16 230)",
    preset.colors["--accent-bg-dark"] || "oklch(0.30 0.08 230)",
  ];
}

function applyPreset(preset: FullPresetTheme) {
  activePresetId.value = preset.id;
  saveActivePresetId(preset.id);

  if (preset.defaultRadius) {
    settings.radius = preset.defaultRadius;
  }
  if (preset.defaultFont) {
    settings.font = preset.defaultFont;
  }

  saveThemeQuickSettings(settings);
  applyActiveTheme();
  notifyThemeSettingsChanged();
}

function emitClose() {
  emit("close");
}

function openThemeEditor() {
  emitClose();
  router.push({ name: "ThemeEditor" });
}
</script>

<style scoped>
.theme-quick {
  position: fixed;
  inset: 0;
  z-index: 2147482000;
  display: flex;
  justify-content: flex-end;
}

.theme-quick__scrim {
  position: absolute;
  inset: 0;
  border: 0;
  background: color-mix(in srgb, var(--primary-bg) 34%, transparent);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  cursor: default;
}

.theme-quick__panel {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(420px, calc(100vw - 16px));
  height: 100%;
  background: color-mix(in srgb, var(--secondary-bg) 98%, var(--primary-bg));
  border-left: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
  box-shadow: var(--shadow-overlay-soft);
  color: var(--primary-text);
}

.theme-quick__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.theme-quick__header h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: 0;
}

.theme-quick__header p {
  margin: 4px 0 0;
  color: var(--secondary-text);
  font-size: 0.8125rem;
  line-height: 1.45;
}

.theme-quick__body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  overflow: auto;
  padding: 16px 18px 18px;
}

.theme-quick__section {
  display: grid;
  gap: 8px;
}

.theme-quick__section h3 {
  margin: 0;
  color: var(--secondary-text);
  font-size: 0.8125rem;
  font-weight: 650;
  line-height: 1.3;
}

.theme-quick__grid {
  display: grid;
  gap: 8px;
}

.theme-quick__grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.theme-quick__grid--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.theme-quick__preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.theme-quick__preset {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1.4%, transparent);
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.theme-quick__preset:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 34%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 4%, transparent);
}

.theme-quick__preset:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.theme-quick__preset--active {
  border-color: color-mix(in srgb, var(--highlight-text) 76%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 7%, transparent);
}

.theme-quick__preset-swatches {
  display: inline-flex;
  align-items: center;
  width: 38px;
  height: 18px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  border-radius: 999px;
}

.theme-quick__preset-swatches span {
  flex: 1 1 0;
  align-self: stretch;
}

.theme-quick__preset-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.25;
}

.theme-quick__choice {
  position: relative;
  display: grid;
  align-content: start;
  gap: 4px;
  min-height: 56px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--border-color) 86%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1.4%, transparent);
  color: var(--primary-text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.theme-quick__choice:hover {
  border-color: color-mix(in srgb, var(--highlight-text) 34%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 4%, transparent);
}

.theme-quick__choice:focus-visible {
  outline: 2px solid var(--highlight-text);
  outline-offset: 2px;
}

.theme-quick__choice > span:not(.theme-quick__preview):not(.theme-quick__check):not(.theme-quick__radius-preview) {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
}

.theme-quick__choice small {
  color: var(--secondary-text);
  font-size: 0.6875rem;
  line-height: 1.3;
}

.theme-quick__choice--active {
  border-color: color-mix(in srgb, var(--highlight-text) 76%, var(--border-color));
  background: color-mix(in srgb, var(--highlight-text) 7%, transparent);
}

.theme-quick__choice--icon {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  min-height: 48px;
}

.theme-quick__preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent-bg) 72%, transparent);
  color: var(--primary-text);
}

.theme-quick__preview .material-symbols-outlined {
  font-size: 17px;
}

.theme-quick__radius-preview {
  display: block;
  width: 26px;
  height: 20px;
}

.theme-quick__radius-preview span {
  display: block;
  width: 24px;
  height: 18px;
  border-top: 2px solid var(--highlight-text);
  border-left: 2px solid var(--highlight-text);
}

.theme-quick__check {
  position: absolute;
  top: -8px;
  right: -8px;
  display: none;
  color: var(--highlight-text);
  font-size: 18px;
  background: var(--secondary-bg);
  border-radius: 999px;
}

.theme-quick__choice--active .theme-quick__check {
  display: inline-flex;
}

.theme-quick__footer {
  padding: 12px 18px 16px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
  background: color-mix(in srgb, var(--secondary-bg) 92%, transparent);
}

.theme-quick__footer .material-symbols-outlined {
  font-size: 18px;
}

.theme-quick-drawer-enter-active,
.theme-quick-drawer-leave-active {
  transition: opacity var(--transition-fast);
}

.theme-quick-drawer-enter-active .theme-quick__panel,
.theme-quick-drawer-leave-active .theme-quick__panel {
  transition: transform var(--transition-fast);
}

.theme-quick-drawer-enter-from,
.theme-quick-drawer-leave-to {
  opacity: 0;
}

.theme-quick-drawer-enter-from .theme-quick__panel,
.theme-quick-drawer-leave-to .theme-quick__panel {
  transform: translateX(18px);
}

@media (max-width: 640px) {
  .theme-quick__panel {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .theme-quick-drawer-enter-active,
  .theme-quick-drawer-leave-active,
  .theme-quick-drawer-enter-active .theme-quick__panel,
  .theme-quick-drawer-leave-active .theme-quick__panel {
    transition: none;
  }
}
</style>
