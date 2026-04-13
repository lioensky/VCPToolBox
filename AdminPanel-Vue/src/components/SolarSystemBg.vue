<template>
  <div
    class="solar-system-bg"
    :class="{ 'immersive-mode': isImmersiveMode }"
    aria-hidden="true"
    :style="{ display: animationsEnabled ? '' : 'none' }"
  >
    <div class="stars"></div>
    <div class="stars2"></div>
    <div class="stars3"></div>
    <div class="sun"></div>
    <div class="orbit orbit-mercury">
      <div class="planet planet-mercury"></div>
    </div>
    <div class="orbit orbit-venus">
      <div class="planet planet-venus"></div>
    </div>
    <div class="orbit orbit-earth">
      <div class="planet planet-earth"></div>
    </div>
    <div class="orbit orbit-mars">
      <div class="planet planet-mars"></div>
    </div>
    <div class="orbit orbit-jupiter">
      <div class="planet planet-jupiter"></div>
    </div>
    <div class="orbit orbit-saturn">
      <div class="planet planet-saturn"></div>
    </div>
    <div class="orbit orbit-uranus">
      <div class="planet planet-uranus"></div>
    </div>
    <div class="orbit orbit-neptune">
      <div class="planet planet-neptune"></div>
    </div>
    <div class="shooting-stars">
      <div class="shooting-star"></div>
      <div class="shooting-star"></div>
      <div class="shooting-star"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const animationsEnabled = computed(() => appStore.animationsEnabled)
const isImmersiveMode = computed(() => appStore.isImmersiveMode)
</script>

<style scoped>
.solar-system-bg {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: var(--app-viewport-height, 100vh);
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background: transparent;
  transition:
    z-index 0.5s step-end,
    background 2.5s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
  transform: translateZ(0);
}

.solar-system-bg.immersive-mode {
  z-index: 9999;
  pointer-events: auto;
  background: radial-gradient(
    ellipse at bottom,
    color-mix(in srgb, var(--secondary-bg) 78%, var(--highlight-text) 22%) 0%,
    color-mix(in srgb, var(--primary-bg) 92%, oklch(0 0 0)) 100%
  );
  transition:
    z-index 0s,
    background 2.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.sun {
  transition:
    width 2.5s cubic-bezier(0.4, 0, 0.2, 1),
    height 2.5s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 2s cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 2.5s ease;
}

.orbit {
  transition:
    width 2.5s cubic-bezier(0.4, 0, 0.2, 1),
    height 2.5s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 2s ease;
}

.planet {
  transition:
    width 2.5s cubic-bezier(0.4, 0, 0.2, 1),
    height 2.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.solar-system-bg.immersive-mode .sun {
  opacity: 1;
  width: 120px;
  height: 120px;
  box-shadow: 0 0 80px var(--sun-color);
}

.solar-system-bg.immersive-mode .orbit-mercury { width: 250px; height: 250px; }
.solar-system-bg.immersive-mode .orbit-venus { width: 380px; height: 380px; }
.solar-system-bg.immersive-mode .orbit-earth { width: 550px; height: 550px; }
.solar-system-bg.immersive-mode .orbit-mars { width: 720px; height: 720px; }
.solar-system-bg.immersive-mode .orbit-jupiter { width: 1000px; height: 1000px; }
.solar-system-bg.immersive-mode .orbit-saturn { width: 1300px; height: 1300px; }
.solar-system-bg.immersive-mode .orbit-uranus { width: 1600px; height: 1600px; }
.solar-system-bg.immersive-mode .orbit-neptune { width: 1900px; height: 1900px; }

.solar-system-bg.immersive-mode .planet-mercury { width: 12px; height: 12px; }
.solar-system-bg.immersive-mode .planet-venus { width: 22px; height: 22px; }
.solar-system-bg.immersive-mode .planet-earth { width: 24px; height: 24px; }
.solar-system-bg.immersive-mode .planet-mars { width: 18px; height: 18px; }
.solar-system-bg.immersive-mode .planet-jupiter { width: 64px; height: 64px; }
.solar-system-bg.immersive-mode .planet-saturn { width: 56px; height: 56px; }
.solar-system-bg.immersive-mode .planet-uranus { width: 36px; height: 36px; }
.solar-system-bg.immersive-mode .planet-neptune { width: 36px; height: 36px; }

.sun {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 40px;
  height: 40px;
  background: var(--sun-color);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 30px var(--sun-color);
  opacity: 0.6;
}

.orbit {
  position: absolute;
  top: 50%;
  left: 50%;
  border: 1px solid var(--orbit-color);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  will-change: transform;
}

.planet {
  position: absolute;
  top: 0;
  left: 50%;
  width: 10px;
  height: 10px;
  background: var(--planet-color);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  will-change: transform;
}

.orbit-mercury { width: 100px; height: 100px; animation: rotate 8.8s linear infinite; }
.orbit-venus { width: 160px; height: 160px; animation: rotate 22.5s linear infinite; }
.orbit-earth { width: 240px; height: 240px; animation: rotate 36.5s linear infinite; }
.orbit-mars { width: 320px; height: 320px; animation: rotate 68.7s linear infinite; }
.orbit-jupiter { width: 480px; height: 480px; animation: rotate 118.6s linear infinite; }
.orbit-saturn { width: 640px; height: 640px; animation: rotate 294.5s linear infinite; }
.orbit-uranus { width: 800px; height: 800px; animation: rotate 840.1s linear infinite; }
.orbit-neptune { width: 960px; height: 960px; animation: rotate 1647.9s linear infinite; }

.planet-mercury { width: 4px; height: 4px; background: var(--mercury-color); }
.planet-venus { width: 8px; height: 8px; background: var(--venus-color); }
.planet-earth { width: 9px; height: 9px; background: var(--earth-color); }
.planet-mars { width: 6px; height: 6px; background: var(--mars-color); }
.planet-jupiter { width: 24px; height: 24px; background: var(--jupiter-color); }
.planet-saturn { width: 20px; height: 20px; background: var(--saturn-color); }
.planet-uranus { width: 14px; height: 14px; background: var(--uranus-color); }
.planet-neptune { width: 14px; height: 14px; background: var(--neptune-color); }

/* Saturn Ring */
.planet-saturn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 34px;
  height: 10px;
  border: 2px solid color-mix(in srgb, var(--saturn-color) 42%, transparent);
  border-radius: 50%;
  transform: translate(-50%, -50%) rotateX(70deg);
}

@keyframes rotate {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}

/* Stars Animation */
.stars, .stars2, .stars3 {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: transparent;
}

.stars {
  width: 1px;
  height: 1px;
  box-shadow: 
    10vw 10vh var(--star-color),
    20vw 30vh var(--star-color),
    40vw 15vh var(--star-color),
    60vw 45vh var(--star-color),
    80vw 20vh var(--star-color),
    90vw 70vh var(--star-color),
    15vw 85vh var(--star-color),
    35vw 60vh var(--star-color),
    55vw 80vh var(--star-color),
    75vw 95vh var(--star-color),
    5vw 50vh var(--star-color),
    25vw 75vh var(--star-color),
    45vw 10vh var(--star-color),
    65vw 30vh var(--star-color),
    85vw 85vh var(--star-color);
  animation: twinkle 5s infinite ease-in-out;
}

.stars2 {
  width: 2px;
  height: 2px;
  box-shadow: 
    5vw 25vh var(--star-color),
    25vw 5vh var(--star-color),
    45vw 35vh var(--star-color),
    65vw 10vh var(--star-color),
    85vw 55vh var(--star-color),
    12vw 65vh var(--star-color),
    32vw 90vh var(--star-color),
    52vw 20vh var(--star-color),
    72vw 40vh var(--star-color),
    92vw 85vh var(--star-color),
    2vw 15vh var(--star-color),
    22vw 45vh var(--star-color),
    42vw 65vh var(--star-color),
    62vw 85vh var(--star-color),
    82vw 5vh var(--star-color);
  animation: twinkle 7s infinite ease-in-out 1s;
}

.stars3 {
  width: 3px;
  height: 3px;
  box-shadow: 
    8vw 40vh var(--star-color),
    28vw 60vh var(--star-color),
    48vw 80vh var(--star-color),
    68vw 25vh var(--star-color),
    88vw 15vh var(--star-color),
    18vw 5vh var(--star-color),
    38vw 30vh var(--star-color),
    58vw 50vh var(--star-color),
    78vw 75vh var(--star-color),
    98vw 95vh var(--star-color),
    10vw 5vh var(--star-color),
    30vw 25vh var(--star-color),
    50vw 45vh var(--star-color),
    70vw 65vh var(--star-color),
    90vw 85vh var(--star-color);
  animation: twinkle 9s infinite ease-in-out 2s;
}

@keyframes twinkle {
  0%, 100% { opacity: 0.2; transform: scale(1); }
  50% { opacity: 0.9; transform: scale(1.2); }
}

/* Shooting Stars */
.shooting-stars {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
}

.shooting-star {
  position: absolute;
  left: 50%;
  top: 50%;
  height: 2px;
  background: linear-gradient(-45deg, var(--star-color), transparent);
  border-radius: 999px;
  filter: drop-shadow(0 0 6px var(--star-color));
  animation: tail 3000ms ease-in-out infinite, shooting 3000ms ease-in-out infinite;
}

.shooting-star::before, .shooting-star::after {
  content: '';
  position: absolute;
  top: calc(50% - 1px);
  right: 0;
  height: 2px;
  background: linear-gradient(-45deg, transparent, var(--star-color), transparent);
  transform: translateX(50%) rotateZ(45deg);
  border-radius: 100%;
  animation: shining 3000ms ease-in-out infinite;
}

.shooting-star::after {
  transform: translateX(50%) rotateZ(-45deg);
}

.shooting-star:nth-child(1) { top: 10%; left: 30%; animation-delay: 0ms; }
.shooting-star:nth-child(2) { top: 20%; left: 60%; animation-delay: 1500ms; }
.shooting-star:nth-child(3) { top: 40%; left: 10%; animation-delay: 2500ms; }

@keyframes tail {
  0% { width: 0; }
  30% { width: 100px; }
  100% { width: 0; }
}

@keyframes shining {
  0% { width: 0; }
  50% { width: 30px; }
  100% { width: 0; }
}

@keyframes shooting {
  0% { transform: translateX(0) translateY(0) rotateZ(45deg); }
  100% { transform: translateX(300px) translateY(300px) rotateZ(45deg); }
}
</style>
