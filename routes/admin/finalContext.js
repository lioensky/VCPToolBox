const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const finalContextStore = require('../../modules/finalContextStore.js');
const {
    CONFIG_PATH: BRIDGE_CONFIG_PATH,
    DESCRIPTION: BRIDGE_CONFIG_DESCRIPTION,
    readBridgeConfig,
    saveBridgeConfig,
    normalizeBridgeConfig
} = require('../../Plugin/VCPBridgeServer/bridgeConfig.js');

const DEFAULT_ONERING_CONFIG = Object.freeze({
    enabled: true,
    tailTagPlacement: 'inline',
    maxContextBlocks: 10,
    timeInsert: true
});

function normalizeBoolean(value, defaultValue) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return defaultValue;
}

function normalizePositiveInteger(value, defaultValue) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function normalizeTailTagPlacement(value) {
    const normalized = String(value || DEFAULT_ONERING_CONFIG.tailTagPlacement).trim().toLowerCase();
    if (['system_user_block', 'system-user-block', 'user_block', 'user-block', 'pseudo_system_user'].includes(normalized)) {
        return 'system_user_block';
    }
    return 'inline';
}

function normalizeOneRingConfig(raw = {}) {
    return {
        enabled: normalizeBoolean(raw.enabled, DEFAULT_ONERING_CONFIG.enabled),
        tailTagPlacement: normalizeTailTagPlacement(raw.tailTagPlacement),
        maxContextBlocks: normalizePositiveInteger(raw.maxContextBlocks, DEFAULT_ONERING_CONFIG.maxContextBlocks),
        timeInsert: normalizeBoolean(raw.timeInsert, DEFAULT_ONERING_CONFIG.timeInsert)
    };
}

function getOneRingConfigPath() {
    return path.join(__dirname, '..', '..', 'Plugin', 'OneRing', 'OneRingConfig.json');
}

module.exports = function() {
    const router = express.Router();
    let bridgeConfigWatcher = null;

    router.get('/final-context', (req, res) => {
        const snapshot = finalContextStore.getLastFinalContext();

        if (!snapshot) {
            return res.json({
                available: false,
                message: '尚未捕获任何最终上下文。请先发起一次 /v1/chat/completions 请求。'
            });
        }

        res.json({
            available: true,
            snapshot
        });
    });

    router.get('/onering-config', async (req, res) => {
        const configPath = getOneRingConfigPath();
        try {
            const content = await fs.readFile(configPath, 'utf8');
            const parsed = JSON.parse(content);
            res.json({
                success: true,
                config: normalizeOneRingConfig(parsed),
                raw: parsed,
                path: 'Plugin/OneRing/OneRingConfig.json'
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.json({
                    success: true,
                    config: { ...DEFAULT_ONERING_CONFIG },
                    raw: { ...DEFAULT_ONERING_CONFIG },
                    path: 'Plugin/OneRing/OneRingConfig.json',
                    message: 'OneRingConfig.json 不存在，已返回默认配置。保存后会创建该文件。'
                });
            }
            console.error('[FinalContext] Failed to read OneRing config:', error);
            res.status(500).json({ success: false, error: '读取 OneRingConfig.json 失败', details: error.message });
        }
    });

    router.put('/onering-config', async (req, res) => {
        const configPath = getOneRingConfigPath();
        try {
            const nextConfig = normalizeOneRingConfig(req.body || {});
            const payload = {
                ...nextConfig,
                description: {
                    enabled: 'OneRing 热开关。false 时插件直接透传 messages，不再读取 ONERING_ENABLED 环境开关。',
                    tailTagPlacement: 'OneRing 来源标记输出位置。inline=继续追加到原 user/assistant 块内部；system_user_block=从原块剥离后追加独立 user 伪系统提示块，降低 assistant 块内部来源标记导致的 AI 幻觉风险。',
                    maxContextBlocks: '最大补充后上下文 block 数。block 指 role=user 或 role=assistant 的消息块；若当前 post 已经接近或超过该数量，OneRing 不再继续插入补充消息。',
                    timeInsert: '是否允许基于时间戳顺序进行 Post 内插入。true=按时间线合并补入消息；false=不做时间线内插入。'
                }
            };
            await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            res.json({
                success: true,
                config: nextConfig,
                path: 'Plugin/OneRing/OneRingConfig.json',
                message: 'OneRing 配置已保存，运行中插件会通过 chokidar 自动热加载。'
            });
        } catch (error) {
            console.error('[FinalContext] Failed to save OneRing config:', error);
            res.status(500).json({ success: false, error: '保存 OneRingConfig.json 失败', details: error.message });
        }
    });

    router.get('/bridge-config', async (req, res) => {
        try {
            const config = readBridgeConfig();
            res.json({
                success: true,
                config,
                path: 'Plugin/VCPBridgeServer/bridge-config.json',
                description: BRIDGE_CONFIG_DESCRIPTION,
                message: '前端劫持配置已读取。该 JSON 文件是 VCPBridgeServer 的运行真相源。'
            });
        } catch (error) {
            console.error('[FinalContext] Failed to read VCPBridge config:', error);
            res.status(500).json({ success: false, error: '读取 VCPBridgeServer 配置失败', details: error.message });
        }
    });

    router.put('/bridge-config', async (req, res) => {
        try {
            const nextConfig = normalizeBridgeConfig(req.body || {});
            const saved = saveBridgeConfig(nextConfig);
            res.json({
                success: true,
                config: normalizeBridgeConfig(saved),
                path: 'Plugin/VCPBridgeServer/bridge-config.json',
                description: BRIDGE_CONFIG_DESCRIPTION,
                message: '前端劫持配置已保存，运行中的 VCPBridgeServer 会通过 chokidar 自动热加载。端口变更需重启后生效。'
            });
        } catch (error) {
            console.error('[FinalContext] Failed to save VCPBridge config:', error);
            res.status(500).json({ success: false, error: '保存 VCPBridgeServer 配置失败', details: error.message });
        }
    });

    function ensureBridgeConfigWatcher() {
        if (bridgeConfigWatcher) return;
        try {
            const chokidar = require('chokidar');
            bridgeConfigWatcher = chokidar.watch(BRIDGE_CONFIG_PATH, {
                ignoreInitial: true,
                awaitWriteFinish: {
                    stabilityThreshold: 250,
                    pollInterval: 50
                }
            });
            bridgeConfigWatcher.on('add', () => console.log('[FinalContext] VCPBridge config file created:', BRIDGE_CONFIG_PATH));
            bridgeConfigWatcher.on('change', () => console.log('[FinalContext] VCPBridge config file changed:', BRIDGE_CONFIG_PATH));
            bridgeConfigWatcher.on('error', error => console.error('[FinalContext] VCPBridge config watcher error:', error));
        } catch (error) {
            console.error('[FinalContext] Failed to watch VCPBridge config:', error);
        }
    }

    ensureBridgeConfigWatcher();

    return router;
};