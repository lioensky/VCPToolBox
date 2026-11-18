<template>
  <Transition name="celestial-panel">
    <div v-if="isImmersiveMode" class="celestial-panel" :class="{ 'is-open': isOpen }">
      <Transition name="celestial-expand" mode="out-in">
        <button
          v-if="!isOpen"
          key="capsule"
          type="button"
          class="celestial-panel__capsule"
          aria-label="展开实时星轨数据"
          @click="openPanel"
        >
          <span class="material-symbols-outlined">auto_awesome</span>
          <span>星轨</span>
        </button>

      <section v-else key="card" class="celestial-panel__card" aria-label="实时星轨数据">
        <header class="celestial-panel__header">
          <div>
            <p class="celestial-panel__eyebrow">LIVE CELESTIAL TRACE</p>
            <h2>实时星轨记录</h2>
          </div>
          <button
            type="button"
            class="celestial-panel__icon-btn"
            aria-label="收起实时星轨数据"
            @click="isOpen = false"
          >
            <span class="material-symbols-outlined">keyboard_arrow_down</span>
          </button>
        </header>

        <div class="celestial-panel__meta">
          <span>{{ snapshotTimeLabel }}</span>
          <span>{{ freshnessLabel }}</span>
        </div>

        <div v-if="isLoadingSnapshot" class="celestial-panel__loading">
          <span class="material-symbols-outlined">progress_activity</span>
          正在校准星历……
        </div>

        <div v-else-if="snapshotError" class="celestial-panel__error">
          {{ snapshotError }}
        </div>

        <div v-else class="celestial-panel__planet-list">
          <article
            v-for="planet in planets"
            :key="planet.planet"
            class="celestial-panel__planet"
          >
            <span class="celestial-panel__planet-name">{{ planet.name_cn }}</span>
            <span class="celestial-panel__planet-angle">{{ planet.angle_deg.toFixed(2) }}°</span>
            <span class="celestial-panel__planet-distance">{{ planet.distance_au.toFixed(3) }} AU</span>
          </article>
        </div>

        <footer class="celestial-panel__actions">
          <button type="button" class="celestial-panel__secondary" @click="loadSnapshot">
            重新校准
          </button>
          <button type="button" class="celestial-panel__primary" @click="openTarotModal">
            塔罗占卜
          </button>
        </footer>
      </section>
      </Transition>

      <Teleport to="body">
        <Transition name="tarot-modal">
          <div v-if="isTarotModalOpen" class="tarot-modal" role="dialog" aria-modal="true" aria-label="今日塔罗占卜">
            <div class="tarot-modal__backdrop" @click="closeTarotModal"></div>
            <section class="tarot-modal__panel">
              <header class="tarot-modal__header">
                <div>
                  <p class="celestial-panel__eyebrow">TAROT DIVINATION</p>
                  <h2>今日优雅占卜</h2>
                </div>
                <button
                  type="button"
                  class="celestial-panel__icon-btn"
                  aria-label="关闭塔罗占卜"
                  @click="closeTarotModal"
                >
                  <span class="material-symbols-outlined">close</span>
                </button>
              </header>

              <form class="tarot-modal__form" @submit.prevent="submitDivination">
                <label>
                  <span>牌阵</span>
                  <select v-model="tarotForm.command">
                    <option value="draw_single_card">单牌占卜</option>
                    <option value="draw_three_card_spread">三牌阵</option>
                    <option value="draw_celtic_cross">凯尔特十字</option>
                  </select>
                </label>

                <label>
                  <span>起源</span>
                  <select v-model="tarotForm.origin">
                    <option value="星">✦ 星：智慧与平衡</option>
                    <option value="日">☉ 日：行动与显化</option>
                    <option value="月">☽ 月：直觉与潜意识</option>
                  </select>
                </label>

                <label>
                  <span>命运检定数</span>
                  <input
                    v-model="tarotForm.fate_check_number"
                    type="number"
                    inputmode="numeric"
                    placeholder="可留空，让星轨决定"
                  />
                </label>

                <button type="submit" class="tarot-modal__submit" :disabled="isDivining || isRevealingDestiny">
                  {{ isDivining || isRevealingDestiny ? "正在揭示…" : "开始占卜" }}
                </button>
              </form>

              <div v-if="divinationError" class="celestial-panel__error tarot-modal__error">
                {{ divinationError }}
              </div>

              <Transition name="tarot-reveal" mode="out-in">
                <section v-if="isRevealingDestiny" key="revealing" class="tarot-reveal" aria-live="polite">
                  <div class="tarot-reveal__orb" aria-hidden="true">
                    <span class="tarot-reveal__card tarot-reveal__card--left"></span>
                    <span class="tarot-reveal__card tarot-reveal__card--center">
                      <span class="material-symbols-outlined">auto_awesome</span>
                    </span>
                    <span class="tarot-reveal__card tarot-reveal__card--right"></span>
                  </div>
                  <div class="tarot-reveal__copy">
                    <p>正在揭示命运……</p>
                    <span>星轨正在翻开牌面，请保持灵魂的静默。</span>
                  </div>
                  <div class="tarot-reveal__sparkles" aria-hidden="true">
                    <i></i>
                    <i></i>
                    <i></i>
                  </div>
                </section>

                <section v-else-if="divinationResult" key="result" class="tarot-result">
                  <header class="tarot-result__header">
                    <h3>{{ divinationResult.spread?.name || "占卜结果" }}</h3>
                    <span v-if="divinationResult.spread?.origin">
                      {{ divinationResult.spread.origin.symbol }} {{ divinationResult.spread.origin.name }}
                    </span>
                  </header>

                  <div class="tarot-result__cards">
                    <article
                      v-for="card in divinationResult.details || []"
                      :key="`${card.position}-${card.name}`"
                      class="tarot-card"
                      :class="{ 'is-reversed': card.reversed }"
                    >
                      <div class="tarot-card__image-shell">
                        <img :src="card.image_url" :alt="`${card.name_cn}${card.reversed ? '逆位' : '正位'}`" />
                      </div>
                      <div class="tarot-card__copy">
                        <span class="tarot-card__position">{{ card.position }}</span>
                        <h4>{{ card.name_cn }} · {{ card.reversed ? "逆位" : "正位" }}</h4>
                        <p>{{ card.meaning }}</p>
                      </div>
                    </article>
                  </div>
                </section>
              </Transition>
            </section>
          </div>
        </Transition>
      </Teleport>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  tarotDivinationApi,
  type TarotCardDetail,
  type TarotCelestialSnapshot,
  type TarotDivinationResult,
  type TarotInvokePayload,
} from "@/api";
import { useAppStore } from "@/stores/app";

const appStore = useAppStore();
const isImmersiveMode = computed(() => appStore.isImmersiveMode);

const isOpen = ref(false);
const isLoadingSnapshot = ref(false);
const snapshot = ref<TarotCelestialSnapshot | null>(null);
const snapshotError = ref("");

const isTarotModalOpen = ref(false);
const isDivining = ref(false);
const isRevealingDestiny = ref(false);
const divinationError = ref("");
const divinationResult = ref<TarotDivinationResult | null>(null);

const tarotForm = reactive<TarotInvokePayload>({
  command: "draw_three_card_spread",
  origin: "星",
  fate_check_number: "",
});

const planets = computed(() => snapshot.value?.planets || []);

const snapshotTimeLabel = computed(() => {
  if (!snapshot.value?.sampled_at) {
    return "等待星历采样";
  }

  return new Date(snapshot.value.sampled_at).toLocaleString("zh-CN", {
    hour12: false,
  });
});

const freshnessLabel = computed(() => {
  const diffMs = snapshot.value?.diff_ms;
  if (typeof diffMs !== "number") {
    return "未同步";
  }

  return `误差 ${Math.round(diffMs / 60000)} 分钟`;
});

function syncAnglesToSolarSystem(nextSnapshot: TarotCelestialSnapshot | null) {
  appStore.setImmersiveCelestialAngles(
    (nextSnapshot?.planets || []).map((planet) => ({
      planet: planet.planet,
      angle: planet.angle_deg,
    }))
  );
}

async function loadSnapshot() {
  isLoadingSnapshot.value = true;
  snapshotError.value = "";

  try {
    const response = await tarotDivinationApi.getCelestialSnapshot(tarotForm.origin, {
      showLoader: false,
      suppressErrorMessage: true,
    });

    if (response.status !== "success" || !response.result) {
      throw new Error(response.error || response.details || "星轨数据暂不可用。");
    }

    snapshot.value = response.result;
    syncAnglesToSolarSystem(response.result);
  } catch (error) {
    snapshotError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isLoadingSnapshot.value = false;
  }
}

function openPanel() {
  isOpen.value = true;
  void loadSnapshot();
}

function openTarotModal() {
  isTarotModalOpen.value = true;
}

function closeTarotModal() {
  isTarotModalOpen.value = false;
}

function waitForDestinyReveal(delayMs: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function preloadTarotImages(cards: TarotCardDetail[]) {
  const imageUrls = cards.map((card) => card.image_url).filter(Boolean);

  if (!imageUrls.length) {
    return Promise.resolve();
  }

  return Promise.allSettled(
    imageUrls.map(
      (imageUrl) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = () => resolve();
          image.onerror = () => resolve();
          image.src = imageUrl;
        })
    )
  );
}

async function submitDivination() {
  isDivining.value = true;
  isRevealingDestiny.value = false;
  divinationError.value = "";
  divinationResult.value = null;

  try {
    const response = await tarotDivinationApi.invoke(tarotForm, {
      loadingKey: "immersive-tarot-divination",
      suppressErrorMessage: true,
    });

    if (response.status !== "success" || !response.result) {
      throw new Error(response.error || response.details || "占卜失败，星轨没有回应。");
    }

    const nextResult: TarotDivinationResult = {
      ...response.result,
      details: (response.result.details || []) as TarotCardDetail[],
    };

    isDivining.value = false;
    isRevealingDestiny.value = true;

    await Promise.all([
      waitForDestinyReveal(900),
      Promise.race([preloadTarotImages(nextResult.details || []), waitForDestinyReveal(1800)]),
    ]);

    divinationResult.value = nextResult;
  } catch (error) {
    divinationError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isDivining.value = false;
    isRevealingDestiny.value = false;
  }
}

watch(isImmersiveMode, (enabled) => {
  isOpen.value = false;
  isTarotModalOpen.value = false;
  isRevealingDestiny.value = false;
  snapshot.value = null;
  snapshotError.value = "";
  syncAnglesToSolarSystem(null);

  if (!enabled) {
    return;
  }
});
</script>

<style scoped>
.celestial-panel {
  position: fixed;
  left: 24px;
  bottom: 24px;
  z-index: 10002;
  color: var(--primary-text);
}

.celestial-panel__capsule,
.celestial-panel__card,
.tarot-modal__panel {
  border: 1px solid color-mix(in srgb, var(--highlight-text) 36%, transparent);
  background:
    radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--highlight-text) 22%, transparent), transparent 46%),
    color-mix(in srgb, var(--secondary-bg) 82%, transparent);
  backdrop-filter: blur(18px);
  box-shadow:
    0 24px 60px color-mix(in srgb, #000 34%, transparent),
    0 0 34px color-mix(in srgb, var(--highlight-text) 14%, transparent);
}

.celestial-panel__capsule {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 10px 16px;
  border-radius: 999px;
  color: var(--primary-text);
  cursor: pointer;
  transform-origin: left bottom;
}

.celestial-panel__capsule:hover {
  transform: translateY(-2px);
}

.celestial-panel__card {
  width: min(360px, calc(100vw - 32px));
  padding: 16px;
  border-radius: 24px;
  transform-origin: left bottom;
}

.celestial-panel__header,
.tarot-modal__header,
.tarot-result__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.celestial-panel__eyebrow {
  margin: 0 0 4px;
  color: color-mix(in srgb, var(--highlight-text) 86%, #fff);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}

.celestial-panel h2,
.tarot-modal h2,
.tarot-result h3 {
  margin: 0;
}

.celestial-panel__icon-btn {
  display: inline-grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid color-mix(in srgb, var(--border-color) 76%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-overlay-soft) 86%, transparent);
  color: var(--primary-text);
  cursor: pointer;
}

.celestial-panel__meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 12px 0;
  color: var(--secondary-text);
  font-size: 0.76rem;
}

.celestial-panel__loading,
.celestial-panel__error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--tertiary-bg) 72%, transparent);
  color: var(--secondary-text);
}

.celestial-panel__loading .material-symbols-outlined {
  animation: celestial-spin 1s linear infinite;
}

.celestial-panel__error {
  color: var(--danger-text, #ffb4b4);
}

.celestial-panel__planet-list {
  display: grid;
  gap: 8px;
  max-height: 280px;
  overflow: auto;
}

.celestial-panel__planet {
  display: grid;
  grid-template-columns: 64px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-overlay-soft) 70%, transparent);
}

.celestial-panel__planet-name {
  font-weight: 700;
}

.celestial-panel__planet-angle {
  color: var(--highlight-text);
  font-variant-numeric: tabular-nums;
}

.celestial-panel__planet-distance {
  color: var(--secondary-text);
  font-size: 0.76rem;
}

.celestial-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}

.celestial-panel__primary,
.celestial-panel__secondary,
.tarot-modal__submit {
  min-height: 36px;
  padding: 8px 14px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 700;
}

.celestial-panel__primary,
.tarot-modal__submit {
  border: 1px solid color-mix(in srgb, var(--highlight-text) 56%, transparent);
  background: color-mix(in srgb, var(--highlight-text) 26%, transparent);
  color: var(--primary-text);
}

.celestial-panel__secondary {
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--secondary-text);
}

.tarot-modal {
  position: fixed;
  inset: 0;
  z-index: 10005;
  display: grid;
  place-items: center;
  padding: 24px;
}

.tarot-modal__backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, #000 48%, transparent);
  backdrop-filter: blur(6px);
}

.tarot-modal__panel {
  position: relative;
  width: min(920px, calc(100vw - 32px));
  max-height: min(760px, calc(100vh - 32px));
  overflow: auto;
  padding: 20px;
  border-radius: 28px;
}

.tarot-modal__form {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 18px 0;
}

.tarot-modal__form label {
  display: grid;
  gap: 6px;
  color: var(--secondary-text);
  font-size: 0.82rem;
}

.tarot-modal__form label:first-child,
.tarot-modal__form label:nth-child(2) {
  grid-column: span 1;
}

.tarot-modal__form input,
.tarot-modal__form select {
  width: 100%;
  min-height: 38px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: color-mix(in srgb, var(--tertiary-bg) 78%, transparent);
  color: var(--primary-text);
  padding: 8px 10px;
}

.tarot-modal__submit {
  align-self: end;
}

.tarot-modal__submit:disabled {
  cursor: wait;
  opacity: 0.68;
}

.tarot-modal__error {
  margin-bottom: 14px;
}

.tarot-reveal {
  position: relative;
  display: grid;
  place-items: center;
  gap: 18px;
  min-height: 430px;
  margin-top: 8px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 28%, transparent);
  border-radius: 22px;
  background:
    radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--highlight-text) 24%, transparent), transparent 34%),
    radial-gradient(circle at 18% 18%, color-mix(in srgb, #fff 14%, transparent), transparent 26%),
    color-mix(in srgb, var(--surface-overlay-soft) 72%, transparent);
}

.tarot-reveal::before {
  content: "";
  position: absolute;
  width: 420px;
  height: 420px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 32%, transparent);
  border-radius: 999px;
  animation: tarot-reveal-orbit 8s linear infinite;
}

.tarot-reveal::after {
  content: "";
  position: absolute;
  inset: 16%;
  border-radius: 999px;
  background: conic-gradient(
    from 90deg,
    transparent,
    color-mix(in srgb, var(--highlight-text) 22%, transparent),
    transparent,
    color-mix(in srgb, #fff 12%, transparent),
    transparent
  );
  filter: blur(20px);
  opacity: 0.72;
  animation: tarot-reveal-aura 3.4s ease-in-out infinite;
}

.tarot-reveal__orb {
  position: relative;
  z-index: 1;
  width: min(340px, 76vw);
  height: 230px;
}

.tarot-reveal__card {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  place-items: center;
  width: 112px;
  height: 166px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 58%, transparent);
  border-radius: 16px;
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--highlight-text) 28%, transparent), transparent),
    repeating-linear-gradient(
      45deg,
      color-mix(in srgb, #fff 10%, transparent) 0 1px,
      transparent 1px 9px
    ),
    color-mix(in srgb, var(--secondary-bg) 92%, #000);
  box-shadow:
    0 18px 42px color-mix(in srgb, #000 34%, transparent),
    inset 0 0 28px color-mix(in srgb, var(--highlight-text) 16%, transparent);
  transform: translate(-50%, -50%);
}

.tarot-reveal__card--left {
  animation: tarot-card-left 2.8s ease-in-out infinite;
}

.tarot-reveal__card--center {
  z-index: 2;
  color: color-mix(in srgb, var(--highlight-text) 88%, #fff);
  animation: tarot-card-center 2.8s ease-in-out infinite;
}

.tarot-reveal__card--center .material-symbols-outlined {
  font-size: 2.2rem;
  animation: tarot-star-pulse 1.8s ease-in-out infinite;
}

.tarot-reveal__card--right {
  animation: tarot-card-right 2.8s ease-in-out infinite;
}

.tarot-reveal__copy {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 6px;
  text-align: center;
}

.tarot-reveal__copy p {
  margin: 0;
  color: var(--primary-text);
  font-size: 1.02rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.tarot-reveal__copy span {
  color: var(--secondary-text);
  font-size: 0.86rem;
}

.tarot-reveal__sparkles {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 8px;
}

.tarot-reveal__sparkles i {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--highlight-text) 86%, #fff);
  box-shadow: 0 0 14px color-mix(in srgb, var(--highlight-text) 64%, transparent);
  animation: tarot-sparkle 1.2s ease-in-out infinite;
}

.tarot-reveal__sparkles i:nth-child(2) {
  animation-delay: 0.18s;
}

.tarot-reveal__sparkles i:nth-child(3) {
  animation-delay: 0.36s;
}

.tarot-result__header {
  align-items: center;
  margin-bottom: 12px;
}

.tarot-result__header span {
  color: var(--highlight-text);
  font-weight: 800;
}

.tarot-result__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}

.tarot-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-overlay-soft) 72%, transparent);
}

.tarot-card__image-shell {
  display: grid;
  place-items: center;
  min-height: clamp(320px, 48vh, 520px);
  overflow: visible;
  border-radius: 14px;
  background:
    radial-gradient(circle, color-mix(in srgb, var(--highlight-text) 18%, transparent), transparent 62%),
    color-mix(in srgb, #000 20%, transparent);
}

.tarot-card__image-shell img {
  width: 100%;
  height: clamp(300px, 46vh, 500px);
  border-radius: 10px;
  object-fit: contain;
}

.tarot-card__position {
  color: var(--highlight-text);
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.tarot-card h4 {
  margin: 4px 0;
}

.tarot-card p {
  margin: 0;
  color: var(--secondary-text);
  font-size: 0.86rem;
  line-height: 1.6;
}

.celestial-panel-enter-active,
.celestial-panel-leave-active,
.celestial-expand-enter-active,
.celestial-expand-leave-active,
.tarot-modal-enter-active,
.tarot-modal-leave-active,
.tarot-reveal-enter-active,
.tarot-reveal-leave-active {
  transition:
    opacity 0.32s ease,
    transform 0.42s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.36s ease;
}

.celestial-panel-enter-from,
.celestial-panel-leave-to,
.celestial-expand-enter-from,
.celestial-expand-leave-to,
.tarot-modal-enter-from,
.tarot-modal-leave-to,
.tarot-reveal-enter-from,
.tarot-reveal-leave-to {
  opacity: 0;
  filter: blur(10px);
  transform: translateY(12px) scale(0.9);
}

.celestial-expand-enter-from {
  transform: translateY(10px) scale(0.72);
}

.celestial-expand-leave-to {
  transform: translateY(6px) scale(0.82);
}

@keyframes celestial-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes tarot-reveal-orbit {
  to {
    transform: rotate(360deg);
  }
}

@keyframes tarot-reveal-aura {
  0%,
  100% {
    opacity: 0.42;
    transform: scale(0.92) rotate(0deg);
  }

  50% {
    opacity: 0.86;
    transform: scale(1.06) rotate(18deg);
  }
}

@keyframes tarot-card-left {
  0%,
  100% {
    transform: translate(-86%, -48%) rotate(-14deg);
  }

  50% {
    transform: translate(-96%, -54%) rotate(-18deg);
  }
}

@keyframes tarot-card-center {
  0%,
  100% {
    transform: translate(-50%, -52%) rotate(0deg) scale(1);
  }

  50% {
    transform: translate(-50%, -60%) rotate(2deg) scale(1.04);
  }
}

@keyframes tarot-card-right {
  0%,
  100% {
    transform: translate(-14%, -48%) rotate(14deg);
  }

  50% {
    transform: translate(-4%, -54%) rotate(18deg);
  }
}

@keyframes tarot-star-pulse {
  0%,
  100% {
    opacity: 0.62;
    transform: scale(0.92);
  }

  50% {
    opacity: 1;
    transform: scale(1.12);
  }
}

@keyframes tarot-sparkle {
  0%,
  100% {
    opacity: 0.28;
    transform: translateY(0) scale(0.72);
  }

  50% {
    opacity: 1;
    transform: translateY(-4px) scale(1);
  }
}

@media (max-width: 720px) {
  .celestial-panel {
    left: 12px;
    bottom: 12px;
  }

  .tarot-modal {
    padding: 12px;
  }

  .tarot-modal__form {
    grid-template-columns: 1fr;
  }

  .tarot-card__image-shell {
    min-height: 360px;
  }

  .tarot-card__image-shell img {
    height: 340px;
  }
}
</style>