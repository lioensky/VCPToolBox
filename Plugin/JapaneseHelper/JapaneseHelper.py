#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from py_backend.compatibility_render import render_plugin_error
from py_backend.dispatcher import HybridDispatcher


def safe_read_input() -> Dict[str, Any]:
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception as exc:
        return {
            "_hybrid_entry_error": f"input_json_error: {exc}",
        }


def safe_write_output(raw_output: str) -> None:
    text = (raw_output or "").strip()
    if text:
        sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
    else:
        sys.stdout.buffer.write(render_plugin_error("hybrid_dispatcher_empty_output").encode("utf-8", errors="replace"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def main() -> None:
    args = safe_read_input()
    if args.get("_hybrid_entry_error"):
        safe_write_output(render_plugin_error(str(args["_hybrid_entry_error"])))
        return

    dispatcher = HybridDispatcher(PLUGIN_DIR)
    result = dispatcher.dispatch(args)
    safe_write_output(result)


if __name__ == "__main__":
    main()