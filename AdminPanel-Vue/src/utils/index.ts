/**
 * 工具函数统一导出
 */

// UI 工具
export { showLoading, showMessage } from "@/platform/feedback/feedbackBus";

// API 工具

// 认证工具
export {
  redirectToLogin,
  redirectToDashboard,
  handle401Response,
  withAuth,
} from "./auth";

// 格式化工具
export { formatFileSize, formatTime, formatDate, escapeHTML } from "./format";

// 存储工具
export { storage } from "./storage";

// ENV 工具
export {
  parseEnvToList,
  buildEnvString,
  serializeEnvAssignment,
  serializeEnvValue,
  castEnvValue,
  isSensitiveConfigKey,
  type EnvEntry,
} from "./env";

// 性能监控
export { performanceMonitor, fetchWithPerformance } from "./performance";

// 日志工具
export { createLogger, type LogLevel, type Logger } from "./logger";

// URL 工具
export { sanitizeExternalUrl, isSafeExternalUrl } from "./url";
