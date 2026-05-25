/**
 * 操作台折叠组合式函数
 *
 * 用于在带有「操作台」侧栏卡片的页面中提供一致的本地折叠 / 展开能力：
 * - 折叠后保留一条窄轨（icon rail），只露出展开按钮和少量图标入口
 * - 展开状态以 localStorage 持久化，刷新后保持用户上次选择
 * - 视口宽度较小时自动强制展开（小屏堆叠布局下折叠没有意义）
 *
 * @example
 * ```ts
 * const { collapsed, toggle } = useConsoleCollapse('semantic-groups')
 * ```
 */

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useLocalStorage } from "@/composables/useLocalStorage";

export interface UseConsoleCollapseOptions {
  /** 视口宽度小于该值时强制展开（默认 1024，匹配页面的 stack 断点） */
  stackBreakpoint?: number;
  /** 初始折叠状态（仅在 localStorage 无记录时使用） */
  defaultCollapsed?: boolean;
}

export function useConsoleCollapse(
  key: string,
  options: UseConsoleCollapseOptions = {}
) {
  const { stackBreakpoint = 1024, defaultCollapsed = false } = options;

  const persisted = useLocalStorage<boolean>(
    `console-collapse:${key}`,
    defaultCollapsed
  );

  const isCompactViewport = ref(false);

  function updateViewport(): void {
    if (typeof window === "undefined") {
      isCompactViewport.value = false;
      return;
    }
    isCompactViewport.value = window.innerWidth <= stackBreakpoint;
  }

  onMounted(() => {
    updateViewport();
    window.addEventListener("resize", updateViewport);
  });

  onUnmounted(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", updateViewport);
    }
  });

  /** 实际折叠状态：小屏下强制展开，避免堆叠布局下卡成一条 icon rail。 */
  const collapsed = computed<boolean>({
    get: () => !isCompactViewport.value && persisted.value,
    set: (value) => {
      if (isCompactViewport.value) return;
      persisted.value = value;
    },
  });

  /** 是否允许折叠（小屏自动禁用）。 */
  const canCollapse = computed(() => !isCompactViewport.value);

  function toggle(): void {
    if (!canCollapse.value) return;
    collapsed.value = !collapsed.value;
  }

  function expand(): void {
    collapsed.value = false;
  }

  function collapse(): void {
    if (!canCollapse.value) return;
    collapsed.value = true;
  }

  // 保证外部通过 persisted.value 直接改写时也走裁剪逻辑
  watch(isCompactViewport, (isCompact) => {
    if (isCompact && persisted.value) {
      // 不清除持久化值，切回宽屏时仍保留用户偏好
    }
  });

  return {
    collapsed,
    canCollapse,
    toggle,
    expand,
    collapse,
  };
}
