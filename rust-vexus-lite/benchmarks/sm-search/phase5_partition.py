"""Read-only file-disjoint query selection; never inspect vectors or query results."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def readonly(path):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def choose(rows, excluded, count, seed):
    groups = {}
    for file_id, chunk_id, diary in rows:
        if file_id not in excluded:
            groups.setdefault(diary, []).append((file_id, chunk_id))
    order = lambda text: hashlib.sha256(text.encode()).digest()
    for diary, items in groups.items():
        items.sort(key=lambda item: (order(f"{seed}:{item[0]}"), item[0]))
    diaries = sorted(groups, key=lambda diary: (order(f"{seed}:diary:{diary}"), diary))
    selected = []
    offset = 0
    while len(selected) < count:
        progressed = False
        for diary in diaries:
            if offset < len(groups[diary]):
                file_id, chunk_id = groups[diary][offset]
                selected.append(dict(file_id=file_id, chunk_id=chunk_id))
                progressed = True
                if len(selected) == count:
                    break
        if not progressed:
            raise ValueError("insufficient fresh files")
        offset += 1
    return selected


def partition(source, history, output, count=32):
    source, history, output = map(Path, (source, history, output))
    source_digest = file_hash(source)
    with closing(readonly(source)) as connection:
        connection.execute("BEGIN")
        rows = connection.execute(
            "SELECT c.file_id,MIN(c.id),f.diary_name FROM chunks c "
            "JOIN files f ON f.id=c.file_id WHERE length(c.vector)=12288 "
            "GROUP BY c.file_id,f.diary_name ORDER BY c.file_id"
        ).fetchall()
        old_queries = set()
        evidence = []
        for path in sorted(history.glob("*tags*.sqlite")):
            with closing(readonly(path)) as old:
                if not old.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='queries'"
                ).fetchone():
                    continue
                old_queries.update(row[0] for row in old.execute(
                    "SELECT source_chunk_id FROM queries"))
                evidence.append(dict(name=path.name, sha256=file_hash(path)))
        if not evidence:
            raise ValueError("no historical query manifests")
        excluded = set()
        for chunk_id in sorted(old_queries):
            row = connection.execute(
                "SELECT file_id FROM chunks WHERE id=?", (chunk_id,)).fetchone()
            if row is None:
                raise ValueError("historical query cannot be mapped to source file")
            excluded.add(row[0])
    if file_hash(source) != source_digest:
        raise ValueError("source changed during partition")
    development = choose(rows, excluded, count, 20261119)
    development_files = {row["file_id"] for row in development}
    validation = choose(rows, excluded | development_files, count, 20261120)
    validation_files = {row["file_id"] for row in validation}
    assert not validation_files & (excluded | development_files)
    report = dict(
        schema="phase5-file-partition-v1", source_sha256=source_digest,
        historical_queries=len(old_queries), historical_files=sorted(excluded),
        history=evidence, development=development, file_holdout_v1=validation,
        seeds=[20261119, 20261120],
        scope="query-file-disjoint; indexed knowledge retains all source files",
    )
    with output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
    return dict(historical_files=len(excluded), development=len(development),
                file_holdout_v1=len(validation))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--history", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(partition(args.source, args.history, args.output)))