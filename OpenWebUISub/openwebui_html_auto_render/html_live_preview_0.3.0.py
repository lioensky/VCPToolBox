"""
title: HTML Live Preview
author: B3000Kcn & DBL1F7E5
version: 0.3.0
description: 从模型回复中提取 HTML 代码块，通过 HTMLResponse 在 iframe 中渲染。支持多代码块合并渲染（用 section data-vcp-block 分隔）。
required_open_webui_version: 0.8.0
"""

import re
from pydantic import BaseModel
from typing import Optional, Callable, Any
from fastapi.responses import HTMLResponse


class Action:
    class Valves(BaseModel):
        pass

    def __init__(self):
        self.valves = self.Valves()

    async def action(
        self,
        body: dict,
        __user__=None,
        __event_emitter__: Callable[[dict], Any] = None,
        __event_call__=None,
    ) -> Optional[dict]:
        if __event_emitter__:
            await __event_emitter__(
                {
                    "type": "status",
                    "data": {"description": "正在提取 HTML...", "done": False},
                }
            )
        # 获取最新 assistant 消息
        messages = body.get("messages", [])
        last_assistant_msg = ""
        for msg in reversed(messages):
            if msg.get("role") == "assistant":
                last_assistant_msg = msg.get("content", "")
                break
        if not last_assistant_msg:
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {"description": "❌ 未找到模型回复", "done": True},
                    }
                )
            return None
        # 提取 HTML 代码块
        pattern = r"```(?:html|HTML)\s*\n([\s\S]*?)```"
        matches = re.findall(pattern, last_assistant_msg)
        if not matches:
            pattern_fb = r"```\w*\s*\n([\s\S]*?<!DOCTYPE[\s\S]*?)```|```\w*\s*\n([\s\S]*?<html[\s\S]*?)```"
            matches_fb = re.findall(pattern_fb, last_assistant_msg, re.IGNORECASE)
            if matches_fb:
                matches = [m[0] or m[1] for m in matches_fb]
        if not matches:
            if (
                "<html" in last_assistant_msg.lower()
                or "<!doctype" in last_assistant_msg.lower()
            ):
                matches = [last_assistant_msg]
        if not matches:
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {"description": "❌ 未找到 HTML 代码块", "done": True},
                    }
                )
            return None

        # v0.3.0: 用 section data-vcp-block 包裹每个代码块
        sections = []
        for i, block in enumerate(matches):
            block = block.strip()
            # 对不完整的 HTML 片段包裹基础样式容器
            if "<html" not in block.lower():
                block = (
                    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;'
                    'padding:16px;margin:0;">'
                    f"\n{block}\n"
                    "</div>"
                )
            sections.append(f'<section data-vcp-block="{i}">\n{block}\n</section>')

        html_content = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {{ margin:0; padding:0; }}
        section[data-vcp-block] {{ margin:0; padding:0; }}
    </style>
</head>
<body>
{"".join(sections)}
</body>
</html>"""

        if __event_emitter__:
            await __event_emitter__(
                {"type": "status", "data": {"description": "✅ 渲染中", "done": True}}
            )
        return HTMLResponse(
            content=html_content, headers={"Content-Disposition": "inline"}
        )