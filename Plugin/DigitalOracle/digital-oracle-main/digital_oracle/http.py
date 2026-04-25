from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class HttpClientError(RuntimeError):
    pass


class JsonHttpClient(Protocol):
    def get_json(self, url: str, *, params: Mapping[str, object] | None = None) -> Any: ...


class TextHttpClient(Protocol):
    def get_text(self, url: str, *, params: Mapping[str, object] | None = None) -> str: ...


def _serialize_query_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _build_url(url: str, params: Mapping[str, object] | None) -> str:
    if not params:
        return url
    query_items = [
        (key, _serialize_query_value(value))
        for key, value in params.items()
        if value is not None
    ]
    if not query_items:
        return url
    return f"{url}?{urlencode(query_items)}"


@dataclass
class UrllibJsonClient:
    timeout_seconds: float = 20.0
    retry_attempts: int = 3
    retry_delay_seconds: float = 1.0
    headers: Mapping[str, str] = field(
        default_factory=lambda: {
            "Accept": "application/json,text/csv,text/plain,application/xml",
            "User-Agent": "digital-oracle/0.1",
        }
    )

    def get_json(self, url: str, *, params: Mapping[str, object] | None = None) -> Any:
        request_url = self._build_request(url, params)
        try:
            with self._open(request_url) as response:
                return json.load(response)
        except HTTPError as exc:
            raise HttpClientError(f"request failed: {request_url.full_url}") from exc
        except json.JSONDecodeError as exc:
            raise HttpClientError(f"invalid json payload: {request_url.full_url}") from exc

    def get_text(self, url: str, *, params: Mapping[str, object] | None = None) -> str:
        request_url = self._build_request(url, params)
        try:
            with self._open(request_url) as response:
                return response.read().decode("utf-8")
        except HTTPError as exc:
            raise HttpClientError(f"request failed: {request_url.full_url}") from exc

    def _build_request(self, url: str, params: Mapping[str, object] | None) -> Request:
        request_url = _build_url(url, params)
        return Request(request_url, headers=dict(self.headers))

    def _open(self, request: Request):
        last_error: Exception | None = None
        for attempt in range(1, self.retry_attempts + 1):
            try:
                return urlopen(request, timeout=self.timeout_seconds)
            except HTTPError:
                raise
            except (URLError, TimeoutError) as exc:
                last_error = exc
                if attempt >= self.retry_attempts:
                    break
                time.sleep(self.retry_delay_seconds)
        raise HttpClientError(f"request failed: {request.full_url}") from last_error
