"""Read-only fixed-pool replay of one rejected XW route, not ANN or embedding evaluation."""
import argparse
import math
import sqlite3
import struct
from pathlib import Path

SIGNATURE = "ee9089df98fb3a95700cbdfe58a4fe0cb58aadd258f6fc6d"
OMEGA = 0.8143843990684092
CAP = 0.08
# Server V5 trace: chunk, finalScoreWithXw, previousGraphBonus. All proxy requests
# were zero. Only the first chunk had a path bonus; no candidate clipped.
TRACE = [
    (11761,.4617938779256532,.0009952753360519765),
    (11220,.392835312474749,.00438374223673034),
    (4620,.3818907049176157,.0022145009437706835),
    (11124,.3672137512591233,.0017642127439712245),
    (3828,.3602058056707725,.003593963329693208),
    (3757,.3575799115043956,.003228252670384822),
    (4416,.34948424132280886,.0005074884207433857),
    (3963,.34896680611910835,.0007420913541121327),
    (6851,.3472915717577049,.0013641352609509636),
    (9086,.3443221388763917,.002242381734566008),
    (3863,.34129188080507206,.005941388106547811),
    (6737,.3407503502028327,.004344486678184299),
    (4354,.3406034880897377,.0021398468809590253),
    (11129,.3394346728013633,.0020960457717837887),
    (3800,.3381842859451558,.006144424541485346),
    (3951,.33613753861252205,.002786664395373619),
    (4627,.3338235165551545,.004215201027703573),
    (10460,.3273314689765538,.00027321930589184836),
    (4392,.3272824166118988,.001614806515602647),
    (4364,.32689774497853485,.0033401158023966173),
    (4693,.3240839787644412,.0019860848730076804),
    (4409,.32196724243204483,.0020423219829680795),
    (11258,.3217414377962651,.001650763829522454),
    (11709,.3120421565066753,.0013711289795826026),
    (11203,.30910210918407033,.0016600860795884884),
    (10627,.30596911832866713,.00033419723007275067),
    (6696,.3011565024830137,.0002349365796415005),
    (10626,.3000696775018128,.0000010244765587269243),
    (4288,.29712025309237927,.000042487063615607894),
    (10543,.2920014525801625,.00017325123911385995),
]


def unit(blob):
    v = struct.unpack("<3072f", blob)
    n = math.sqrt(sum(x*x for x in v))
    if not math.isfinite(n) or n == 0:
        raise ValueError("invalid vector")
    return [x/n for x in v]


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def replay(db):
    db.execute("BEGIN")
    if db.execute("SELECT value FROM kbm_runtime_meta WHERE key='database_generation'").fetchone() != ("808",):
        raise ValueError("wrong database generation for this trace")
    if not db.execute("SELECT 1 FROM rivermemo_artifacts WHERE artifact_sig=? AND status='ready'", (SIGNATURE,)).fetchone():
        raise ValueError("trace artifact unavailable")
    files = db.execute("""SELECT DISTINCT f.id,f.checksum FROM files f
        JOIN file_tags s ON s.file_id=f.id JOIN file_tags t ON t.file_id=f.id
        WHERE s.tag_id=40770 AND t.tag_id=39492 ORDER BY f.id""").fetchall()
    if [i for i, _ in files] != [9478, 9479]:
        raise ValueError("joint files differ from original trace")
    sets = [{r[0] for r in db.execute("SELECT tag_id FROM file_tags WHERE file_id=?", (i,))} for i, _ in files]
    print("distinct checksums:", len({h for _, h in files if h}), "other focus present:",
          [40783 in s for s in sets], "shared bridges:", sorted(set.intersection(*sets)-{40770,39492,40783}))
    target = unit(db.execute("SELECT vector FROM tags WHERE id=39492").fetchone()[0])
    ranks = []
    for rank, (cid, before, graph) in enumerate(TRACE, 1):
        fid, blob = db.execute("SELECT file_id,vector FROM chunks WHERE id=?", (cid,)).fetchone()
        body = unit(blob)
        cosine = dot(target, body)
        best = None
        for tid, name, blob in db.execute("""SELECT t.id,t.name,t.vector FROM file_tags ft
                JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id=? AND t.vector IS NOT NULL""", (fid,)):
            v = unit(blob)
            sim = 1.0 if tid == 39492 else dot(target, v)
            if sim > .48 and dot(v, body) > 0 and (best is None or (sim,-tid) > best[:2]):
                best = (sim,-tid,name)
        # Route relative flow and omegaGamma are both 1; candidate tag closure
        # is an eligibility condition, not another factor in evidence.
        evidence = min(1.0,max(0.0,cosine))*OMEGA if best else 0.0
        path = .000742727506207406 if cid == 11761 else 0.0
        merged = min(CAP-path, graph+(CAP-graph)*evidence)
        after = min(1.0, before+(merged-graph))
        ranks.append((after, rank, cid, before, cosine, best))
    print("new old chunk  baseline  if_admit  delta    body_cos  matched_tag")
    for pos,(after,rank,cid,before,cosine,best) in enumerate(sorted(ranks,key=lambda r:-r[0]),1):
        print(f"{pos:2} {rank:3} {cid:5}  {before:.5f}   {after:.5f}  {after-before:+.5f}  {cosine:.4f}   {best[2] if best else '-'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1]/"VectorStore"/"knowledge_base.sqlite")
    db = sqlite3.connect(parser.parse_args().db.resolve().as_uri()+"?mode=ro", uri=True)
    try:
        replay(db)
    finally:
        db.close()