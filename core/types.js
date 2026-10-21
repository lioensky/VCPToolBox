// core/types.js
/**
 * @fileoverview VCP 方案 2 核心协议与数据模型定义
 * 纯 JavaScript 实现，零外部依赖，协议与传输层无关。
 */

'use strict';

/**
 * 流式输出事件类型
 */
const ChatChunkType = Object.freeze({
  DELTA: 'delta',                  // 正文文本增量
  REASONING: 'reasoning',          // 思维链/推理内容增量
  TOOL_CALL: 'tool_call',          // 工具调用触发
  TOOL_RESULT: 'tool_result',      // 工具执行结果
  LOOP_CONTINUE: 'loop_continue',  // 工具循环下一轮递归开启
  KEEPALIVE: 'keepalive',          // 幽灵心跳保活
  ABORTED: 'aborted',              // 中止事件
  ERROR: 'error',                  // 错误事件
  DONE: 'done'                     // 完成标记
});

/**
 * 主动唤醒级别（生命体对前端的打扰程度）
 */
const WakeLevel = Object.freeze({
  TOAST: 'toast',                  // Windows 原生横幅通知（轻度提醒，不夺焦点）
  TRAY_PULSE: 'tray_pulse',        // 托盘图标呼吸跳动（含蓄等待用户点开）
  OVERLAY_BUBBLE: 'overlay_bubble',// 桌面浮窗气泡与语音（桌宠式互动）
  URGENT_POPUP: 'urgent_popup'     // 霸道强弹（窗口还原、最前、夺取焦点）
});

/**
 * 后台守护进程生命周期状态
 */
const DaemonLifecycleState = Object.freeze({
  INITIALIZING: 'initializing',    // 初始化中
  RUNNING: 'running',              // 运行中（正常服务）
  SLEEPING: 'sleeping',            // 打盹/休眠中（VCPSleep 运行，后台思考）
  DRAINING: 'draining',            // 正在清空排队请求
  SHUTDOWN: 'shutdown',            // 已优雅关闭
  STOPPED: 'stopped'               // 已停止
});

/**
 * 退出原因
 */
const ShutdownReason = Object.freeze({
  USER_QUIT: 'user_quit',          // 用户通过托盘选择“彻底退出”
  SYSTEM_SHUTDOWN: 'system_shutdown', // 系统关机 / SIGTERM / SIGINT
  CRASH_RECOVERY: 'crash_recovery',// 崩溃异常防护
  RELOAD: 'reload'                 // 重载配置
});

/**
 * 校验并规范化 ChatRequest 请求对象
 * @param {object} req - 原始请求
 * @returns {object} 规范化后的请求对象
 */
function validateChatRequest(req) {
  if (!req || typeof req !== 'object') {
    throw new TypeError('ChatRequest must be an object');
  }

  const normalized = {
    id: req.id || req.requestId || req.messageId || `vcp-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    model: typeof req.model === 'string' ? req.model.trim() : 'default',
    messages: Array.isArray(req.messages) ? req.messages : [],
    stream: req.stream !== false, // 默认流式
    signal: req.signal || null,
    clientIp: req.clientIp || '127.0.0.1',
    forceShowVCP: Boolean(req.forceShowVCP),
    contextTokenLimit: typeof req.contextTokenLimit === 'number' ? req.contextTokenLimit : undefined,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    presence_penalty: req.presence_penalty,
    frequency_penalty: req.frequency_penalty,
    // 携带的透传字段
    ...req
  };

  if (!Array.isArray(normalized.messages)) {
    throw new TypeError('ChatRequest.messages must be an Array');
  }

  return normalized;
}

/**
 * 构建标准流式事件 Chunk
 * @param {string} type - ChatChunkType 中的一种
 * @param {object} payload - 负载数据
 * @returns {object}
 */
function createChatChunk(type, payload = {}) {
  return {
    type,
    timestamp: Date.now(),
    ...payload
  };
}

/**
 * 构建主动唤醒事件对象（ProactiveWakeEvent）
 * @param {object} options
 * @returns {object}
 */
function createWakeEvent({
  id = null,
  level = WakeLevel.URGENT_POPUP,
  title = 'VCP 智能体唤醒',
  content = '',
  audioTts = false,
  autoDismissMs = 0,
  actions = [],
  source = 'autonomous_brain',
  metadata = null
} = {}) {
  const validLevels = Object.values(WakeLevel);
  const normalizedLevel = validLevels.includes(level) ? level : WakeLevel.URGENT_POPUP;

  return {
    type: 'proactive:wake',
    id: id || `wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    level: normalizedLevel,
    title: String(title || ''),
    content: String(content || ''),
    audioTts: Boolean(audioTts),
    autoDismissMs: typeof autoDismissMs === 'number' && autoDismissMs >= 0 ? autoDismissMs : 0,
    actions: Array.isArray(actions) ? actions : [],
    source: String(source || 'autonomous_brain'),
    timestamp: Date.now(),
    metadata: metadata && typeof metadata === 'object' ? metadata : null
  };
}

/**
 * 抽象流事件 Sink（出站端口基类）
 * 用于适配不同的传输层（HTTP SSE、Electron IPC、WebSocket、测试 Capture）
 */
class StreamEventSink {
  /**
   * 写入一个结构化事件 Chunk
   * @param {object} chunk
   */
  writeChunk(chunk) {
    throw new Error('StreamEventSink.writeChunk() must be implemented');
  }

  /**
   * 结束输出流
   */
  end() {
    throw new Error('StreamEventSink.end() must be implemented');
  }

  /**
   * 输出错误事件并关闭
   * @param {Error|object} err
   */
  error(err) {
    throw new Error('StreamEventSink.error() must be implemented');
  }

  /**
   * 流是否已关闭
   * @returns {boolean}
   */
  isClosed() {
    return false;
  }
}

module.exports = {
  ChatChunkType,
  WakeLevel,
  DaemonLifecycleState,
  ShutdownReason,
  validateChatRequest,
  createChatChunk,
  createWakeEvent,
  StreamEventSink
};
