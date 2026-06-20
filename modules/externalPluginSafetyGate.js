'use strict';

const path = require('path');

const KNOWN_PLUGIN_SOURCES = new Set(['legacy', 'external', 'modern']);

function normalizeString(value) {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : null;
}

function normalizePluginSource(value) {
    const source = normalizeString(value);
    return source && KNOWN_PLUGIN_SOURCES.has(source)
        ? source
        : 'legacy';
}

function resolvePluginSource(manifest, options) {
    const explicitSource = normalizeString(manifest.pluginSource || options.pluginSource);
    if (explicitSource && KNOWN_PLUGIN_SOURCES.has(explicitSource)) {
        return explicitSource;
    }
    return options.isExternal === true
        ? 'external'
        : 'legacy';
}

function normalizeBasePath(value, projectRoot = process.cwd()) {
    const basePath = normalizeString(value);
    if (!basePath) {
        return null;
    }
    return path.resolve(projectRoot, basePath);
}

function normalizeBuiltInPluginNames(names) {
    if (!names) {
        return new Set();
    }
    if (names instanceof Set) {
        return new Set(Array.from(names).map(normalizeString).filter(Boolean));
    }
    if (Array.isArray(names)) {
        return new Set(names.map(normalizeString).filter(Boolean));
    }
    return new Set();
}

function getEntryPointKind(entryPoint) {
    if (!entryPoint || typeof entryPoint !== 'object') {
        return 'unknown';
    }
    if (normalizeString(entryPoint.command)) {
        return 'command';
    }
    if (normalizeString(entryPoint.script)) {
        return 'script';
    }
    return 'unknown';
}

function getCommunicationProtocol(manifest) {
    return normalizeString(manifest?.communication?.protocol);
}

function classifyManifestRisk(manifest, entryPointKind, communicationProtocol) {
    if (entryPointKind === 'command') {
        return 'executes_process';
    }
    if (entryPointKind === 'script' && communicationProtocol === 'direct') {
        return 'loads_code';
    }
    if (entryPointKind === 'script') {
        return 'unknown';
    }
    return 'unknown';
}

function classifyExternalPluginManifest(manifest = {}, options = {}) {
    const pluginName = normalizeString(manifest.name) || 'unknown';
    const pluginSource = resolvePluginSource(manifest, options);
    const basePath = normalizeBasePath(manifest.basePath, options.projectRoot);
    const isExternal = options.isExternal === true || pluginSource === 'external';
    const builtInPluginNames = normalizeBuiltInPluginNames(options.builtInPluginNames);
    const duplicateOfBuiltIn = isExternal && builtInPluginNames.has(pluginName);
    const pluginType = normalizeString(manifest.pluginType);
    const communicationProtocol = getCommunicationProtocol(manifest);
    const entryPointKind = getEntryPointKind(manifest.entryPoint);
    const risk = classifyManifestRisk(manifest, entryPointKind, communicationProtocol);
    const reasons = [];

    if (!normalizeString(manifest.name)) {
        reasons.push('manifest is missing a plugin name');
    }
    if (!pluginType) {
        reasons.push('manifest is missing a plugin type');
    }
    if (!basePath) {
        reasons.push('manifest is missing a base path');
    }
    if (entryPointKind === 'unknown') {
        reasons.push('manifest entrypoint is missing or unsupported');
    }
    if (isExternal) {
        reasons.push('external plugin requires explicit allow policy before registration');
    }
    if (duplicateOfBuiltIn) {
        reasons.push('external plugin name duplicates a built-in plugin');
    }
    if (risk === 'loads_code') {
        reasons.push('direct script entrypoint can load plugin code during registration');
    } else if (risk === 'executes_process') {
        reasons.push('command entrypoint can execute a process during tool use');
    } else if (risk === 'unknown') {
        reasons.push('entrypoint risk could not be determined from manifest metadata');
    }

    return {
        pluginName,
        pluginSource,
        basePath,
        isExternal,
        duplicateOfBuiltIn,
        pluginType,
        communicationProtocol,
        entryPointKind,
        risk,
        decision: isExternal ? 'would_block' : 'observe',
        reasons
    };
}

function classifyExternalPluginManifests(manifests = [], options = {}) {
    if (!Array.isArray(manifests)) {
        return [];
    }
    return manifests.map((manifest) => classifyExternalPluginManifest(manifest, options));
}

module.exports = {
    classifyExternalPluginManifest,
    classifyExternalPluginManifests
};
