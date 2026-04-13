import { onMounted, onBeforeUnmount } from "vue";

/**
 * 事件监听器 Composable
 * 
 * 统一管理 DOM 事件监听器的添加和移除，防止内存泄漏。
 * 支持 Vue 生命周期自动清理。
 * 
 * @example
 * ```typescript
 * // 基础用法
 * useEventListener(window, 'scroll', handleScroll);
 * 
 * // 带选项
 * useEventListener(element, 'click', handleClick, { passive: true });
 * 
 * // 条件监听
 * useEventListener(document, 'keydown', handleKeydown, { enabled: isModalOpen });
 * ```
 */
export function useEventListener<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Window | Document | null,
  event: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions & { enabled?: boolean }
): void;

export function useEventListener(
  target: EventTarget | null,
  event: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions & { enabled?: boolean }
): void;

export function useEventListener(
  target: EventTarget | null,
  event: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions & { enabled?: boolean }
): void {
  const { enabled = true, ...listenerOptions } = options || {};

  onMounted(() => {
    if (!target || !enabled) {
      return;
    }

    target.addEventListener(event, handler, listenerOptions);
  });

  onBeforeUnmount(() => {
    if (!target) {
      return;
    }

    target.removeEventListener(event, handler, listenerOptions);
  });
}

/**
 * 动态事件监听 Composable
 * 
 * 允许在组件生命周期内动态启用/禁用事件监听。
 * 返回控制函数供手动管理监听器。
 * 
 * @example
 * ```typescript
 * const { add, remove } = useDynamicEventListener();
 * 
 * // 添加监听
 * add(window, 'scroll', handleScroll);
 * 
 * // 移除监听
 * remove(window, 'scroll', handleScroll);
 * ```
 */
export function useDynamicEventListener() {
  const listeners = new Map<
    string,
    { target: EventTarget; handler: EventListenerOrEventListenerObject }
  >();

  function add(
    target: EventTarget,
    event: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions
  ): void {
    const key = `${event}-${JSON.stringify(handler)}`;
    
    if (listeners.has(key)) {
      return;
    }

    target.addEventListener(event, handler, options);
    listeners.set(key, { target, handler });
  }

  function remove(
    target: EventTarget,
    event: string,
    handler: EventListenerOrEventListenerObject
  ): void {
    const key = `${event}-${JSON.stringify(handler)}`;
    
    if (!listeners.has(key)) {
      return;
    }

    target.removeEventListener(event, handler);
    listeners.delete(key);
  }

  function removeAll(): void {
    listeners.forEach(({ target, handler }, key) => {
      const event = key.split("-")[0];
      target.removeEventListener(event, handler);
    });
    listeners.clear();
  }

  onBeforeUnmount(() => {
    removeAll();
  });

  return { add, remove, removeAll };
}
