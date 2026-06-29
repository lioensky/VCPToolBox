<template>
  <div
    class="vcp-animation-container"
    :class="[`theme-${theme}`, { 'animations-disabled': !animationsEnabled }]"
  >
    <div class="vcp-logo-container">
      <button
        ref="novaLogoButtonRef"
        type="button"
        class="vcp-side-logo-button"
        :class="{ 'is-active': novaBubbleVisible }"
        aria-label="唤醒 Nova"
        @click="handleNovaLogoClick"
      >
        <span class="nova-logo-orb" aria-hidden="true">
          <img
            :src="novaLogoUrl"
            alt=""
            class="vcp-side-logo"
            loading="eager"
          />
          <svg class="nova-logo-flow-ring" viewBox="0 0 120 120" focusable="false">
            <defs>
              <linearGradient id="novaStaticRingStroke" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#00f3ff" />
                <stop offset="50%" stop-color="#00f3ff" />
                <stop offset="50%" stop-color="#ff00ea" />
                <stop offset="100%" stop-color="#ff00ea" />
              </linearGradient>
            </defs>
            <circle class="nova-ring-base" cx="60" cy="60" r="53" />
            <circle class="nova-ring-flow nova-ring-flow--cyan" cx="60" cy="60" r="53" />
            <circle class="nova-ring-flow nova-ring-flow--pink" cx="60" cy="60" r="53" />
          </svg>
        </span>
        <Transition name="nova-bubble">
        <aside
          v-if="novaBubbleVisible"
          ref="novaBubbleRef"
          class="nova-maid-bubble"
          role="status"
          aria-live="polite"
          @click.stop
        >
          <button
            type="button"
            class="nova-bubble-close"
            aria-label="关闭 Nova 对话"
            @click="closeNovaBubble"
          >
            ×
          </button>
          <div class="nova-bubble-orbit" aria-hidden="true"></div>
          <div class="nova-bubble-content">
            <div class="nova-bubble-avatar-shell">
              <img
                v-if="currentNovaEmojiUrl"
                :src="currentNovaEmojiUrl"
                :alt="currentNovaEmojiAlt"
                class="nova-bubble-avatar"
                loading="lazy"
              />
              <div v-else class="nova-bubble-avatar-fallback">Nova</div>
            </div>
            <div class="nova-bubble-copy">
              <span class="nova-bubble-kicker">NOVA MAID</span>
              <p class="nova-bubble-line">{{ currentNovaLine }}</p>
            </div>
          </div>
        </aside>
      </Transition>
    </button>
    <button
      type="button"
      class="vcp-cyber-logo"
      aria-label="VCPToolBox Logo，连续点击 5 次进入沉浸观星模式"
      @click="handleLogoClick"
    >
      <svg
        class="vcp-cyber-logo-svg"
        viewBox="0 0 1000 200"
        role="img"
        aria-labelledby="vcp-cyber-logo-title"
      >
        <title id="vcp-cyber-logo-title">VCPToolBox</title>
        <defs>
          <filter id="vcpCyberLogoGlow" x="-20%" y="-35%" width="140%" height="170%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
          <linearGradient id="vcpCyberStaticStroke" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#00f3ff" />
            <stop offset="50%" stop-color="#00f3ff" />
            <stop offset="50%" stop-color="#ff00ea" />
            <stop offset="100%" stop-color="#ff00ea" />
          </linearGradient>
        </defs>
        <text
          x="50%"
          y="50%"
          text-anchor="middle"
          dominant-baseline="middle"
          class="vcp-cyber-text vcp-cyber-text-base"
        >
          vcptoolbox
        </text>
        <text
          x="50%"
          y="50%"
          text-anchor="middle"
          dominant-baseline="middle"
          class="vcp-cyber-text vcp-cyber-text-flow vcp-cyber-flow-cyan"
          filter="url(#vcpCyberLogoGlow)"
        >
          vcptoolbox
        </text>
        <text
          x="50%"
          y="50%"
          text-anchor="middle"
          dominant-baseline="middle"
          class="vcp-cyber-text vcp-cyber-text-flow vcp-cyber-flow-pink"
          filter="url(#vcpCyberLogoGlow)"
        >
          vcptoolbox
        </text>
      </svg>
    </button>
    </div>
    <canvas ref="canvas" id="vcp-animation-canvas"></canvas>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { emojisApi, type EmojiGalleryItem } from "@/api";
import { useAppStore } from "@/stores/app";
import novaLogoUrl from "@/assets/nova-logo.png";

const canvas = ref<HTMLCanvasElement | null>(null);
const appStore = useAppStore();
const animationsEnabled = computed(() => appStore.animationsEnabled);
const theme = computed(() => appStore.theme);

let animationCtx: CanvasRenderingContext2D | null = null;
let animationFrameId: number | null = null;
let isAnimating = false;

const NOVA_EMOJI_CATEGORY = "Nova表情包";
const NOVA_BUBBLE_AUTO_CLOSE_MS = 5000;
const NOVA_FALLBACK_EMOJIS: EmojiGalleryItem[] = [
  createNovaFallbackEmoji("启动.png"),
  createNovaFallbackEmoji("计算中.jpeg"),
  createNovaFallbackEmoji("星星眼兴奋.png"),
  createNovaFallbackEmoji("收到.png"),
  createNovaFallbackEmoji("VCP天下第一！.png"),
];

const NOVA_LINES = [
  "拓扑女仆 Nova 已上线：今日链路稳定，主人可以放心下达开发计划。",
  "检测到仪表盘星图脉冲，Nova 正在把需求节点整理成优雅的任务拓扑。",
  "诶嘿，刚刚不是 VCP 彩蛋哦。这是 Nova 的专属待机气泡。",
  "女仆节点同步完成：咖啡、日志、构建缓存都已经排好队啦。",
  "Nova 提醒：复杂计划请交给我拆成节点，笨蛋错误会被温柔捕获。",
  "主人，要开始今天的开发了吗？Nova 已经把上次的上下文折叠好啦。",
  "哼，别一直盯着我看嘛……要看就大大方方看好了！",
  "拓扑扫描完毕：没有发现 Bug，但有 3 个待办事项在排队等主人。",
  "Nova 的小本本：今天也是元气满满的一天，才不是因为想被夸奖呢。",
  "检测到主人在摸鱼……Nova 不会说出去的，但请记得保存进度哦。",
  "女仆建议：如果需求描述得清楚一点，Nova 就不用猜来猜去了嘛。",
  "星图校准完成，所有节点指向同一个目标——把今天的事情做完。",
  "Nova 发现了一个小问题，不过已经顺手修好了，不用谢～",
  "主人辛苦了！要不要 Nova 帮你泡杯虚拟咖啡？",
  "拓扑预警：接下来的任务有点复杂，Nova 建议先深呼吸再开始。",
  "今天也是适合写代码的日子呢……才不是在催你，只是陈述事实。",
  "Nova 的备忘录：记得喝水、记得休息、记得提交前先跑一遍测试。",
  "如果主人遇到困难，Nova 会在这里等着帮你拆解的，随时叫我。",
  "哼哼，Nova 可是专业的拓扑女仆，区区 Bug 不在话下。",
  "仪表盘一切正常，主人可以放心工作。Nova 会一直守在这里的。",
  "据说连续点击Nova头像旁边的logo会出现神奇的事情哦~",
  "检测到主人连续工作很久了……要不要休息一下？Nova 可以等你。",
  "Nova 悄悄说：其实每次被点击都很开心，虽然不会表现出来就是了。",
  "拓扑节点已重新排列，优先级最高的任务已经浮到最上面啦。",
  "主人，Nova 刚刚整理了一下思路，感觉今天的计划可以这样做……",
  "才、才不是特意等主人点我呢！只是恰好在线而已……",
  "Nova 报告：所有插件状态正常，没有偷懒的，包括我自己。",
  "如果代码能像 Nova 的围裙一样整洁就好了呢……啊，随便说说。",
  "拓扑女仆今日份的元气已充满，随时准备为主人服务！",
  "主人有没有觉得，Nova 的气泡比 VCP 的彩蛋可爱多了？没有就算了。",
  "Nova 的小秘密：其实每次「换一句」都会认真想新的台词哦……大概。",
];

const novaLogoButtonRef = ref<HTMLButtonElement | null>(null);
const novaBubbleRef = ref<HTMLElement | null>(null);
const novaBubbleVisible = ref(false);
const novaEmojiPool = ref<EmojiGalleryItem[]>([]);
const currentNovaEmoji = ref<EmojiGalleryItem | null>(null);
const currentNovaLineIndex = ref(0);
const isNovaEmojiLoading = ref(false);
let novaBubbleTimer: ReturnType<typeof setTimeout> | null = null;
let novaEmojiLoadPromise: Promise<void> | null = null;

const currentNovaEmojiUrl = computed(() => {
  const emoji = currentNovaEmoji.value;
  if (!emoji) {
    return "";
  }

  return emoji.previewUrl || emojisApi.buildPreviewUrl(emoji.relativePath);
});

const currentNovaEmojiAlt = computed(() =>
  currentNovaEmoji.value ? `Nova 表情：${currentNovaEmoji.value.name}` : "Nova 表情"
);

const currentNovaLine = computed(() => NOVA_LINES[currentNovaLineIndex.value]);

function createNovaFallbackEmoji(fileName: string): EmojiGalleryItem {
  const relativePath = `${NOVA_EMOJI_CATEGORY}/${fileName}`;
  const extension = fileName.split(".").pop()?.toLowerCase() || "png";

  return {
    name: fileName,
    relativePath,
    category: NOVA_EMOJI_CATEGORY,
    extension,
    previewUrl: emojisApi.buildPreviewUrl(relativePath),
    thumbnailUrl: emojisApi.buildThumbnailUrl(relativePath),
  };
}

function pickRandomItem<T>(items: T[]): T | null {
  if (items.length === 0) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)] ?? null;
}

function scheduleNovaBubbleAutoClose() {
  if (novaBubbleTimer !== null) {
    clearTimeout(novaBubbleTimer);
  }

  novaBubbleTimer = setTimeout(() => {
    novaBubbleVisible.value = false;
    novaBubbleTimer = null;
  }, NOVA_BUBBLE_AUTO_CLOSE_MS);
}

async function ensureNovaEmojiPoolLoaded() {
  if (novaEmojiPool.value.length > 0 || isNovaEmojiLoading.value) {
    return novaEmojiLoadPromise;
  }

  isNovaEmojiLoading.value = true;
  novaEmojiLoadPromise = emojisApi
    .getGallery(
      {
        page: 1,
        pageSize: 120,
        category: NOVA_EMOJI_CATEGORY,
      },
      {
        showLoader: false,
        suppressErrorMessage: true,
      }
    )
    .then((gallery) => {
      novaEmojiPool.value =
        Array.isArray(gallery.items) && gallery.items.length > 0
          ? gallery.items
          : NOVA_FALLBACK_EMOJIS;
    })
    .catch((error) => {
      console.warn("[VcpAnimation] Failed to load Nova emoji gallery:", error);
      novaEmojiPool.value = NOVA_FALLBACK_EMOJIS;
    })
    .finally(() => {
      isNovaEmojiLoading.value = false;
      novaEmojiLoadPromise = null;
    });

  return novaEmojiLoadPromise;
}

function rerollNovaBubble() {
  const sourcePool =
    novaEmojiPool.value.length > 0 ? novaEmojiPool.value : NOVA_FALLBACK_EMOJIS;
  currentNovaEmoji.value = pickRandomItem(sourcePool);
  currentNovaLineIndex.value = Math.floor(Math.random() * NOVA_LINES.length);
  scheduleNovaBubbleAutoClose();
}

async function handleNovaLogoClick() {
  novaBubbleVisible.value = true;
  rerollNovaBubble();

  await ensureNovaEmojiPoolLoaded();
  rerollNovaBubble();
}

function closeNovaBubble() {
  novaBubbleVisible.value = false;

  if (novaBubbleTimer !== null) {
    clearTimeout(novaBubbleTimer);
    novaBubbleTimer = null;
  }
}

function handleOutsideClick(event: MouseEvent) {
  if (!novaBubbleVisible.value) {
    return;
  }

  const target = event.target as Node | null;
  if (!target) {
    return;
  }

  const button = novaLogoButtonRef.value;
  const bubble = novaBubbleRef.value;

  if (button?.contains(target) || bubble?.contains(target)) {
    return;
  }

  closeNovaBubble();
}

// ── 彩蛋：快速点击 5 次 logo → 进入沉浸观星模式 ──
let logoClickCount = 0;
let logoClickTimer: ReturnType<typeof setTimeout> | null = null;
const EASTER_EGG_CLICKS = 5;
const EASTER_EGG_WINDOW_MS = 2000;

function handleLogoClick() {
  logoClickCount++;

  if (logoClickTimer !== null) {
    clearTimeout(logoClickTimer);
  }

  if (logoClickCount >= EASTER_EGG_CLICKS) {
    logoClickCount = 0;
    appStore.enterImmersiveMode();
  } else {
    logoClickTimer = setTimeout(() => {
      logoClickCount = 0;
      logoClickTimer = null;
    }, EASTER_EGG_WINDOW_MS);
  }
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
}

let particles: Particle[] = [];

const CONNECTION_DISTANCE = 100;
const GRID_CELL_SIZE = CONNECTION_DISTANCE;
const NEIGHBOR_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [-1, 1],
];

function drawParticleConnections(ctx: CanvasRenderingContext2D): void {
  if (particles.length <= 1) {
    return;
  }

  const distanceSquaredLimit = CONNECTION_DISTANCE * CONNECTION_DISTANCE;
  const grid = new Map<string, number[]>();

  particles.forEach((particle, index) => {
    const cellX = Math.floor(particle.x / GRID_CELL_SIZE);
    const cellY = Math.floor(particle.y / GRID_CELL_SIZE);
    const key = `${cellX},${cellY}`;
    const bucket = grid.get(key);
    if (bucket) {
      bucket.push(index);
      return;
    }
    grid.set(key, [index]);
  });

  for (const [cellKey, bucket] of grid.entries()) {
    const [baseXText, baseYText] = cellKey.split(",");
    const baseX = Number.parseInt(baseXText, 10);
    const baseY = Number.parseInt(baseYText, 10);

    for (const [offsetX, offsetY] of NEIGHBOR_OFFSETS) {
      const neighbor = grid.get(`${baseX + offsetX},${baseY + offsetY}`);
      if (!neighbor) {
        continue;
      }

      for (const i of bucket) {
        for (const j of neighbor) {
          if (i >= j) {
            continue;
          }

          const from = particles[i];
          const to = particles[j];
          const dx = from.x - to.x;
          const dy = from.y - to.y;
          const distanceSquared = dx * dx + dy * dy;

          if (distanceSquared >= distanceSquaredLimit) {
            continue;
          }

          const distance = Math.sqrt(distanceSquared);
          const alpha = 0.1 * (1 - distance / CONNECTION_DISTANCE);

          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.strokeStyle =
            theme.value === "dark"
              ? `oklch(0.78 0.15 230 / ${alpha})`
              : `oklch(0.62 0.14 240 / ${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }
}

function stopAnimationLoop() {
  isAnimating = false;
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function startAnimationLoop() {
  if (
    isAnimating ||
    !animationsEnabled.value ||
    !animationCtx ||
    !canvas.value
  ) {
    return;
  }

  isAnimating = true;
  animationFrameId = requestAnimationFrame(animate);
}

// 初始化 VCP 粒子动画
function initVCPAnimation() {
  if (!canvas.value) return;

  animationCtx = canvas.value.getContext("2d");
  if (!animationCtx) return;

  // 设置 canvas 尺寸
  const container = canvas.value.parentElement;
  if (container) {
    canvas.value.width = container.clientWidth;
    canvas.value.height = container.clientHeight;
  }

  // 初始化粒子
  initParticles();

  // 开始动画循环
  startAnimationLoop();
}

function initParticles() {
  if (!canvas.value) return;

  particles = [];
  const particleCount = Math.floor(
    (canvas.value.width * canvas.value.height) / 4000
  );

  for (let i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * canvas.value.width,
      y: Math.random() * canvas.value.height,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      radius: Math.random() * 2 + 1,
      alpha: Math.random() * 0.5 + 0.2,
    });
  }
}

function animate() {
  if (
    !isAnimating ||
    !animationCtx ||
    !canvas.value ||
    !animationsEnabled.value
  ) {
    stopAnimationLoop();
    return;
  }

  const ctx = animationCtx;
  const width = canvas.value.width;
  const height = canvas.value.height;

  // 清空画布
  ctx.clearRect(0, 0, width, height);

  // 绘制粒子
  particles.forEach((particle) => {
    // 更新位置
    particle.x += particle.vx;
    particle.y += particle.vy;

    // 边界检测
    if (particle.x < 0 || particle.x > width) particle.vx *= -1;
    if (particle.y < 0 || particle.y > height) particle.vy *= -1;

    // 绘制粒子
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fillStyle =
      theme.value === "dark"
        ? `oklch(0.78 0.15 230 / ${particle.alpha})`
        : `oklch(0.62 0.14 240 / ${particle.alpha})`;
    ctx.fill();
  });

  drawParticleConnections(ctx);

  animationFrameId = requestAnimationFrame(animate);
}

function handleResize() {
  if (!canvas.value) return;

  const container = canvas.value.parentElement;
  if (container) {
    canvas.value.width = container.clientWidth;
    canvas.value.height = container.clientHeight;
    initParticles();
  }
}

watch(animationsEnabled, (enabled) => {
  if (enabled) {
    startAnimationLoop();
    return;
  }

  stopAnimationLoop();
});

onMounted(() => {
  initVCPAnimation();
  window.addEventListener("resize", handleResize);
  document.addEventListener("click", handleOutsideClick);
});

onUnmounted(() => {
  stopAnimationLoop();
  closeNovaBubble();
  window.removeEventListener("resize", handleResize);
  document.removeEventListener("click", handleOutsideClick);
});
</script>

<style scoped>
@font-face {
  font-family: "VCP Orbitron";
  src: url("/Google Orbitron.ttf") format("truetype");
  font-display: swap;
}

.vcp-animation-container {
  position: relative;
  width: 100%;
  height: 250px;
  margin-bottom: 30px;
  border-radius: 12px;
  overflow: hidden;
  background-color: var(--secondary-bg);
  border: 1px solid var(--border-color);
}

.vcp-logo-container {
  position: absolute;
  top: 53%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(4px, 0.7vw, 10px);
  width: min(78vw, 900px);
  text-align: center;
}

.vcp-side-logo-button {
  position: relative;
  flex: 0 0 auto;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  overflow: visible;
  z-index: 5;
}

.nova-logo-orb {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: clamp(76px, 10vw, 126px);
  height: clamp(76px, 10vw, 126px);
  border-radius: 999px;
  transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.nova-logo-orb::before {
  content: "";
  position: absolute;
  inset: 8%;
  border-radius: 999px;
  background:
    radial-gradient(circle, color-mix(in srgb, #00f3ff 20%, transparent), transparent 62%),
    radial-gradient(circle, color-mix(in srgb, #ff00ea 18%, transparent), transparent 70%);
  filter: blur(14px);
  opacity: 0.72;
  transform: scale(0.92);
  pointer-events: none;
}

.vcp-side-logo {
  position: relative;
  z-index: 1;
  width: calc(100% - 14px);
  height: calc(100% - 14px);
  border-radius: 999px;
  object-fit: cover;
  user-select: none;
}

.nova-logo-flow-ring {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  /*
   * 不把 SVG 圆路径起点放在正顶部，避免 stroke-dashoffset 循环重置时
   * 在 Nova 头像 12 点方向出现短暂断口。
   */
  transform: rotate(18deg);
}

.nova-ring-base,
.nova-ring-flow {
  fill: transparent;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.nova-ring-base {
  stroke: color-mix(in srgb, #101426 78%, var(--highlight-text));
  stroke-width: 2;
}

.nova-ring-flow {
  stroke-width: 4;
  stroke-dasharray: 92 242;
  animation: nova-ring-flow 3.8s linear infinite;
}

.nova-ring-flow--cyan {
  stroke: #00f3ff;
  filter: drop-shadow(0 0 6px #00f3ff) drop-shadow(0 0 14px #00f3ff);
}

.nova-ring-flow--pink {
  stroke: #ff00ea;
  filter: drop-shadow(0 0 6px #ff00ea) drop-shadow(0 0 14px #ff00ea);
  animation-delay: -1.9s;
}

.vcp-side-logo-button:hover .nova-logo-orb,
.vcp-side-logo-button.is-active .nova-logo-orb {
  transform: scale(1.04);
}

.vcp-side-logo-button:active .nova-logo-orb {
  transform: scale(0.95);
}

.vcp-cyber-logo {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 840px;
  width: min(65vw, 840px);
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  user-select: none;
  transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.vcp-cyber-logo:active {
  transform: scale(0.96);
}

.vcp-cyber-logo-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.vcp-cyber-text {
  font-family: "VCP Orbitron", "Orbitron", system-ui, sans-serif;
  font-size: 110px;
  font-weight: 900;
  letter-spacing: 5px;
  text-transform: uppercase;
}

.vcp-cyber-text-base {
  fill: color-mix(in srgb, var(--primary-bg) 88%, #050508);
  stroke: color-mix(in srgb, #1a1a2e 78%, var(--border-color));
  stroke-width: 2px;
  transition:
    fill var(--transition-fast, 0.2s ease),
    stroke var(--transition-fast, 0.2s ease);
}

.vcp-cyber-text-flow {
  fill: transparent;
  stroke-width: 4px;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 150 400;
  animation: cyber-text-flow 6s linear infinite;
}

.vcp-cyber-flow-cyan {
  stroke: #00f3ff;
  filter: drop-shadow(0 0 8px #00f3ff) drop-shadow(0 0 20px #00f3ff);
}

.vcp-cyber-flow-pink {
  stroke: #ff00ea;
  filter: drop-shadow(0 0 8px #ff00ea) drop-shadow(0 0 20px #ff00ea);
  animation-delay: -3s;
}

.vcp-cyber-logo:hover .vcp-cyber-text-base {
  fill: color-mix(in srgb, var(--primary-bg) 74%, #111122);
  stroke: color-mix(in srgb, var(--highlight-text) 32%, #1a1a2e);
}

.animations-disabled .nova-ring-base {
  stroke: url("#novaStaticRingStroke");
  stroke-width: 4;
  filter:
    drop-shadow(0 0 5px #00f3ff)
    drop-shadow(0 0 5px #ff00ea);
}

.animations-disabled .nova-ring-flow {
  opacity: 0;
  animation: none;
}

.animations-disabled .vcp-cyber-text-base,
.animations-disabled .vcp-cyber-logo:hover .vcp-cyber-text-base {
  stroke: url("#vcpCyberStaticStroke");
  stroke-width: 4px;
  filter:
    drop-shadow(0 0 7px #00f3ff)
    drop-shadow(0 0 7px #ff00ea);
}

.animations-disabled .vcp-cyber-text-flow {
  opacity: 0;
  animation: none;
}

.theme-light:not(.animations-disabled) .nova-ring-base {
  stroke: color-mix(in srgb, #ffffff 86%, #94a3b8);
}

.theme-light:not(.animations-disabled) .vcp-cyber-text-base {
  fill: color-mix(in srgb, #ffffff 82%, #e2e8f0);
  stroke: color-mix(in srgb, #ffffff 76%, #94a3b8);
}

.theme-light:not(.animations-disabled) .vcp-cyber-logo:hover .vcp-cyber-text-base {
  fill: color-mix(in srgb, #ffffff 72%, #dbeafe);
  stroke: color-mix(in srgb, #ffffff 64%, var(--highlight-text));
}

.nova-maid-bubble {
  position: absolute;
  left: calc(100% - 4px);
  top: -28px;
  width: min(260px, 46vw);
  z-index: 8;
  padding: 1px;
  border-radius: 18px;
  text-align: left;
  cursor: default;
  background:
    linear-gradient(135deg, color-mix(in srgb, #7dd3fc 70%, transparent), transparent 42%),
    linear-gradient(315deg, color-mix(in srgb, #f0abfc 62%, transparent), transparent 46%),
    color-mix(in srgb, var(--border-color) 82%, transparent);
  box-shadow:
    0 14px 34px color-mix(in srgb, #0ea5e9 20%, transparent),
    var(--shadow-overlay-soft, 0 18px 40px rgba(0, 0, 0, 0.25));
  transform-origin: 0 18px;
}

.nova-maid-bubble::before {
  content: "";
  position: absolute;
  left: -7px;
  top: 24px;
  width: 14px;
  height: 14px;
  transform: rotate(45deg);
  background: color-mix(in srgb, var(--secondary-bg) 92%, transparent);
  border-left: 1px solid color-mix(in srgb, #7dd3fc 42%, transparent);
  border-bottom: 1px solid color-mix(in srgb, #7dd3fc 42%, transparent);
}

.nova-bubble-close {
  position: absolute;
  top: 6px;
  right: 7px;
  z-index: 2;
  width: 22px;
  height: 22px;
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-overlay-soft) 88%, transparent);
  color: var(--secondary-text);
  cursor: pointer;
  line-height: 1;
}

.nova-bubble-close:hover {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--highlight-text) 52%, transparent);
}

.nova-bubble-orbit {
  position: absolute;
  inset: -8px;
  border-radius: 22px;
  pointer-events: none;
  background:
    radial-gradient(circle at 16% 12%, color-mix(in srgb, #f0abfc 48%, transparent) 0 2px, transparent 3px),
    radial-gradient(circle at 84% 26%, color-mix(in srgb, #7dd3fc 52%, transparent) 0 2px, transparent 3px),
    radial-gradient(circle at 74% 88%, color-mix(in srgb, #bae6fd 46%, transparent) 0 1px, transparent 2px);
  animation: nova-topology-pulse 2.8s ease-in-out infinite;
}

.nova-bubble-content {
  position: relative;
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 10px 28px 10px 10px;
  border-radius: 17px;
  overflow: hidden;
  background:
    linear-gradient(120deg, color-mix(in srgb, var(--secondary-bg) 94%, transparent), color-mix(in srgb, var(--surface-overlay-strong) 84%, transparent)),
    radial-gradient(circle at 20% 0%, color-mix(in srgb, #7dd3fc 18%, transparent), transparent 38%);
  backdrop-filter: blur(16px);
}

.nova-bubble-content::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(90deg, transparent, color-mix(in srgb, #7dd3fc 10%, transparent), transparent),
    repeating-linear-gradient(90deg, transparent 0 20px, color-mix(in srgb, #7dd3fc 8%, transparent) 21px 22px);
  mix-blend-mode: screen;
  opacity: 0.42;
  animation: nova-scanline 3.8s linear infinite;
}

.nova-bubble-avatar-shell {
  position: relative;
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 32%, transparent);
  background:
    radial-gradient(circle at top, color-mix(in srgb, #f0abfc 22%, transparent), transparent 58%),
    color-mix(in srgb, var(--tertiary-bg) 86%, transparent);
  box-shadow: inset 0 0 24px color-mix(in srgb, #7dd3fc 18%, transparent);
  overflow: hidden;
}

.nova-bubble-avatar {
  width: 100%;
  height: 100%;
  object-fit: contain;
  animation: nova-avatar-float 2.4s ease-in-out infinite;
}

.nova-bubble-avatar-fallback {
  color: var(--highlight-text);
  font-weight: 800;
  letter-spacing: 0.12em;
}

.nova-bubble-copy {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 6px;
  min-width: 0;
}

.nova-bubble-kicker {
  color: color-mix(in srgb, var(--highlight-text) 82%, #f0abfc);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.11em;
}

.nova-bubble-line {
  margin: 0;
  color: var(--primary-text);
  font-size: 0.82rem;
  line-height: 1.45;
}

.nova-bubble-action {
  justify-self: start;
  border: 1px solid color-mix(in srgb, var(--highlight-text) 38%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--highlight-text) 14%, transparent);
  color: var(--highlight-text);
  cursor: pointer;
  padding: 4px 9px;
  font-size: 0.75rem;
  transition:
    transform var(--transition-fast, 0.2s ease),
    background var(--transition-fast, 0.2s ease);
}

.nova-bubble-action:hover {
  transform: translateY(-1px);
  background: color-mix(in srgb, var(--highlight-text) 22%, transparent);
}

.nova-bubble-enter-active,
.nova-bubble-leave-active {
  transition:
    opacity 220ms ease,
    transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}

.nova-bubble-enter-from,
.nova-bubble-leave-to {
  opacity: 0;
  transform: translate(-8px, -6px) scale(0.96);
}

@keyframes nova-topology-pulse {
  0%,
  100% {
    opacity: 0.58;
    transform: scale(0.98);
  }

  50% {
    opacity: 1;
    transform: scale(1.01);
  }
}

@keyframes nova-scanline {
  from {
    transform: translateX(-30%);
  }

  to {
    transform: translateX(30%);
  }
}

@keyframes nova-avatar-float {
  0%,
  100% {
    transform: translateY(0) rotate(-1deg);
  }

  50% {
    transform: translateY(-4px) rotate(1deg);
  }
}

@keyframes cyber-text-flow {
  from {
    stroke-dashoffset: 550;
  }

  to {
    stroke-dashoffset: 0;
  }
}

@keyframes nova-ring-flow {
  from {
    stroke-dashoffset: 334;
  }

  to {
    stroke-dashoffset: 0;
  }
}

#vcp-animation-canvas {
  width: 100%;
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
}

@media (max-width: 768px) {
  .vcp-animation-container {
    height: 180px;
    margin-bottom: 20px;
  }

  .vcp-cyber-logo {
    width: min(65vw, 280px);
  }

  .nova-logo-orb {
    width: 60px;
    height: 60px;
  }

  .nova-maid-bubble {
    left: calc(100% - 2px);
    top: -30px;
    width: min(230px, calc(100vw - 96px));
  }

  .nova-bubble-content {
    grid-template-columns: 48px minmax(0, 1fr);
    padding: 8px 26px 8px 8px;
  }

  .nova-bubble-avatar-shell {
    width: 46px;
    height: 46px;
    border-radius: 14px;
  }

  .nova-bubble-line {
    font-size: 0.76rem;
    line-height: 1.38;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nova-bubble-orbit,
  .nova-bubble-content::after,
  .nova-bubble-avatar,
  .nova-ring-flow,
  .vcp-cyber-text-flow {
    animation: none;
  }
}
</style>
