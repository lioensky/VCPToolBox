import argparse
import hashlib
import json
import subprocess
from pathlib import Path
import numpy as np

PLATE = "cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73"
QUERIES = "b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005"
TILES = "2df6e0dcdc2050b5e5a0ab5f9d8772a78a7dca801e6597621983df9a0630d2ef"
JS = Path(__file__).with_name("p0-controls.cjs").resolve()


def checked(path, expected):
    with path.open("rb") as f:
        if hashlib.file_digest(f, "sha256").hexdigest() != expected:
            raise ValueError(f"digest mismatch: {path.name}")
    return path


def stats(x):
    return [float(x.mean()), *map(float, np.quantile(x, [.5, .95, .99]))]


def run(root, out, limit):
    root, out = root.resolve(), out.resolve()
    if any((p / ".git").exists() for p in (out, *out.parents)):
        raise ValueError("private output required")
    pd, qd = root / "plate-a", root / "queries-a"
    m = json.loads(checked(pd/"plate.json", PLATE).read_bytes())
    q = json.loads(checked(qd/"queries.json", QUERIES).read_bytes())
    t = json.loads(checked(root/"tiles-a.json", TILES).read_bytes())
    for a in m["arrays"].values():
        checked(pd/a["file"], a["sha256"])
    x = np.fromfile(pd/"vectors.f32le", "<f4").reshape(m["rows"], m["dimensions"])
    ids = np.fromfile(pd/"ids.u64le", "<u8")
    dev = np.fromfile(checked(qd/"dev.f32le", q["files"]["dev.f32le"]["sha256"]), "<f4").reshape(-1,x.shape[1])
    if not 1 <= limit <= len(dev): raise ValueError("invalid dev limit")
    out.mkdir(mode=0o700)
    n,d = x.shape
    cap = np.array(t["capacities"])
    starts = np.r_[0,cap.cumsum()[:-1]]
    cuts = np.sort(x,axis=0)[[(n-1)*j//8 for j in range(1,8)]].copy()
    spread = cuts[5].astype("f8") - cuts[1]
    configs = [(s,w) for s in range(limit) for w in (8,16,4)]
    ends = np.empty((len(configs),2,d),dtype="<f8")
    for i,(s,w) in enumerate(configs):
        ends[i] = dev[s]-spread/w,dev[s]+spread/w
    ends.tofile(out/"ends.f64")
    def node(mode):
        subprocess.run(["node",str(JS),str(root),str(out),mode],check=True)
    node("orders")
    node("oracle")
    scores = np.fromfile(out/"scores.u32","<u4").reshape(len(configs),n)
    tops = [json.loads(l) for l in (out/"topk.jsonl").read_text().splitlines()]
    bins = np.zeros(x.shape,dtype="u1")
    for c in cuts: bins += x>=c
    bits = np.left_shift(np.uint8(1),bins)
    del bins
    plates = []
    pop = np.array([i.bit_count() for i in range(256)],dtype="u1")
    for ix in range(6):
        order = np.fromfile(out/f"order-{ix}.u32","<u4")
        packed = x[order]
        occ = np.bitwise_or.reduceat(bits[order], starts, axis=0)
        plates.append((order,np.minimum.reduceat(packed,starts,axis=0),
                       np.maximum.reduceat(packed,starts,axis=0),occ,np.minimum.reduceat(ids[order],starts),
                       float(pop[occ].mean()/8)))
    del packed,bits
    with (out/"per-query.jsonl").open("x") as report:
        for i,(slot,w) in enumerate(configs):
            lo,hi=ends[i]
            hits=(x>=lo)&(x<=hi)
            if not np.array_equal(hits.sum(axis=1),scores[i]): raise ValueError("scalar score mismatch")
            top=np.lexsort((ids,-scores[i].astype("i4")))[:10]
            if [(int(scores[i,j]),int(ids[j])) for j in top]!=[(a["score"],a["id"]) for a in tops[i]]:
                raise ValueError("scalar ranking mismatch")
            sk,ik=tops[i][-1]["score"],tops[i][-1]["id"]
            mask=np.zeros(d,dtype="u1")
            for b in range(8):
                left=cuts[b-1] if b else -np.inf
                right=cuts[b] if b<7 else np.inf
                mask |= ((left<right)&(hi>=left)&(lo<right)).astype("u1")<<b
            for ix,(order,mn,mx,occ,minid,fill) in enumerate(plates):
                e=np.logical_or.reduceat(hits[order],starts,axis=0).sum(axis=1,dtype="i4")
                best=np.maximum.reduceat(scores[i,order],starts).astype("i4")
                def skipped(u):
                    return int(cap[(u<sk)|((u==sk)&(minid>ik))].sum())*d*4
                for kind,u,cost in (("aabb",((mn<=hi)&(mx>=lo)).sum(axis=1,dtype="i4"),8),
                                    ("bins",((occ&mask)!=0).sum(axis=1,dtype="i4"),1)):
                    if (u<e).any() or (e<best).any(): raise ValueError("unsafe bound")
                    saved=skipped(u)
                    rec=dict(slot=slot,denominator=w,plate=ix,summary=kind,kthScore=sk,
                             env=stats(u-e),chimera=stats(e-best),totalSlack=stats(u-best),
                             occupiedBinFraction=fill,queryMaskFraction=float(pop[mask].mean()/8),
                             litDimensionFraction=float(u.mean()/d),skippedBytes=saved,
                             idealESkippedBytes=skipped(e),summaryBytes=len(cap)*d*cost,
                             netBytes=saved-len(cap)*d*cost)
                    report.write(json.dumps(rec,separators=(",",":"))+"\n")
            report.flush()
    print(json.dumps(dict(complete=True,queries=limit,configurations=len(configs),records=len(configs)*12,
                          statsOrder=["mean","p50","p95","p99"],output=str(out))),flush=True)


if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("root",type=Path); p.add_argument("out",type=Path)
    p.add_argument("--limit",type=int,default=253)
    run(**vars(p.parse_args()))