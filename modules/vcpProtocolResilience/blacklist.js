'use strict';

/**
 * modules/vcpProtocolResilience/blacklist.js
 * 负责高确定性黑名单反查（插件名入 maid 场景 A/B 拦截、生效角色名与系统保留词反查）
 */
const fs = require('fs');
const path = require('path');

/**
 * 通用系统保留角色代称（不可被当做工具名的通用保留词）
 */
const SYSTEM_RESERVED_ROLES = new Set([
  'maid', 'valet', 'assistant', 'user', 'system', 'agent', 'bot', 'vcp'
]);

let _cachedStaticAgentMap = null;
let _cachedStaticPluginSet = null;
let _testStaticAgentMapCandidates = null;

function _setStaticAgentMapCandidatesForTest(paths) {
  _testStaticAgentMapCandidates = Array.isArray(paths) ? paths : null;
  _cachedStaticAgentMap = null;
}

/**
 * 读取并缓存 agent_map.json 中配置的角色名（当未注入 agentManager 或 agentMap 为空时兜底）
 */
function getStaticAgentMap() {
  if (_cachedStaticAgentMap) return _cachedStaticAgentMap;
  const candidatePaths = _testStaticAgentMapCandidates || [
    path.resolve(__dirname, '../../agent_map.json'),
    path.resolve(__dirname, '../../../agent_map.json')
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        _cachedStaticAgentMap = new Set(Object.keys(data).map(k => k.toLowerCase()));
        return _cachedStaticAgentMap;
      } catch (e) { /* ignore */ }
    }
  }
  _cachedStaticAgentMap = new Set();
  return _cachedStaticAgentMap;
}

/**
 * 读取并缓存本地 Plugin/<Name>/plugin-manifest.json 中声明的插件名称集合
 * （当轮间历史清洗或单文本净化未注入运行时 pluginManager 实例时提供确定性兜底）
 */
function getStaticPluginSet() {
  if (_cachedStaticPluginSet) return _cachedStaticPluginSet;
  const pluginSet = new Set();
  const candidatePluginDirs = [
    path.resolve(__dirname, '../../Plugin'),
    path.resolve(__dirname, '../../../Plugin')
  ];
  for (const dir of candidatePluginDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        pluginSet.add(entry.name);
        const manifestPath = path.join(dir, entry.name, 'plugin-manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            if (manifest && typeof manifest.name === 'string' && manifest.name.trim()) {
              pluginSet.add(manifest.name.trim());
            }
          } catch (e) {
            // ignore JSON parse error, entry.name already added
          }
        }
      }
      break;
    } catch (e) { /* ignore */ }
  }
  _cachedStaticPluginSet = pluginSet;
  return _cachedStaticPluginSet;
}

/**
 * 判定一个名称是否属于当前生效的角色名（全动态反查，严禁按文件目录扫描）
 *
 * @param {string} name 待检测的名称（如来自 tool_name）
 * @param {object} [agentManager] 服务端注入的 AgentManager 实例
 * @returns {boolean} 是否为生效角色名或系统保留词
 */
function checkDirectRoleName(trimmed, agentManager) {
  if (!trimmed) return false;
  // 1. 动态核心：严格反查 agent_map.json 中当前映射激活的角色名
  let hasActiveDynamicEntries = false;

  if (agentManager?.isAgent?.(trimmed)) return true;

  if (agentManager?.agentMap) {
    if (typeof agentManager.agentMap.has === 'function') {
      if (typeof agentManager.agentMap.size === 'number' && agentManager.agentMap.size > 0) {
        hasActiveDynamicEntries = true;
      }
      if (agentManager.agentMap.has(trimmed)) return true;
    }
    if (typeof agentManager.agentMap.keys === 'function') {
      const keys = Array.from(agentManager.agentMap.keys());
      if (keys.length > 0) hasActiveDynamicEntries = true;
      for (const activeAlias of keys) {
        if (activeAlias.toLowerCase() === trimmed.toLowerCase()) return true;
      }
    } else if (typeof agentManager.agentMap === 'object') {
      const keys = Object.keys(agentManager.agentMap);
      if (keys.length > 0) hasActiveDynamicEntries = true;
      for (const activeAlias of keys) {
        if (activeAlias.toLowerCase() === trimmed.toLowerCase()) return true;
      }
    }
  }

  // 若未注入 agentManager，或传入的 agentManager.agentMap 有效条目数为空（size 为 0），回退读取 staticAgentMap
  if (!hasActiveDynamicEntries) {
    const staticMap = getStaticAgentMap();
    if (staticMap && staticMap.has(trimmed.toLowerCase())) {
      return true;
    }
  }

  // 2. 通用系统保留角色代称（不可被当做工具名的通用保留词）
  return SYSTEM_RESERVED_ROLES.has(trimmed.toLowerCase());
}

function isEffectiveRoleName(name, agentManager) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (checkDirectRoleName(trimmed, agentManager)) return true;
  const prefixMatch = /^\[[^\]]+\](.+)$/.exec(trimmed);
  if (prefixMatch) {
    return checkDirectRoleName(prefixMatch[1].trim(), agentManager);
  }
  return false;
}

/**
 * 检测名称是否为已知已注册的插件名
 *
 * @param {string} name 待检测名称
 * @param {object} [pluginManager] 插件管理器
 * @returns {boolean}
 */
function checkDirectKnownPlugin(trimmed, pluginManager) {
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  if (pluginManager) {
    if (pluginManager.getPlugin?.(trimmed)) return true;
    if (pluginManager.hasPlugin?.(trimmed)) return true;
    if (typeof pluginManager.isRegistered === 'function' && pluginManager.isRegistered(trimmed)) return true;
    if (pluginManager.plugins) {
      if (typeof pluginManager.plugins.has === 'function' && pluginManager.plugins.has(trimmed)) return true;
      if (typeof pluginManager.plugins.get === 'function' && pluginManager.plugins.get(trimmed)) return true;
      if (typeof pluginManager.plugins === 'object' && pluginManager.plugins[trimmed]) return true;
      if (typeof pluginManager.plugins.keys === 'function') {
        for (const k of pluginManager.plugins.keys()) {
          if (typeof k === 'string' && k.toLowerCase() === lower) return true;
        }
      } else if (typeof pluginManager.plugins === 'object') {
        for (const k of Object.keys(pluginManager.plugins)) {
          if (k.toLowerCase() === lower) return true;
        }
      }
    }
    return false;
  }

  // 未注入 pluginManager 实例时（如轮间历史坏块反查或单文本净化），回退查询本地静态插件清单缓存
  const staticPlugins = getStaticPluginSet();
  if (!staticPlugins) return false;
  if (staticPlugins.has(trimmed)) return true;
  for (const p of staticPlugins) {
    if (typeof p === 'string' && p.toLowerCase() === lower) return true;
  }
  return false;
}

function isKnownPlugin(name, pluginManager) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (checkDirectKnownPlugin(trimmed, pluginManager)) return true;
  const prefixMatch = /^\[[^\]]+\](.+)$/.exec(trimmed);
  if (prefixMatch) {
    return checkDirectKnownPlugin(prefixMatch[1].trim(), pluginManager);
  }
  return false;
}

/**
 * 校验黑名单冲突（场景 A / 场景 B / 角色名入 tool_name）
 *
 * @param {string} toolName 提取出的 tool_name 字符串
 * @param {string} maidKey 署名键名 ('maid' | 'Maid' | 'valet' 等)
 * @param {string} maidValue 提取出的 maid/valet 角色署名值
 * @param {object} [options={}] 配置选项（包含 pluginManager 与 agentManager）
 * @returns {object|null} 命中冲突时返回结构化拦截对象，未命中返回 null
 */
function checkBlacklistConflict(toolName, maidKey, maidValue, options = {}) {
  const pluginMgr = options.pluginManager;
  const agentMgr = options.agentManager;
  const rawKey = maidKey || 'maid';
  const cleanMaidVal = typeof maidValue === 'string' ? maidValue.trim() : '';
  const cleanToolVal = typeof toolName === 'string' ? toolName.trim() : '';

  const maidIsPlugin = cleanMaidVal ? isKnownPlugin(cleanMaidVal, pluginMgr) : false;
  const hasToolName = Boolean(cleanToolVal);

  // 场景 A：已知插件名误填入 maid/valet 且缺 tool_name -> 报 MISSING_TOOL_NAME
  if (!hasToolName && maidIsPlugin) {
    return {
      conflict: true,
      errorCode: 'MISSING_TOOL_NAME',
      errorDetail: `检测到将已知插件名「${cleanMaidVal}」误填入了 ${rawKey} 署名字段，且缺少 tool_name。tool_name 必须填写插件名，${rawKey} 仅填写角色名`,
      detectedPluginInMaid: cleanMaidVal,
      subType: 'BLACKLIST_SCENARIO_A',
      isProtocolError: true
    };
  }

  // 场景：角色名误填入 tool_name -> 报 INVALID_TOOL_NAME
  if (hasToolName && isEffectiveRoleName(cleanToolVal, agentMgr)) {
    return {
      conflict: true,
      errorCode: 'INVALID_TOOL_NAME',
      errorDetail: `tool_name 字段填写了角色名「${cleanToolVal}」，必须填写具体要调用的插件名（如 LinuxShellExecutor 等）`,
      roleNameInTool: cleanToolVal,
      subType: 'ROLE_IN_TOOL_NAME',
      isProtocolError: true
    };
  }

  // 场景 B：已填 tool_name 但 maid/valet 误填已知插件名 -> 报 INVALID_TOOL_NAME
  if (hasToolName && maidIsPlugin) {
    return {
      conflict: true,
      errorCode: 'INVALID_TOOL_NAME',
      errorDetail: `检测到将已知插件名「${cleanMaidVal}」误填入了 ${rawKey} 署名字段。${rawKey} 仅填写角色名，不可填写插件名`,
      pluginInMaid: cleanMaidVal,
      subType: 'BLACKLIST_SCENARIO_B',
      isProtocolError: true
    };
  }

  // 零误杀正常合法调用
  return null;
}

module.exports = {
  isEffectiveRoleName,
  isKnownPlugin,
  checkBlacklistConflict,
  SYSTEM_RESERVED_ROLES,
  getStaticAgentMap,
  getStaticPluginSet,
  _setStaticAgentMapCandidatesForTest
};
