/**
 * 通知中心 Store
 *
 * 负责：
 * 1. 调用 /admin_api/notifications/connection 获取 VCP 主服务器的 WebSocket 鉴权信息
 * 2. 建立并维护 VCPlog 通道连接（带自动重连）
 * 3. 解析收到的 vcp_log / daily_note_created / connection_ack 等消息为前端通知项
 * 4. 暴露给 UI 一个统一的列表，以及抽屉打开/关闭状态
 *
 * 通知解析逻辑参考桌面端 notificationRenderer.js（example 目录）。
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { systemApi } from "@/api";
import type { NotificationsConnectionInfo } from "@/types/api.system";
import { createLogger } from "@/utils";

const logger = createLogger("NotificationsStore");

export type NotificationStatus =
  | "open"
  | "closed"
  | "error"
  | "connecting"
  | "idle";

export interface NotificationItem {
  id: string;
  /** 大标题，例如 "DailyNote success" */
  title: string;
  /** 详细内容（可能是 JSON 字符串或文本） */
  content: string;
  /** 内容是否为预格式化文本（决定 UI 使用 <pre> 还是 <p>） */
  preformatted: boolean;
  /** 接收时间 */
  receivedAt: number;
  /** 原始消息字符串（用于复制） */
  raw: string;
  /** 消息类型：vcp_log / daily_note_created / connection_ack / 其他 */
  type: string;
  /** 是否为工具审核请求（特殊处理） */
  toolApproval?: {
    requestId: string;
    toolName: string;
    maid?: string;
    args?: unknown;
  };
  /** 解析失败标记 */
  unread: boolean;
}

interface ParsedNotification {
  title: string;
  content: string;
  preformatted: boolean;
  type: string;
  toolApproval?: NotificationItem["toolApproval"];
}

const MAX_NOTIFICATIONS = 200;
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 30000;

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 解析单条 VCPLog 消息为 UI 友好的结构 */
function parseLogMessage(raw: string): ParsedNotification {
  let logData: unknown;
  try {
    logData = JSON.parse(raw);
  } catch {
    return {
      title: "VCP 消息",
      content: raw,
      preformatted: false,
      type: "raw",
    };
  }

  if (!logData || typeof logData !== "object") {
    return {
      title: "VCP 消息",
      content: String(logData),
      preformatted: false,
      type: "raw",
    };
  }

  const obj = logData as Record<string, any>;
  const msgType = String(obj.type || "unknown");

  // 工具审核请求
  if (msgType === "tool_approval_request" && obj.data) {
    const data = obj.data as Record<string, any>;
    const cmd =
      data.args && typeof data.args === "object"
        ? data.args.command || JSON.stringify(data.args)
        : "";
    return {
      title: `🛠️ 审核请求: ${data.toolName || "未知工具"}`,
      content: [
        `助手: ${data.maid || "未知"}`,
        cmd ? `命令: ${cmd}` : null,
        data.timestamp ? `时间: ${data.timestamp}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      preformatted: true,
      type: msgType,
      toolApproval: {
        requestId: String(data.requestId || ""),
        toolName: String(data.toolName || ""),
        maid: data.maid,
        args: data.args,
      },
    };
  }

  // 标准 vcp_log
  if (msgType === "vcp_log" && obj.data && typeof obj.data === "object") {
    const vcp = obj.data as Record<string, any>;
    let title = "VCP 日志";
    let content = "";
    let preformatted = false;

    if (vcp.tool_name && vcp.status) {
      title = `${vcp.tool_name} ${vcp.status}`;
      if (typeof vcp.content !== "undefined") {
        let raw = String(vcp.content);
        content = raw;
        preformatted = true;

        // 错误内容尝试解析为 JSON
        if (vcp.status === "error" && raw.includes("{")) {
          const jsonStart = raw.indexOf("{");
          const prefix = raw.substring(0, jsonStart);
          const jsonPart = raw.substring(jsonStart);
          try {
            const parsed = JSON.parse(jsonPart);
            const display =
              parsed.plugin_error || parsed.error || parsed.message;
            if (display) {
              content =
                prefix.trim() +
                (prefix.trim().endsWith(":") ? " " : ": ") +
                display;
              preformatted = false;
            }
          } catch {
            /* keep raw */
          }
        }

        // 内层 JSON 解析
        try {
          const inner = JSON.parse(raw);
          let suffix = "";
          if (inner.MaidName) suffix += ` by ${inner.MaidName}`;
          if (
            typeof inner.timestamp === "string" &&
            inner.timestamp.length >= 16
          ) {
            suffix += `${inner.MaidName ? " " : ""}@ ${inner.timestamp.substring(11, 16)}`;
          }
          if (suffix) title += ` (${suffix.trim()})`;

          if (typeof inner.original_plugin_output !== "undefined") {
            const out = inner.original_plugin_output;
            if (typeof out === "object" && out !== null) {
              if (vcp.tool_name === "DailyNote" && out.message) {
                content = `${out.status === "success" ? "✅" : "❌"} ${out.message}`;
                preformatted = false;
              } else if (typeof out.message === "string") {
                content = out.message;
                preformatted = false;
              } else {
                content = JSON.stringify(out, null, 2);
                preformatted = true;
              }
            } else {
              content = String(out);
              preformatted = false;
            }
          } else if (vcp.tool_name === "DailyNote") {
            const icon = vcp.status === "success" ? "✅" : "❌";
            content = inner.message
              ? `${icon} ${inner.message}`
              : `${icon} 日记内容已成功记录。`;
            preformatted = false;
          }
        } catch {
          /* not json */
        }
      } else {
        content = "(无内容)";
      }
    } else if (vcp.source === "DistPluginManager" && vcp.content) {
      title = "分布式服务器";
      content = String(vcp.content);
    } else {
      title = "VCP 日志条目";
      content = JSON.stringify(vcp, null, 2);
      preformatted = true;
    }

    return { title, content, preformatted, type: msgType };
  }

  if (msgType === "daily_note_created" && obj.data) {
    const d = obj.data as Record<string, any>;
    return {
      title: `日记: ${d.maidName || "N/A"} (${d.dateString || "N/A"})`,
      content:
        d.message ||
        (d.status === "success"
          ? "日记已成功创建。"
          : `日记处理状态: ${d.status || "未知"}`),
      preformatted: false,
      type: msgType,
    };
  }

  if (msgType === "connection_ack") {
    return {
      title: "VCP 连接",
      content: String(obj.message || "已建立连接"),
      preformatted: false,
      type: msgType,
    };
  }

  if (msgType === "video_generation_status" && obj.data) {
    const d = obj.data as Record<string, any>;
    let content: string;
    let preformatted = false;
    if (d.original_plugin_output?.message) {
      content = String(d.original_plugin_output.message);
    } else if (d.original_plugin_output) {
      content = JSON.stringify(d.original_plugin_output, null, 2);
      preformatted = true;
    } else {
      content = JSON.stringify(d, null, 2);
      preformatted = true;
    }
    let title = "视频生成状态";
    if (typeof d.timestamp === "string" && d.timestamp.length >= 16) {
      title += ` (@ ${d.timestamp.substring(11, 16)})`;
    }
    return { title, content, preformatted, type: msgType };
  }

  // 兜底通用结构
  if (obj.type && obj.message) {
    return {
      title: `类型: ${obj.type}`,
      content: obj.data
        ? `${String(obj.message)}\n数据: ${JSON.stringify(obj.data, null, 2)}`
        : String(obj.message),
      preformatted: !!obj.data,
      type: msgType,
    };
  }

  return {
    title: "VCP 消息",
    content: JSON.stringify(obj, null, 2),
    preformatted: true,
    type: msgType,
  };
}

export const useNotificationsStore = defineStore("notifications", () => {
  const items = ref<NotificationItem[]>([]);
  const status = ref<NotificationStatus>("idle");
  const statusMessage = ref<string>("等待初始化");
  const isDrawerOpen = ref(false);
  const lastViewedAt = ref<number>(0);

  let socket: WebSocket | null = null;
  let connectionInfo: NotificationsConnectionInfo | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: number | null = null;
  let manuallyClosed = false;

  const hasUnread = computed(() =>
    items.value.some((item) => item.receivedAt > lastViewedAt.value)
  );

  const unreadCount = computed(
    () =>
      items.value.filter((item) => item.receivedAt > lastViewedAt.value).length
  );

  function setStatus(next: NotificationStatus, msg: string) {
    status.value = next;
    statusMessage.value = msg;
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (manuallyClosed) return;
    clearReconnectTimer();
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(1.6, reconnectAttempts),
      RECONNECT_MAX_DELAY
    );
    reconnectAttempts += 1;
    setStatus(
      "connecting",
      `连接已断开，${Math.round(delay / 1000)} 秒后重试…`
    );
    reconnectTimer = window.setTimeout(() => {
      void connect(true);
    }, delay);
  }

  function addNotification(raw: string) {
    const parsed = parseLogMessage(raw);

    // 抑制重复的连接成功广播
    if (
      parsed.type === "connection_ack" &&
      parsed.content === "WebSocket connection successful for VCPLog."
    ) {
      return;
    }

    const item: NotificationItem = {
      id: generateId(),
      title: parsed.title,
      content: parsed.content,
      preformatted: parsed.preformatted,
      receivedAt: Date.now(),
      raw,
      type: parsed.type,
      toolApproval: parsed.toolApproval,
      unread: true,
    };

    items.value = [item, ...items.value].slice(0, MAX_NOTIFICATIONS);
  }

  function openSocket(wsUrl: string) {
    try {
      const ws = new WebSocket(wsUrl);
      socket = ws;
      setStatus("connecting", "正在连接 VCP 通知通道…");

      ws.onopen = () => {
        reconnectAttempts = 0;
        clearReconnectTimer();
        setStatus("open", "已连接到 VCP 通知通道");
      };

      ws.onmessage = (evt) => {
        try {
          addNotification(String(evt.data));
        } catch (e) {
          logger.error("处理通知消息时出错:", e);
        }
      };

      ws.onerror = (err) => {
        logger.error("VCPLog WebSocket 错误:", err);
        setStatus("error", "连接发生错误，稍后将自动重试");
      };

      ws.onclose = () => {
        socket = null;
        if (manuallyClosed) {
          setStatus("closed", "已断开");
          return;
        }
        scheduleReconnect();
      };
    } catch (error) {
      logger.error("创建 WebSocket 失败:", error);
      setStatus("error", "无法创建 WebSocket 连接");
      scheduleReconnect();
    }
  }

  async function connect(forceReload = false) {
    clearReconnectTimer();
    manuallyClosed = false;

    if (socket && socket.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      if (!connectionInfo || forceReload) {
        setStatus("connecting", "正在获取连接信息…");
        connectionInfo = await systemApi.getNotificationsConnection();
      }
      if (!connectionInfo?.wsUrl) {
        setStatus("error", "未获取到 VCP_Key，无法建立连接");
        return;
      }
      openSocket(connectionInfo.wsUrl);
    } catch (error) {
      logger.error("获取通知连接信息失败:", error);
      setStatus(
        "error",
        error instanceof Error
          ? `获取连接信息失败：${error.message}`
          : "获取连接信息失败"
      );
      scheduleReconnect();
    }
  }

  function disconnect() {
    manuallyClosed = true;
    clearReconnectTimer();
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
    }
    setStatus("idle", "未连接");
  }

  function clearAll() {
    items.value = [];
  }

  function removeOne(id: string) {
    items.value = items.value.filter((it) => it.id !== id);
  }

  function openDrawer() {
    isDrawerOpen.value = true;
    markAllRead();
  }

  function closeDrawer() {
    isDrawerOpen.value = false;
  }

  function toggleDrawer() {
    if (isDrawerOpen.value) {
      closeDrawer();
    } else {
      openDrawer();
    }
  }

  function markAllRead() {
    lastViewedAt.value = Date.now();
    items.value = items.value.map((item) => ({ ...item, unread: false }));
  }

  /**
   * 给审核请求发送响应
   * 这通过同一个 WebSocket 连接发回服务器
   */
  function sendToolApprovalResponse(
    requestId: string,
    approved: boolean,
    reason?: string
  ): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      logger.warn("尝试发送审核响应但 WebSocket 未连接");
      return false;
    }
    try {
      const payload: Record<string, unknown> = {
        requestId,
        approved: approved === true,
      };
      const trimmed = reason?.trim();
      if (trimmed) payload.reason = trimmed;

      socket.send(
        JSON.stringify({
          type: "tool_approval_response",
          data: payload,
        })
      );
      return true;
    } catch (err) {
      logger.error("发送审核响应失败:", err);
      return false;
    }
  }

  return {
    // state
    items,
    status,
    statusMessage,
    isDrawerOpen,
    // getters
    hasUnread,
    unreadCount,
    // actions
    connect,
    disconnect,
    clearAll,
    removeOne,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    markAllRead,
    sendToolApprovalResponse,
  };
});