"""Starry field dev pilot. No eval, no online-latency claim."""
import hashlib
import json
import sys
from pathlib import Path
import numpy as np

def checked(p, h):
    data = p.read_bytes()
    if hashlib.sha256(data).hexdigest() != h:
        raise ValueError(f"digest mismatch: {p.name}")
    return data

def run(root):
    root = root.resolve()
    if any((p / ".git").exists() for p in (root, *root.parents)):
        raise ValueError("private results directory required")
    pd, qd, prev = root/"plate-a", root/"queries-a", root/"p0-dev-v1"
    m = json.loads(checked(pd/"plate.json", "cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73"))
    qm = json.loads(checked(qd/"queries.json", "b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005"))
    tm = json.loads(checked(root/"tiles-a.json", "2df6e0dcdc2050b5e5a0ab5f9d8772a78a7dca801e6597621983df9a0630d2ef"))
    old = {}
    for line in checked(root/"stage1-dev-pilot-v1/rows.jsonl", "3cfa5c1635deb5b1e9202ce277dbbf6cc483416a5a6510843590ede3155c77b5").splitlines():
        r = json.loads(line)
        if r["graph"] == -1: old[r["slot"]] = r
    def arr(key, dtype):
        a = m["arrays"][key]
        return np.frombuffer(checked(pd/a["file"], a["sha256"]), dtype)
    ids = arr("ids","<u8"); n, d = len(ids), m["dimensions"]
    x = arr("vectors","<f4").reshape(n,d)
    dev = np.frombuffer(checked(qd/"dev.f32le", qm["files"]["dev.f32le"]["sha256"]), "<f4").reshape(253,d)
    scores = np.memmap(prev/"scores.u32", mode="r", dtype="<u4", shape=(253,3,n))
    cuts = np.sort(x,axis=0)[[(n-1)*j//8 for j in range(1,8)]]
    tau = (cuts[5].astype("f8")-cuts[1])/8
    scale = np.abs(x).max(axis=0).astype("f8")/127
    scale[scale==0] = 1
    # Boundaries in rank space for the shared within-bin empirical CDF.
    sx = np.ascontiguousarray(np.sort(x.T,axis=1))
    bounds = np.empty((9,d),dtype="i4"); bounds[0]=0; bounds[-1]=n
    for j in range(d): bounds[1:8,j]=sx[j].searchsorted(cuts[:,j],side="left")
    totals=np.diff(bounds,axis=0)
    bins=np.zeros((n,d),"u1")
    for c in cuts: bins += x>=c
    cap=np.asarray(tm["capacities"]); starts=np.r_[0,cap.cumsum()[:-1]]
    nt=len(cap);tiles=np.arange(nt); plates=[]
    for ix in range(6):
        order=np.fromfile(prev/f"order-{ix}.u32","<u4")
        if hashlib.sha256(ids[order].tobytes()).hexdigest()!=tm["plates"][ix]["orderedIdsSha256"]: raise ValueError("membership")
        mu=(np.add.reduceat(x[order],starts,axis=0,dtype="f8")/cap[:,None]).astype("f4")
        ci=np.rint(mu/scale).clip(-127,127).astype("i1")
        ob=bins[order]; counts=np.empty((8,nt,d),"u1"); occ=np.zeros((nt,d),"u1")
        for b in range(8):
            counts[b]=np.add.reduceat(ob==b,starts,axis=0,dtype="u1")
            occ|=(counts[b]>0).astype("u1")<<b
        if not np.all(counts.sum(axis=0)==cap[:,None]):raise ValueError("lost histogram mass")
        tile=np.empty(n,"i4");tile[order]=np.repeat(tiles,cap)
        plates.append((order,tile,mu,ci,counts,occ))
    rows=[]
    for s,q in enumerate(dev):
        lo=q-tau;hi=q+tau; sc=scores[s,0]
        if not np.array_equal(((x>=lo)&(x<=hi)).sum(axis=1),sc):raise ValueError("scalar reference mismatch")
        top=np.lexsort((ids,-sc.astype("i4")))[:10]
        left=np.fromiter((sx[j].searchsorted(lo[j],"left") for j in range(d)),dtype="i4",count=d)
        right=np.fromiter((sx[j].searchsorted(hi[j],"right") for j in range(d)),dtype="i4",count=d)
        mass=np.maximum(0,np.minimum(right,bounds[1:])-np.maximum(left,bounds[:-1]))
        prob=np.divide(mass,totals,out=np.zeros((8,d),"f8"),where=totals>0)
        mask=np.zeros(d,"u1")
        for b in range(8):
            a=cuts[b-1] if b else -np.inf; z=cuts[b] if b<7 else np.inf
            mask|=((a<z)&(hi>=a)&(lo<z)).astype("u1")<<b
        il=np.ceil(lo/scale);ih=np.floor(hi/scale)
        for ix,(order,tile,mu,ci,counts,occ) in enumerate(plates):
            fields={"or":((occ&mask)!=0).sum(axis=1),
                    "exact_mean":np.add.reduceat(sc[order],starts,dtype="u8")/cap,
                    "hist8_ecdf":np.einsum("btd,bd->t",counts,prob,optimize=False)/cap,
                    "centroid_f32":((mu>=lo)&(mu<=hi)).sum(axis=1),
                    "centroid_i8":((ci>=il)&(ci<=ih)).sum(axis=1)}
            for name,field in fields.items():
                picked=[];points=0
                for t in np.lexsort((tiles,-field.astype("f8"))):
                    if points+cap[t]<=128:
                        picked.append(t); points+=int(cap[t])
                    if points==128:break
                hits=int(np.isin(tile[top],picked).sum())
                if ix==0 and name=="or" and (hits/10!=old[s]["recall"] or points!=old[s]["verify"]):raise ValueError("old OR mismatch")
                rows.append(dict(slot=s,plate=ix,field=name,hits=hits,points=points))
    if len(rows)!=253*6*5: raise ValueError("incomplete matrix")
    out=root/"starry-fields-dev-v1.jsonl"
    with out.open("x") as f:
        for r in rows:f.write(json.dumps(r)+"\n")
    def metric(k):
        return np.array([r["hits"] for r in rows if r["field"]==k]).reshape(253,6)/10
    summary={}
    for k in fields:
        v=metric(k); delta=v[:,0]-metric("or")[:,0]
        pts=[r["points"] for r in rows if r["field"]==k and r["plate"]==0]
        summary[k]=dict(trueRecall=float(v[:,0].mean()),shuffleRecall=float(v[:,1:].mean()),
                        firstHit=float((v[:,0]>0).mean()),wins=int((delta>0).sum()),
                        ties=int((delta==0).sum()),losses=int((delta<0).sum()),
                        meanPoints=float(np.mean(pts)),pointRange=[min(pts),max(pts)])
    print(json.dumps(dict(rows=len(rows),sha256=hashlib.sha256(out.read_bytes()).hexdigest(),summary=summary)))
if __name__=="__main__":run(Path(sys.argv[1]))