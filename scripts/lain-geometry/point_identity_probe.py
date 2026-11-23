import hashlib,json,sys
from pathlib import Path
import numpy as np
from starry_field_probe import checked

def main(root):
    root=root.resolve()
    if any((p/'.git').exists() for p in (root,*root.parents)):raise ValueError('private output required')
    pd=root/'plate-a';qd=root/'queries-a';prev=root/'p0-dev-v1'
    def man(p,h):return json.loads(checked(p,h))
    m=man(pd/'plate.json','cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73')
    qm=man(qd/'queries.json','b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005')
    tm=man(root/'tiles-a.json','2df6e0dcdc2050b5e5a0ab5f9d8772a78a7dca801e6597621983df9a0630d2ef')
    old={}
    for l in checked(root/'starry-fields-dev-v1.jsonl','0e077d04d1fdc928e93128ffabc58b376512fbe1499ac7138a58f3485c1e8755').splitlines():
        r=json.loads(l)
        if r['plate']==0 and r['field']=='hist8_ecdf':old[r['slot']]=r
    def arr(k,t):
        a=m['arrays'][k];return np.frombuffer(checked(pd/a['file'],a['sha256']),t)
    ids=arr('ids','<u8');d=m['dimensions'];n=len(ids);x=arr('vectors','<f4').reshape(n,d)
    dev=np.frombuffer(checked(qd/'dev.f32le',qm['files']['dev.f32le']['sha256']),'<f4').reshape(253,d)
    cap=np.array(tm['capacities']);ts=np.arange(len(cap));starts=np.r_[0,cap.cumsum()[:-1]]
    order=np.fromfile(prev/'order-0.u32','<u4')
    if hashlib.sha256(ids[order].tobytes()).hexdigest()!=tm['plates'][0]['orderedIdsSha256']:raise ValueError('order')
    tile=np.empty(n,'i4');tile[order]=np.repeat(ts,cap)
    sx=np.ascontiguousarray(np.sort(x.T,axis=1));cuts=sx[:,[(n-1)*j//8 for j in range(1,8)]].T
    tau=(cuts[5].astype('f8')-cuts[1])/8
    bounds=np.empty((9,d),'i4');bounds[0]=0;bounds[8]=n
    for j in range(d):bounds[1:8,j]=sx[j].searchsorted(cuts[:,j],'left')
    totals=np.diff(bounds,axis=0);bins=np.zeros(x.shape,'u1')
    for c in cuts:bins+=x>=c
    ob=bins[order];counts=np.stack([np.add.reduceat(ob==b,starts,axis=0,dtype='u1') for b in range(8)])
    del ob
    truthfile=[json.loads(l) for l in (prev/'topk.jsonl').read_bytes().splitlines()][::3]
    oracle=np.memmap(prev/'scores.u32','<u4','r',shape=(253,3,n))
    dims=np.arange(d);rows=[];maxerr=0
    for s,q in enumerate(dev):
        lo=q-tau;hi=q+tau
        l=np.fromiter((sx[j].searchsorted(lo[j],'left') for j in range(d)),dtype='i4',count=d)
        r=np.fromiter((sx[j].searchsorted(hi[j],'right') for j in range(d)),dtype='i4',count=d)
        mass=np.maximum(0,np.minimum(r,bounds[1:])-np.maximum(l,bounds[:-1]))
        prob=np.divide(mass,totals,out=np.zeros((8,d),'f8'),where=totals>0)
        field=np.einsum('btd,bd->t',counts,prob,optimize=False)/cap
        pts=np.empty(n)
        for i in range(0,n,128):pts[i:i+128]=prob[bins[i:i+128],dims].sum(axis=1)
        err=float(np.max(np.abs(np.add.reduceat(pts[order],starts)/cap-field)));maxerr=max(err,maxerr)
        if err>1e-8:raise ValueError('point to tile mean mismatch')
        exact=((x>=lo)&(x<=hi)).sum(axis=1)
        if not np.array_equal(exact,oracle[s,0]):raise ValueError('truth mismatch')
        winners=np.lexsort((ids,-exact))[:10]
        if list(map(int,ids[winners]))!=[a['id'] for a in truthfile[s]]:raise ValueError('topk mismatch')
        ranked=np.lexsort((ts,-field));chosen=[];used=0
        for t in ranked:
            if used+cap[t]<=128:chosen.append(t);used+=int(cap[t])
            if used==128:break
        cand0=np.flatnonzero(np.isin(tile,chosen))
        pool=np.flatnonzero(np.isin(tile,ranked[:32]))
        def pointpick(ix):
            cand=ix[np.lexsort((ids[ix],-pts[ix]))[:128]]
            cut=pts[cand[-1]]
            return cand,dict(at=int((pts[ix]==cut).sum()),taken=int((pts[cand]==cut).sum()))
        cand1,t1=pointpick(np.arange(n));cand2,t2=pointpick(pool)
        def hit(cand):
            final=cand[np.lexsort((ids[cand],-exact[cand]))[:10]]
            return sorted(set(map(int,ids[winners])).intersection(map(int,ids[final])))
        a,b,c=map(hit,(cand0,cand1,cand2))
        if (len(a),len(cand0))!=(old[s]['hits'],old[s]['points']):raise ValueError('baseline')
        rows.append(dict(slot=s,tile=a,globalPoint=b,shortPoint=c,poolHits=int(np.isin(winners,pool).sum()),
                         tileCost=len(cand0),poolSize=len(pool),globalTie=t1,shortTie=t2))
    dest=root/'point-identity-dev-v1.jsonl'
    with dest.open('x') as f:
        for r in rows:f.write(json.dumps(r)+'\n')
    summary={}
    for k in ('tile','globalPoint','shortPoint'):
        hits=[len(r[k]) for r in rows];delta=[z-len(r['tile']) for z,r in zip(hits,rows)]
        summary[k]=dict(recall=sum(hits)/2530,atLeastOne=sum(z>0 for z in hits)/253,hits=sum(hits),
            wins=sum(z>0 for z in delta),ties=sum(z==0 for z in delta),losses=sum(z<0 for z in delta),
            gained=sum(len(set(r[k])-set(r['tile'])) for r in rows),lost=sum(len(set(r['tile'])-set(r[k])) for r in rows))
    print(json.dumps(dict(rows=len(rows),sha=hashlib.sha256(dest.read_bytes()).hexdigest(),maxMeanError=maxerr,
        summary=summary,pool32Coverage=sum(r['poolHits'] for r in rows)/2530,
        meanPoolSize=np.mean([r['poolSize'] for r in rows]),splitTies={k:sum(r[k]['at']>r[k]['taken'] for r in rows) for k in ('globalTie','shortTie')})))
if __name__=='__main__':main(Path(sys.argv[1]))