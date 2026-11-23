"""Post-P0 diagnostic, not an online index or a latency benchmark."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import numpy as np

def checked(p, expected):
    with p.open("rb") as f:
        if hashlib.file_digest(f, "sha256").hexdigest() != expected:
            raise ValueError(f"unexpected digest: {p.name}")
    return p

def run(root):
    root = root.resolve()
    if any((p / ".git").exists() for p in (root, *root.parents)):
        raise ValueError("private output required")
    pd, qd, prev = root/"plate-a", root/"queries-a", root/"p0-dev-v1"
    def manifest(p,h):
        return json.loads(checked(p,h).read_bytes())
    m=manifest(pd/"plate.json","cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73")
    qm=manifest(qd/"queries.json","b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005")
    tm=manifest(root/"tiles-a.json","2df6e0dcdc2050b5e5a0ab5f9d8772a78a7dca801e6597621983df9a0630d2ef")
    old=checked(prev/"per-query.jsonl","cf7d8ddea5fc2847b49442fd67183db32e3a15f1b5741c69c61c09569e6e9db7")
    baseline={}
    for line in old.read_bytes().splitlines():
        r=json.loads(line)
        if r["denominator"]==8 and r["summary"]=="aabb":
            baseline[r["slot"],r["plate"]]=r
    n,d=m["rows"],m["dimensions"]
    cap=np.array(tm["capacities"])
    if cap.tolist()!=[16]*428+[1]: raise ValueError("unexpected frozen capacities")
    def array(k,dt):
        a=m["arrays"][k]
        return np.fromfile(checked(pd/a["file"],a["sha256"]),dt)
    ids=array("ids","<u8")
    x=array("vectors","<f4").reshape(n,d)
    q=np.fromfile(checked(qd/"dev.f32le",qm["files"]["dev.f32le"]["sha256"]),"<f4").reshape(253,d)
    sorted_x=np.sort(x,axis=0)
    tau=(sorted_x[3*(n-1)//4].astype("f8")-sorted_x[(n-1)//4])/8
    del sorted_x
    scores=np.memmap(prev/"scores.u32",mode="r",dtype="<u4",shape=(253,3,n))
    orders=[]
    for ix in range(6):
        order=np.fromfile(prev/f"order-{ix}.u32","<u4")
        if hashlib.sha256(ids[order].astype("<u8").tobytes()).hexdigest()!=tm["plates"][ix]["orderedIdsSha256"]:
            raise ValueError("membership mismatch")
        orders.append((order,np.minimum.reduceat(ids[order],np.arange(0,n,16))))
    out=root/"p0-group-oracle-v1"
    out.mkdir(mode=0o700)
    with (out/"rows.jsonl").open("x") as f:
        for slot,v in enumerate(q):
            hits=(x>=v-tau)&(x<=v+tau)
            s=hits.sum(axis=1,dtype="i4")
            if not np.array_equal(s,scores[slot,0]): raise ValueError("scalar scores differ")
            kth=np.lexsort((ids,-s))[9]
            sk,ik=int(s[kth]),int(ids[kth])
            for ix,(order,minid) in enumerate(orders):
                # Shrink 3072 dimensions to 384 bytes without losing hit identity.
                packed=np.packbits(hits[order],axis=1)
                lut=POPCOUNT
                full=packed[:-1].reshape(428,16,-1)
                best=np.maximum.reduceat(s[order],np.arange(0,n,16))
                last=best[-1]
                before=None
                for size in (16,8,4,1):
                    union=np.bitwise_or.reduce(full.reshape(428,16//size,size,-1),axis=2)
                    u=np.r_[lut[union].sum(axis=-1,dtype="i4").max(axis=1),last]
                    if (u<best).any() or (before is not None and (u>before).any()):
                        raise ValueError("bound nesting failure")
                    if size==1 and not np.array_equal(u,best): raise ValueError("singleton oracle failure")
                    before=u
                    pruned=(u<sk)|((u==sk)&(minid>ik))
                    saved=int(cap[pruned].sum())*d*4
                    ref=baseline[slot,ix]
                    if ref["kthScore"]!=sk or (size==16 and saved!=ref["idealESkippedBytes"]):
                        raise ValueError("P0 reference mismatch")
                    f.write(json.dumps(dict(slot=slot,plate=ix,groupSize=size,
                        fullSkipped=int(pruned[:-1].sum()),tailSkipped=bool(pruned[-1]),
                        skippedBytes=saved,meanSlack=float((u-best).mean())))+"\n")
    raw=(out/"rows.jsonl").read_bytes()
    if len(raw.splitlines())!=6072: raise ValueError("incomplete matrix")
    rows=[json.loads(l) for l in raw.splitlines()]
    groups=[]
    for size in (16,8,4,1):
        real=[r for r in rows if r["plate"]==0 and r["groupSize"]==size]
        rand=[r for r in rows if r["plate"]!=0 and r["groupSize"]==size]
        saved=np.array([r["skippedBytes"] for r in real])
        diff=saved-np.array([r["skippedBytes"] for r in rand]).reshape(253,5).mean(axis=1)
        groups.append(dict(groupSize=size,queriesSkippingFull=sum(r["fullSkipped"]>0 for r in real),
            meanFullSkipped=float(np.mean([r["fullSkipped"] for r in real])),
            meanSavedBytes=float(saved.mean()),meanBudgetPerOriginalTile=float(saved.mean()/429),
            meanPairedGainBytes=float(diff.mean()),medianPairedGainBytes=float(np.median(diff))))
    result=dict(records=len(rows),rowsSha256=hashlib.sha256(raw).hexdigest(),groups=groups)
    (out/"summary.tmp").write_text(json.dumps(result,indent=2),encoding="utf8")
    os.replace(out/"summary.tmp",out/"summary.json")
    print(json.dumps(result),flush=True)

POPCOUNT=np.array([i.bit_count() for i in range(256)],dtype="u1")
if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("root",type=Path)
    run(parser.parse_args().root)