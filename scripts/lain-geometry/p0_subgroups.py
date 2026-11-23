import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from run_p0_dev import PLATE, TILES, QUERIES, checked

def main(root, out):
    root, out = root.resolve(), out.resolve()
    if any((p/".git").exists() for p in (out,*out.parents)):
        raise ValueError("output inside worktree")
    p, old = root/"plate-a", root/"p0-dev-v1"
    m = json.loads(checked(p/"plate.json",PLATE).read_bytes())
    tm = json.loads(checked(root/"tiles-a.json",TILES).read_bytes())
    qd=root/"queries-a"
    qm=json.loads(checked(qd/"queries.json",QUERIES).read_bytes())
    prev=checked(old/"per-query.jsonl","cf7d8ddea5fc2847b49442fd67183db32e3a15f1b5741c69c61c09569e6e9db7")
    baseline={}
    for line in prev.read_bytes().splitlines():
        r=json.loads(line)
        if r["summary"]=="bins" and r["denominator"]==8:
            baseline[r["slot"],r["plate"]]=r
    def load(key,dtype):
        a=m["arrays"][key]
        return np.fromfile(checked(p/a["file"],a["sha256"]),dtype)
    n,d=m["rows"],m["dimensions"]
    x=load("vectors","<f4").reshape(n,d)
    ids=load("ids","<u8")
    dev=np.fromfile(checked(qd/"dev.f32le",qm["files"]["dev.f32le"]["sha256"]),"<f4").reshape(253,d)
    ranks=np.array([(n-1)//4,3*(n-1)//4])
    quart=np.partition(x,ranks,axis=0)[ranks].astype("f8")
    tau=(quart[1]-quart[0])/8
    frames=np.memmap(old/"ends.f64",mode="r",dtype="<f8",shape=(253,3,2,d))
    scores=np.memmap(old/"scores.u32",mode="r",dtype="<u4",shape=(253,3,n))
    cap=np.array(tm["capacities"])
    if not np.array_equal(cap,np.r_[np.full(428,16),1]): raise ValueError("unexpected capacities")
    plates=[]
    for i,entry in enumerate(tm["plates"]):
        order=np.fromfile(old/f"order-{i}.u32","<u4")
        if hashlib.sha256(ids[order].astype("<u8").tobytes()).hexdigest()!=entry["orderedIdsSha256"]:
            raise ValueError("order digest mismatch")
        plates.append((order,np.minimum.reduceat(ids[order],np.r_[0,cap.cumsum()[:-1]])))
    out.mkdir(mode=0o700)
    with (out/"subgroups.jsonl").open("x") as f:
        for s,row in enumerate(dev):
            lo,hi=frames[s,0]
            if not (np.array_equal(lo,row-tau) and np.array_equal(hi,row+tau)): raise ValueError("endpoint drift")
            hit=(x>=lo)&(x<=hi)
            sc=hit.sum(1,dtype="i4")
            if not np.array_equal(sc,scores[s,0]): raise ValueError("score drift")
            kth=np.lexsort((ids,-sc))[9]
            for i,(order,minid) in enumerate(plates):
                packed=hit[order]
                # Adjacent groups are nested; the last point is its own nonempty group at every scale.
                flags=packed[:-1].reshape(428,4,4,d).any(axis=2)
                best=np.maximum.reduceat(sc[order],np.r_[0,cap.cumsum()[:-1]])
                last=None
                for size in (4,8,16):
                    if size!=4: flags=flags.reshape(428,-1,2,d).any(axis=2)
                    u=np.r_[flags.sum(axis=2,dtype="i4").max(axis=1),sc[order[-1]]]
                    if (u<best).any() or (last is not None and (u<last).any()): raise ValueError("bound violation")
                    last=u
                    excluded=(u<sc[kth])|((u==sc[kth])&(minid>ids[kth]))
                    saved=int(cap[excluded].sum())*d*4
                    ng=428*(16//size)+1
                    if size==16:
                        b=baseline[s,i]
                        if saved!=b["idealESkippedBytes"] or sc[kth]!=b["kthScore"] or abs((u-best).mean()-b["chimera"][0])>1e-8:
                            raise ValueError("E16 replay mismatch")
                    rec=dict(slot=s,plate=i,groupSize=size,fullTilesSkipped=int(excluded[:-1].sum()),
                             idealSavedBytes=saved,meanSlack=float((u-best).mean()),
                             idealNetAtBitmapCost=saved-ng*d,idealNetAtAabbCost=saved-ng*d*8)
                    f.write(json.dumps(rec,separators=(",",":"))+"\n")
    print(json.dumps(dict(complete=True,queries=253,records=253*6*3,evalUsed=False)),flush=True)

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("root",type=Path);ap.add_argument("out",type=Path)
    main(**vars(ap.parse_args()))