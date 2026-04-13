/**
 * LocalStorage 组合式函数
 * 提供响应式的 localStorage 读写能力
 *
 * @example
 * ```typescript
 * // 基本使用
 * const theme = useLocalStorage('theme', 'dark')
 *
 * // 使用自定义序列化
 * const date = useLocalStorage('lastLogin', new Date(), {
 *   serializer: (v) => v.toISOString(),
 *   parser: (v) => new Date(v)
 * })
 * ```
 */

import { ref, watch, type Ref, getCurrentScope, onScopeDispose } from "vue";
import { createLogger } from "@/utils/logger";

const logger = createLogger("useLocalStorage");

export interface UseLocalStorageOptions<T> {
  /** 自定义序列化函数 */
  serializer?: (value: T) => string;
  /** 自定义解析函数 */
  parser?: (value: string) => T;
  /** 是否监听外部变化（多标签页同步） */
  listenExternal?: boolean;
  /** 是否监听 storage 事件 */
  sync?: boolean;
  /** 是否深度监听（默认仅对象/数组开启） */
  deep?: boolean;
}

function shouldUseDeepWatch(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * 创建 localStorage 响应式引用
 *
 * @param key - localStorage 键名
 * @param initialValue - 初始值
 * @param options - 选项
 * @returns 响应式引用
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  options: UseLocalStorageOptions<T> = {}
): Ref<T> {
  const {
    serializer = JSON.stringify,
    parser = JSON.parse,
    listenExternal = false,
    sync = true,
    deep = shouldUseDeepWatch(initialValue),
  } = options;

  /** 读取 localStorage 值 */
  const readValue = (): T => {
    if (typeof window === "undefined") {
      return initialValue;
    }

    try {
      const item = window.localStorage.getItem(key);
      return item ? parser(item) : initialValue;
    } catch (error) {
      logger.warn(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  };

  /** 创建响应式引用（初始化时同步读取，避免依赖组件生命周期） */
  const storedValue = ref<T>(readValue());

  /** 监听值变化并写入 localStorage */
  watch(
    storedValue,
    (newValue) => {
      if (typeof window === "undefined") return;

      try {
        const serializedValue = serializer(newValue);
        window.localStorage.setItem(key, serializedValue);

        // 如果启用外部同步，触发自定义事件
        if (listenExternal || sync) {
          window.dispatchEvent(new Event("local-storage"));
        }
      } catch (error) {
        logger.warn(`Error setting localStorage key "${key}":`, error);
      }
    },
    { deep }
  );

  /** 监听 storage 事件（多标签页同步） */
  if (sync && typeof window !== "undefined") {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === key) {
        try {
          if (event.newValue === null) {
            storedValue.value = initialValue;
            return;
          }

          storedValue.value = parser(event.newValue);
        } catch (error) {
          logger.warn(`Error parsing storage event for key "${key}":`, error);
        }
      }
    };

    window.addEventListener("storage", handleStorageChange);

    // 在组件/作用域销毁时清理监听，避免监听器累积
    if (getCurrentScope()) {
      onScopeDispose(() => {
        window.removeEventListener("storage", handleStorageChange);
      });
    }
  }

  return storedValue as Ref<T>;
}

/**
 * 创建 sessionStorage 响应式引用
 * 使用方式与 useLocalStorage 相同
 */
export function useSessionStorage<T>(
  key: string,
  initialValue: T,
  options: UseLocalStorageOptions<T> = {}
): Ref<T> {
  const {
    serializer = JSON.stringify,
    parser = JSON.parse,
    listenExternal = false,
    sync = true,
    deep = shouldUseDeepWatch(initialValue),
  } = options;

  const readValue = (): T => {
    if (typeof window === "undefined") {
      return initialValue;
    }

    try {
      const item = window.sessionStorage.getItem(key);
      return item ? parser(item) : initialValue;
    } catch (error) {
      logger.warn(`Error reading sessionStorage key "${key}":`, error);
      return initialValue;
    }
  };

  const storedValue = ref<T>(readValue());

  watch(
    storedValue,
    (newValue) => {
      if (typeof window === "undefined") return;

      try {
        const serializedValue = serializer(newValue);
        window.sessionStorage.setItem(key, serializedValue);

        if (listenExternal || sync) {
          window.dispatchEvent(new Event("session-storage"));
        }
      } catch (error) {
        logger.warn(`Error setting sessionStorage key "${key}":`, error);
      }
    },
    { deep }
  );

  if (sync && typeof window !== "undefined") {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === key && event.storageArea === window.sessionStorage) {
        try {
          if (event.newValue === null) {
            storedValue.value = initialValue;
            return;
          }

          storedValue.value = parser(event.newValue);
        } catch (error) {
          logger.warn(`Error parsing storage event for key "${key}":`, error);
        }
      }
    };

    window.addEventListener("storage", handleStorageChange);

    if (getCurrentScope()) {
      onScopeDispose(() => {
        window.removeEventListener("storage", handleStorageChange);
      });
    }
  }

  return storedValue as Ref<T>;
}

/**
 * 从 localStorage 移除项
 */
export function removeLocalStorage(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    logger.warn(`Error removing localStorage key "${key}":`, error);
  }
}

/**
 * 从 sessionStorage 移除项
 */
export function removeSessionStorage(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch (error) {
    logger.warn(`Error removing sessionStorage key "${key}":`, error);
  }
}

/**
 * 清空 localStorage
 */
export function clearLocalStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.clear();
  } catch (error) {
    logger.warn("Error clearing localStorage:", error);
  }
}

/**
 * 清空 sessionStorage
 */
export function clearSessionStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.clear();
  } catch (error) {
    logger.warn("Error clearing sessionStorage:", error);
  }
}
