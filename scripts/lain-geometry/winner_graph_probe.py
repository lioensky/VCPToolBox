import hashlib, json, random, sys
from collections import deque
from itertools import combinations
from pathlib import Path
import numpy as np

def sha(b): return hashlib.sha256(b).hexdigest()
def read(p,h):
    b=p.read_bytes()
    if sha(b)!=h: raise ValueError(f"digest mismatch: {p.name}")
    return b

def components(adj):
    labels=[-1]*len(adj)
    for i in range(len(adj)):
        if labels[i]>=0: continue
        todo=[i]; labels[i]=i
        while todo:
            for j in adj[todo.pop()]:
                if labels[j]<0: labels[j]=i; todo.append(j)
    return labels

def dist(adj):
    d=np.full((len(adj),len(adj)),-1,dtype="i2")
    for i in range(len(adj)):
        seen={i:0}; q=deque([i])
        while q:
            v=q.popleft()
            for j in adj[v]:
                if j not in seen: seen[j]=seen[v]+1; q.append(j)
        for v,k in seen.items(): d[i,v]=k
    return d

def rewire(base,seed):
    labels=components(base)
    original={(i,j) for i,nb in enumerate(base) for j in nb if i<j}
    for attempt in range(4):
        rng=random.Random(seed+attempt*1000)
        a=[set(x) for x in base]; edges=sorted(original); m=len(edges)
        ok=0; tries=0
        while ok<10*m and tries<150*m:
            tries+=1
            i,j=rng.sample(range(m),2)
            u,v=edges[i]; w,z=edges[j]
            if rng.getrandbits(1): w,z=z,w
            if len({u,v,w,z})<4 or labels[u]!=labels[w] or w in a[u] or z in a[v]: continue
            for p,q in ((u,v),(w,z)): a[p].remove(q); a[q].remove(p)
            for p,q in ((u,w),(v,z)): a[p].add(q); a[q].add(p)
            edges[i]=tuple(sorted((u,w))); edges[j]=tuple(sorted((v,z))); ok+=1
        if components(a)!=labels: continue
        if [len(x) for x in a]!=[len(x) for x in base] or ok!=10*m: raise ValueError("unmixed control")
        return a,dict(seed=seed,effectiveSeed=seed+attempt*1000,swaps=ok,attempts=tries,
                      originalEdgeRetention=len(original.intersection(edges))/m)
    raise ValueError("could not preserve components")

def measure(a,winners):
    d=dist(a); rows=[]
    for nodes in winners:
        pairs=list(combinations(nodes,2))
        ds=[int(d[u,v]) for u,v in pairs]; finite=[x for x in ds if x>=0]
        sub=[{j for j,v in enumerate(nodes) if v in a[u]} for u in nodes]
        labels=components(sub)
        cc=sum(all(d[u,v]<0 for v in nodes[:i]) for i,u in enumerate(nodes))
        rows.append(dict(tiles=len(nodes),inducedCC=len(set(labels)),ambientCC=cc,
            reachable=len(finite)/len(ds) if ds else None,
            meanFiniteHop=float(np.mean(finite)) if finite else None,
            within2=sum(0<=x<=2 for x in ds)/len(ds) if ds else None,
            direct=sum(x==1 for x in ds)/len(ds) if ds else None))
    return rows

def main(root):
    pd=root/"plate-a"; prev=root/"p0-dev-v1"
    m=json.loads(read(pd/"plate.json","cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73"))
    tm=json.loads(read(root/"tiles-a.json","2df6e0dcdc2050b5e5a0ab5f9d8772a78a7dca801e6597621983df9a0630d2ef"))
    def arr(k,dt):
        t=m["arrays"][k]; return np.frombuffer(read(pd/t["file"],t["sha256"]),dt)
    ids=arr("ids","<u8"); offsets=arr("offsets","<u4"); graph=arr("graph","<u4")
    order=np.fromfile(prev/"order-0.u32","<u4")
    if sha(ids[order].tobytes())!=tm["plates"][0]["orderedIdsSha256"]: raise ValueError("membership")
    cap=tm["capacities"]; tile=np.empty(len(ids),dtype=int); tile[order]=np.repeat(np.arange(len(cap)),cap)
    adj=[set() for _ in cap]
    for s,u in enumerate(tile.tolist()):
        for v in tile[graph[offsets[s]:offsets[s+1]]].tolist():
            if u!=v: adj[u].add(v); adj[v].add(u)
    ref=json.loads if False else [json.loads(l) for l in (prev/"topk.jsonl").read_bytes().splitlines()]
    scores=np.fromfile(prev/"scores.u32","<u4").reshape(253,3,len(ids))
    ledger=[json.loads(l) for l in read(prev/"per-query.jsonl","cf7d8ddea5fc2847b49442fd67183db32e3a15f1b5741c69c61c09569e6e9db7").splitlines()]
    ks={r["slot"]:r["kthScore"] for r in ledger if r["denominator"]==8 and r["plate"]==0 and r["summary"]=="aabb"}
    winners=[]
    for i,s in enumerate(scores[:,0]):
        ix=np.lexsort((ids,-s.astype("i4")))[:10]
        if ref[3*i]!=[dict(score=int(s[j]),id=int(ids[j])) for j in ix] or s[ix[-1]]!=ks[i]: raise ValueError("oracle mismatch")
        winners.append(sorted(set(tile[ix].tolist())))
    data=[measure(adj,winners)]; controls=[]
    for seed in range(1,6):
        a,meta=rewire(adj,seed); controls.append(meta); data.append(measure(a,winners))
    summary={}
    for key in data[0][0]:
        pairs=[(r[key],np.mean([g[i][key] for g in data[1:]])) for i,r in enumerate(data[0])
               if all(g[i][key] is not None for g in data)]
        if not pairs: continue
        real,null=np.array(pairs).T
        summary[key]=dict(n=len(real),real=float(real.mean()),null=float(null.mean()),
            pairedDelta=float((real-null).mean()),medianDelta=float(np.median(real-null)))
    result=dict(queries=len(winners),tiles=len(adj),edges=sum(map(len,adj))//2,
        componentCount=len(set(components(adj))),controls=controls,summary=summary)
    with (root/"winner-graph-dev-v1.json").open("x") as f: json.dump(dict(**result,perQuery=data),f)
    print(json.dumps(result))
if __name__=="__main__": main(Path(sys.argv[1]))