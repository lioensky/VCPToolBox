# VCP 官方插件商店落地方案：基于 VCPDistributedServer 的 Registry + ZIP 模式

## 1. 目标

本文档用于指导在独立仓库 `VCPDistributedServer` 中落地 VCP 官方插件商店。

目标是：

- 使用 `VCPDistributedServer` 作为轻量官方插件源仓库。
- 扫描仓库内 `Plugin/` 目录下的插件。
- 为每个插件自动生成独立 `.zip` 安装包。
- 自动生成根目录 `plugins.json` 插件索引。
- 让 VCPToolBox 管理员面板的“插件商店”通过 Registry JSON 源安装插件。
- 安装时只下载对应插件 zip，而不是下载整个 GitHub 仓库。

---

## 2. 背景结论

VCPToolBox 当前插件商店后端已经支持两种源：

| 源类型 | 用法 | 安装行为 |
|---|---|---|
| `github` | 添加 `https://github.com/owner/repo` | 扫描仓库内 `plugin-manifest.json`，安装时会下载整个仓库 zip，再取子目录 |
| `registry` | 添加 `https://raw.githubusercontent.com/.../plugins.json` | 读取 JSON 列表，按条目的 `downloadUrl` 下载单个插件 zip |

因此，如果直接把 `https://github.com/lioensky/VCPDistributedServer` 添加为 GitHub 源，虽然能扫描插件，但安装时仍可能下载整个仓库。

本方案改用 Registry 源：

```text
https://raw.githubusercontent.com/lioensky/VCPDistributedServer/main/plugins.json
```

只要 `plugins.json` 中每个插件条目只写 `downloadUrl`，管理员面板安装时就会只下载对应插件 zip。

---

## 3. 仓库结构约定

推荐 `VCPDistributedServer` 仓库结构如下：

```text
VCPDistributedServer/
├─ Plugin/
│  ├─ SomePlugin/
│  │  ├─ plugin-manifest.json
│  │  ├─ SomePlugin.js
│  │  ├─ package.json
│  │  └─ SomePlugin.zip
│  ├─ AnotherPlugin/
│  │  ├─ plugin-manifest.json
│  │  └─ AnotherPlugin.zip
│  └─ DisabledPlugin/
│     └─ plugin-manifest.json.block
├─ scripts/
│  └─ build_plugin_store.py
├─ plugins.json
├─ package.json
└─ README.md
```

约定：

- 每个可发布插件必须位于 `Plugin/<PluginDir>/`。
- 每个可发布插件必须包含 `plugin-manifest.json`。
- 含 `plugin-manifest.json.block` 且没有 `plugin-manifest.json` 的插件视为禁用插件，默认不进入商店。
- 每个插件目录下生成一个同名 zip：`Plugin/<PluginName>/<PluginName>.zip`。
- 根目录生成 `plugins.json`。
- `plugins.json` 内插件条目使用 `downloadUrl` 指向 raw zip 文件。

---

## 4. `plugins.json` 格式约定

推荐格式：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-03T03:00:00+08:00",
  "source": {
    "name": "VCP 官方插件商店",
    "repository": "https://github.com/lioensky/VCPDistributedServer"
  },
  "plugins": [
    {
      "name": "SomePlugin",
      "displayName": "Some Plugin",
      "description": "插件描述",
      "version": "1.0.0",
      "author": "VCP Team",
      "icon": "extension",
      "category": "tool",
      "downloadUrl": "https://raw.githubusercontent.com/lioensky/VCPDistributedServer/main/Plugin/SomePlugin/SomePlugin.zip"
    }
  ]
}
```

当前 VCPToolBox 插件商店实际读取的是 `plugins` 字段，因此额外的 `schemaVersion`、`generatedAt`、`source` 不会影响兼容性。

### 4.1 必需字段

| 字段 | 说明 |
|---|---|
| `name` | 插件唯一名，应与插件 `plugin-manifest.json` 的 `name` 一致 |
| `displayName` | 显示名 |
| `description` | 插件描述 |
| `version` | 插件版本 |
| `downloadUrl` | 单插件 zip 下载地址 |

### 4.2 推荐字段

| 字段 | 说明 |
|---|---|
| `author` | 作者 |
| `icon` | Material Symbols 图标名 |
| `category` | 插件分类 |
| `homepage` | 插件主页，可后续扩展前端展示 |
| `repository` | 插件源码地址，可后续扩展前端展示 |
| `license` | 许可证，可后续扩展前端展示 |
| `minVcpVersion` | 最低 VCPToolBox 版本要求，可后续扩展安装校验 |

### 4.3 禁止字段或不推荐字段

官方 Registry 模式中，不建议写以下字段：

| 字段 | 原因 |
|---|---|
| `directory` | 会让 GitHub 源模式生成子目录安装信息，但本方案要求强制 zip 安装 |
| `path` | 同上 |
| `subpath` | 同上 |
| `directoryName` | 同上 |
| `github` | 当前安装器会优先走 GitHub 安装路径，可能下载整个仓库 |

本方案要求每个条目只依赖 `downloadUrl` 完成安装。

---

## 5. 插件 zip 包格式约定

推荐 zip 包内包含插件目录本身：

```text
SomePlugin.zip
└─ SomePlugin/
   ├─ plugin-manifest.json
   ├─ SomePlugin.js
   ├─ package.json
   └─ README.md
```

当前 VCPToolBox 安装器会在解压后的目录中递归查找 `plugin-manifest.json`，因此以下结构也可用：

```text
SomePlugin.zip
├─ plugin-manifest.json
├─ SomePlugin.js
└─ package.json
```

但官方仓库建议统一使用第一种结构，便于人工检查和解压调试。

---

## 6. 打包脚本职责

新增脚本：

```text
scripts/build_plugin_store.py
```

脚本应该完成：

1. 从仓库根目录定位 `Plugin/`。
2. 遍历 `Plugin/` 的一级子目录。
3. 检查每个子目录是否存在 `plugin-manifest.json`。
4. 跳过没有启用 manifest 的目录。
5. 读取 manifest 元数据。
6. 校验 manifest 的 `name` 字段。
7. 删除该插件目录内旧的同名 zip。
8. 重新创建 `Plugin/<PluginName>/<PluginName>.zip`。
9. 生成根目录 `plugins.json`。
10. 输出打包结果摘要。

---

## 7. 推荐打包脚本实现

将以下文件保存为：

```text
scripts/build_plugin_store.py
```

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Build VCP official plugin store index and per-plugin zip packages.

Usage:
    python scripts/build_plugin_store.py

Optional:
    python scripts/build_plugin_store.py --repo lioensky/VCPDistributedServer --branch main
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List


SAFE_PLUGIN_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

DEFAULT_EXCLUDE_DIRS = {
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "env",
    "dist",
    "build",
}

DEFAULT_EXCLUDE_FILE_NAMES = {
    ".DS_Store",
    "Thumbs.db",
    "config.env",
    ".env",
    ".env.local",
    ".env.production",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
}

DEFAULT_EXCLUDE_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".log",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".tmp",
    ".bak",
    ".zip",
    ".tar",
    ".tgz",
    ".gz",
}


CATEGORY_BY_PLUGIN_TYPE = {
    "static": "data-provider",
    "service": "service",
    "hybridservice": "service",
}


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def write_json(path: Path, data: Dict[str, Any]) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def is_safe_plugin_name(name: str) -> bool:
    return bool(name and SAFE_PLUGIN_NAME_RE.fullmatch(name) and not name.startswith("."))


def normalize_category(manifest: Dict[str, Any]) -> str:
    raw = str(manifest.get("category") or "").strip()
    if raw:
        return raw

    plugin_type = str(manifest.get("pluginType") or manifest.get("type") or "").strip().lower()
    if plugin_type in CATEGORY_BY_PLUGIN_TYPE:
        return CATEGORY_BY_PLUGIN_TYPE[plugin_type]

    name = str(manifest.get("name") or "").lower()
    if any(k in name for k in ["image", "gen", "draw", "flux", "doubao", "zimage", "comfy", "novelai"]):
        return "image-generation"
    if any(k in name for k in ["video", "suno", "music"]):
        return "media-generation"
    if any(k in name for k in ["search", "fetch", "crawl", "wiki", "serp", "arxiv", "paper"]):
        return "information-retrieval"
    if any(k in name for k in ["shell", "executor", "file", "backup", "operator"]):
        return "system-integration"
    if any(k in name for k in ["agent", "message", "assistant", "dream", "task"]):
        return "agent-collab"
    if any(k in name for k in ["forum", "bilibili"]):
        return "social"
    if any(k in name for k in ["chrome", "bridge", "capture", "screenshot"]):
        return "browser"
    return "tool"


def should_exclude(path: Path, plugin_dir: Path) -> bool:
    rel_parts = path.relative_to(plugin_dir).parts

    for part in rel_parts:
        if part in DEFAULT_EXCLUDE_DIRS:
            return True

    name = path.name
    if name in DEFAULT_EXCLUDE_FILE_NAMES:
        return True

    lower = name.lower()
    if any(lower.endswith(suffix) for suffix in DEFAULT_EXCLUDE_SUFFIXES):
        return True

    return False


def iter_plugin_files(plugin_dir: Path) -> Iterable[Path]:
    for path in plugin_dir.rglob("*"):
        if path.is_dir():
            continue
        if should_exclude(path, plugin_dir):
            continue
        yield path


def build_plugin_zip(plugin_dir: Path, plugin_name: str) -> Path:
    zip_path = plugin_dir / f"{plugin_name}.zip"
    if zip_path.exists():
        zip_path.unlink()

    parent_dir_name = plugin_dir.name

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for file_path in iter_plugin_files(plugin_dir):
            arcname = Path(parent_dir_name) / file_path.relative_to(plugin_dir)
            zf.write(file_path, arcname.as_posix())

    return zip_path


def to_raw_download_url(repo: str, branch: str, zip_path: Path, root: Path) -> str:
    rel = zip_path.relative_to(root).as_posix()
    return f"https://raw.githubusercontent.com/{repo}/{branch}/{rel}"


def make_plugin_entry(
    manifest: Dict[str, Any],
    plugin_name: str,
    zip_url: str,
) -> Dict[str, Any]:
    display_name = str(manifest.get("displayName") or plugin_name).strip()
    description = str(manifest.get("description") or "").strip()
    version = str(manifest.get("version") or "").strip()
    author = str(manifest.get("author") or "VCP Team").strip()
    icon = str(manifest.get("icon") or "extension").strip()

    entry: Dict[str, Any] = {
        "name": plugin_name,
        "displayName": display_name,
        "description": description,
        "version": version,
        "author": author,
        "icon": icon,
        "category": normalize_category(manifest),
        "downloadUrl": zip_url,
    }

    for optional_key in ["homepage", "repository", "license", "minVcpVersion"]:
        value = manifest.get(optional_key)
        if isinstance(value, str) and value.strip():
            entry[optional_key] = value.strip()

    return entry


def build_store(root: Path, repo: str, branch: str, include_blocked: bool) -> Dict[str, Any]:
    plugin_root = root / "Plugin"
    if not plugin_root.is_dir():
        raise FileNotFoundError(f"Plugin directory not found: {plugin_root}")

    entries: List[Dict[str, Any]] = []
    skipped: List[str] = []

    for plugin_dir in sorted(plugin_root.iterdir(), key=lambda p: p.name.lower()):
        if not plugin_dir.is_dir():
            continue

        manifest_path = plugin_dir / "plugin-manifest.json"
        blocked_manifest_path = plugin_dir / "plugin-manifest.json.block"

        if not manifest_path.exists():
            if blocked_manifest_path.exists() and include_blocked:
                manifest_path = blocked_manifest_path
            else:
                skipped.append(f"{plugin_dir.name}: no enabled plugin-manifest.json")
                continue

        try:
            manifest = read_json(manifest_path)
            raw_name = str(manifest.get("name") or "").strip()
            if not is_safe_plugin_name(raw_name):
                skipped.append(f"{plugin_dir.name}: unsafe or empty manifest name: {raw_name!r}")
                continue

            zip_path = build_plugin_zip(plugin_dir, raw_name)
            zip_url = to_raw_download_url(repo, branch, zip_path, root)
            entries.append(make_plugin_entry(manifest, raw_name, zip_url))
            print(f"[OK] {raw_name} -> {zip_path.relative_to(root).as_posix()}")
        except Exception as exc:
            skipped.append(f"{plugin_dir.name}: {exc}")

    entries.sort(key=lambda item: str(item.get("displayName") or item.get("name") or "").lower())

    payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "name": "VCP 官方插件商店",
            "repository": f"https://github.com/{repo}",
            "branch": branch,
        },
        "plugins": entries,
    }

    write_json(root / "plugins.json", payload)

    print("")
    print(f"Generated plugins.json with {len(entries)} plugin(s).")
    if skipped:
        print("")
        print("Skipped:")
        for item in skipped:
            print(f"  - {item}")

    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build VCP plugin store registry and zip packages.")
    parser.add_argument("--repo", default="lioensky/VCPDistributedServer", help="GitHub repo in owner/name format.")
    parser.add_argument("--branch", default="main", help="GitHub branch for raw download URLs.")
    parser.add_argument("--root", default="", help="Repository root. Defaults to script parent parent.")
    parser.add_argument("--include-blocked", action="store_true", help="Also package plugin-manifest.json.block plugins.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve() if args.root else repo_root_from_script()

    if not re.fullmatch(r"[^/\s]+/[^/\s]+", args.repo):
        print(f"Invalid --repo: {args.repo}", file=sys.stderr)
        return 2

    build_store(root=root, repo=args.repo, branch=args.branch, include_blocked=args.include_blocked)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

---

## 8. 运行方式

在 `VCPDistributedServer` 仓库根目录运行：

```bash
python scripts/build_plugin_store.py
```

如果仓库名或分支不同：

```bash
python scripts/build_plugin_store.py --repo lioensky/VCPDistributedServer --branch main
```

运行后应生成：

```text
plugins.json
Plugin/SomePlugin/SomePlugin.zip
Plugin/AnotherPlugin/AnotherPlugin.zip
```

---

## 9. 管理员面板测试方式

进入 VCPToolBox 管理员面板：

1. 打开“插件商店”。
2. 切换到“源管理”。
3. 添加自定义源：
   - 名称：`VCP 官方插件商店`
   - 类型：`Registry (JSON 列表)`
   - URL：`https://raw.githubusercontent.com/lioensky/VCPDistributedServer/main/plugins.json`
4. 点击“添加源”。
5. 回到“插件市场”。
6. 点击“刷新列表”。
7. 搜索某个插件。
8. 点击“安装插件”。
9. 查看安装日志。

预期结果：

- 插件列表正常显示。
- 安装日志中下载地址是单个插件 zip。
- 不会下载整个 `VCPDistributedServer` 仓库 zip。
- 安装完成后插件出现在 VCPToolBox 的 `Plugin/<PluginName>/`。
- 如果插件目录含 `package.json`，VCPToolBox 安装器会自动执行 `npm install --omit=dev --no-audit --no-fund`。

---

## 10. 后端兼容性说明

当前 VCPToolBox 后端已经支持本方案，不需要立即改前端。

关键兼容点：

- Registry 源读取 `plugins.json` 的 `plugins` 数组。
- 插件条目中的 `downloadUrl` 会被用于下载安装包。
- 支持 `.zip`、`.tar`、`.tar.gz`、`.tgz`。
- 解压后会递归查找 `plugin-manifest.json`。
- 安装目标目录由 manifest 的 `name` 决定。
- 同名插件已存在时，默认报冲突；覆盖安装会备份旧目录。

---

## 11. 内置官方源的后续改造

测试稳定后，可以在 VCPToolBox 后端内置官方源。

将插件商店后端中的内置源改为：

```js
const BUILTIN_SOURCES = [
    {
        id: 'official-distributed',
        name: 'VCP 官方插件商店',
        url: 'https://raw.githubusercontent.com/lioensky/VCPDistributedServer/main/plugins.json',
        type: 'registry',
        builtin: true,
    },
];
```

这样用户打开插件商店后会自动看到官方源，不需要手动添加。

---

## 12. 注意事项

### 12.1 不要提交敏感配置

打包脚本默认排除：

```text
config.env
.env
.env.local
.env.production
```

但发布前仍应人工检查 zip 内容，避免泄露密钥。

### 12.2 不要打包依赖目录

脚本默认排除：

```text
node_modules/
.venv/
venv/
__pycache__/
```

插件如果有 Node.js 依赖，应提交 `package.json`，让 VCPToolBox 安装器在用户机器上执行 `npm install`。

### 12.3 Python 依赖不会自动安装

当前 VCPToolBox 插件商店只自动执行 `npm install`，不会自动执行 `pip install`。

Python 插件应在 `README.md` 或 `plugin-manifest.json` 的 `description` 中说明依赖要求。

### 12.4 大插件建议使用 Release Asset

如果单个 zip 很大，不建议长期放在 GitHub 仓库普通文件中。

可改为：

```json
{
  "downloadUrl": "https://github.com/lioensky/VCPDistributedServer/releases/download/SomePlugin-v1.0.0/SomePlugin.zip"
}
```

第一阶段可以先用 raw zip，后续再迁移到 GitHub Release。

---

## 13. 验收清单

发布前检查：

- [ ] `python scripts/build_plugin_store.py` 可在仓库根目录成功运行。
- [ ] 根目录生成 `plugins.json`。
- [ ] `plugins.json` 是合法 JSON。
- [ ] 每个插件条目都有 `name`、`displayName`、`version`、`downloadUrl`。
- [ ] 每个 `downloadUrl` 可公开访问。
- [ ] 每个 zip 内包含 `plugin-manifest.json`。
- [ ] zip 内不包含 `node_modules/`。
- [ ] zip 内不包含 `.env`、`config.env` 等敏感文件。
- [ ] 管理员面板使用 Registry 源可加载列表。
- [ ] 点击安装时只下载对应插件 zip。
- [ ] 安装后插件能被 VCPToolBox 热加载。
- [ ] 覆盖重装和卸载流程可用。

---

## 14. 最终使用约定

官方插件商店源 URL：

```text
https://raw.githubusercontent.com/lioensky/VCPDistributedServer/main/plugins.json
```

源类型：

```text
registry
```

插件包下载方式：

```text
downloadUrl -> 单插件 zip
```

核心原则：

```text
官方商店不使用 GitHub 仓库源安装；官方商店使用 Registry JSON + 单插件 ZIP 安装。