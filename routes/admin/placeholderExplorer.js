'use strict';

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const EXPLORER_PLUGIN_DIR = path.join(PROJECT_ROOT, 'Plugin', 'PlaceholderExplorer');
const COMMAND_PLUGIN_DIR = path.join(PROJECT_ROOT, 'Plugin', 'PlaceholderExplorerCommand');
const MAX_PLACEHOLDER_LENGTH = 4096;

const { editPlaceholder } = require(path.join(EXPLORER_PLUGIN_DIR, 'modules', 'editor'));
const { locate } = require(path.join(EXPLORER_PLUGIN_DIR, 'modules', 'indexStore'));
const { previewPlaceholder } = require(path.join(EXPLORER_PLUGIN_DIR, 'modules', 'preview'));
const { createScanConfig, ensureIndex, scanProject } = require(path.join(EXPLORER_PLUGIN_DIR, 'modules', 'scanner'));
const { isPathInside, normalizePlaceholder, pathExists, toRelative } = require(path.join(EXPLORER_PLUGIN_DIR, 'modules', 'pathUtils'));

module.exports = function() {
    const router = express.Router();
    let mutationQueue = Promise.resolve();

    function enqueueMutation(task) {
        const result = mutationQueue.then(task, task);
        mutationQueue = result.catch(() => undefined);
        return result;
    }

    function createHttpError(message, statusCode = 400) {
        const error = new Error(message);
        error.statusCode = statusCode;
        return error;
    }

    function requireBodyObject(req) {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            throw createHttpError('请求体必须是 JSON 对象。');
        }
        return req.body;
    }

    function requirePlaceholder(value) {
        if (typeof value !== 'string' || !value.trim()) {
            throw createHttpError('缺少 placeholder 参数。');
        }
        if (value.length > MAX_PLACEHOLDER_LENGTH) {
            throw createHttpError(`placeholder 长度不能超过 ${MAX_PLACEHOLDER_LENGTH} 个字符。`);
        }
        return normalizePlaceholder(value);
    }

    function sendError(res, error, fallbackMessage, defaultStatus = 500) {
        const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : defaultStatus;
        console.error(`[PlaceholderExplorerAdmin] ${fallbackMessage}:`, error);
        res.status(statusCode).json({
            success: false,
            error: fallbackMessage,
            details: error.message,
        });
    }

    async function readExplorerEnvironment() {
        const env = { ...process.env };
        const envPath = path.join(EXPLORER_PLUGIN_DIR, 'config.env');
        try {
            Object.assign(env, dotenv.parse(await fs.readFile(envPath, 'utf8')));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        return env;
    }

    async function createOperationContext() {
        const env = await readExplorerEnvironment();
        const scanConfig = createScanConfig(env, EXPLORER_PLUGIN_DIR);
        const configuredBackupDir = String(env.PLACEHOLDER_BACKUP_DIR || 'backups').trim() || 'backups';
        const backupRoot = path.isAbsolute(configuredBackupDir)
            ? path.resolve(configuredBackupDir)
            : path.resolve(EXPLORER_PLUGIN_DIR, configuredBackupDir);

        return {
            env,
            scanConfig,
            editorConfig: {
                ...scanConfig,
                pluginDir: EXPLORER_PLUGIN_DIR,
                backupRoot,
                backupRetention: Number(env.PLACEHOLDER_BACKUP_RETENTION || 20),
                maxEditBytes: Number(env.PLACEHOLDER_MAX_EDIT_BYTES || 1048576),
            },
        };
    }

    async function readPluginStatus(pluginDir) {
        const enabledManifestPath = path.join(pluginDir, 'plugin-manifest.json');
        const blockedManifestPath = path.join(pluginDir, 'plugin-manifest.json.block');
        const enabled = await pathExists(enabledManifestPath);
        const manifestPath = enabled ? enabledManifestPath : blockedManifestPath;
        if (!(await pathExists(manifestPath))) {
            return {
                name: path.basename(pluginDir),
                displayName: path.basename(pluginDir),
                pluginType: 'unknown',
                version: null,
                enabled: false,
                available: false,
                commands: [],
            };
        }

        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        const commands = Array.isArray(manifest?.capabilities?.invocationCommands)
            ? manifest.capabilities.invocationCommands
                .map(item => item?.commandIdentifier || item?.command)
                .filter(Boolean)
            : [];
        return {
            name: manifest.name || path.basename(pluginDir),
            displayName: manifest.displayName || manifest.name || path.basename(pluginDir),
            pluginType: manifest.pluginType || 'unknown',
            version: manifest.version || null,
            enabled,
            available: true,
            commands,
        };
    }

    async function createSnapshot(index) {
        const plugins = await Promise.all([
            readPluginStatus(EXPLORER_PLUGIN_DIR),
            readPluginStatus(COMMAND_PLUGIN_DIR),
        ]);
        return { index, plugins };
    }

    function findEntry(index, placeholder) {
        const entry = locate(index, placeholder);
        if (!entry) throw createHttpError(`索引中找不到占位符：${placeholder}`, 404);
        return entry;
    }

    function resolveDefinition(entry) {
        if (entry.type === 'sar') {
            const sarDefinition = entry.definitions.find(item => item.source === 'sarprompt_json');
            if (sarDefinition) return sarDefinition;
        }
        return entry.definitions.find(item => item.source === 'config_env')
            || entry.definitions.find(item => item.editable === true)
            || null;
    }

    async function readEditableContent(index, placeholder, scope, context) {
        const entry = findEntry(index, placeholder);
        if (!entry.editable) throw createHttpError(`${entry.placeholder} 是只读占位符。`, 403);

        if (scope === 'file') {
            const candidates = entry.definitions.filter(item => item.resolvesTo);
            if (candidates.length !== 1) {
                throw createHttpError(`${entry.placeholder} 必须唯一指向一个 TVStxt 文件才能编辑文件内容。`);
            }
            const targetPath = path.resolve(context.scanConfig.projectRoot, candidates[0].resolvesTo);
            if (!isPathInside(context.scanConfig.tvsDir, targetPath)) {
                throw createHttpError('只允许读取和编辑 TVStxt 目录内的变量文件。', 403);
            }
            const stat = await fs.stat(targetPath);
            if (stat.size > context.editorConfig.maxEditBytes) {
                throw createHttpError(`目标文件超过 ${context.editorConfig.maxEditBytes} 字节编辑限制。`);
            }
            return {
                placeholder: entry.placeholder,
                scope,
                source: 'TVStxt',
                file: toRelative(context.scanConfig.projectRoot, targetPath),
                content: await fs.readFile(targetPath, 'utf8'),
                restartRequired: false,
            };
        }

        const definition = resolveDefinition(entry);
        if (!definition) throw createHttpError(`${entry.placeholder} 没有可写定义。`);
        return {
            placeholder: entry.placeholder,
            scope: 'definition',
            source: definition.source === 'sarprompt_json' ? 'sarprompt.json' : 'config.env',
            file: definition.file,
            content: String(definition.value ?? ''),
            restartRequired: definition.source !== 'sarprompt_json',
        };
    }

    router.get('/placeholder-explorer/index', async (req, res) => {
        try {
            const context = await createOperationContext();
            const { index } = await ensureIndex(context.scanConfig);
            res.json({ success: true, data: await createSnapshot(index) });
        } catch (error) {
            sendError(res, error, '读取占位符索引失败');
        }
    });

    router.get('/placeholder-explorer/editable-content', async (req, res) => {
        try {
            const placeholder = requirePlaceholder(req.query.placeholder);
            const scope = req.query.scope === 'file' ? 'file' : 'definition';
            const context = await createOperationContext();
            const { index } = await ensureIndex(context.scanConfig);
            const data = await readEditableContent(index, placeholder, scope, context);
            res.json({ success: true, data });
        } catch (error) {
            sendError(res, error, '读取可编辑内容失败');
        }
    });

    router.post('/placeholder-explorer/scan', async (req, res) => {
        try {
            const data = await enqueueMutation(async () => {
                const context = await createOperationContext();
                const { index } = await scanProject(context.scanConfig);
                return createSnapshot(index);
            });
            res.json({ success: true, data });
        } catch (error) {
            sendError(res, error, '重建占位符索引失败');
        }
    });

    router.post('/placeholder-explorer/preview', async (req, res) => {
        try {
            const body = requireBodyObject(req);
            const placeholder = requirePlaceholder(body.placeholder);
            const role = ['system', 'user', 'assistant'].includes(body.role) ? body.role : 'system';
            const context = await createOperationContext();
            const preview = await previewPlaceholder(placeholder, {
                config: context.scanConfig,
                role,
                model: typeof body.model === 'string' ? body.model : undefined,
                text: typeof body.text === 'string' ? body.text : undefined,
                context: typeof body.context === 'string' ? body.context : undefined,
            });
            res.json({ success: true, data: { preview } });
        } catch (error) {
            sendError(res, error, '预览占位符失败');
        }
    });

    router.post('/placeholder-explorer/edit', async (req, res) => {
        try {
            const body = requireBodyObject(req);
            const placeholder = requirePlaceholder(body.placeholder);
            if (!Object.prototype.hasOwnProperty.call(body, 'newValue') || typeof body.newValue !== 'string') {
                throw createHttpError('newValue 必须是字符串。');
            }
            const scope = body.scope === 'file' ? 'file' : 'definition';
            const data = await enqueueMutation(async () => {
                const context = await createOperationContext();
                const { index } = await ensureIndex(context.scanConfig);
                const edit = await editPlaceholder(index, placeholder, body.newValue, {
                    ...context.editorConfig,
                    scope,
                });
                const rescanned = await scanProject(context.scanConfig);
                return {
                    snapshot: await createSnapshot(rescanned.index),
                    edit,
                    message: edit.restartRequired
                        ? '保存成功。config.env 已备份并原子写回；请重启 VCP 服务后生效。'
                        : '保存成功。原文件已备份并原子写回。',
                };
            });
            res.json({ success: true, data });
        } catch (error) {
            sendError(res, error, '编辑占位符失败');
        }
    });

    return router;
};
