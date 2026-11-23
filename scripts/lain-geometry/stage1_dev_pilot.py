import hashlib, json, sys, time
from pathlib import Path
import numpy as np
from winner_graph_probe import read, rewire

BP,BV,FAN,BETA=64,128,8,0.5
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def run(root,audit=False):
    root=root.resolve()
    if any((p/'.git').exists() for p in (root,*root.parents)): raise ValueError('private output required')
    pd=root/'plate-a'; qd=root/'queries-a'; prev=root/'p0-dev-v1'
    def manifest(p,h): return json.loads(read(p,h))
    m=manifest(pd/'plate.json','cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73')
    qm=manifest(qd/'queries.json','b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005')
    tm=manifest(root/'tiles-a.json','2df6e0dcdc2050b5e5a0ab5f9d8772a78a7dca801e6597621983df9a0630d2ef')
    def arr(k,dt):
        a=m['arrays'][k]; return np.frombuffer(read(pd/a['file'],a['sha256']),dt)
    ids=arr('ids','<u8'); n=len(ids); d=m['dimensions']
    order=np.fromfile(prev/'order-0.u32','<u4')
    if hashlib.sha256(ids[order].tobytes()).hexdigest()!=tm['plates'][0]['orderedIdsSha256']: raise ValueError('order')
    cap=tm['capacities']; nt=len(cap); start=np.r_[0,np.cumsum(cap)]
    tile=np.empty(n,int); tile[order]=np.repeat(np.arange(nt),cap)
    seeds=[]
    for key in ('entries','directionLandmarks','shellLandmarks'):
        for s in arr(key,'<u4'):
            t=int(tile[s])
            if t not in seeds: seeds.append(t)
    seeds=seeds[:4]
    if not seeds: raise ValueError('no frozen entry')
    offsets=arr('offsets','<u4'); graph=arr('graph','<u4')
    base=[set() for _ in cap]
    for i,t in enumerate(tile):
        for j in tile[graph[offsets[i]:offsets[i+1]]]:
            if t!=j: base[t].add(int(j));base[j].add(int(t))
    def frozen(a):
        return [sorted(nb,key=lambda j:hashlib.sha256(f's1-v1:{i}:{j}'.encode()).digest()) for i,nb in enumerate(a)]
    gs=[frozen(base)]+([] if audit else [frozen(rewire(base,s)[0]) for s in range(1,6)])
    x=arr('vectors','<f4').reshape(n,d)[order]; ids=ids[order]
    cuts=np.sort(x,axis=0)[[(n-1)*j//8 for j in range(1,8)]]
    tau=(cuts[5].astype('f8')-cuts[1])/8
    b=np.zeros(x.shape,'u1')
    for c in cuts: b+=x>=c
    occ=np.bitwise_or.reduceat(np.uint8(1)<<b,start[:-1],axis=0); del b
    dev=np.frombuffer(read(qd/'dev.f32le',qm['files']['dev.f32le']['sha256']),'<f4').reshape(253,d)
    tops=[json.loads(l) for l in (prev/'topk.jsonl').read_bytes().splitlines()][::3]
    ref=np.memmap(prev/'scores.u32','<u4','r',shape=(253,3,n))
    out=root/('stage1-pool-audit-v1' if audit else 'stage1-dev-pilot-v1');out.mkdir(mode=0o700)
    if audit:
        prior_rows=read(root/'stage1-dev-pilot-v1'/'rows.jsonl','3cfa5c1635deb5b1e9202ce277dbbf6cc483416a5a6510843590ede3155c77b5')
        prior_true={r['slot']:r for r in map(json.loads,prior_rows.splitlines()) if r['graph']==0 and r['beta']==0}
    def navigate(q,adj,beta,scan,observe=None):
        ts=time.perf_counter_ns()
        lo=q-tau;hi=q+tau; mask=np.zeros(d,'u1')
        for k in range(8):
            l=cuts[k-1] if k else -np.inf;r=cuts[k] if k<7 else np.inf
            mask|=((l<r)&(hi>=l)&(lo<r)).astype('u1')<<k
        h={};u={};priority={};cursor={};verified=set();trace=[];points=0
        def probe(t):
            h[t]=int.from_bytes(np.packbits((occ[t]&mask)!=0).tobytes(),'little')
            u[t]=h[t].bit_count();priority[t]=float('-inf');cursor[t]=0
        def verify(t):
            nonlocal points
            if observe is not None: observe.append((list(h),t))
            v=x[start[t]:start[t+1]]
            s=((v>=lo)&(v<=hi)).sum(axis=1)
            trace.append((len(h),points,[(int(sc),int(i)) for sc,i in zip(s,ids[start[t]:start[t+1]])]))
            points+=cap[t];verified.add(t)
        if scan:
            for t in range(nt): probe(t);priority[t]=u[t]
        else:
            for t in seeds: probe(t);priority[t]=u[t]
        while points<BV:
            if not scan and len(h)<BP:
                active=[t for t in h if cursor[t]<len(adj[t])]
                if active:
                    i=max(active,key=lambda t:(priority[t],-t)); fresh=0
                    while cursor[i]<len(adj[i]) and fresh<FAN and len(h)<BP:
                        j=adj[i][cursor[i]];cursor[i]+=1
                        if j not in h: probe(j);fresh+=1
                        priority[j]=max(priority[j],u[j]-beta*(h[i]^h[j]).bit_count())
            cand=[t for t in h if t not in verified and cap[t]<=BV-points]
            if cand: verify(max(cand,key=lambda t:(priority[t],-t)))
            elif scan or len(h)>=BP or not any(cursor[t]<len(adj[t]) for t in h): break
        ranked=sorted((pair for _,_,chunk in trace for pair in chunk),key=lambda a:(-a[0],a[1]))[:10]
        return len(h),points,trace,ranked,(time.perf_counter_ns()-ts)/1e6
    with (out/'rows.jsonl').open('x') as f:
        for slot,q in enumerate(dev):
            exact=ref[slot,0,order]; top=np.lexsort((ids,-exact.astype('i4')))[:10]
            truth={(int(exact[i]),int(ids[i])) for i in top}
            if truth!={(a['score'],a['id']) for a in tops[slot]}: raise ValueError('truth mismatch')
            truth_map=dict(zip(map(int,ids),map(int,exact)))
            jobs=[(0,0)] if audit else [(g,b) for g in range(6) for b in (0,BETA)]+[(-1,0)]
            for g,beta in jobs[slot%13:]+jobs[:slot%13]:
                actions=[] if audit else None
                p,v,tr,rank,ms=navigate(q,gs[g],beta,g<0,actions)
                hits=[]; first=None
                for probes,prior,chunk in tr:
                    if any(truth_map[i]!=s for s,i in chunk): raise ValueError('verification mismatch')
                    winners=[i for s,i in chunk if (s,i) in truth]
                    if winners and first is None: first=(probes,prior+len(chunk))
                    hits.append((prior+len(chunk),len(winners)))
                matched=len(truth.intersection(rank))
                if matched!=sum(k for _,k in hits) or p>(nt if g<0 else BP) or v>BV: raise ValueError('budget or ranking')
                after=None
                if first and v>=first[1]+32: after=sum(k for end,k in hits if first[1]<end<=first[1]+32)
                if audit:
                    prevrow=prior_true[slot]
                    if (prevrow['probe'],prevrow['verify'],prevrow['recall'],prevrow['first'],prevrow['extra32'])!=(p,v,matched/10,list(first) if first else None,after):
                        raise ValueError('pilot replay mismatch')
                    from stage1_pool_oracles import decompose
                    wtiles=np.searchsorted(start[1:],top,side='right').tolist()
                    result=decompose(actions,wtiles,cap,BV,matched,p)
                    f.write(json.dumps(dict(slot=slot,**result))+'\n')
                    continue
                f.write(json.dumps(dict(slot=slot,graph=g,beta=beta,probe=p,verify=v,recall=matched/10,
                    first=first,extra32=after,ms=ms))+'\n')
    print(json.dumps(dict(complete=True,queries=253,rows=253*len(jobs),seeds=seeds,sha256=digest(out/'rows.jsonl'))))
if __name__=='__main__': run(Path(sys.argv[1]),audit=sys.argv[2:]==['--pool-audit'])