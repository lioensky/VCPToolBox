"""Compare multi-focus witness policies on current SQL facts; no embeddings or DB writes."""
import argparse
import json
import sqlite3
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Focus IDs in the historical mechanism probe, not new query observations.
# Huawei uses the actual hop-0 explicit sources in the generation-808 trace.
FOCI = {"huawei": {40770, 40783}, "lunarium": {41604, 40117, 40089}, "iran": set()}


def measure(db, source, target, focus):
    if source not in focus or len(focus) < 2:
        return "unchanged (outside multi-focus experiment)", None
    rows = db.execute("""SELECT DISTINCT f.id,f.checksum FROM file_tags s
        JOIN file_tags t ON t.file_id=s.file_id AND t.tag_id=?
        JOIN files f ON f.id=s.file_id WHERE s.tag_id=? ORDER BY f.id LIMIT 129""",
                      (target, source)).fetchall()
    if len(rows) > 128:
        return "unchanged (file limit)", None
    records = []
    for fid, checksum in rows:
        tags = {r[0] for r in db.execute(
            "SELECT DISTINCT tag_id FROM file_tags WHERE file_id=? ORDER BY tag_id LIMIT 129", (fid,))}
        if len(tags) > 128:
            return "unchanged (tag limit)", None
        records.append((fid, checksum, tags))
    relaxed = None
    for (a, ha, ta), (b, hb, tb) in combinations(records, 2):
        if not ha or not hb or ha == hb:
            continue
        bridges = (ta & tb) - focus - {source, target}
        if not bridges:
            continue
        pair = {"files": [a,b], "bridgeCount": len(bridges), "bridgeIds": sorted(bridges)}
        if (focus - {source,target}) & (ta | tb):
            return "both accept", pair
        if relaxed is None:
            relaxed = pair
    return ("newly admitted", relaxed) if relaxed else ("both reject", None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=ROOT/"VectorStore"/"knowledge_base.sqlite")
    parser.add_argument("--routes", type=Path, default=ROOT/"rust-vexus-lite"/"target"/"wormhole-gate-probe.json")
    args = parser.parse_args()
    cases = json.loads(args.routes.read_text(encoding="utf-8-sig"))["cases"]
    db = sqlite3.connect(args.db.resolve().as_uri()+"?mode=ro", uri=True)
    try:
        db.execute("BEGIN")
        print("current database generation:", db.execute(
            "SELECT value FROM kbm_runtime_meta WHERE key='database_generation'").fetchone()[0])
        for case in cases:
            key = case["key"]
            for route in case["routes"]:
                s, t = route["sourceId"], route["targetId"]
                result, witness = measure(db,s,t,FOCI[key])
                print(key, s, t, result, json.dumps(witness) if witness else "")
    finally:
        db.close()


if __name__ == "__main__":
    main()