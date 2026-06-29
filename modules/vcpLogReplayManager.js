// modules/vcpLogReplayManager.js
//
// VCPLog 离线通知缓存与补发管理器(一期:基于 IP 的设备识别)
//
// 目标:
//   1. 在主服务运行期间,把所有发往 clientType === 'VCPLog' 的广播消息缓存下来。
//   2. 以"客户端 IP"为 deviceKey 跟踪同一设备(VCPChat 通知栏)反复上下线。
//   3. 当某设备重新上线并在 ONLINE_STABILITY_MS(默认 3 秒)内保持在线时,把它离线期间
//      错过的 VCPLog 通知按序逐条补发(条间留 REPLAY_INTERVAL_MS 间隔避免拥塞)。
//   4. 工具审核类消息(tool_approval_request)在以下任一情况下自动从缓存清除,不参与补发:
//        - 用户已经响应(approve/reject) → 由 PluginManager 主动调用 cancelApprovalCache(requestId)。
//        - 审核超时(由 toolApprovalManager.timeoutMinutes 决定) → 模块内部 expireAt 触发。
//   5. 全局缓存上限:MAX_CACHE_SIZE 条 + MAX_CACHE_AGE_MS 时间窗,先到的边界先生效。
//
// 设计要点:
//   - 模块自维护内存级状态,不持久化。主服务重启后所有缓存与设备表清空,符合一期定位。
//   - 设备表(devices)采用 deviceKey(IP) → DeviceState 映射,**不在设备下线时删除**,
//     以便后续重连时能识别"同一设备"。仅在 DEVICE_TTL_MS 时间窗内长时间没有任何活动时回收。
//   - DeviceState.deliveredIds 记录"该设备已收到的缓存条目 id",用作离线补发的差集计算依据。
//   - 二期升级路径:把 deviceKey 来源从 IP 改为客户端上报的 deviceId 即可,其他逻辑不变。
//     为此对外暴露 registerOnline / handleOffline / recordDelivered 等动作时,
//     deviceKey 与 ws 解耦传入,便于上层在握手时自行决定取 IP 还是取 query.deviceId。
//
// 该模块完全独立,不依赖 WebSocketServer 内部实现。WebSocketServer 在事件钩子里调用即可。

const DEFAULTS = Object.freeze({
    MAX_CACHE_SIZE: 100,
    MAX_CACHE_AGE_MS: 24 * 60 * 60 * 1000, // 24h
    ONLINE_STABILITY_MS: 3000,             // 上线后稳定 3 秒才补发
    REPLAY_INTERVAL_MS: 80,                // 逐条补发的最小间隔
    DEVICE_TTL_MS: 7 * 24 * 60 * 60 * 1000,// 设备状态在内存中至少保留 7 天(防止短期重启失忆)
    APPROVAL_DEFAULT_TTL_MS: 5 * 60 * 1000 // 当上游没传 approvalTtlMs 时,审核条目默认 5 分钟过期
});

const APPROVAL_MESSAGE_TYPE = 'tool_approval_request';

class VcpLogReplayManager {
    constructor(options = {}) {
        this.config = {
            maxCacheSize: options.maxCacheSize || DEFAULTS.MAX_CACHE_SIZE,
            maxCacheAgeMs: options.maxCacheAgeMs || DEFAULTS.MAX_CACHE_AGE_MS,
            onlineStabilityMs: options.onlineStabilityMs ?? DEFAULTS.ONLINE_STABILITY_MS,
            replayIntervalMs: options.replayIntervalMs ?? DEFAULTS.REPLAY_INTERVAL_MS,
            deviceTtlMs: options.deviceTtlMs || DEFAULTS.DEVICE_TTL_MS,
            approvalDefaultTtlMs: options.approvalDefaultTtlMs || DEFAULTS.APPROVAL_DEFAULT_TTL_MS,
            debugMode: options.debugMode === true
        };

        // 全局缓存:有序数组(最新的在末尾)
        // 每个条目: { id, type, data /* WebSocket 帧的完整 payload */, createdAt, expireAt }
        this.cache = [];

        // 审核 requestId -> 缓存条目 id 的快速索引,便于 cancelApprovalCache 直接命中
        this.approvalIndex = new Map();

        // deviceKey -> DeviceState
        // DeviceState: {
        //   deviceKey, // 当前以 IP 作为 key,二期可换 deviceId
        //   clientIp,
        //   currentClientId, // 当前 ws.clientId,仅用于调试
        //   online,
        //   firstSeenAt,
        //   lastOnlineAt,
        //   lastOfflineAt,
        //   deliveredIds: Set<string>, // 已成功投递的缓存条目 id
        //   stabilityTimer: NodeJS.Timeout | null, // 上线稳定窗口计时器
        //   replayInFlight: boolean    // 正在补发,防止并发
        // }
        this.devices = new Map();

        // 启动周期清理(每分钟):删过期缓存条目 + 删过期 deliveredIds + 回收长期不活动设备
        this._cleanupTimer = setInterval(() => this._sweep(), 60 * 1000);
        this._cleanupTimer.unref?.();
    }

    // ---------- 外部钩子:WebSocketServer 在连接事件中调用 ----------

    /**
     * 一个 VCPLog 类型客户端完成 ws 握手后调用。
     * @param {object} params
     * @param {string} params.deviceKey   - 设备唯一标识(一期用 IP)
     * @param {string} [params.clientIp]  - 调试日志使用
     * @param {string} [params.clientId]  - ws.clientId
     * @param {function} params.sendFn    - (payloadObject) => Promise|void,用于补发实际写 ws
     * @returns {DeviceState}
     */
    registerOnline({ deviceKey, clientIp = null, clientId = null, sendFn }) {
        if (!deviceKey) {
            if (this.config.debugMode) console.warn('[VcpLogReplay] registerOnline called without deviceKey, skipped.');
            return null;
        }
        if (typeof sendFn !== 'function') {
            throw new Error('[VcpLogReplay] registerOnline requires a sendFn(payload) function.');
        }

        const now = Date.now();
        let state = this.devices.get(deviceKey);
        const isReconnect = !!state;

        if (!state) {
            state = {
                deviceKey,
                clientIp,
                currentClientId: clientId,
                online: true,
                firstSeenAt: now,
                lastOnlineAt: now,
                lastOfflineAt: null,
                deliveredIds: new Set(),
                stabilityTimer: null,
                replayInFlight: false,
                sendFn
            };
            this.devices.set(deviceKey, state);
            if (this.config.debugMode) {
                console.log(`[VcpLogReplay] Device registered (NEW): key=${deviceKey} ip=${clientIp} clientId=${clientId}`);
            }
        } else {
            // 同一设备重连
            state.online = true;
            state.currentClientId = clientId;
            state.clientIp = clientIp || state.clientIp;
            state.lastOnlineAt = now;
            state.sendFn = sendFn;
            if (state.stabilityTimer) {
                clearTimeout(state.stabilityTimer);
                state.stabilityTimer = null;
            }
            if (this.config.debugMode) {
                console.log(`[VcpLogReplay] Device reconnected: key=${deviceKey} ip=${clientIp} clientId=${clientId}, will check replay after ${this.config.onlineStabilityMs}ms.`);
            }
        }

        // 启动稳定窗口:窗口结束时若仍在线,则触发补发。
        if (isReconnect) {
            state.stabilityTimer = setTimeout(() => {
                state.stabilityTimer = null;
                this._triggerReplay(state).catch(err => {
                    console.error(`[VcpLogReplay] Replay error for device ${deviceKey}:`, err.message);
                });
            }, this.config.onlineStabilityMs);
            state.stabilityTimer.unref?.();
        }

        return state;
    }

    /**
     * VCPLog 客户端断开时调用。设备状态不删除,仅标记离线并清理稳定窗口计时器。
     */
    handleOffline({ deviceKey, clientId = null }) {
        if (!deviceKey) return;
        const state = this.devices.get(deviceKey);
        if (!state) return;

        // 若设备已经被新的 ws 顶替,这次 close 来自旧连接,忽略状态变更。
        if (clientId && state.currentClientId && state.currentClientId !== clientId) {
            if (this.config.debugMode) {
                console.log(`[VcpLogReplay] Stale close ignored for device=${deviceKey}, oldClientId=${clientId}, currentClientId=${state.currentClientId}.`);
            }
            return;
        }

        state.online = false;
        state.lastOfflineAt = Date.now();
        if (state.stabilityTimer) {
            clearTimeout(state.stabilityTimer);
            state.stabilityTimer = null;
        }
        if (this.config.debugMode) {
            console.log(`[VcpLogReplay] Device offline: key=${deviceKey} clientId=${clientId} deliveredCount=${state.deliveredIds.size}`);
        }
    }

    // ---------- 外部钩子:WebSocketServer.broadcast 调用 ----------

    /**
     * 把一条 VCPLog 广播消息纳入缓存。返回赋予的 entry,供 broadcast 把 id 注入 payload。
     * @param {object} payload 原始 broadcast payload(含 type / data 等)
     * @returns {object} cacheEntry { id, type, data, createdAt, expireAt }
     */
    enqueue(payload) {
        if (!payload || typeof payload !== 'object') return null;

        const id = this._generateId();
        const now = Date.now();
        let expireAt = now + this.config.maxCacheAgeMs;

        // 审核类消息有更短的有效期
        if (payload.type === APPROVAL_MESSAGE_TYPE) {
            const approvalTtl =
                Number(payload?.data?.approvalTtlMs) ||
                this.config.approvalDefaultTtlMs;
            expireAt = Math.min(expireAt, now + approvalTtl);
        }

        const entry = {
            id,
            type: payload.type || 'unknown',
            data: payload,     // 直接保存整条 payload,补发时原样发出
            createdAt: now,
            expireAt
        };

        // 在 payload 上挂一个 id 字段(非侵入,前端可选用)
        try {
            payload._vcpReplayId = id;
        } catch (_) { /* 防御性:若 payload 是冻结对象则跳过 */ }

        this.cache.push(entry);

        // 审核索引
        if (entry.type === APPROVAL_MESSAGE_TYPE) {
            const requestId = payload?.data?.requestId;
            if (requestId) {
                this.approvalIndex.set(requestId, id);
            }
        }

        // 容量上限淘汰
        if (this.cache.length > this.config.maxCacheSize) {
            const dropped = this.cache.splice(0, this.cache.length - this.config.maxCacheSize);
            for (const item of dropped) {
                this._removeEntryFromAuxIndex(item);
            }
        }

        if (this.config.debugMode) {
            console.log(`[VcpLogReplay] enqueue id=${id} type=${entry.type} cacheSize=${this.cache.length}`);
        }
        return entry;
    }

    /**
     * 在线广播实际投递成功后调用,标记某条 entry 已被某 device 收到。
     * 这样下次该设备重连不会重复补发它。
     */
    recordDelivered(deviceKey, entryId) {
        if (!deviceKey || !entryId) return;
        const state = this.devices.get(deviceKey);
        if (!state) return;
        state.deliveredIds.add(entryId);
    }

    /**
     * 当工具审核响应到达(approve / reject / silentReject)时,
     * 由 PluginManager 调用此方法,把对应缓存条目清掉,避免补发已经处理完的审核请求。
     */
    cancelApprovalCache(requestId) {
        if (!requestId) return false;
        const entryId = this.approvalIndex.get(requestId);
        if (!entryId) return false;

        const idx = this.cache.findIndex(item => item.id === entryId);
        if (idx >= 0) {
            this.cache.splice(idx, 1);
            if (this.config.debugMode) {
                console.log(`[VcpLogReplay] cancelApprovalCache removed entryId=${entryId} requestId=${requestId}.`);
            }
        }
        this.approvalIndex.delete(requestId);

        // 同步从所有 device.deliveredIds 中移除,节省内存(不影响行为)
        for (const dev of this.devices.values()) {
            dev.deliveredIds.delete(entryId);
        }
        return true;
    }

    // ---------- 内部:补发与清理 ----------

    async _triggerReplay(state) {
        if (!state.online) {
            if (this.config.debugMode) {
                console.log(`[VcpLogReplay] _triggerReplay aborted: device ${state.deviceKey} went offline before stability window finished.`);
            }
            return;
        }
        if (state.replayInFlight) return;

        // 计算需要补发的条目
        const now = Date.now();
        const toReplay = this.cache.filter(entry =>
            entry.expireAt > now &&
            !state.deliveredIds.has(entry.id)
        );

        if (toReplay.length === 0) {
            if (this.config.debugMode) {
                console.log(`[VcpLogReplay] No replay needed for device=${state.deviceKey}.`);
            }
            return;
        }

        state.replayInFlight = true;
        console.log(`[VcpLogReplay] Replaying ${toReplay.length} cached VCPLog entries to device=${state.deviceKey} (ip=${state.clientIp}).`);

        try {
            for (const entry of toReplay) {
                if (!state.online) {
                    if (this.config.debugMode) {
                        console.log(`[VcpLogReplay] Device ${state.deviceKey} went offline mid-replay. Aborting remaining ${toReplay.length} entries.`);
                    }
                    break;
                }
                // 二次确认条目未过期(逐条间隔期间可能过期)
                if (entry.expireAt <= Date.now()) continue;

                try {
                    // 用 payload 的浅克隆 + 加一个 replay 标记,方便客户端区分
                    const replayPayload = {
                        ...entry.data,
                        _vcpReplay: true,
                        _vcpReplayOriginalAt: entry.createdAt
                    };
                    const ret = state.sendFn(replayPayload);
                    if (ret && typeof ret.then === 'function') {
                        await ret;
                    }
                    state.deliveredIds.add(entry.id);
                } catch (sendErr) {
                    console.error(`[VcpLogReplay] Failed to replay entry ${entry.id} to ${state.deviceKey}:`, sendErr.message);
                    // 一次失败即视为掉线,停止后续补发
                    state.online = false;
                    break;
                }

                if (this.config.replayIntervalMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.config.replayIntervalMs));
                }
            }
        } finally {
            state.replayInFlight = false;
        }
    }

    _sweep() {
        const now = Date.now();

        // 1) 清理过期缓存
        if (this.cache.length > 0) {
            const before = this.cache.length;
            this.cache = this.cache.filter(entry => entry.expireAt > now);
            const removed = before - this.cache.length;
            if (removed > 0 && this.config.debugMode) {
                console.log(`[VcpLogReplay] Swept ${removed} expired cache entries. remaining=${this.cache.length}`);
            }

            // 同步审核索引
            for (const [requestId, entryId] of this.approvalIndex.entries()) {
                if (!this.cache.some(entry => entry.id === entryId)) {
                    this.approvalIndex.delete(requestId);
                }
            }
        }

        // 2) 清理设备表中已不存在的 deliveredIds 引用,节省内存
        const validIds = new Set(this.cache.map(entry => entry.id));
        for (const state of this.devices.values()) {
            if (state.deliveredIds.size === 0) continue;
            for (const id of Array.from(state.deliveredIds)) {
                if (!validIds.has(id)) state.deliveredIds.delete(id);
            }
        }

        // 3) 回收长期不活动设备
        for (const [key, state] of this.devices.entries()) {
            if (state.online) continue;
            const inactiveSince = state.lastOfflineAt || state.lastOnlineAt || state.firstSeenAt;
            if (inactiveSince && (now - inactiveSince) > this.config.deviceTtlMs) {
                if (state.stabilityTimer) clearTimeout(state.stabilityTimer);
                this.devices.delete(key);
                if (this.config.debugMode) {
                    console.log(`[VcpLogReplay] Reclaimed inactive device ${key} after ${(now - inactiveSince) / 1000}s.`);
                }
            }
        }
    }

    _removeEntryFromAuxIndex(entry) {
        if (!entry) return;
        if (entry.type === APPROVAL_MESSAGE_TYPE) {
            const requestId = entry.data?.data?.requestId;
            if (requestId && this.approvalIndex.get(requestId) === entry.id) {
                this.approvalIndex.delete(requestId);
            }
        }
    }

    _generateId() {
        return `vcplog-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
    }

    // ---------- 调试 / 运维辅助 ----------

    getStats() {
        return {
            cacheSize: this.cache.length,
            cacheCap: this.config.maxCacheSize,
            deviceCount: this.devices.size,
            onlineDeviceCount: Array.from(this.devices.values()).filter(s => s.online).length,
            approvalIndexSize: this.approvalIndex.size
        };
    }

    /** 测试/重启时调用,清空所有内存状态。 */
    reset() {
        for (const state of this.devices.values()) {
            if (state.stabilityTimer) clearTimeout(state.stabilityTimer);
        }
        this.devices.clear();
        this.cache = [];
        this.approvalIndex.clear();
    }

    shutdown() {
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        this.reset();
    }
}

// 单例导出(与 toolApprovalManager 风格保持一致)
const singleton = new VcpLogReplayManager({
    debugMode: (process.env.DebugMode || 'false').toLowerCase() === 'true'
});

module.exports = singleton;
module.exports.VcpLogReplayManager = VcpLogReplayManager;
module.exports.APPROVAL_MESSAGE_TYPE = APPROVAL_MESSAGE_TYPE;