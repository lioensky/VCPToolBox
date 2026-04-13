import { onUnmounted, ref } from "vue";

export interface UsePollingOptions {
  interval: number;
  immediate?: boolean;
  onError?: (error: unknown) => void;
}

export function usePolling(
  fetchFn: () => Promise<unknown>,
  options: UsePollingOptions
) {
  const { interval, immediate = true, onError } = options;

  const isRunning = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    try {
      await fetchFn();
    } catch (error) {
      onError?.(error);
    }
  }

  function clearTimer() {
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    timer = null;
  }

  function scheduleNext(delay: number) {
    clearTimer();
    if (!isRunning.value) {
      return;
    }

    timer = setTimeout(() => {
      void runCycle();
    }, delay);
  }

  async function runCycle() {
    if (!isRunning.value) {
      return;
    }

    await tick();

    if (isRunning.value) {
      scheduleNext(interval);
    }
  }

  function start() {
    if (isRunning.value) {
      return;
    }

    isRunning.value = true;

    if (immediate) {
      void runCycle();
      return;
    }

    scheduleNext(interval);
  }

  function stop() {
    if (!isRunning.value && !timer) {
      return;
    }

    isRunning.value = false;
    clearTimer();
  }

  onUnmounted(() => {
    stop();
  });

  return {
    isRunning,
    tick,
    start,
    stop,
  };
}
