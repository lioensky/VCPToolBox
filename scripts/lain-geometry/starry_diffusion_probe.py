import hashlib,json,random,sys
from pathlib import Path
import numpy as np
from winner_graph_probe import rewire
from starry_field_probe import checked

def main(root):
    root=root.resolve()
    if any((p/'.git').exists() for p in (root,*root.parents)):raise ValueError('private output required')
    pd=root/'plate-a';qd=root/'queries-a';prev=root/'p0-dev-v1'
    m=json.loads(checked(pd/'plate.json','cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73'))
    qm=json.loads(checked(qd/'queries.json','b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005'))
    tm=json.loads(checked(root/'tiles-a.json','2df6e0dcdc2050b5e5a0ab5f9d8772a78a7dca801e6597621983df9a0630d2ef'))
    old={}
    for line in checked(root/'starry-fields-dev-v1.jsonl','0e077d04d1fdc928e93128ffabc58b376512fbe1499ac7138a58f3485c1e8755').splitlines():
        r=json.loads(line)
        if r['plate']==0 and r['field']=='hist8_ecdf':old[r['slot']]=r
    def arr(k,typ):
        a=m['arrays'][k];return np.frombuffer(checked(pd/a['file'],a['sha256']),typ)
    ids=arr('ids','<u8');n=len(ids);d=m['dimensions']
    x=arr('vectors','<f4').reshape(n,d)
    q=np.frombuffer(checked(qd/'dev.f32le',qm['files']['dev.f32le']['sha256']),'<f4').reshape(253,d)
    order=np.fromfile(prev/'order-0.u32','<u4')
    if hashlib.sha256(ids[order].tobytes()).hexdigest()!=tm['plates'][0]['orderedIdsSha256']:raise ValueError('order')
    cap=np.array(tm['capacities']);nt=len(cap);tiles=np.arange(nt);starts=np.r_[0,cap.cumsum()[:-1]]
    tile=np.empty(n,'i4');tile[order]=np.repeat(tiles,cap)
    # Count directed CSR records in either direction; mutual arcs count twice.
    off=arr('offsets','<u4');edges=arr('graph','<u4')
    C=np.zeros((nt,nt),'i8')
    np.add.at(C,(np.repeat(tile,np.diff(off)),tile[edges]),1)
    C=C+C.T;np.fill_diagonal(C,0)
    adj=[set(map(int,np.flatnonzero(row))) for row in C]
    if sum(map(len,adj))!=48674:raise ValueError('topology mismatch')
    def norm(a):
        s=a.sum(axis=1,keepdims=True)
        if np.any(s==0):raise ValueError('isolated tile')
        return a/s
    kernels={'weighted':norm(C),'unweighted':norm(C>0)}
    for seed in range(1,6):
        rew,_=rewire(adj,seed)
        for tag,neighbors in [('shuffleWeight',adj),('rewired',rew)]:
            rng=random.Random(104729+seed);A=np.zeros_like(C)
            for i,nb in enumerate(neighbors):
                vals=C[i,sorted(adj[i])].tolist();rng.shuffle(vals)
                A[i,sorted(nb)]=vals
            if not np.array_equal(np.sort(A,axis=1),np.sort(C,axis=1)):raise ValueError('row strength')
            kernels[f'{tag}{seed}']=norm(A)
    cuts=np.sort(x,axis=0)[[(n-1)*j//8 for j in range(1,8)]]
    tau=(cuts[5].astype('f8')-cuts[1])/8;sx=np.ascontiguousarray(np.sort(x.T,axis=1))
    bounds=np.empty((9,d),'i4');bounds[0]=0;bounds[-1]=n
    for j in range(d):bounds[1:8,j]=sx[j].searchsorted(cuts[:,j],'left')
    totals=np.diff(bounds,axis=0)
    bins=np.zeros((n,d),'u1')
    for c in cuts:bins+=x>=c
    bins=bins[order];counts=np.stack([np.add.reduceat(bins==b,starts,axis=0,dtype='u1') for b in range(8)])
    sc=np.memmap(prev/'scores.u32','<u4','r',shape=(253,3,n))
    tops=[json.loads(l) for l in (prev/'topk.jsonl').read_bytes().splitlines()][::3]
    def pick(field):
        chosen=[];pts=0
        for t in np.lexsort((tiles,-field)):
            if pts+cap[t]<=128:chosen.append(t);pts+=int(cap[t])
            if pts==128:break
        return chosen,pts
    records=[]
    for s,v in enumerate(q):
        lo=v-tau;hi=v+tau
        l=np.fromiter((sx[j].searchsorted(lo[j],'left') for j in range(d)),dtype='i4',count=d)
        r=np.fromiter((sx[j].searchsorted(hi[j],'right') for j in range(d)),dtype='i4',count=d)
        mass=np.maximum(0,np.minimum(r,bounds[1:])-np.maximum(l,bounds[:-1]))
        prob=np.divide(mass,totals,out=np.zeros((8,d),'f8'),where=totals>0)
        e=np.einsum('btd,bd->t',counts,prob,optimize=False)/cap
        top=np.lexsort((ids,-sc[s,0].astype('i4')))[:10]
        if [int(i) for i in ids[top]]!=[a['id'] for a in tops[s]]:raise ValueError('truth')
        def winners(ts):return set(map(int,ids[top[np.isin(tile[top],ts)]]))
        baseline,pts=pick(e);before=winners(baseline)
        if (len(before),pts)!=(old[s]['hits'],old[s]['points']):raise ValueError('baseline mismatch')
        for name,K in kernels.items():
            field=.75*e+.25*np.einsum('ij,j->i',K,e,optimize=False)
            ts,used=pick(field);after=winners(ts)
            records.append(dict(slot=s,kernel=name,hits=len(after),base=len(before),points=used,
                                gained=len(after-before),lost=len(before-after)))
    if len(records)!=253*12:raise ValueError('matrix')
    target=root/'starry-diffusion-dev-v1.jsonl'
    with target.open('x') as f:
        for row in records:f.write(json.dumps(row)+'\n')
    summary={}
    for group in ('weighted','unweighted','shuffleWeight','rewired'):
        rr=[r for r in records if r['kernel'].startswith(group)]
        gains=sum(r['gained'] for r in rr);loss=sum(r['lost'] for r in rr)
        summary[group]=dict(trajectories=len(rr),recall=sum(r['hits'] for r in rr)/(10*len(rr)),
            gained=gains,lost=loss,firstHit=sum(r['hits']>0 for r in rr)/len(rr),
            wins=sum(r['hits']>r['base'] for r in rr),ties=sum(r['hits']==r['base'] for r in rr),
            losses=sum(r['hits']<r['base'] for r in rr),meanPoints=np.mean([r['points'] for r in rr]))
    print(json.dumps(dict(complete=True,baselineHits=sum(r['hits'] for r in old.values()),records=len(records),
        sha256=hashlib.sha256(target.read_bytes()).hexdigest(),summary=summary)))
if __name__=='__main__':main(Path(sys.argv[1]))