from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

from .http import JsonHttpClient, TextHttpClient, UrllibJsonClient


class SnapshotMissError(LookupError):
    pass


def _normalize_value(value: object) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Mapping):
        return {
            str(key): _normalize_value(inner_value)
            for key, inner_value in sorted(value.items(), key=lambda item: str(item[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_normalize_value(item) for item in value]
    return str(value)


def _normalize_params(params: Mapping[str, object] | None) -> dict[str, Any]:
    if not params:
        return {}
    return {
        str(key): _normalize_value(value)
        for key, value in sorted(params.items(), key=lambda item: str(item[0]))
    }


def _request_key(kind: str, url: str, params: Mapping[str, object] | None) -> str:
    normalized = {
        "kind": kind,
        "url": url,
        "params": _normalize_params(params),
    }
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"))


def _snapshot_filename(kind: str, url: str, params: Mapping[str, object] | None) -> str:
    parsed = urlparse(url)
    tail = Path(parsed.path).name or "root"
    safe_tail = "".join(character if character.isalnum() else "_" for character in tail).strip("_") or "root"
    digest = hashlib.sha1(_request_key(kind, url, params).encode("utf-8")).hexdigest()[:12]
    return f"{kind}__{safe_tail}__{digest}.json"


@dataclass(frozen=True)
class SnapshotEnvelope:
    kind: str
    request: dict[str, Any]
    response: Any
    captured_at: str

    def to_json(self) -> str:
        return json.dumps(
            {
                "kind": self.kind,
                "request": self.request,
                "response": self.response,
                "captured_at": self.captured_at,
            },
            ensure_ascii=True,
            indent=2,
            sort_keys=True,
        )


class RecordingHttpClient:
    def __init__(
        self,
        snapshot_dir: str | Path,
        *,
        json_client: JsonHttpClient | None = None,
        text_client: TextHttpClient | None = None,
    ):
        default_client = UrllibJsonClient()
        self.snapshot_dir = Path(snapshot_dir)
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)
        self.json_client = json_client or default_client
        self.text_client = text_client or default_client

    def get_json(self, url: str, *, params: Mapping[str, object] | None = None) -> Any:
        payload = self.json_client.get_json(url, params=params)
        self._write_snapshot(kind="json", url=url, params=params, response=payload)
        return payload

    def get_text(self, url: str, *, params: Mapping[str, object] | None = None) -> str:
        payload = self.text_client.get_text(url, params=params)
        self._write_snapshot(kind="text", url=url, params=params, response=payload)
        return payload

    def _write_snapshot(
        self,
        *,
        kind: str,
        url: str,
        params: Mapping[str, object] | None,
        response: Any,
    ) -> None:
        envelope = SnapshotEnvelope(
            kind=kind,
            request={
                "url": url,
                "params": _normalize_params(params),
            },
            response=response,
            captured_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        )
        path = self.snapshot_dir / _snapshot_filename(kind, url, params)
        path.write_text(envelope.to_json())


class ReplayHttpClient:
    def __init__(self, snapshot_dir: str | Path):
        self.snapshot_dir = Path(snapshot_dir)
        self.snapshots: dict[str, Any] = {}
        self._load_snapshots()

    def get_json(self, url: str, *, params: Mapping[str, object] | None = None) -> Any:
        key = _request_key("json", url, params)
        if key not in self.snapshots:
            raise SnapshotMissError(f"missing json snapshot for {url} {dict(_normalize_params(params))}")
        return self.snapshots[key]

    def get_text(self, url: str, *, params: Mapping[str, object] | None = None) -> str:
        key = _request_key("text", url, params)
        if key not in self.snapshots:
            raise SnapshotMissError(f"missing text snapshot for {url} {dict(_normalize_params(params))}")
        response = self.snapshots[key]
        if not isinstance(response, str):
            raise SnapshotMissError(f"snapshot for {url} is not a text payload")
        return response

    def _load_snapshots(self) -> None:
        if not self.snapshot_dir.exists():
            return
        for path in sorted(self.snapshot_dir.rglob("*.json")):
            try:
                payload = json.loads(path.read_text())
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, Mapping):
                continue
            kind = payload.get("kind")
            request = payload.get("request")
            if not isinstance(kind, str) or not isinstance(request, Mapping):
                continue
            url = request.get("url")
            params = request.get("params")
            if not isinstance(url, str):
                continue
            if params is not None and not isinstance(params, Mapping):
                continue
            key = _request_key(kind, url, params if isinstance(params, Mapping) else None)
            self.snapshots[key] = payload.get("response")
