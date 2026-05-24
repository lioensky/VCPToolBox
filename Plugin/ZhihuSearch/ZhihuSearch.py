#!/usr/bin/env python3
"""VCP Zhihu search plugin.

This plugin adapts the zhihu-search and global-search skill scripts. It uses
only the Python standard library and speaks the VCP stdio JSON contract.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "https://developer.zhihu.com"
DEFAULT_TIMEOUT_SECONDS = 5

try:
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except AttributeError:
    pass


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def fail(message: str, *, body: Any | None = None) -> NoReturn:
    payload: Dict[str, Any] = {
        "status": "error",
        "error": f"ZhihuSearch Error: {message}",
    }
    if body is not None:
        payload["result"] = {"body": body}
    emit(payload)
    raise SystemExit(0)


def read_stdin_payload() -> Dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff")
    if not raw or not raw.strip():
        fail("No input received from stdin.")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        fail("Invalid JSON payload.")

    if not isinstance(payload, dict):
        fail("Invalid JSON payload.")
    return payload


def parse_query(payload: Dict[str, Any]) -> str:
    raw_query = (
        payload.get("query")
        or payload.get("q")
        or payload.get("text")
        or payload.get("Query")
        or ""
    )
    if not isinstance(raw_query, str) or not raw_query.strip():
        fail("Missing required argument: query.")
    return raw_query.strip()


def parse_search_type(payload: Dict[str, Any]) -> str:
    raw_search_type = (
        payload.get("search_type")
        or payload.get("type")
        or payload.get("scope")
        or payload.get("command")
        or payload.get("SearchType")
        or "zhihu_search"
    )
    if not isinstance(raw_search_type, str):
        fail("search_type must be a string.")

    normalized = raw_search_type.strip().lower().replace("-", "_")
    aliases = {
        "zhihu": "zhihu_search",
        "site": "zhihu_search",
        "content": "zhihu_search",
        "zhihu_search": "zhihu_search",
        "global": "global_search",
        "global_search": "global_search",
        "all": "global_search",
    }
    search_type = aliases.get(normalized)
    if not search_type:
        fail("Invalid search_type. Use zhihu_search or global_search.")
    return search_type


def parse_count(payload: Dict[str, Any], search_type: str) -> int:
    raw_count = (
        payload.get("count")
        if payload.get("count") is not None
        else payload.get("max_results", payload.get("Count", 10))
    )
    try:
        count = int(raw_count)
    except (TypeError, ValueError):
        count = 10

    max_count = 20 if search_type == "global_search" else 10
    return max(1, min(max_count, count))


def get_timeout_seconds() -> int:
    raw_timeout = os.getenv("ZHIHU_SEARCH_TIMEOUT_SECONDS", "").strip()
    try:
        timeout = int(raw_timeout) if raw_timeout else DEFAULT_TIMEOUT_SECONDS
    except ValueError:
        timeout = DEFAULT_TIMEOUT_SECONDS
    return max(1, min(60, timeout))


def get_endpoint(search_type: str) -> str:
    env_name = (
        "ZHIHU_GLOBAL_SEARCH_URL"
        if search_type == "global_search"
        else "ZHIHU_ZHIHU_SEARCH_URL"
    )
    path = (
        "/api/v1/content/global_search"
        if search_type == "global_search"
        else "/api/v1/content/zhihu_search"
    )

    explicit = os.getenv(env_name, "").strip()
    if explicit:
        return explicit

    base_url = os.getenv("ZHIHU_OPENAPI_BASE_URL", DEFAULT_BASE_URL).strip()
    if not base_url:
        base_url = DEFAULT_BASE_URL
    return f"{base_url.rstrip('/')}{path}"


def request_zhihu(query: str, count: int, search_type: str) -> Dict[str, Any]:
    secret = os.getenv("ZHIHU_ACCESS_SECRET", "").strip()
    if not secret:
        fail("Set ZHIHU_ACCESS_SECRET first.")

    params = urlencode({"Query": query, "Count": str(count)})
    url = f"{get_endpoint(search_type)}?{params}"
    req = Request(
        url=url,
        method="GET",
        headers={
            "Authorization": f"Bearer {secret}",
            "X-Request-Timestamp": str(int(time.time())),
        },
    )

    try:
        with urlopen(req, timeout=get_timeout_seconds()) as response:
            body_text = response.read().decode("utf-8", errors="replace")
    except HTTPError as error:
        body_text = error.read().decode("utf-8", errors="replace")
        fail(f"HTTP {error.code}", body=body_text)
    except (TimeoutError, URLError) as error:
        print(f"[ZhihuSearch] HTTP request failed: {error}", file=sys.stderr)
        fail("HTTP request failed (timeout or network error).")

    try:
        api_response = json.loads(body_text)
    except json.JSONDecodeError:
        fail("Non-JSON response from API.", body=body_text[:1000])

    if not isinstance(api_response, dict):
        fail("Invalid JSON response from API.")
    return api_response


def normalize_zhihu_result(api_response: Dict[str, Any]) -> Dict[str, Any]:
    data = api_response.get("Data") if isinstance(api_response.get("Data"), dict) else {}
    items = data.get("Items") if isinstance(data.get("Items"), list) else []

    normalized_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        normalized_items.append(
            {
                "title": item.get("Title", ""),
                "url": item.get("Url", ""),
                "author_name": item.get("AuthorName", ""),
                "summary": item.get("ContentText", ""),
                "vote_up_count": item.get("VoteUpCount", 0),
                "comment_count": item.get("CommentCount", 0),
                "edit_time": item.get("EditTime", 0),
            }
        )

    result = {
        "search_type": "zhihu_search",
        "code": api_response.get("Code", -1),
        "api_message": api_response.get("Message", ""),
        "item_count": len(normalized_items),
        "items": normalized_items,
    }
    result["sources"] = build_sources(normalized_items)
    result["content"] = build_markdown_result(result)
    result["message"] = result["content"]
    return result


def normalize_global_result(api_response: Dict[str, Any]) -> Dict[str, Any]:
    data = api_response.get("Data") if isinstance(api_response.get("Data"), dict) else {}
    items = data.get("Items") if isinstance(data.get("Items"), list) else []

    normalized_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        normalized_items.append(
            {
                "title": item.get("Title", ""),
                "url": item.get("Url", ""),
                "author_name": item.get("AuthorName", ""),
                "summary": item.get("ContentText", ""),
                "edit_time": item.get("EditTime", 0),
            }
        )

    result = {
        "search_type": "global_search",
        "code": api_response.get("Code", -1),
        "api_message": api_response.get("Message", ""),
        "item_count": len(normalized_items),
        "items": normalized_items,
    }
    result["sources"] = build_sources(normalized_items)
    result["content"] = build_markdown_result(result)
    result["message"] = result["content"]
    return result


def normalize_result(api_response: Dict[str, Any], search_type: str) -> Dict[str, Any]:
    if search_type == "global_search":
        return normalize_global_result(api_response)
    return normalize_zhihu_result(api_response)


def build_sources(items: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    sources = []
    for index, item in enumerate(items, start=1):
        sources.append(
            {
                "rank": index,
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "snippet": item.get("summary", ""),
                "author_name": item.get("author_name", ""),
            }
        )
    return sources


def build_markdown_result(result: Dict[str, Any]) -> str:
    search_type = result.get("search_type", "zhihu_search")
    items = result.get("items", [])
    lines = [
        "## 知乎搜索结果" if search_type == "zhihu_search" else "## 知乎全局搜索结果",
        "",
        f"**状态**: {result.get('api_message', '')}",
        f"**结果数**: {result.get('item_count', 0)}",
        "",
    ]

    if not items:
        lines.append("未找到相关结果。")
        return "\n".join(lines)

    for index, item in enumerate(items, start=1):
        title = item.get("title", "") or "无标题"
        url = item.get("url", "")
        author = item.get("author_name", "")
        summary = item.get("summary", "")
        lines.append(f"### {index}. {title}")
        if url:
            lines.append(f"- **链接**: {url}")
        if author:
            lines.append(f"- **作者**: {author}")
        if "vote_up_count" in item:
            lines.append(
                f"- **点赞/评论**: {item.get('vote_up_count', 0)} / {item.get('comment_count', 0)}"
            )
        if item.get("edit_time"):
            lines.append(f"- **编辑时间**: {item.get('edit_time')}")
        if summary:
            lines.append(f"- **摘要**: {summary}")
        lines.append("")
    return "\n".join(lines).strip()


def main() -> None:
    try:
        payload = read_stdin_payload()
        search_type = parse_search_type(payload)
        query = parse_query(payload)
        count = parse_count(payload, search_type)
        api_response = request_zhihu(query, count, search_type)
        emit({"status": "success", "result": normalize_result(api_response, search_type)})
    except SystemExit:
        raise
    except Exception as error:
        print(f"[ZhihuSearch] Unhandled error: {error}", file=sys.stderr)
        fail(str(error))


if __name__ == "__main__":
    main()
