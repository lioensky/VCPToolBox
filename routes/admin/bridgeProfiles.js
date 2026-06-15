/**
 * Bridge Profiles Admin API
 * 
 * Provides CRUD endpoints for VCPBridgeServer's multi-profile system.
 * Each profile defines an independent systemPrompt + hijackMode combination,
 * allowing per-request profile selection via URL path, header, or model prefix.
 * 
 * Endpoints:
 *   GET    /bridge-profiles          — List all profiles
 *   GET    /bridge-profiles/:name    — Read a single profile
 *   POST   /bridge-profiles/:name    — Create or update a profile
 *   DELETE /bridge-profiles/:name    — Delete a profile
 *   POST   /bridge-profiles/:name/activate — Set as default profile in bridge-config.json
 */

const express = require('express');
const {
    PROFILES_DIR,
    isValidProfileName,
    profileExists,
    listProfiles,
    readProfile,
    saveProfile,
    deleteProfile,
    readBridgeConfig,
    saveBridgeConfig
} = require('../../Plugin/VCPBridgeServer/bridgeConfig.js');

module.exports = function (options) {
    const router = express.Router();

    // ─── List all profiles ───────────────────────────────────────────────
    router.get('/bridge-profiles', (req, res) => {
        try {
            const profiles = listProfiles();
            const config = readBridgeConfig();
            res.json({
                success: true,
                profiles,
                activeDefault: config.defaultProfile || '',
                profilesDir: 'Plugin/VCPBridgeServer/profiles/',
                count: profiles.length,
                message: `已加载 ${profiles.length} 个 Bridge Profile。`
            });
        } catch (error) {
            console.error('[BridgeProfiles] Failed to list profiles:', error);
            res.status(500).json({
                success: false,
                error: '列出 Bridge Profiles 失败',
                details: error.message
            });
        }
    });

    // ─── Read a single profile ───────────────────────────────────────────
    router.get('/bridge-profiles/:name', (req, res) => {
        try {
            const { name } = req.params;

            if (!isValidProfileName(name)) {
                return res.status(400).json({
                    success: false,
                    error: `无效的 Profile 名称: "${name}"。仅允许小写字母、数字、连字符和下划线（1-64 字符）。`
                });
            }

            const profile = readProfile(name);
            if (!profile) {
                return res.status(404).json({
                    success: false,
                    error: `Profile "${name}" 不存在。`
                });
            }

            res.json({
                success: true,
                profile,
                message: `已读取 Profile "${name}"。`
            });
        } catch (error) {
            console.error('[BridgeProfiles] Failed to read profile:', error);
            res.status(500).json({
                success: false,
                error: '读取 Profile 失败',
                details: error.message
            });
        }
    });

    // ─── Create or update a profile ──────────────────────────────────────
    router.post('/bridge-profiles/:name', (req, res) => {
        try {
            const { name } = req.params;
            const data = req.body || {};

            if (!isValidProfileName(name)) {
                return res.status(400).json({
                    success: false,
                    error: `无效的 Profile 名称: "${name}"。仅允许小写字母、数字、连字符和下划线（1-64 字符）。`
                });
            }

            const isNew = !profileExists(name);
            const saved = saveProfile(name, data);

            res.json({
                success: true,
                profile: saved,
                created: isNew,
                message: isNew
                    ? `Profile "${name}" 创建成功。`
                    : `Profile "${name}" 更新成功。`
            });
        } catch (error) {
            console.error('[BridgeProfiles] Failed to save profile:', error);
            res.status(500).json({
                success: false,
                error: '保存 Profile 失败',
                details: error.message
            });
        }
    });

    // ─── Delete a profile ────────────────────────────────────────────────
    router.delete('/bridge-profiles/:name', (req, res) => {
        try {
            const { name } = req.params;

            if (!isValidProfileName(name)) {
                return res.status(400).json({
                    success: false,
                    error: `无效的 Profile 名称: "${name}"。`
                });
            }

            if (!profileExists(name)) {
                return res.status(404).json({
                    success: false,
                    error: `Profile "${name}" 不存在，无法删除。`
                });
            }

            // Prevent deleting the currently active default profile
            const config = readBridgeConfig();
            if (config.defaultProfile === name) {
                return res.status(409).json({
                    success: false,
                    error: `Profile "${name}" 当前是默认激活 Profile，请先切换默认后再删除。`
                });
            }

            const deleted = deleteProfile(name);
            if (!deleted) {
                return res.status(500).json({
                    success: false,
                    error: `删除 Profile "${name}" 时发生未知错误。`
                });
            }

            res.json({
                success: true,
                message: `Profile "${name}" 已删除。`
            });
        } catch (error) {
            console.error('[BridgeProfiles] Failed to delete profile:', error);
            res.status(500).json({
                success: false,
                error: '删除 Profile 失败',
                details: error.message
            });
        }
    });

    // ─── Activate a profile as default ───────────────────────────────────
    router.post('/bridge-profiles/:name/activate', (req, res) => {
        try {
            const { name } = req.params;

            if (!isValidProfileName(name)) {
                return res.status(400).json({
                    success: false,
                    error: `无效的 Profile 名称: "${name}"。`
                });
            }

            if (!profileExists(name)) {
                return res.status(404).json({
                    success: false,
                    error: `Profile "${name}" 不存在，无法激活。`
                });
            }

            // Read current config, update defaultProfile, save back
            const config = readBridgeConfig();
            config.defaultProfile = name;
            saveBridgeConfig(config);

            res.json({
                success: true,
                activeDefault: name,
                message: `已将 "${name}" 设为默认 Profile。VCPBridgeServer 将通过 chokidar 自动热加载。`
            });
        } catch (error) {
            console.error('[BridgeProfiles] Failed to activate profile:', error);
            res.status(500).json({
                success: false,
                error: '激活 Profile 失败',
                details: error.message
            });
        }
    });

    // ─── Deactivate default profile (clear) ──────────────────────────────
    router.post('/bridge-profiles/deactivate', (req, res) => {
        try {
            const config = readBridgeConfig();
            config.defaultProfile = '';
            saveBridgeConfig(config);

            res.json({
                success: true,
                activeDefault: '',
                message: '已清除默认 Profile。VCPBridgeServer 将回退到全局 systemPrompt/hijackMode 配置。'
            });
        } catch (error) {
            console.error('[BridgeProfiles] Failed to deactivate profile:', error);
            res.status(500).json({
                success: false,
                error: '清除默认 Profile 失败',
                details: error.message
            });
        }
    });

    return router;
};