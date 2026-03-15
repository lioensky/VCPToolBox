from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any, Dict


class LegacyBridge:
    def __init__(self, plugin_dir: str):
        self.plugin_dir = plugin_dir
        self.entry_path = os.path.join(plugin_dir, "JapaneseHelper_legacy.py")

    def is_available(self) -> bool:
        return os.path.isfile(self.entry_path)

    def call(self, args: Dict[str, Any]) -> str:
        if not self.is_available():
            payload = {
                "ok": False,
                "error": f"legacy_entry_missing: {self.entry_path}",
                "meta": {"backend": "python-legacy-bridge"},
            }
            return json.dumps(payload, ensure_ascii=False)

        env = os.environ.copy()
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")

        proc = subprocess.run(
            [sys.executable, self.entry_path],
            input=json.dumps(args, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            cwd=self.plugin_dir,
            env=env,
        )

        if proc.returncode != 0:
            payload = {
                "ok": False,
                "error": f"legacy_bridge_failed: {(proc.stderr or '').strip() or 'unknown error'}",
                "meta": {"backend": "python-legacy-bridge"},
            }
            return json.dumps(payload, ensure_ascii=False)

        stdout = (proc.stdout or "").strip()
        if not stdout:
            payload = {
                "ok": False,
                "error": f"legacy_bridge_empty_stdout: {(proc.stderr or '').strip() or 'no stderr'}",
                "meta": {"backend": "python-legacy-bridge"},
            }
            return json.dumps(payload, ensure_ascii=False)

        return stdout