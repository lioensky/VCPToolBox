const path = require("path");
const express = require("express");

/**
 * DailyNotePanel 路由胶水插件
 *
 * 作用：
 * - 通过 PluginManager 在主 app 上注册 DailyNotePanel 的前端页面路由
 * - 以及专供 DailyNotePanel 使用的一套 dailynote API 路由
 *
 * 设计要点：
 * - 不移动现有的 DailyNotePanel 前端目录和官方 routes/dailyNotesRoutes.js 文件
 * - 仅仅是“接线”：利用 projectBasePath 去 require / 挂载
 * - 兼容 AdminPanel 独立 server 后主服务对 /AdminPanel 的整体重定向
 *
 * 重要：
 * - adminAuth 在 server.js / adminServer.js 里是全局中间件，按路径前缀判断是否需要 BasicAuth。
 * - 本插件不重复实现认证逻辑，只确保自己的 /AdminPanel/DailyNotePanel 与
 *   /AdminPanel/dailynote_api 路由不会被更宽的 /AdminPanel 重定向或 SPA 兜底提前吞掉。
 */

function getExpressStack(app) {
  const router = app && (app._router || app.router);
  if (!router || !Array.isArray(router.stack)) return null;
  return router.stack;
}

function normalizePrefix(prefix) {
  const value = String(prefix || "").trim();
  if (!value || value === "/") return "/";
  return value.replace(/\/+$/, "");
}

function prefixContainsPath(prefix, requestPath) {
  const normalizedPrefix = normalizePrefix(prefix);
  const normalizedPath = String(requestPath || "");
  if (normalizedPrefix === "/") return true;
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
}

function layerMatchesPath(layer, requestPath) {
  if (!layer) return false;

  if (typeof layer.match === "function") {
    try {
      return !!layer.match(requestPath);
    } catch (error) {
      // Express 内部 Layer#match 失败时继续走兼容兜底。
    }
  }

  if (typeof layer.path === "string") {
    return prefixContainsPath(layer.path, requestPath);
  }

  if (layer.regexp) {
    const regexpText = String(layer.regexp);
    if (regexpText.includes("\\/AdminPanel")) {
      return prefixContainsPath("/AdminPanel", requestPath);
    }
  }

  return false;
}

function isSpecificAdminPanelLayer(layer, samplePaths) {
  const matchesDailyNotePath = samplePaths.some((samplePath) =>
    layerMatchesPath(layer, samplePath)
  );
  if (!matchesDailyNotePath) return false;

  // 根级中间件（例如 cors/json/adminAuth/bearer auth）会匹配所有路径，不能把插件路由挪到它们前面。
  return !layerMatchesPath(layer, "/__dailynote_panel_route_probe__");
}

function hoistDailyNoteRoutesBeforeAdminPanelCatchAll(
  app,
  routeEntries,
  debug
) {
  const stack = getExpressStack(app);
  if (!stack) {
    if (debug) {
      console.warn(
        "[DailyNotePanelRouter] Express router stack is unavailable; skip route hoist."
      );
    }
    return;
  }

  const selectedLayers = routeEntries
    .map((entry) => ({
      ...entry,
      index: stack.findIndex((layer) => layer && layer.handle === entry.handle),
    }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (selectedLayers.length !== routeEntries.length) {
    if (debug) {
      console.warn(
        "[DailyNotePanelRouter] Could not find all mounted route layers; skip route hoist."
      );
    }
    return;
  }

  const firstDailyNoteIndex = selectedLayers[0].index;
  let lastAdminAuthIndex = -1;
  for (let i = 0; i < firstDailyNoteIndex; i += 1) {
    const layer = stack[i];
    if (layer && layer.handle && layer.handle.name === "adminAuth") {
      lastAdminAuthIndex = i;
    }
  }

  const searchStartIndex = lastAdminAuthIndex >= 0 ? lastAdminAuthIndex + 1 : 0;
  const samplePaths = routeEntries.flatMap((entry) => {
    const prefix = normalizePrefix(entry.prefix);
    return [prefix, `${prefix}/__dailynote_panel_route_probe__`];
  });

  let insertIndex = -1;
  for (let i = searchStartIndex; i < firstDailyNoteIndex; i += 1) {
    if (isSpecificAdminPanelLayer(stack[i], samplePaths)) {
      insertIndex = i;
      break;
    }
  }

  if (insertIndex < 0) {
    if (debug) {
      console.log(
        "[DailyNotePanelRouter] No earlier /AdminPanel catch-all layer found; route hoist is not needed."
      );
    }
    return;
  }

  const layersToMove = selectedLayers.map((entry) => stack[entry.index]);
  for (const entry of [...selectedLayers].sort((a, b) => b.index - a.index)) {
    stack.splice(entry.index, 1);
  }
  stack.splice(insertIndex, 0, ...layersToMove);

  console.log(
    `[DailyNotePanelRouter] Hoisted ${layersToMove.length} route layer(s) before AdminPanel catch-all at stack index ${insertIndex}.`
  );
}

/**
 * 旧式 service 插件接口：
 * PluginManager.initializeServices(app, adminApiRouter, projectBasePath)
 * 会在检测到模块导出了 registerRoutes 时调用：
 *
 *   module.registerRoutes(app, adminApiRouter, pluginConfig, projectBasePath);
 *
 * 这里我们只用 app 和 projectBasePath，adminApiRouter 暂时用不到。
 *
 * @param {import('express').Express} app
 * @param {import('express').Router} adminApiRouter
 * @param {object} pluginConfig  来自 plugin-manifest.json 解析后的 config（含 DebugMode、PanelPathPrefix、ApiPathPrefix 等）
 * @param {string} projectBasePath VCP 主项目根目录（即包含 server.js 的那个目录）
 */
function registerRoutes(app, adminApiRouter, pluginConfig, projectBasePath) {
  const debug = !!pluginConfig.DebugMode;

  const panelPrefix =
    pluginConfig.PanelPathPrefix || "/AdminPanel/DailyNotePanel";
  const apiPrefix = pluginConfig.ApiPathPrefix || "/AdminPanel/dailynote_api";

  if (debug) {
    console.log(
      `[DailyNotePanelRouter] registerRoutes called with panelPrefix="${panelPrefix}", apiPrefix="${apiPrefix}", projectBasePath="${projectBasePath}"`
    );
  }

  // 1. 挂载 DailyNotePanel 前端静态资源
  // 前端文件已被移动到插件自身目录下：Plugin/DailyNotePanel/frontend
  // 这里通过 __dirname 定位到插件目录，再拼出 frontend 子目录
  const panelDir = path.join(__dirname, "frontend");
  if (debug) {
    console.log(
      `[DailyNotePanelRouter] Serving static DailyNotePanel from: ${panelDir} at prefix: ${panelPrefix}`
    );
  }
  const panelStaticMiddleware = express.static(panelDir);
  app.use(panelPrefix, panelStaticMiddleware);

  // 2. 挂载专供 DailyNotePanel 使用的一套 dailynote API
  const dailyNoteRootPath =
    process.env.KNOWLEDGEBASE_ROOT_PATH ||
    path.join(projectBasePath, "dailynote");
  if (debug) {
    console.log(
      `[DailyNotePanelRouter] Daily note root path: ${dailyNoteRootPath}`
    );
  }

  // 注意：这里严格复用官方 routes/dailyNotesRoutes.js，而不是复制实现
  const dailyNotesRoutesFactory = require(path.join(
    projectBasePath,
    "routes",
    "dailyNotesRoutes"
  ));
  const dailyNotesRoutes = dailyNotesRoutesFactory(
    dailyNoteRootPath,
    !!pluginConfig.DebugMode
  );

  if (debug) {
    console.log(
      `[DailyNotePanelRouter] Mounting dailyNotesRoutes at: ${apiPrefix}`
    );
  }
  app.use(apiPrefix, dailyNotesRoutes);

  hoistDailyNoteRoutesBeforeAdminPanelCatchAll(
    app,
    [
      { prefix: panelPrefix, handle: panelStaticMiddleware },
      { prefix: apiPrefix, handle: dailyNotesRoutes },
    ],
    debug
  );

  if (debug) {
    console.log("[DailyNotePanelRouter] Route registration completed.");
  }
}

module.exports = {
  registerRoutes,
};
