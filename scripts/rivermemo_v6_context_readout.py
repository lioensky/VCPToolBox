"""Usage: python -B rivermemo_v6_context_readout.py frozen.sqlite export_dir new.json"""
import gzip
import json
import sqlite3
import sys
from functools import lru_cache
from pathlib import Path
import numpy as np
from rivermemo_v6_shadow_readout import corroborated, arms
from rivermemo_v6_shadow_replay import SIG


def run(db, directory, output):
    all_results = {}
    with sqlite3.connect(db.resolve().as_uri()+"?mode=ro&immutable=1", uri=True) as c:
        tr = json.loads(gzip.decompress(c.execute(
            "SELECT payload FROM rivermemo_artifacts WHERE artifact_sig=?", (SIG,)
        ).fetchone()[0]))["sharedTransport"]
        index = {v:i for i,v in enumerate(tr["nodeIds"])}

        def unit(blob):
            v = np.frombuffer(blob, dtype="<f4").astype(np.float64)
            n = np.linalg.norm(v)
            assert v.size == 3072 and np.isfinite(n) and n > 0
            return v / n

        @lru_cache(None)
        def vector(i):
            return unit(c.execute("SELECT vector FROM tags WHERE id=?", (i,)).fetchone()[0])

        @lru_cache(None)
        def row(s):
            i = index[s]
            off = tr["rowOffsets"]
            return {tr["nodeIds"][tr["targetIndices"][j]]:tr["weights"][j]
                    for j in range(off[i],off[i+1])}

        for key in ("auto","phone","general"):
            d = json.loads((directory/(key+".json")).read_bytes())
            assert d["sig"] == SIG
            for track,r in d["tracks"].items():
                graph = r["queryRiverGraph"]
                nodes = {n["id"]:n for n in graph["nodes"]}
                explicit = {i for i,n in nodes.items() if n["hop"] == 0 and
                            n["sourceType"] in ("core","lexical_seed") and n["energy"] > 0}
                assert not graph["truncated"] and len(nodes) == graph["totalNodes"]
                assert len(graph["edges"]) == graph["totalEdges"] and r["omega"]["completeObservation"]
                routes = []
                for edge in graph["edges"]:
                    s,t = edge["sourceId"],edge["targetId"]
                    if s not in explicit or nodes[t]["hop"] != 1 or edge["immediateReturn"] or edge["flow"] <= 0:
                        continue
                    w = row(s)
                    assert abs(w[t]-edge["conductance"]) < 1e-8
                    routes.append((s,t,w[t]/sum(w.values())))
                cfg = r["parameters"]["parsedConfig"]
                conf = r["parameters"]["queryCalibration"]["differentiaConfidence"]
                rows = []
                for item in r["results"]:
                    cid = item["chunkId"]
                    fid,blob = c.execute("SELECT file_id,vector FROM chunks WHERE id=?", (cid,)).fetchone()
                    cv = unit(blob)
                    tvs = {k:vector(k) for k, in c.execute("SELECT tag_id FROM file_tags WHERE file_id=?", (fid,))}
                    body = {t:float(vector(t) @ cv) for _,t,_ in routes}
                    bind = {t:{k:(1. if k==t else float(vector(t) @ v),float(v @ cv))
                               for k,v in tvs.items()} for t in body}
                    ev,wit = corroborated(routes,explicit,bind,body,cfg["semanticNodeThreshold"])
                    j = item["topologyV3"]
                    fw = cfg["pureLocalWeight"] + cfg["pureTransferWeight"]
                    scores = arms(raw=j["queryScore"],diff=j["differentiaScore"],mix=.5*conf,
                        genus=j["genusGate"],field=j["fieldScore"],field_lambda=fw/(fw+cfg["pureQueryWeight"]),
                        support=j["fieldSupport"],path=j["pathBonus"],graph=j["graphBonus"],
                        cap=cfg["topologyBonusCap"],omega_gate=j["graphGate"],evidence=ev,baseline=j["finalScore"])
                    rows.append(dict(id=cid,scores=scores,evidence=ev,witness=wit))
                orders = {a:[x["id"] for x in sorted(rows,key=lambda x:-x["scores"][a])] for a in rows[0]["scores"]}
                orig = orders["current"]
                assert orig == [x["chunkId"] for x in r["results"]] and len(orig)==len(set(orig))==30
                assert set(orig)==set(d["pools"][track])
                changes = {a:{k:dict(order=v[:k],entered=[i for i in v[:k] if i not in orig[:k]],
                                     exited=[i for i in orig[:k] if i not in v[:k]]) for k in (3,10)}
                           for a,v in orders.items()}
                all_results[key+"/"+track] = dict(explicit=sorted(explicit),routes=routes,rows=rows,top=changes)
                v = orders["combined"]
                print(key,track,"foci",sorted(explicit),"routes",len(routes),"positive",sum(x["evidence"]>0 for x in rows),
                      "changed scores",sum(abs(x["scores"]["combined"]-x["scores"]["current"])>1e-12 for x in rows),
                      "combined top3",v[:3],"top10 order changed",v[:10]!=orig[:10],
                      "in/out",changes["combined"][10]["entered"],changes["combined"][10]["exited"],
                      "11124", (orig.index(11124)+1,v.index(11124)+1) if 11124 in orig else "outside")
    with output.open("x",encoding="utf8") as f:
        json.dump(all_results,f,ensure_ascii=False,indent=2)


if __name__ == "__main__":
    run(*map(Path,sys.argv[1:]))