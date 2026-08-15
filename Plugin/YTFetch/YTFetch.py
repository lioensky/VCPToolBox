#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv


PLUGIN_DIR = Path(__file__).parent
PROJECT_ROOT = PLUGIN_DIR.parent.parent

logging.getLogger("dotenv.main").setLevel(logging.CRITICAL)
load_dotenv(PROJECT_ROOT / "config.env", verbose=False)
load_dotenv(PLUGIN_DIR / "config.env", verbose=False)

API_BASE_URL = os.getenv("GEMINI_API_BASE_URL", "https://generativelanguage.googleapis.com").rstrip("/")
DEFAULT_MODEL = os.getenv("YTFETCH_MODEL", "gemini-2.5-flash-lite")
DEFAULT_FALLBACK_MODELS = [
    DEFAULT_MODEL,
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-flash",
    "gemini-flash-lite-latest",
]

DEFAULT_PROMPT = """Read this YouTube video deeply. Use Simplified Chinese only.
Do not use English headings unless they are proper nouns from the video.
Include:
1. The core topic
2. Main visible scenes and people/objects
3. Main audible content, dialogue, narration, or music
4. Key timeline or steps
5. The most useful facts for an Agent to reuse later
"""


class YTFetchError(Exception):
    def __init__(self, message: str, code: str = "YTFETCH_ERROR", status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    sys.stdout.flush()
    raise SystemExit(exit_code)


MODEL_ALIASES = {
    "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
}


def get_api_keys() -> list[str]:
    values: list[str] = []
    multi_key = os.getenv("GEMINI_API_KEYS") or os.getenv("YTFETCH_API_KEYS") or ""
    if multi_key.strip():
        values.extend(re.split(r"[,;\n]+", multi_key))
    values.extend(
        [
            os.getenv("GEMINI_API_KEY"),
            os.getenv("AI_STUDIO_API_KEY"),
            os.getenv("GOOGLE_API_KEY"),
            os.getenv("GeminiImageKey"),
        ]
    )
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        key = (value or "").strip()
        if key and key not in seen:
            seen.add(key)
            result.append(key)
    if not result:
        raise YTFetchError("Missing GEMINI_API_KEY / AI_STUDIO_API_KEY / GOOGLE_API_KEY", "NO_API_KEY")
    return result


def normalize_model(model: str | None) -> str:
    value = (model or DEFAULT_MODEL).strip()
    value = value.removeprefix("models/")
    return MODEL_ALIASES.get(value, value)


def is_youtube_url(url: str) -> bool:
    return bool(re.match(r"^https?://(www\.)?(youtube\.com/watch\?v=|youtu\.be/)", url.strip(), re.I))


def canonicalize_youtube_url(url: str) -> str:
    text = url.strip()
    watch = re.search(r"[?&]v=([A-Za-z0-9_-]+)", text)
    if watch:
        return f"https://www.youtube.com/watch?v={watch.group(1)}"
    short = re.search(r"youtu\.be/([A-Za-z0-9_-]+)", text, re.I)
    if short:
        return f"https://www.youtube.com/watch?v={short.group(1)}"
    return text


def parse_int(value: Any, default: int) -> int:
    try:
        if value in (None, ""):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_float(value: Any, default: float) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "y"}


def handle_response(resp: requests.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError as exc:
        raise YTFetchError(f"Gemini API returned non-JSON response: {resp.text[:500]}", "BAD_RESPONSE", resp.status_code) from exc
    if resp.status_code >= 400:
        error = data.get("error", {})
        message = error.get("message") or resp.text[:1000]
        raise YTFetchError(message, error.get("status", "HTTP_ERROR"), resp.status_code)
    return data


def list_models(api_key: str) -> list[dict[str, Any]]:
    resp = requests.get(f"{API_BASE_URL}/v1beta/models", params={"key": api_key}, timeout=30)
    data = handle_response(resp)
    models = []
    for item in data.get("models", []):
        methods = item.get("supportedGenerationMethods", [])
        name = item.get("name", "")
        display_name = item.get("displayName", "")
        if "generateContent" not in methods:
            continue
        if "pro" in name.lower() or "pro" in display_name.lower():
            continue
        models.append(
            {
                "name": name,
                "displayName": display_name,
                "inputTokenLimit": item.get("inputTokenLimit"),
                "outputTokenLimit": item.get("outputTokenLimit"),
                "thinking": item.get("thinking", False),
            }
        )
    return models


def extract_text(data: dict[str, Any]) -> str:
    texts: list[str] = []
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if "text" in part:
                texts.append(part["text"])
    return "\n".join(t.strip() for t in texts if t and t.strip()).strip()


def usage_summary(data: dict[str, Any]) -> dict[str, Any]:
    usage = data.get("usageMetadata", {})
    return {
        "promptTokenCount": usage.get("promptTokenCount"),
        "candidatesTokenCount": usage.get("candidatesTokenCount"),
        "thoughtsTokenCount": usage.get("thoughtsTokenCount"),
        "totalTokenCount": usage.get("totalTokenCount"),
        "promptTokensDetails": usage.get("promptTokensDetails"),
    }


def build_payload(req: dict[str, Any], url: str) -> dict[str, Any]:
    prompt = req.get("prompt") or req.get("question") or DEFAULT_PROMPT
    max_tokens = parse_int(req.get("maxOutputTokens") or req.get("max_tokens"), 40000)
    temperature = parse_float(req.get("temperature"), 0.2)
    mime_type = req.get("mime_type") or req.get("mimeType") or "video/mp4"

    generation_config: dict[str, Any] = {
        "temperature": temperature,
        "maxOutputTokens": max_tokens,
    }

    thinking_budget = req.get("thinkingBudget")
    if thinking_budget is None:
        thinking_budget = req.get("thinking_budget")
    if thinking_budget is not None:
        generation_config["thinkingConfig"] = {"thinkingBudget": parse_int(thinking_budget, 0)}

    return {
        "systemInstruction": {
            "parts": [
                {
                    "text": "You are a YouTube video analysis tool. Unless the user explicitly requests another language, answer only in Simplified Chinese. Do not use English section headings."
                }
            ]
        },
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": str(prompt)},
                    {"file_data": {"file_uri": url, "mime_type": str(mime_type)}},
                ],
            }
        ],
        "generationConfig": generation_config,
    }


def generate_once(api_key: str, model: str, payload: dict[str, Any], timeout_sec: int) -> dict[str, Any]:
    endpoint = f"{API_BASE_URL}/v1beta/models/{normalize_model(model)}:generateContent"
    resp = requests.post(
        endpoint,
        params={"key": api_key},
        headers={"Content-Type": "application/json; charset=utf-8"},
        json=payload,
        timeout=timeout_sec,
    )
    return handle_response(resp)


def model_candidates(req: dict[str, Any]) -> list[str]:
    raw = req.get("models") or req.get("fallbackModels") or req.get("fallback_models")
    if isinstance(raw, list):
        values = raw
    elif isinstance(raw, str) and raw.strip():
        values = [x.strip() for x in raw.split(",")]
    else:
        values = DEFAULT_FALLBACK_MODELS

    primary = req.get("model")
    if primary:
        values = [str(primary), *values]

    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        model = normalize_model(str(value))
        if not model or "pro" in model.lower() or model in seen:
            continue
        seen.add(model)
        result.append(model)
    return result or [DEFAULT_MODEL]


def fetch_youtube(req: dict[str, Any]) -> dict[str, Any]:
    api_keys = get_api_keys()
    url = str(req.get("url") or req.get("URL") or req.get("link") or "").strip()
    if not url:
        raise YTFetchError("Missing required parameter: url", "MISSING_URL")
    if not is_youtube_url(url):
        raise YTFetchError(f"Unsupported YouTube URL: {url}", "BAD_URL")

    original_url = url
    url = canonicalize_youtube_url(url)
    payload = build_payload(req, url)
    timeout_sec = parse_int(req.get("timeoutSec") or req.get("timeout_sec"), 240)
    retries = parse_int(req.get("retries"), 1)
    errors: list[dict[str, Any]] = []

    for key_index, api_key in enumerate(api_keys):
        for model in model_candidates(req):
            for attempt in range(retries + 1):
                started = time.time()
                try:
                    data = generate_once(api_key, model, payload, timeout_sec)
                    text = extract_text(data)
                    if not text:
                        finish = data.get("candidates", [{}])[0].get("finishReason")
                        raise YTFetchError(f"Gemini returned empty text. finishReason={finish}", "EMPTY_TEXT")
                    return {
                        "model": normalize_model(model),
                        "keyIndex": key_index,
                        "url": original_url,
                        "canonicalUrl": url,
                        "durationMs": int((time.time() - started) * 1000),
                        "text": text,
                        "attemptedErrors": errors,
                        "usage": usage_summary(data),
                        "finishReason": data.get("candidates", [{}])[0].get("finishReason"),
                        "responseId": data.get("responseId"),
                        "modelVersion": data.get("modelVersion"),
                    }
                except YTFetchError as exc:
                    errors.append(
                        {
                            "keyIndex": key_index,
                            "model": normalize_model(model),
                            "attempt": attempt + 1,
                            "code": exc.code,
                            "statusCode": exc.status_code,
                            "message": str(exc)[:1200],
                        }
                    )
                    retryable = exc.status_code in {429, 500, 502, 503, 504}
                    if exc.status_code in {400, 404} or not retryable:
                        break
                    if attempt < retries:
                        time.sleep(min(2 + attempt * 2, 8))
                    else:
                        break

    raise YTFetchError("All Gemini model attempts failed: " + json.dumps(errors, ensure_ascii=False), "ALL_MODELS_FAILED")


def format_markdown(result: dict[str, Any]) -> str:
    usage = result.get("usage") or {}
    lines = [
        "## YouTube Fetch Result",
        "",
        f"- URL: {result.get('url')}",
        f"- Model: {result.get('modelVersion') or result.get('model')}",
        f"- Finish: {result.get('finishReason')}",
        f"- Tokens: prompt={usage.get('promptTokenCount')}, output={usage.get('candidatesTokenCount')}, thoughts={usage.get('thoughtsTokenCount')}, total={usage.get('totalTokenCount')}",
        "",
        result.get("text", ""),
    ]
    return "\n".join(lines).strip()


def main() -> None:
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            raise YTFetchError("Empty stdin", "NO_INPUT")
        req = json.loads(raw)
        command = str(req.get("command") or req.get("cmd") or "fetch").strip().lower()

        if command in {"models", "list_models", "list-models"}:
            models = list_models(get_api_keys()[0])
            emit({"status": "success", "result": {"models": models}})

        result = fetch_youtube(req)
        output = result if parse_bool(req.get("raw"), False) else format_markdown(result)
        emit({"status": "success", "result": output, "data": result})
    except json.JSONDecodeError as exc:
        emit({"status": "error", "code": "BAD_JSON", "error": str(exc)}, 1)
    except YTFetchError as exc:
        emit({"status": "error", "code": exc.code, "statusCode": exc.status_code, "error": str(exc)}, 1)
    except Exception as exc:
        emit({"status": "error", "code": "FATAL", "error": str(exc)}, 1)


if __name__ == "__main__":
    main()
