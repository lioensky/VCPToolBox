"""Freeze one SQLite database. Output directory must be new and outside this worktree."""
import argparse
import hashlib
import json
import shutil
import sqlite3
import time
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def backup(source: Path, output: Path, timeout: float = 300) -> dict:
    source = source.resolve(strict=True)
    output = output.resolve()
    if not source.is_file() or output.is_relative_to(ROOT):
        raise ValueError("need a source file and a new directory outside this worktree")
    # Do not silently place private data in another checked-out repository either.
    if any((p / ".git").exists() for p in (output, *output.parents)):
        raise ValueError("output directory is inside a Git worktree")
    if source.name not in {"knowledge_base.sqlite", "folding_store.db"}:
        raise ValueError("expected knowledge_base.sqlite or folding_store.db")
    output.mkdir(mode=0o700, exist_ok=False)
    try:
        target = output / source.name
        deadline = time.monotonic() + timeout

        def check_timeout(status, remaining, total):
            if time.monotonic() >= deadline:
                raise TimeoutError("SQLite backup exceeded deadline")

        # mode=ro, NOT immutable=1: the latter would ignore live WAL transactions.
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as src:
            with closing(sqlite3.connect(target)) as dst:
                src.backup(dst, pages=256, progress=check_timeout, sleep=0.05)
                mode = dst.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
                if mode.lower() != "delete" or dst.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise ValueError("backup did not pass standalone database checks")
        if any(Path(str(target) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
            raise ValueError("unexpected sidecar after backup")
        with target.open("rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        manifest = {"format": "lain-sqlite-backup-v1", "file": source.name,
                    "bytes": target.stat().st_size, "sha256": digest}
        # A package without this completion marker must not be consumed.
        (output / "backup.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        return manifest
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(backup(args.source, args.output)))