/**
 * 性能监控工具
 * 用于追踪页面加载时间和 API 请求性能
 */

import { createLogger } from "./logger";

export interface PerformanceMetrics {
  // 页面加载时间
  pageLoadTime: number;
  domContentLoaded: number;
  firstPaint?: number;
  firstContentfulPaint?: number;

  // API 请求统计
  apiRequests: {
    total: number;
    success: number;
    failed: number;
    avgResponseTime: number;
  };

  // 资源加载
  resources: {
    total: number;
    cached: number;
    totalSize: number;
  };
}

const logger = createLogger("Performance");

class PerformanceMonitor {
  private metrics: PerformanceMetrics = {
    pageLoadTime: 0,
    domContentLoaded: 0,
    apiRequests: {
      total: 0,
      success: 0,
      failed: 0,
      avgResponseTime: 0,
    },
    resources: {
      total: 0,
      cached: 0,
      totalSize: 0,
    },
  };

  private totalApiResponseTime = 0;

  constructor() {
    if (typeof window !== "undefined") {
      this.initPageMetrics();
      this.initResourceMetrics();
    }
  }

  /**
   * 初始化页面加载指标
   */
  private initPageMetrics() {
    window.addEventListener("load", () => {
      const navigationEntry = performance
        .getEntriesByType("navigation")
        .find((entry): entry is PerformanceNavigationTiming => entry instanceof PerformanceNavigationTiming);

      if (navigationEntry) {
        this.metrics.pageLoadTime = Math.max(
          0,
          navigationEntry.loadEventEnd - navigationEntry.startTime
        );
        this.metrics.domContentLoaded = Math.max(
          0,
          navigationEntry.domContentLoadedEventEnd - navigationEntry.startTime
        );
      }

      // 获取 Paint 指标
      const paintEntries = performance.getEntriesByType("paint");
      paintEntries.forEach((entry) => {
        if (entry.name === "first-paint") {
          this.metrics.firstPaint = entry.startTime;
        } else if (entry.name === "first-contentful-paint") {
          this.metrics.firstContentfulPaint = entry.startTime;
        }
      });

      logger.debug("页面加载完成", {
        加载时间: `${this.metrics.pageLoadTime}ms`,
        "DOM 就绪": `${this.metrics.domContentLoaded}ms`,
        首次绘制: `${this.metrics.firstPaint?.toFixed(2)}ms`,
        内容绘制: `${this.metrics.firstContentfulPaint?.toFixed(2)}ms`,
      });
    });
  }

  /**
   * 初始化资源加载指标
   */
  private initResourceMetrics() {
    window.addEventListener("load", () => {
      const resources = performance.getEntriesByType("resource");
      this.metrics.resources.total = resources.length;

      resources.forEach((resource) => {
        if ((resource as PerformanceResourceTiming).transferSize === 0) {
          this.metrics.resources.cached++;
        }
        this.metrics.resources.totalSize +=
          (resource as PerformanceResourceTiming).transferSize || 0;
      });

      logger.debug("资源加载", {
        总数: this.metrics.resources.total,
        缓存: this.metrics.resources.cached,
        总大小: `${(this.metrics.resources.totalSize / 1024).toFixed(2)} KB`,
      });
    });
  }

  /**
   * 记录 API 请求
   */
  recordApiRequest(duration: number, success: boolean) {
    this.metrics.apiRequests.total++;
    if (success) {
      this.metrics.apiRequests.success++;
    } else {
      this.metrics.apiRequests.failed++;
    }
    this.totalApiResponseTime += duration;

    // 计算平均响应时间
    this.metrics.apiRequests.avgResponseTime =
      this.totalApiResponseTime / this.metrics.apiRequests.total;
  }

  /**
   * 获取性能报告
   */
  getReport(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * 打印性能报告
   */
  printReport() {
    logger.info("Performance Report", this.metrics);
  }
}

// 导出单例
export const performanceMonitor = new PerformanceMonitor();

/**
 * 包装 fetch 函数，自动记录性能
 */
export async function fetchWithPerformance(
  input: RequestInfo,
  init?: RequestInit
): Promise<Response> {
  const startTime = performance.now();

  try {
    const response = await fetch(input, init);
    const duration = performance.now() - startTime;
    performanceMonitor.recordApiRequest(duration, response.ok);
    return response;
  } catch (error) {
    const duration = performance.now() - startTime;
    performanceMonitor.recordApiRequest(duration, false);
    throw error;
  }
}
