/**
 * 本地存储工具
 */

import { createLogger } from "./logger";

const logger = createLogger("Storage");

export const storage = {
  /**
   * 从 localStorage 获取数据
   */
  get<T>(key: string): T | null {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch {
      logger.warn(`Failed to parse key: ${key}`);
      return null;
    }
  },

  /**
   * 保存数据到 localStorage
   */
  set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      logger.error("Set error:", error);
    }
  },

  /**
   * 从 localStorage 移除数据
   */
  remove(key: string): void {
    localStorage.removeItem(key);
  },

  /**
   * 清空 localStorage
   */
  clear(): void {
    localStorage.clear();
  },
};
