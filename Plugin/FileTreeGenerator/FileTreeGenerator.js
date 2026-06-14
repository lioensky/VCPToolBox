const fs = require("fs");
const path = require("path");

// --- 路径定义 ---
const CWD = __dirname;
const CONFIG_PATH = path.join(CWD, "config.env");

// --- 日志记录 (仅用于调试，输出到 stderr) ---
function log(message) {
  console.error(`[FileTreeGenerator] ${new Date().toISOString()}: ${message}`);
}

// --- 函数：读取和解析配置文件 ---
function parseConfig() {
  const config = {};
  if (!fs.existsSync(CONFIG_PATH)) {
    log(`[ERROR] Config file not found at ${CONFIG_PATH}`);
    return null;
  }
  try {
    const fileContent = fs.readFileSync(CONFIG_PATH, "utf8");
    fileContent.split(/\r?\n/).forEach((line) => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith("#")) {
        const [key, value] = trimmedLine.split("=");
        if (key && value) {
          config[key.trim()] = value.trim();
        }
      }
    });
  } catch (error) {
    log(`[ERROR] Failed to read config file: ${error.message}`);
    return null;
  }
  return config;
}

/**
 * 递归生成目录树结构字符串（只包含文件夹）
 * @param {string} dir - 要扫描的目录路径
 * @param {string} prefix - 用于缩进的字符串
 * @param {Set} excludeSet - 排除的目录名集合
 * @param {number} depth - 当前递归深度
 * @param {number} maxDepth - 最大递归深度，0 表示无限制
 * @returns {string} - 生成的目录树字符串
 */
function generateTree(
  dir,
  prefix = "",
  excludeSet = new Set(),
  depth = 0,
  maxDepth = 0
) {
  if (maxDepth > 0 && depth >= maxDepth) return "";
  let treeString = "";
  try {
    const items = fs.readdirSync(dir);
    const subdirs = items.filter((item) => {
      // 检查是否在排除列表中
      if (excludeSet.has(item)) {
        return false;
      }
      try {
        const fullPath = path.join(dir, item);
        const stats = fs.lstatSync(fullPath);
        // 接受目录或指向目录的符号链接
        if (stats.isSymbolicLink()) {
          try {
            const targetStats = fs.statSync(fullPath);
            return targetStats.isDirectory();
          } catch (e) {
            // 悬空链接也显示
            return true;
          }
        }
        return stats.isDirectory();
      } catch (e) {
        return false;
      }
    });

    subdirs.forEach((subdir, index) => {
      const isLast = index === subdirs.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const fullPath = path.join(dir, subdir);

      let displayName = subdir;
      let symlinkInfo = "";
      let shouldRecurse = true;

      try {
        const stats = fs.lstatSync(fullPath);
        if (stats.isSymbolicLink()) {
          // 符号链接：添加 @ 后缀 + 箭头指向
          const target = fs.readlinkSync(fullPath);
          displayName = `${subdir}@`;
          symlinkInfo = ` -> ${target}`;
          // 检查目标是否可访问
          try {
            fs.statSync(fullPath);
          } catch (e) {
            // 悬空链接，不递归
            shouldRecurse = false;
          }
        } else if (stats.isDirectory()) {
          // 普通目录：添加 / 后缀
          displayName = `${subdir}/`;
        }
      } catch (e) {
        // 如果无法读取，保持原名
      }

      treeString += `${prefix}${connector}${displayName}${symlinkInfo}\n`;

      // 只对可访问的目录递归展开
      if (shouldRecurse) {
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        treeString += generateTree(
          fullPath,
          newPrefix,
          excludeSet,
          depth + 1,
          maxDepth
        );
      }
    });
  } catch (error) {
    // 如果读取目录失败（例如权限问题），则返回错误信息
    return `[Error reading directory ${dir}: ${error.message}]`;
  }
  return treeString;
}

// --- 主程序 ---
function main() {
  log("Plugin invoked. Generating file tree with Node.js...");

  // 1. 读取和验证配置
  const config = parseConfig();
  if (!config || !config.TARGET_DIRECTORY) {
    const errorMsg =
      "Configuration error: TARGET_DIRECTORY is not defined or config.env is missing.";
    log(`[FATAL] ${errorMsg}`);
    console.log(JSON.stringify({ status: "error", error: errorMsg }));
    return;
  }

  // 处理排除列表
  const excludeDirsString = config.EXCLUDE_DIRS || "";
  const excludeSet = new Set(
    excludeDirsString
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d)
  );
  if (excludeSet.size > 0) {
    log(`Excluding directories: ${Array.from(excludeSet).join(", ")}`);
  }

  const targetDir = config.TARGET_DIRECTORY;
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    const errorMsg = `Target directory does not exist or is not a directory: ${targetDir}`;
    log(`[FATAL] ${errorMsg}`);
    console.log(JSON.stringify({ status: "error", error: errorMsg }));
    return;
  }

  // 2. 生成目录树
  try {
    const maxDepth = parseInt(config.MAX_DEPTH || "0", 10);
    if (maxDepth > 0) {
      log(`Max depth limit: ${maxDepth}`);
    }
    log(`Scanning directory: ${targetDir}`);

    // 构建带有层级信息的标题
    let header = `Directory tree for: ${targetDir}\n`;
    if (maxDepth > 0) {
      header += `(Expanded to depth: ${maxDepth})\n`;
    } else {
      header += `(Fully expanded)\n`;
    }

    const treeContent = generateTree(targetDir, "", excludeSet, 0, maxDepth);
    const finalResult = header + treeContent;
    log("File tree generation finished.");

    // 3. 将结果输出到 stdout
    console.log(JSON.stringify({ status: "success", result: finalResult }));
  } catch (error) {
    const errorMsg = `An unexpected error occurred during tree generation: ${error.message}`;
    log(`[FATAL] ${errorMsg}`);
    console.log(JSON.stringify({ status: "error", error: errorMsg }));
  }
}

// 直接执行主函数
main();
