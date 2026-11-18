#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VCPToolBox 插件 GUI 开关管理器

功能：
- 自动扫描服务器根目录 Plugin/ 下的插件目录
- 识别 plugin-manifest.json 为已启用
- 识别 plugin-manifest.json.block 为已禁用
- 显示插件名称、显示名、类型、版本、状态、路径
- 支持批量选中、批量启用、批量禁用
- 支持按状态/类型/关键字过滤
- 操作时仅重命名 manifest 文件，不修改 manifest 内容

运行：
    python plugin_gui_manager.py
"""

from __future__ import annotations

import json
import os
import sys
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import messagebox, ttk
from typing import Dict, List, Optional, Tuple


PLUGIN_TYPES = (
    "static",
    "messagePreprocessor",
    "synchronous",
    "asynchronous",
    "service",
    "hybridservice",
)


@dataclass
class PluginInfo:
    directory: Path
    enabled_manifest: Path
    disabled_manifest: Path
    manifest_path: Optional[Path]
    status: str
    name: str
    display_name: str
    plugin_type: str
    version: str
    description: str
    error: str = ""

    @property
    def folder_name(self) -> str:
        return self.directory.name

    @property
    def relative_manifest(self) -> str:
        if self.manifest_path:
            return str(self.manifest_path)
        return ""

    @property
    def is_enabled(self) -> bool:
        return self.status == "启用"

    @property
    def is_disabled(self) -> bool:
        return self.status == "禁用"


class PluginManagerGui(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("VCPToolBox 插件开关管理器")
        self.geometry("1180x720")
        self.minsize(980, 560)

        self.root_dir = Path(__file__).resolve().parent
        self.plugin_dir = self.root_dir / "Plugin"
        self.plugins: List[PluginInfo] = []
        self.filtered_plugins: List[PluginInfo] = []
        self.item_to_plugin: Dict[str, PluginInfo] = {}

        self.search_var = tk.StringVar()
        self.status_filter_var = tk.StringVar(value="全部")
        self.type_filter_var = tk.StringVar(value="全部")
        self.summary_var = tk.StringVar(value="")
        self.root_var = tk.StringVar(value=f"服务器根目录：{self.root_dir}")
        self.plugin_dir_var = tk.StringVar(value=f"插件目录：{self.plugin_dir}")

        self._build_ui()
        self.scan_plugins()

    def _build_ui(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(3, weight=1)

        top_frame = ttk.Frame(self, padding=(10, 8, 10, 4))
        top_frame.grid(row=0, column=0, sticky="ew")
        top_frame.columnconfigure(0, weight=1)

        ttk.Label(top_frame, textvariable=self.root_var).grid(row=0, column=0, sticky="w")
        ttk.Label(top_frame, textvariable=self.plugin_dir_var).grid(row=1, column=0, sticky="w")

        filter_frame = ttk.LabelFrame(self, text="筛选与搜索", padding=(10, 8))
        filter_frame.grid(row=1, column=0, padx=10, pady=6, sticky="ew")
        filter_frame.columnconfigure(1, weight=1)

        ttk.Label(filter_frame, text="关键字：").grid(row=0, column=0, padx=(0, 6), sticky="w")
        search_entry = ttk.Entry(filter_frame, textvariable=self.search_var)
        search_entry.grid(row=0, column=1, padx=(0, 12), sticky="ew")
        search_entry.bind("<KeyRelease>", lambda _event: self.apply_filters())

        ttk.Label(filter_frame, text="状态：").grid(row=0, column=2, padx=(0, 6), sticky="w")
        status_combo = ttk.Combobox(
            filter_frame,
            textvariable=self.status_filter_var,
            values=("全部", "启用", "禁用", "异常", "无manifest"),
            width=12,
            state="readonly",
        )
        status_combo.grid(row=0, column=3, padx=(0, 12), sticky="w")
        status_combo.bind("<<ComboboxSelected>>", lambda _event: self.apply_filters())

        ttk.Label(filter_frame, text="类型：").grid(row=0, column=4, padx=(0, 6), sticky="w")
        type_combo = ttk.Combobox(
            filter_frame,
            textvariable=self.type_filter_var,
            values=("全部", *PLUGIN_TYPES, "未知"),
            width=22,
            state="readonly",
        )
        type_combo.grid(row=0, column=5, padx=(0, 12), sticky="w")
        type_combo.bind("<<ComboboxSelected>>", lambda _event: self.apply_filters())

        ttk.Button(filter_frame, text="清空筛选", command=self.clear_filters).grid(row=0, column=6, sticky="e")

        action_frame = ttk.Frame(self, padding=(10, 4))
        action_frame.grid(row=2, column=0, sticky="ew")

        ttk.Button(action_frame, text="重新扫描", command=self.scan_plugins).pack(side="left", padx=(0, 8))
        ttk.Button(action_frame, text="全选当前列表", command=self.select_all_visible).pack(side="left", padx=(0, 8))
        ttk.Button(action_frame, text="反选当前列表", command=self.invert_selection).pack(side="left", padx=(0, 8))
        ttk.Button(action_frame, text="清空选择", command=self.clear_selection).pack(side="left", padx=(0, 18))
        ttk.Button(action_frame, text="批量启用所选", command=self.enable_selected).pack(side="left", padx=(0, 8))
        ttk.Button(action_frame, text="批量禁用所选", command=self.disable_selected).pack(side="left", padx=(0, 18))
        ttk.Button(action_frame, text="退出", command=self.destroy).pack(side="right")

        table_frame = ttk.Frame(self, padding=(10, 4, 10, 4))
        table_frame.grid(row=3, column=0, sticky="nsew")
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)

        columns = ("status", "folder", "display_name", "name", "type", "version", "manifest", "description", "error")
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings", selectmode="extended")

        headings = {
            "status": "状态",
            "folder": "目录",
            "display_name": "显示名",
            "name": "名称",
            "type": "类型",
            "version": "版本",
            "manifest": "Manifest",
            "description": "描述",
            "error": "错误",
        }
        widths = {
            "status": 72,
            "folder": 150,
            "display_name": 180,
            "name": 160,
            "type": 150,
            "version": 80,
            "manifest": 280,
            "description": 320,
            "error": 220,
        }

        for col in columns:
            self.tree.heading(col, text=headings[col], command=lambda c=col: self.sort_by_column(c, False))
            self.tree.column(col, width=widths[col], anchor="w", stretch=col in {"description", "error", "manifest"})

        y_scroll = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        x_scroll = ttk.Scrollbar(table_frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

        self.tree.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")

        self.tree.tag_configure("enabled", foreground="#107c10")
        self.tree.tag_configure("disabled", foreground="#8a2be2")
        self.tree.tag_configure("error", foreground="#b00020")
        self.tree.tag_configure("missing", foreground="#666666")

        bottom_frame = ttk.Frame(self, padding=(10, 4, 10, 8))
        bottom_frame.grid(row=4, column=0, sticky="ew")
        bottom_frame.columnconfigure(0, weight=1)
        ttk.Label(bottom_frame, textvariable=self.summary_var).grid(row=0, column=0, sticky="w")

        help_text = (
            "提示：启用=plugin-manifest.json；禁用=plugin-manifest.json.block。"
            "批量操作会重命名文件；若目标文件已存在，会跳过并提示。"
        )
        ttk.Label(bottom_frame, text=help_text).grid(row=1, column=0, sticky="w", pady=(4, 0))

    def scan_plugins(self) -> None:
        if not self.plugin_dir.exists() or not self.plugin_dir.is_dir():
            messagebox.showerror("插件目录不存在", f"未找到插件目录：\n{self.plugin_dir}")
            self.plugins = []
            self.apply_filters()
            return

        plugins: List[PluginInfo] = []
        for child in sorted(self.plugin_dir.iterdir(), key=lambda p: p.name.lower()):
            if not child.is_dir():
                continue
            if child.name.startswith("."):
                continue
            if child.name == "__pycache__":
                continue
            plugins.append(self._scan_one_plugin(child))

        self.plugins = plugins
        self.apply_filters()

    def _scan_one_plugin(self, directory: Path) -> PluginInfo:
        enabled_manifest = directory / "plugin-manifest.json"
        disabled_manifest = directory / "plugin-manifest.json.block"

        manifest_path: Optional[Path] = None
        status = "无manifest"
        error = ""

        has_enabled = enabled_manifest.exists()
        has_disabled = disabled_manifest.exists()

        if has_enabled and has_disabled:
            manifest_path = enabled_manifest
            status = "异常"
            error = "同时存在启用和禁用 manifest"
        elif has_enabled:
            manifest_path = enabled_manifest
            status = "启用"
        elif has_disabled:
            manifest_path = disabled_manifest
            status = "禁用"

        data: Dict[str, object] = {}
        if manifest_path:
            try:
                with manifest_path.open("r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    data = loaded
                else:
                    status = "异常"
                    error = "manifest 根节点不是 JSON 对象"
            except Exception as exc:
                status = "异常"
                error = f"读取/解析失败：{exc}"

        name = self._safe_str(data.get("name")) or directory.name
        display_name = self._safe_str(data.get("displayName")) or name
        plugin_type = self._safe_plugin_type(data.get("pluginType"))
        version = self._safe_str(data.get("version"))
        description = self._safe_str(data.get("description"))

        return PluginInfo(
            directory=directory,
            enabled_manifest=enabled_manifest,
            disabled_manifest=disabled_manifest,
            manifest_path=manifest_path,
            status=status,
            name=name,
            display_name=display_name,
            plugin_type=plugin_type,
            version=version,
            description=description,
            error=error,
        )

    @staticmethod
    def _safe_str(value: object) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return str(value)

    @staticmethod
    def _safe_plugin_type(value: object) -> str:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list):
            joined = ", ".join(str(item) for item in value if str(item).strip())
            return joined or "未知"
        return "未知"

    def clear_filters(self) -> None:
        self.search_var.set("")
        self.status_filter_var.set("全部")
        self.type_filter_var.set("全部")
        self.apply_filters()

    def apply_filters(self) -> None:
        keyword = self.search_var.get().strip().lower()
        status_filter = self.status_filter_var.get()
        type_filter = self.type_filter_var.get()

        filtered: List[PluginInfo] = []
        for plugin in self.plugins:
            if status_filter != "全部" and plugin.status != status_filter:
                continue
            if type_filter != "全部":
                if type_filter == "未知":
                    if plugin.plugin_type != "未知":
                        continue
                elif plugin.plugin_type != type_filter:
                    continue
            if keyword:
                haystack = " ".join(
                    [
                        plugin.folder_name,
                        plugin.name,
                        plugin.display_name,
                        plugin.plugin_type,
                        plugin.version,
                        plugin.description,
                        plugin.relative_manifest,
                        plugin.error,
                    ]
                ).lower()
                if keyword not in haystack:
                    continue
            filtered.append(plugin)

        self.filtered_plugins = filtered
        self.refresh_table()
        self.update_summary()

    def refresh_table(self) -> None:
        selected_dirs = {
            self.item_to_plugin[item].folder_name
            for item in self.tree.selection()
            if item in self.item_to_plugin
        }

        self.tree.delete(*self.tree.get_children())
        self.item_to_plugin.clear()

        for plugin in self.filtered_plugins:
            tag = self._status_tag(plugin.status)
            item = self.tree.insert(
                "",
                "end",
                values=(
                    plugin.status,
                    plugin.folder_name,
                    plugin.display_name,
                    plugin.name,
                    plugin.plugin_type,
                    plugin.version,
                    plugin.relative_manifest,
                    plugin.description,
                    plugin.error,
                ),
                tags=(tag,),
            )
            self.item_to_plugin[item] = plugin
            if plugin.folder_name in selected_dirs:
                self.tree.selection_add(item)

    @staticmethod
    def _status_tag(status: str) -> str:
        if status == "启用":
            return "enabled"
        if status == "禁用":
            return "disabled"
        if status == "异常":
            return "error"
        return "missing"

    def update_summary(self) -> None:
        total = len(self.plugins)
        visible = len(self.filtered_plugins)
        enabled = sum(1 for p in self.plugins if p.status == "启用")
        disabled = sum(1 for p in self.plugins if p.status == "禁用")
        error = sum(1 for p in self.plugins if p.status == "异常")
        missing = sum(1 for p in self.plugins if p.status == "无manifest")
        selected = len(self.tree.selection())

        self.summary_var.set(
            f"总计 {total} 个插件目录；当前显示 {visible} 个；已选 {selected} 个；"
            f"启用 {enabled}；禁用 {disabled}；异常 {error}；无manifest {missing}"
        )

    def select_all_visible(self) -> None:
        for item in self.tree.get_children():
            self.tree.selection_add(item)
        self.update_summary()

    def clear_selection(self) -> None:
        self.tree.selection_remove(self.tree.selection())
        self.update_summary()

    def invert_selection(self) -> None:
        current = set(self.tree.selection())
        for item in self.tree.get_children():
            if item in current:
                self.tree.selection_remove(item)
            else:
                self.tree.selection_add(item)
        self.update_summary()

    def get_selected_plugins(self) -> List[PluginInfo]:
        return [self.item_to_plugin[item] for item in self.tree.selection() if item in self.item_to_plugin]

    def enable_selected(self) -> None:
        selected = self.get_selected_plugins()
        if not selected:
            messagebox.showinfo("未选择插件", "请先选择要启用的插件。")
            return
        self._batch_toggle(selected, enable=True)

    def disable_selected(self) -> None:
        selected = self.get_selected_plugins()
        if not selected:
            messagebox.showinfo("未选择插件", "请先选择要禁用的插件。")
            return
        self._batch_toggle(selected, enable=False)

    def _batch_toggle(self, plugins: List[PluginInfo], enable: bool) -> None:
        action = "启用" if enable else "禁用"
        candidates = [
            plugin
            for plugin in plugins
            if (plugin.is_disabled if enable else plugin.is_enabled)
        ]

        skipped_state = len(plugins) - len(candidates)
        if not candidates:
            messagebox.showinfo(
                f"无需{action}",
                f"所选插件中没有可{action}的项目。\n"
                f"只有当前状态为{'禁用' if enable else '启用'}的插件会被{action}。",
            )
            return

        preview = "\n".join(f"- {plugin.folder_name} ({plugin.display_name})" for plugin in candidates[:20])
        more = "" if len(candidates) <= 20 else f"\n... 另有 {len(candidates) - 20} 个"
        confirmed = messagebox.askyesno(
            f"确认批量{action}",
            f"将{action} {len(candidates)} 个插件：\n{preview}{more}\n\n"
            f"跳过非目标状态插件 {skipped_state} 个。\n\n是否继续？",
        )
        if not confirmed:
            return

        success, failed = self._perform_toggle(candidates, enable=enable)
        self.scan_plugins()

        message = [f"批量{action}完成。", f"成功：{len(success)} 个", f"失败：{len(failed)} 个"]
        if success:
            message.append("\n成功列表：")
            message.extend(f"- {name}" for name in success[:30])
            if len(success) > 30:
                message.append(f"... 另有 {len(success) - 30} 个")
        if failed:
            message.append("\n失败列表：")
            message.extend(f"- {name}: {reason}" for name, reason in failed[:30])
            if len(failed) > 30:
                message.append(f"... 另有 {len(failed) - 30} 个")

        if failed:
            messagebox.showwarning(f"批量{action}完成但有失败", "\n".join(message))
        else:
            messagebox.showinfo(f"批量{action}完成", "\n".join(message))

    def _perform_toggle(self, plugins: List[PluginInfo], enable: bool) -> Tuple[List[str], List[Tuple[str, str]]]:
        success: List[str] = []
        failed: List[Tuple[str, str]] = []

        for plugin in plugins:
            source = plugin.disabled_manifest if enable else plugin.enabled_manifest
            target = plugin.enabled_manifest if enable else plugin.disabled_manifest

            try:
                if not source.exists():
                    failed.append((plugin.folder_name, f"源文件不存在：{source.name}"))
                    continue
                if target.exists():
                    failed.append((plugin.folder_name, f"目标文件已存在：{target.name}"))
                    continue
                source.rename(target)
                success.append(plugin.folder_name)
            except Exception as exc:
                failed.append((plugin.folder_name, str(exc)))

        return success, failed

    def sort_by_column(self, column: str, descending: bool) -> None:
        items = list(self.tree.get_children(""))
        col_index = self.tree["columns"].index(column)

        def key_func(item: str) -> str:
            values = self.tree.item(item, "values")
            if col_index < len(values):
                return str(values[col_index]).lower()
            return ""

        items.sort(key=key_func, reverse=descending)
        for index, item in enumerate(items):
            self.tree.move(item, "", index)
        self.tree.heading(column, command=lambda: self.sort_by_column(column, not descending))

    def report_exception(self, exc_type, exc_value, exc_traceback) -> None:
        messagebox.showerror("程序异常", f"{exc_type.__name__}: {exc_value}")


def main() -> int:
    app = PluginManagerGui()
    sys.excepthook = app.report_exception
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())