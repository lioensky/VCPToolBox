from __future__ import annotations
import json
import os
from typing import Any, Dict, Optional, Set

from .compatibility_render import render_rust_success
from .legacy_bridge import LegacyBridge
from .rust_bridge import RustCoreBridge

RUST_FIRST_COMMANDS: Set[str] = {
    "lookup_word_json",
    "lookup_word_json_online",
    "online_lookup",
    "lookup_struct",
    "lookup",
    "kanji_info",
    "jlpt_check",
    "wrongbook_add",
    "wrongbook_list",
    "wrongbook_stats",
    "review_due_list",
    "review_submit",
    "review_stats",
    "study_session_submit",
    "progress_report",
    "online_status",
    "resource_status",
    "health_check",
}

def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, str(default))
    return raw.strip().lower() in {"1", "true", "yes", "on"}

class HybridDispatcher:
    def __init__(self, plugin_dir: str):
        self.plugin_dir = plugin_dir
        self.rust = RustCoreBridge(plugin_dir)
        self.legacy = LegacyBridge(plugin_dir)

    def should_prefer_rust(self, command: str) -> bool:
        return _env_bool("JH_RUST_CORE_ENABLED", False) and command.lower() in RUST_FIRST_COMMANDS

    def _parse_rust_result(self, raw: str) -> Optional[Dict[str, Any]]:
        try:
            obj = json.loads(raw)
        except Exception:
            return None
        return obj if isinstance(obj, dict) else None

    def dispatch(self, args: Dict[str, Any]) -> str:
        command = str(args.get("command", "") or "").strip().lower()
        if self.should_prefer_rust(command):
            rust_result = self.rust.call(args)
            rust_payload = self._parse_rust_result(rust_result) if rust_result else None
            if rust_payload and bool(rust_payload.get("ok")):
                return render_rust_success(rust_payload)
        return self.legacy.call(args)