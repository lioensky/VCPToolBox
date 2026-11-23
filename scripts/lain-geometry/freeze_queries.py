"""Export chronological query candidates from a sealed FoldingStore backup."""
import argparse
import hashlib
import json
import math
import re
import shutil
import sqlite3
import struct
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path

HEX = re.compile(r"[a-f0-9]{64}")
D = 3072


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def export(backup, output, cutoff, expected_sha, model_basis):
    stamp = datetime.fromisoformat(cutoff)
    if stamp.utcoffset() is None or stamp.microsecond % 1000:
        raise ValueError("cutoff requires timezone and exact millisecond precision")
    delta = stamp.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    cut = (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000
    dbfile = backup.resolve(strict=True) / "folding_store.db"
    receipt = json.loads(dbfile.with_name("backup.json").read_bytes())
    if (receipt.get("format") != "lain-sqlite-backup-v1" or receipt.get("file") != dbfile.name
            or receipt.get("sha256") != expected_sha or receipt.get("bytes") != dbfile.stat().st_size
            or digest(dbfile) != expected_sha or not model_basis.strip()
            or any(Path(str(dbfile) + s).exists() for s in ("-wal", "-shm", "-journal"))):
        raise ValueError("invalid sealed backup or missing model evidence statement")
    out = output.resolve()
    if any((p / ".git").exists() for p in (out, *out.parents)):
        raise ValueError("output inside Git worktree")
    out.mkdir(mode=0o700, exist_ok=False)
    try:
        counts = {s: {"rows": 0, "knownInput": 0} for s in ("dev", "eval")}
        seen_content, seen_input, seen_vector = set(), set(), set()
        with ExitStack() as stack:
            db = sqlite3.connect(dbfile.as_uri() + "?mode=ro&immutable=1", uri=True)
            stack.callback(db.close)
            streams = {}
            for s in counts:
                streams[s] = tuple(stack.enter_context((out / f"{s}.{ext}").open("xb"))
                                   for ext in ("jsonl", "f32le"))
            rows = db.execute("""SELECT created_at,content_hash,vector_input_hash,vector
                                 FROM folding_entries ORDER BY created_at,content_hash""")
            for created, content, inp, blob in rows:
                if (not isinstance(created, int) or not isinstance(content, str) or not HEX.fullmatch(content)
                        or inp is not None and (not isinstance(inp, str) or not HEX.fullmatch(inp))
                        or not isinstance(blob, bytes) or len(blob) != D * 4
                        or not all(math.isfinite(x) for x, in struct.iter_unpack("<f", blob))):
                    raise ValueError("invalid probe metadata or raw values")
                h = hashlib.sha256(blob).hexdigest()
                if content in seen_content or inp is not None and inp in seen_input or h in seen_vector:
                    raise ValueError("duplicate probe; resolve duplicate group before splitting")
                seen_content.add(content)
                if inp is not None:
                    seen_input.add(inp)
                seen_vector.add(h)
                s = "dev" if created < cut else "eval"
                stat = counts[s]
                record = {"slot": stat["rows"], "createdAtMs": created, "contentHash": content,
                          "vectorInputHash": inp, "vectorSha256": h}
                streams[s][0].write((json.dumps(record, separators=(",", ":")) + "\n").encode())
                streams[s][1].write(blob)
                stat["rows"] += 1
                stat["knownInput"] += int(inp is not None)
        if not all(v["rows"] for v in counts.values()) or digest(dbfile) != expected_sha:
            raise ValueError("empty partition or changed backup")
        manifest = {"format": "lain-query-candidates-v1", "source": "folding_entries.vector",
                    "databaseSha256": expected_sha, "modelBasis": model_basis,
                    "outOfCorpusStatus": "not certified by this exporter",
                    "cutoff": cutoff, "timeKey": "created_at (first entry, not embedding generation)",
                    "devPredicate": "created_at < cutoff", "dimension": D, "dtype": "f32le",
                    "sort": ["created_at", "content_hash"], "counts": counts,
                    "files": {p.name: {"sha256": digest(p), "bytes": p.stat().st_size}
                              for p in sorted(out.iterdir())}}
        (out / "queries.tmp").write_bytes((json.dumps(manifest, indent=2) + "\n").encode())
        (out / "queries.tmp").rename(out / "queries.json")
        return counts
    except BaseException:
        shutil.rmtree(out)
        raise


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("backup", type=Path)
    p.add_argument("output", type=Path)
    for flag in ("cutoff", "expected-sha", "model-basis"):
        p.add_argument("--" + flag, required=True)
    print(json.dumps(export(**vars(p.parse_args()))))