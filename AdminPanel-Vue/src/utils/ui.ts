/**
 * UI 工具函数（兼容入口）
 */

import {
  showLoading as publishLoading,
  showMessage as publishMessage,
  type FeedbackMessageType,
} from "@/platform/feedback/feedbackBus";

export function showLoading(show: boolean) {
  publishLoading(show);
}

export function showMessage(
  message: string,
  type: FeedbackMessageType = "info",
  duration = 3500
) {
  publishMessage(message, type, duration);
}
