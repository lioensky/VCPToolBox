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

/**
 * 复制文本到剪贴板，兼容非安全上下文（HTTP）和旧版浏览器
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('Clipboard API writeText failed, falling back to execCommand:', err);
    }
  }

  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.width = '2em';
    textArea.style.height = '2em';
    textArea.style.padding = '0';
    textArea.style.border = 'none';
    textArea.style.outline = 'none';
    textArea.style.boxShadow = 'none';
    textArea.style.background = 'transparent';
    
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    
    return !!successful;
  } catch (err) {
    console.error('Fallback copy failed:', err);
    return false;
  }
}
