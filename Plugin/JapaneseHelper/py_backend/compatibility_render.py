from __future__ import annotations

import json
from typing import Any, Dict


def render_rust_success(payload: Dict[str, Any]) -> str:
    envelope: Dict[str, Any] = {
        "status": "success",
        "result": payload.get("data"),
    }
    meta = payload.get("meta")
    if isinstance(meta, dict):
        envelope["meta"] = meta
    return json.dumps(envelope, ensure_ascii=False)


def render_plugin_error(message: str, backend: str = "python-hybrid-entry") -> str:
    return json.dumps(
        {
            "status": "error",
            "error": message,
            "meta": {"backend": backend},
        },
        ensure_ascii=False,
    )