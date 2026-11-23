import hashlib,json,sys
from pathlib import Path
import numpy as np
from starry_field_probe import checked

def main(root):
    root=root.resolve()
    if any((p/'.git').exists() for p in (root,*root.parents)):raise ValueError('private output required')
    pd,qd=root/'plate-a',root/'queries-a'
    def load(p,h):return json.loads(checked(p,h))
    m=load(pd/'plate.json','cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73')
    qm=load(qd/'queries.json','b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005')
    old={r['slot']:r for r in map(json.loads,checked(root/'point-identity-dev-v1.jsonl','158c82f7df4ce72fef164076284ba585ef2af366d0632e26f8cd3ed8a7bae025').splitlines())}
    def arr(k,t):
        a=m['arrays'][k];return np.frombuffer(checked(pd/a['file'],a['sha256']),t)
    ids=arr('ids','<u8');n=len(ids);d=m['dimensions']
    x=arr('vectors','<f4').reshape(n,d)
    dev=np.frombuffer(checked(qd/'dev.f32le',qm['files']['dev.f32le']['sha256']),'<f4').reshape(253,d)
    sx=np.ascontiguousarray(np.sort(x.T,axis=1));cuts=sx[:,[(n-1)*j//8 for j in range(1,8)]].T
    tau=(cuts[5].astype('f8')-cuts[1])/8
    bounds=np.empty((9,d),'i4');bounds[0]=0;bounds[8]=n
    for j in range(d):bounds[1:8,j]=sx[j].searchsorted(cuts[:,j],'left')
    totals=np.diff(bounds,axis=0)
    bins=np.zeros_like(x,dtype='u1')
    for c in cuts:bins+=x>=c
    codes={3:bins,2:bins>>1}; denom={3:totals,2:totals.reshape(4,2,d).sum(axis=1)}
    dims=np.arange(d);rows=[]; budgets=(32,64,128)
    for slot,q in enumerate(dev):
        lo=q-tau;hi=q+tau
        exact=((x>=lo)&(x<=hi)).sum(axis=1)
        truth=set(map(int,ids[np.lexsort((ids,-exact))[:10]]))
        l=np.fromiter((sx[j].searchsorted(lo[j],'left') for j in range(d)),dtype='i4',count=d)
        r=np.fromiter((sx[j].searchsorted(hi[j],'right') for j in range(d)),dtype='i4',count=d)
        mass=np.maximum(0,np.minimum(r,bounds[1:])-np.maximum(l,bounds[:-1]))
        if not np.array_equal(mass.sum(axis=0),r-l):raise ValueError('lost window mass')
        for depth in (3,2):
            hits=mass if depth==3 else mass.reshape(4,2,d).sum(axis=1)
            prob=np.divide(hits,denom[depth],out=np.zeros_like(hits,dtype='f8'),where=denom[depth]>0)
            point=np.empty(n)
            for i in range(0,n,128):
                point[i:i+128]=prob[codes[depth][i:i+128],dims].sum(axis=1)
            rank=np.lexsort((ids,-point))
            for budget in budgets:
                cand=rank[:budget]; cutoff=point[cand[-1]]
                result=sorted(truth.intersection(map(int,ids[cand])))
                if depth==3 and budget==128 and result!=old[slot]['globalPoint']:raise ValueError('3-bit replay')
                rows.append(dict(slot=slot,bits=depth,budget=budget,winners=result,
                                 splitTie=bool((point==cutoff).sum()>(point[cand]==cutoff).sum())))
    D={(r['slot'],r['bits'],r['budget']):r for r in rows}
    if len(rows)!=1518 or len(D)!=len(rows):raise ValueError('matrix')
    out=root/'point-bitdepth-dev-v1.jsonl'
    with out.open('x') as f:
        for r in rows:f.write(json.dumps(r)+'\n')
    summary=[]
    for budget in budgets:
        aa=[D[s,3,budget] for s in range(253)];bb=[D[s,2,budget] for s in range(253)]
        a=[set(r['winners']) for r in aa];b=[set(r['winners']) for r in bb]
        z=np.array([len(y)-len(x) for x,y in zip(a,b)])
        summary.append(dict(budget=budget,hits3=sum(map(len,a)),hits2=sum(map(len,b)),
            none3=sum(not x for x in a),none2=sum(not x for x in b),
            all3=sum(len(x)==10 for x in a),all2=sum(len(x)==10 for x in b),
            gained=sum(len(y-x) for x,y in zip(a,b)),lost=sum(len(x-y) for x,y in zip(a,b)),
            wins=int((z>0).sum()),ties=int((z==0).sum()),losses=int((z<0).sum()),
            splitTies3=sum(r['splitTie'] for r in aa),splitTies2=sum(r['splitTie'] for r in bb)))
    print(json.dumps(dict(rows=len(rows),denominator=2530,summary=summary,
        packedPayloadBytes={k:(n*d*k+7)//8 for k in (2,3)},sha256=hashlib.sha256(out.read_bytes()).hexdigest())))
if __name__=='__main__':main(Path(sys.argv[1]))