"use strict";

// TicktickManager inbox project id helper
// Usage:
//   node get-inbox-project-id.js
//   node get-inbox-project-id.js --base-url https://api.ticktick.com/open/v1
//   node get-inbox-project-id.js --write-probe
//
// Requires TICKTICK_ACCESS_TOKEN in config.env or process.env.
//
// Important:
//   TickTick/Dida365 OpenAPI v1 usually does not include Inbox in GET /project.
//   Read-only probing may fail even when Inbox has tasks. Use --write-probe to
//   create a temporary task without projectId, read the returned projectId, and
//   delete the temporary task immediately.

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const CONFIG_ENV_PATH = path.join(DIR, "config.env");
const DEFAULT_BASE_URL = "https://api.ticktick.com/open/v1";

function parseConfigEnv() {
  if (!fs.existsSync(CONFIG_ENV_PATH)) {
    return {};
  }
  const env = {};
  const content = fs.readFileSync(CONFIG_ENV_PATH, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = rawLine.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = rawLine.slice(0, eq).trim();
    if (!key) {
      continue;
    }
    let value = rawLine.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getArgValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }
  return "";
}

async function requestJson(baseUrl, accessToken, endpoint, options = {}) {
  const method = options.method || "GET";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "TicktickManager-InboxIdHelper/1.0",
  };
  const fetchOptions = { method, headers };
  if (options.body !== undefined && method !== "GET" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${endpoint}`, fetchOptions);
  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(
      `OpenAPI 请求失败 HTTP ${response.status}: ${
        parsed.error || parsed.message || parsed.raw || text
      }`
    );
  }
  return parsed;
}

async function discoverInboxIdByWriteProbe(baseUrl, accessToken) {
  const title = `TicktickManager 收集箱ID探测 ${new Date().toISOString()}`;
  let createdTask = null;
  try {
    createdTask = await requestJson(baseUrl, accessToken, "/task", {
      method: "POST",
      body: {
        title,
        content:
          "这是 TicktickManager 为发现收集箱 projectId 自动创建的临时任务，应会立即删除。",
      },
    });

    const projectId = String(
      createdTask && createdTask.projectId ? createdTask.projectId : ""
    ).trim();
    const taskId = String(
      createdTask && createdTask.id ? createdTask.id : ""
    ).trim();
    if (!/^inbox\d+$/i.test(projectId)) {
      throw new Error(
        `临时任务创建成功，但返回 projectId 不是 inbox+数字串：${
          projectId || "<empty>"
        }`
      );
    }
    if (!taskId) {
      throw new Error(
        "临时任务创建成功，但响应中没有任务 id，无法安全删除。需手动检查收集箱。 "
      );
    }

    await requestJson(
      baseUrl,
      accessToken,
      `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(
        taskId
      )}`,
      { method: "DELETE" }
    );
    return { projectId, taskId, deleted: true };
  } catch (error) {
    if (createdTask && createdTask.projectId && createdTask.id) {
      try {
        await requestJson(
          baseUrl,
          accessToken,
          `/project/${encodeURIComponent(
            createdTask.projectId
          )}/task/${encodeURIComponent(createdTask.id)}`,
          { method: "DELETE" }
        );
      } catch (deleteError) {
        error.message = `${
          error.message || error
        }；并且临时任务删除失败，请手动删除任务 ${createdTask.id}。删除错误：${
          deleteError.message || deleteError
        }`;
      }
    }
    throw error;
  }
}

function collectInboxIdsFromValue(value, result) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    const matches = value.match(/inbox\d+/gi) || [];
    for (const match of matches) {
      result.add(match);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectInboxIdsFromValue(item, result);
    }
    return;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectInboxIdsFromValue(nested, result);
    }
  }
}

async function main() {
  if (typeof fetch !== "function") {
    console.error("当前 Node.js 运行环境没有 fetch，请使用 Node.js 18+。");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const config = parseConfigEnv();
  const baseUrl = trimTrailingSlash(
    getArgValue(args, "--base-url") ||
      process.env.TICKTICK_BASE_URL ||
      config.TICKTICK_BASE_URL ||
      DEFAULT_BASE_URL
  );
  const accessToken =
    process.env.TICKTICK_ACCESS_TOKEN || config.TICKTICK_ACCESS_TOKEN || "";

  if (!accessToken) {
    console.error(
      "错误：缺少 TICKTICK_ACCESS_TOKEN。请先在 config.env 中填写 access token。"
    );
    process.exit(1);
  }

  console.log(`服务端：${baseUrl}`);
  console.log("正在读取项目列表...");
  const projects = await requestJson(baseUrl, accessToken, "/project");
  if (!Array.isArray(projects)) {
    console.error("GET /project 返回值不是数组，无法继续。返回：", projects);
    process.exit(1);
  }

  const ids = new Set();
  for (const project of projects) {
    collectInboxIdsFromValue(project, ids);
    const name = String((project && project.name) || "")
      .trim()
      .toLowerCase();
    const id = String((project && project.id) || "").trim();
    if ((name === "inbox" || name === "收集箱") && /^inbox\d+$/i.test(id)) {
      ids.add(id);
    }
  }

  if (ids.size === 0) {
    console.log(
      "项目列表中未直接发现 inbox+数字串，尝试读取各项目数据中的任务 projectId..."
    );
    for (const project of projects) {
      if (!project || !project.id || project.closed === true) {
        continue;
      }
      try {
        const data = await requestJson(
          baseUrl,
          accessToken,
          `/project/${encodeURIComponent(project.id)}/data`
        );
        collectInboxIdsFromValue(data, ids);
      } catch (error) {
        console.warn(
          `跳过项目 ${project.name || project.id}：${error.message || error}`
        );
      }
    }
  }

  console.log("");
  if (ids.size === 0) {
    console.log("只读扫描未能发现收集箱真实项目 ID。");
    console.log(
      "原因：TickTick/Dida365 OpenAPI v1 的 GET /project 通常不返回收集箱，/project/{id}/data 也无法查 i" +
        "nbox 数据。"
    );
    const writeProbe = args.includes("--write-probe");
    if (!writeProbe) {
      console.log("");
      console.log(
        "需要写入探测：请显式添加 --write-probe 参数，脚本将创建一个临时任务" +
          "（不带 projectId），"
      );
      console.log("从返回数据中提取 inbox+数字串，再立即删除临时任务。");
      console.log("  示例：node get-inbox-project-id.js --write-probe");
      return;
    }

    console.log("执行写入探测...");
    try {
      const probe = await discoverInboxIdByWriteProbe(baseUrl, accessToken);
      ids.add(probe.projectId);
      console.log(
        `临时任务 ${probe.taskId} 已创建并删除，探测到收集箱 ID：${probe.projectId}`
      );
    } catch (error) {
      console.error("写入探测失败：", error.message || error);
      return;
    }
  }

  console.log("发现可能的收集箱真实项目 ID：");
  for (const id of ids) {
    console.log(`  ${id}`);
  }
  console.log("");
  console.log("请将确认后的值填入 config.env：");
  console.log(`TICKTICK_INBOX_PROJECT_ID=${Array.from(ids)[0]}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
