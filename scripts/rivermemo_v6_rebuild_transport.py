"""Offline gen1051 / build1039 calibration. No DB writes or network."""
import gzip
import hashlib
import json
import math
import os
import sqlite3
import uuid
from collections import defaultdict
from pathlib import Path

import numpy as np

BASE = Path(os.environ["LOCALAPPDATA"]) / "VCP-Experiments/RiverMemoV6"
DB = BASE / "frozen-1051-v1/knowledge_base.sqlite"
SIG = "51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3"
CHECK = "d2b3e55c2e7cfbe1b82e3aa777298c3d9c8aa1aff23e3838cb99890536bb7c5c"


def main():
    with sqlite3.connect(DB.as_uri()+"?mode=ro&immutable=1", uri=True) as c:
        assert c.execute("SELECT value FROM kbm_runtime_meta WHERE key='database_generation'").fetchone()==("1051",)
        raw = gzip.decompress(c.execute("SELECT payload FROM rivermemo_artifacts WHERE artifact_sig=? AND status='ready'", (SIG,)).fetchone()[0])
        assert hashlib.sha256(raw).hexdigest() == CHECK
        obj = json.loads(raw)
        del raw
        files = {f for _, entries in obj.pop("provenanceView")["edges"] for f, _ in entries}
        graph = obj["sharedTransport"]
        anchors = dict(obj["anchorGainView"])
        labels = set(obj["wormholeView"])
        config = obj["artifact"]["effectiveConfig"]
        oc, v9 = config["orderedCooccurrence"], config["v9"]
        ids = np.array(graph["nodeIds"], dtype=np.int64)
        idx = {int(t): i for i,t in enumerate(ids)}
        vectors = np.zeros((len(ids),3072), dtype=np.float64)
        valid = np.zeros(len(ids), dtype=bool)
        for t,blob in c.execute("SELECT id,vector FROM tags WHERE vector IS NOT NULL"):
            if t not in idx: continue
            v = np.frombuffer(blob, dtype="<f4").astype(np.float64)
            n = np.linalg.norm(v)
            if v.shape==(3072,) and np.isfinite(n) and n>0:
                vectors[idx[t]]=v/n
                valid[idx[t]]=True
        groups=defaultdict(list)
        for f,t,pos in c.execute("SELECT file_id,tag_id,position FROM file_tags ORDER BY file_id,position,tag_id"):
            if f in files: groups[f].append((t,pos))
    assert files==groups.keys()
    off=np.asarray(graph["rowOffsets"],dtype=np.int64)
    src=np.repeat(np.arange(len(ids)),np.diff(off))
    dst=np.asarray(graph["targetIndices"],dtype=np.int64)
    old=np.asarray(graph["weights"],dtype=np.float64)
    gains=np.empty(len(dst))
    for lo in range(0,len(dst),256):
        ix=slice(lo,lo+256); a,b=src[ix],dst[ix]
        sim=np.clip(np.einsum("ij,ij->i",vectors[a],vectors[b]),-1,1)
        sim=np.where(valid[a]&valid[b],sim,oc["semanticGainLowSimFallback"])
        gains[ix]=np.where(sim<.15,.4+sim,.5+.8*np.exp(-((sim-oc["semanticGainPeak"])**2)/(2*oc["semanticGainSigma"]**2))) if oc["semanticGainEnabled"] else 1.
    del vectors
    edge={(int(ids[a]),int(ids[b])):i for i,(a,b) in enumerate(zip(src,dst))}
    fact=np.zeros(len(dst))
    for tags in groups.values():
        n=len(tags)
        assert 2<=n<=100
        for j,(a,pa) in enumerate(tags):
            for b,pb in tags[j+1:]:
                if a==b: continue
                ab,ba=edge[a,b],edge[b,a]
                if min(pa,pb)<=0: fw=bw=.7*.7
                else:
                    phi=lambda p:.9-.4*max(p-1,0)/(n-1)
                    w=phi(pa)*phi(pb)*math.exp(-oc["distanceDecay"]*max(pb-pa-1,0))
                    fw=w*oc["forwardGain"]
                    rev=np.clip(oc["reverseGain"],oc["minReverseGain"],oc["maxReverseGain"])
                    if oc["reverseAnchorBoost"]:rev*=min(anchors.get(a,1.),oc["reverseAnchorMax"])
                    bw=min(w*max(.25,min(.70,rev)),fw*oc["reverseInversionGuard"])
                fact[ab]+=fw*gains[ab];fact[ba]+=bw*gains[ba]
    evidence=np.log(1+np.maximum(fact,0)*v9["evidenceCompression"])
    anchor=np.array([anchors.get(int(t),1.) for t in ids])
    flags=evidence*anchor[dst]>=v9["tensionThreshold"]
    trueflags=np.array([f"{ids[a]}:{ids[b]}" in labels for a,b in zip(src,dst)])
    def transport(gain,reserve):
        conduct=evidence*np.where(flags,gain,1.)
        inflow=np.bincount(dst,weights=conduct,minlength=len(ids))
        x=inflow[inflow>0]
        med=np.partition(x,len(x)//2)[len(x)//2]
        smooth=max(med*v9["hubSmoothingRatio"],1e-9)
        penalty=np.clip(np.maximum(inflow/(med+smooth),1e-9)**(-v9["hubPenaltyExponent"]),v9["hubPenaltyFloor"],v9["hubPenaltyCeiling"])
        adj=conduct*penalty[dst]
        total=np.bincount(src,weights=adj,minlength=len(ids))[src]
        wh=np.bincount(src,weights=adj*flags,minlength=len(ids))[src]
        r=np.where(wh>0,reserve,0.)
        return (v9["outboundMass"]-r)*adj/total+r*flags*adj/np.where(wh>0,wh,1.)
    ref=transport(v9["wormholeGain"],v9["associationReserveMass"])
    err=float(np.max(np.abs(ref-old))); nf=int(np.count_nonzero(flags!=trueflags))
    print("calibration",{"files":len(files),"edges":len(old),"flag_mismatch":nf,"max_abs":err,"edges_over_1e-10":int(np.sum(abs(ref-old)>1e-10))},flush=True)
    assert nf==0 and err<=1e-10,"full-graph calibration failed; no ordinary baseline exported"
    row=src==idx[40770]; target=ids[dst[row]]
    arms={}
    bundle=BASE/("transport-arms-"+uuid.uuid4().hex)
    bundle.mkdir()
    manifest={"sourceArtifact":SIG,"sourcePayloadSha256":CHECK,"nodes":len(ids),"edges":len(dst),"files":{}}
    def save_array(name,values,dtype):
        data=np.asarray(values,dtype=dtype).tobytes(order="C")
        with (bundle/name).open("xb") as f: f.write(data)
        manifest["files"][name]={"sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data),"dtype":dtype}
    save_array("ids.i64",ids,"<i8")
    save_array("offsets.u64",off,"<u8")
    save_array("target-indices.u64",dst,"<u8")
    old_inbound=dict(obj["inboundMassView"])
    expected_in=np.array([old_inbound.get(int(t),0.) for t in ids])
    for name,g,r in [("current",v9["wormholeGain"],v9["associationReserveMass"]),("noReserve",v9["wormholeGain"],0.),("noGain",1.,v9["associationReserveMass"]),("ordinary",1.,0.)]:
        all_weights=transport(g,r)
        incoming=np.bincount(dst,weights=all_weights,minlength=len(ids))
        outgoing=np.bincount(src,weights=all_weights,minlength=len(ids))
        active=np.diff(off)>0
        assert np.max(np.abs(outgoing[active]-v9["outboundMass"]))<1e-10
        assert abs(incoming.sum()-outgoing.sum())<1e-8
        if name=="current":
            in_err=float(np.max(np.abs(incoming-expected_in)))
            print("current inbound maximum absolute difference:",in_err)
            assert in_err<1e-9,"inbound convention mismatch; refuse experimental bundle"
        save_array(name+".weights.f64",all_weights,"<f8")
        vals=all_weights[row];assert abs(vals.sum()-v9["outboundMass"])<1e-12
        arms[name]={str(t):float(w) for t,w in zip(target,vals)}
        print(name,"pedal",arms[name]["39492"],"PC",arms[name]["40773"])
    with (bundle/"manifest.json").open("x",encoding="utf8") as f:json.dump(manifest,f,indent=2)
    print("complete full-graph bundle:",bundle)
    out=BASE/("transport-row40770-"+uuid.uuid4().hex+".json")
    with out.open("x",encoding="utf8") as f:json.dump({"sig":SIG,"calibrationMaxAbs":err,"flagMismatch":nf,"source":40770,"arms":arms},f,indent=2)
    print(out)


if __name__=="__main__":
    main()