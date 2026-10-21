// adapters/IpcAdapter.js
/**
 * @fileoverview VCP 方案 2 全双工 IPC 传输层适配器 (IpcAdapter)
 * 基于原生 Node.js Named Pipe (Windows) / Domain Socket (Unix) 实现。
 * 为本地桌面端 VCPChat 提供零网络端口占用、零配置认证、亚毫秒级延迟与全双工神经互通。
 */

'use strict';

const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');
const { StringDecoder } = require('string_decoder');
const { ChatChunkType, createChatChunk } = require('../core/types');

const DEFAULT_PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\vcp-ipc'
  : '/tmp/vcp-ipc.sock';

class IpcAdapter extends EventEmitter {
  /**
   * @param {object} coreEngine - VcpCoreEngine 实例
   * @param {object} [options={}] - 配置选项
   */
  constructor(coreEngine, options = {}) {
    super();
    if (!coreEngine) {
      throw new Error('IpcAdapter requires a VcpCoreEngine instance');
    }
    this.coreEngine = coreEngine;
    this.pipePath = options.pipePath || process.env.VCP_IPC_PIPE || DEFAULT_PIPE_PATH;
    this.server = null;
    this.clients = new Set();
    this.running = false;
    this.debugMode = Boolean(options.debugMode ?? coreEngine.DEBUG_MODE);

    // 绑定主动唤醒与生命周期事件，自动广播给已连接的前端
    this._onProactiveWake = this._handleProactiveWake.bind(this);
    this._onLifecycleChange = this._handleLifecycleChange.bind(this);
    this.coreEngine.on('proactive:wake', this._onProactiveWake);
    this.coreEngine.on('lifecycle:change', this._onLifecycleChange);
  }

  /**
   * 启动 IPC 服务端监听
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      if (this.server) {
        return resolve();
      }

      // 重新挂载核心事件监听（若此前调用过 stop）
      this.coreEngine.off('proactive:wake', this._onProactiveWake);
      this.coreEngine.off('lifecycle:change', this._onLifecycleChange);
      this.coreEngine.on('proactive:wake', this._onProactiveWake);
      this.coreEngine.on('lifecycle:change', this._onLifecycleChange);

      // Unix 平台清理遗留的 sock 孤儿文件
      if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
        try {
          fs.unlinkSync(this.pipePath);
        } catch (_) {}
      }

      this.server = net.createServer(socket => this._onClientConnect(socket));

      const onInitialError = err => {
        if (this.debugMode) {
          console.error('[IpcAdapter] Startup server error:', err.message);
        }
        try {
          if (this.server) {
            this.server.close?.(() => {});
          }
        } catch (_) {}
        this.server = null;
        this.running = false;
        reject(err);
      };

      this.server.once('error', onInitialError);

      this.server.listen(this.pipePath, () => {
        if (!this.server) return;
        this.server.removeListener('error', onInitialError);
        this.server.on('error', err => {
          if (this.debugMode) {
            console.error('[IpcAdapter] Server runtime error:', err.message);
          }
          if (this.listenerCount('error') > 0) {
            this.emit('error', err);
          }
        });
        this.running = true;
        if (this.debugMode) {
          console.log(`[IpcAdapter] Local duplex IPC server listening on ${this.pipePath}`);
        }
        this.emit('listening', { pipePath: this.pipePath });
        resolve();
      });
    });
  }

  /**
   * 停止 IPC 服务并断开所有客户端
   * @returns {Promise<void>}
   */
  async stop() {
    this.running = false;
    this.coreEngine.off('proactive:wake', this._onProactiveWake);
    this.coreEngine.off('lifecycle:change', this._onLifecycleChange);

    for (const client of this.clients) {
      try {
        client.destroy();
      } catch (_) {}
    }
    this.clients.clear();

    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }

    if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
      try {
        fs.unlinkSync(this.pipePath);
      } catch (_) {}
    }
  }

  /**
   * 向所有连接的 Electron 前端广播消息
   * @param {object} message
   */
  broadcast(message) {
    if (!message || this.clients.size === 0) return;
    const payload = JSON.stringify(message) + '\n';
    for (const client of this.clients) {
      try {
        if (!client.destroyed && client.writable) {
          client.write(payload);
        }
      } catch (_) {}
    }
  }

  /**
   * 处理智能体主动唤醒广播
   * @private
   */
  _handleProactiveWake(event) {
    this.broadcast({
      type: 'proactive:wake',
      event
    });
  }

  /**
   * 处理生命周期变更广播
   * @private
   */
  _handleLifecycleChange(change) {
    this.broadcast({
      type: 'lifecycle:change',
      change
    });
  }

  /**
   * 处理单个客户端套接字连接
   * @private
   */
  _onClientConnect(socket) {
    this.clients.add(socket);
    socket.activeRequests = new Set();
    if (this.debugMode) {
      console.log(`[IpcAdapter] Electron client connected. Total clients: ${this.clients.size}`);
    }

    const decoder = new StringDecoder('utf8');
    let buffer = '';

    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留尚未结束的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const message = JSON.parse(trimmed);
          this._handleClientMessage(socket, message);
        } catch (parseErr) {
          if (this.debugMode) {
            console.error('[IpcAdapter] Failed to parse client NDJSON:', trimmed, parseErr.message);
          }
        }
      }
    });

    socket.on('error', err => {
      if (this.debugMode) {
        console.warn('[IpcAdapter] Client socket error:', err.message);
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      if (socket.activeRequests && socket.activeRequests.size > 0) {
        for (const reqId of socket.activeRequests) {
          if (this.coreEngine?.interrupt) {
            this.coreEngine.interrupt(reqId, 'ipc_socket_closed');
          }
        }
        socket.activeRequests.clear();
      }
      if (this.debugMode) {
        console.log(`[IpcAdapter] Client disconnected. Remaining: ${this.clients.size}`);
      }
    });
  }

  /**
   * 处理来自客户端的命令
   * @private
   */
  async _handleClientMessage(socket, message) {
    const { type, requestId } = message;

    // 1. 保活探针 ping -> pong
    if (type === 'ping') {
      this._sendToSocket(socket, { type: 'pong', timestamp: Date.now() });
      return;
    }

    // 2. 状态查询
    if (type === 'lifecycle:get_state') {
      this._sendToSocket(socket, {
        type: 'lifecycle:state',
        state: this.coreEngine.getState()
      });
      return;
    }

    // 3. 中断指定请求
    if (type === 'chat:interrupt') {
      const success = this.coreEngine.interrupt(requestId, message.reason || 'user_interrupted');
      this._sendToSocket(socket, {
        type: 'chat:interrupted',
        requestId,
        success
      });
      return;
    }

    // 4. 发起对话流式请求
    if (type === 'chat:start') {
      const reqPayload = message.payload || message;
      const reqId = requestId || reqPayload.id || `ipc-${Date.now()}`;
      if (socket.activeRequests) socket.activeRequests.add(reqId);

      try {
        const stream = this.coreEngine.chatStream(
          { ...reqPayload, id: reqId },
          { clientIp: '127.0.0.1 (IPC)' }
        );

        for await (const chunk of stream) {
          if (socket.destroyed || !socket.writable) {
            this.coreEngine.interrupt(reqId, 'ipc_socket_closed');
            break;
          }
          this._sendToSocket(socket, {
            type: 'chat:chunk',
            requestId: reqId,
            chunk
          });
        }
      } catch (err) {
        this._sendToSocket(socket, {
          type: 'chat:chunk',
          requestId: reqId,
          chunk: createChatChunk(ChatChunkType.ERROR, {
            error: err.message || 'IPC Engine Stream Error'
          })
        });
      } finally {
        if (socket.activeRequests) socket.activeRequests.delete(reqId);
      }
      return;
    }
  }

  /**
   * 安全向指定 socket 发送 NDJSON
   * @private
   */
  _sendToSocket(socket, obj) {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(JSON.stringify(obj) + '\n');
    } catch (_) {}
  }
}

module.exports = IpcAdapter;
