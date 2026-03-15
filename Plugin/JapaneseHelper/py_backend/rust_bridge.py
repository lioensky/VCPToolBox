from __future__ import annotations

import json
import os
import platform
import subprocess
from typing import Any, Dict, Optional


class RustCoreBridge:
    def __init__(self, plugin_dir: str):
        self.plugin_dir = plugin_dir

    def _candidate_paths(self) -> list[str]:
        names = []
        system = platform.system().lower()
        if "windows" in system:
            names.append(os.path.join(self.plugin_dir, "bin", "jh_core-win-x64.exe"))
        else:
            names.append(os.path.join(self.plugin_dir, "bin", "jh_core-linux-x64"))
        names.append(os.path.join(self.plugin_dir, "bin", "jh_core"))
        return names

    def _pick_binary(self) -> Optional[str]:
        for path in self._candidate_paths():
            if os.path.isfile(path):
                return path
        return None

    def is_available(self) -> bool:
        return self._pick_binary() is not None

    def call(self, args: Dict[str, Any]) -> Optional[str]:
        binary = self._pick_binary()
        if not binary:
            return None

        env = os.environ.copy()
        env.setdefault("JH_PLUGIN_DIR", self.plugin_dir)

        proc = subprocess.run(
            [binary],
            input=json.dumps(args, ensure_ascii=False),
            text=True,
            capture_output=True,
            cwd=self.plugin_dir,
            env=env,
        )

        if proc.returncode != 0:
            return None

        stdout = (proc.stdout or "").strip()
        return stdout or None