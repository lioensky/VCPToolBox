"""Usage: python rivermemo_v6_shadow_replay.py frozen.sqlite trace.txt new-report.json"""
import gzip
import json
import re
import sqlite3
import sys
from functools import lru_cache
from pathlib import Path
import numpy as np
from rivermemo_v6_shadow_readout import arms, corroborated

SIG = "51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3"


def main(db, trace, output):
    if output.exists():
        raise FileExistsError(output)
    lines = trace.read_text(encoding="utf-8-sig").splitlines()
    starts = [i for i, s in enumerate(lines) if s.startswith("parsedConfig\t")]
    assert len(starts) == 2
    report = {"artifact": SIG, "query": "华为汽车的幽默操作", "tracks": {}}
    with sqlite3.connect(db.resolve().as_uri()+"?mode=ro&immutable=1", uri=True) as c:
        tr = json.loads(gzip.decompress(c.execute(
            "SELECT payload FROM rivermemo_artifacts WHERE artifact_sig=?", (SIG,)
        ).fetchone()[0]))["sharedTransport"]
        ids, off = tr["nodeIds"], tr["rowOffsets"]
        indices = {v: i for i, v in enumerate(ids)}

        def unit(blob):
            a = np.frombuffer(blob, dtype="<f4").astype(np.float64)
            assert a.size == 3072 and np.isfinite(a).all() and np.linalg.norm(a) > 0
            return a / np.linalg.norm(a)

        @lru_cache(None)
        def tagvec(t):
            return unit(c.execute("SELECT vector FROM tags WHERE id=?", (t,)).fetchone()[0])

        for name, lo, hi in zip(("tdb", "warped"), starts, starts[1:]+[len(lines)]):
            block = lines[lo:hi]
            cfg = json.loads(block[0].split("\t", 1)[1])
            cal = json.loads(next(x.split("\t", 1)[1] for x in block if x.startswith("queryCalibration\t")))
            foci = {int(m[1]) for x in block if (m := re.match(r"^(\d+)\t[^\t]+\t0\t(?:lexical_seed|core)\t", x))}
            routes = []
            for x in block:
                m = re.search(r"\(#(\d+)\) → .*?\(#(\d+)\)\t([\d.]+)\t[\d.]+\t(?:true|false)\tfalse$", x)
                if not m or int(m[1]) not in foci or float(m[3]) <= 0:
                    continue
                s, t = int(m[1]), int(m[2])
                i = indices[s]
                row = {ids[tr["targetIndices"][j]]: tr["weights"][j] for j in range(off[i], off[i+1])}
                routes.append((s, t, row[t]/sum(row.values())))
            assert foci == {40770, 40783} and len(set(routes)) == len(routes) == 13
            assert all(t not in foci for _, t, _ in routes)
            rows = []
            for x in block:
                m = re.match(r"Chunk (\d+) topologyV3：(.*)$", x)
                if not m:
                    continue
                cid, j = int(m[1]), json.loads(m[2])
                fid, blob = c.execute("SELECT file_id,vector FROM chunks WHERE id=?", (cid,)).fetchone()
                cv = unit(blob)
                tags = {row[0]: tagvec(row[0]) for row in c.execute(
                    "SELECT tag_id FROM file_tags WHERE file_id=? ORDER BY position", (fid,))}
                body, bindings = {}, {}
                for _, t, _ in routes:
                    tv = tagvec(t)
                    body[t] = float(tv @ cv)
                    bindings[t] = {k: (1. if k == t else float(tv @ v), float(v @ cv)) for k,v in tags.items()}
                e, w = corroborated(routes, foci, bindings, body, cfg["semanticNodeThreshold"])
                field_w = cfg["pureLocalWeight"] + cfg["pureTransferWeight"]
                scores = arms(raw=j["queryScore"], diff=j["differentiaScore"],
                    mix=.5*cal["differentiaConfidence"], genus=j["genusGate"], field=j["fieldScore"],
                    field_lambda=field_w/(cfg["pureQueryWeight"]+field_w), support=j["fieldSupport"],
                    path=j["pathBonus"], graph=j["graphBonus"], cap=cfg["topologyBonusCap"],
                    omega_gate=j["graphGate"], evidence=e, baseline=j["finalScore"])
                rows.append(dict(id=cid, evidence=e, witness=w, scores=scores))
            assert len(rows) == len({r["id"] for r in rows}) == 30
            orders = {a: [r["id"] for r in sorted(rows, key=lambda r: -r["scores"][a])]
                      for a in rows[0]["scores"]}
            assert orders["current"] == [r["id"] for r in rows]
            top = {a: {k: {"order": v[:k], "in": [i for i in v[:k] if i not in orders["current"][:k]],
                           "out": [i for i in orders["current"][:k] if i not in v[:k]]} for k in (3,10)}
                   for a,v in orders.items()}
            report["tracks"][name] = dict(routes=routes, rows=rows, top=top)
            print(name, "positive evidence", sum(r["evidence"] > 0 for r in rows),
                  "11124", next(r for r in rows if r["id"]==11124), "top", json.dumps(top))
    with output.open("x", encoding="utf8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main(*map(Path, sys.argv[1:]))