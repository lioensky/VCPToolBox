'use strict';

const fs = require('fs').promises;
const path = require('path');
const { findLine, normalizePlaceholder, pathExists, toRelative } = require('./pathUtils');

async function scanPluginManifests(pluginRoot, options = {}) {
    const definitions = [];
    const manifests = [];
    const errors = [];
    if (!(await pathExists(pluginRoot))) return { definitions, manifests, errors };

    const folders = await fs.readdir(pluginRoot, { withFileTypes: true });
    folders.sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of folders) {
        if (!folder.isDirectory()) continue;
        const manifestPath = path.join(pluginRoot, folder.name, 'plugin-manifest.json');
        if (!(await pathExists(manifestPath))) continue;
        const relativeFile = options.projectRoot ? toRelative(options.projectRoot, manifestPath) : manifestPath;
        try {
            const content = await fs.readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(content);
            manifests.push({ path: manifestPath, relativeFile, content, manifest });
            const explicit = manifest?.capabilities?.systemPromptPlaceholders;
            if (Array.isArray(explicit)) {
                for (const item of explicit) {
                    if (!item || typeof item.placeholder !== 'string') continue;
                    const placeholder = normalizePlaceholder(item.placeholder);
                    definitions.push({
                        placeholder,
                        type: manifest.pluginType === 'static' ? 'plugin_static' : 'plugin_declared',
                        file: relativeFile,
                        line: findLine(content, item.placeholder),
                        value: item.description || manifest.description || '',
                        resolvesTo: null,
                        editable: false,
                        source: 'plugin_manifest',
                        pluginName: manifest.name || folder.name,
                        pluginType: manifest.pluginType || 'unknown'
                    });
                }
            }

            const commands = manifest?.capabilities?.invocationCommands;
            if (manifest.name && Array.isArray(commands) && commands.length > 0) {
                const placeholder = normalizePlaceholder(`VCP${manifest.name}`);
                if (!definitions.some(item => item.placeholder === placeholder && item.file === relativeFile)) {
                    definitions.push({
                        placeholder,
                        type: 'plugin_tool',
                        file: relativeFile,
                        line: findLine(content, '"invocationCommands"'),
                        value: manifest.description || '',
                        resolvesTo: null,
                        editable: false,
                        source: 'plugin_manifest_generated',
                        pluginName: manifest.name,
                        pluginType: manifest.pluginType || 'unknown',
                        commandCount: commands.length
                    });
                }
            }
        } catch (error) {
            errors.push({ file: relativeFile, line: 1, message: error.message });
        }
    }
    return { definitions, manifests, errors };
}

module.exports = { scanPluginManifests };
