import hashlib,json,random,sys
from pathlib import Path
import numpy as np
from starry_field_probe import checked
from winner_graph_probe import rewire

EPS=1/6849
def fixed_cards(x):
    # Signed feature correlation; spectral embedding then deterministic farthest-first Lloyd.
    y=x.astype('f8');y-=y.mean(axis=0)
    norm=np.linalg.norm(y,axis=0);y/=np.where(norm>0,norm,1)
    _,V=np.linalg.eigh(y.T@ y);v=V[:,-8:].copy()
    v/=np.maximum(np.linalg.norm(v,axis=1,keepdims=True),1e-15)
    centers=[v[0]];near=((v-centers[0])**2).sum(1)
    for _ in range(7):
        j=int(np.argmax(near));centers.append(v[j]);near=np.minimum(near,((v-v[j])**2).sum(1))
    centers=np.array(centers)
    for _ in range(100):
        label=np.argmin(((v[:,None]-centers)**2).sum(2),axis=1)
        if np.any(np.bincount(label,minlength=8)==0):raise ValueError('empty fixed card')
        new=np.stack([v[label==c].mean(0) for c in range(8)])
        if np.array_equal(new,centers):break
        centers=new
    return label

def main(root,pilot=False):
    root=root.resolve()
    if any((p/'.git').exists() for p in (root,*root.parents)):raise ValueError('private output only')
    pd=root/'plate-a';qd=root/'queries-a';prev=root/'p0-dev-v1'
    def man(p,h):return json.loads(checked(p,h))
    m=man(pd/'plate.json','cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73')
    qm=man(qd/'queries.json','b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005')
    tm=man(root/'tiles-a.json','2df6e0dcdc2050b5e5a0ab5f9d8772a78a7dca801e6597621983df9a0630d2ef')
    prior=[json.loads(l) for l in checked(root/'starry-fields-dev-v1.jsonl','0e077d04d1fdc928e93128ffabc58b376512fbe1499ac7138a58f3485c1e8755').splitlines()]
    old={r['slot']:r for r in prior if r['plate']==0 and r['field']=='hist8_ecdf'}
    def arr(k,dt):
        a=m['arrays'][k];return np.frombuffer(checked(pd/a['file'],a['sha256']),dt)
    ids=arr('ids','<u8');n=len(ids);d=m['dimensions'];x=arr('vectors','<f4').reshape(n,d)
    dev=np.frombuffer(checked(qd/'dev.f32le',qm['files']['dev.f32le']['sha256']),'<f4').reshape(253,d)
    order=np.fromfile(prev/'order-0.u32','<u4')
    if hashlib.sha256(ids[order].tobytes()).hexdigest()!=tm['plates'][0]['orderedIdsSha256']:raise ValueError('order')
    cap=np.array(tm['capacities']);starts=np.r_[0,cap.cumsum()[:-1]];nt=len(cap);tiles=np.arange(nt)
    tile=np.empty(n,'i4');tile[order]=np.repeat(tiles,cap)
    C=np.zeros((nt,nt),'i4')
    np.add.at(C,(np.repeat(tile,np.diff(arr('offsets','<u4'))),tile[arr('graph','<u4')]),1)
    C=C+C.T;np.fill_diagonal(C,0);adj=[set(map(int,np.flatnonzero(row))) for row in C]
    def kernel(A):
        ss=A.sum(1,keepdims=True);return np.divide(A,ss,out=np.zeros_like(A,dtype='f8'),where=ss>0)
    K=[kernel(C)]
    for seed in ([] if pilot else range(1,6)):
        g,_=rewire(adj,seed);rng=random.Random(104729+seed);A=np.zeros_like(C)
        for i,nb in enumerate(g):
            vals=C[i,sorted(adj[i])].tolist();rng.shuffle(vals);A[i,sorted(nb)]=vals
        K.append(kernel(A))
    fixed=fixed_cards(x)
    if pilot:
        from chromatic_256_pilot import refine, measure, finish
        if hashlib.sha256(fixed.astype('<i4').tobytes()).hexdigest()!='e03e4ea2d2f3baae04a25eeb775a1aecd3a87af5f6c5e0cdccf168105a4f1610':raise ValueError('eight-card replay')
        fine=refine(x,fixed); sample=set(np.linspace(0,252,16,dtype=int).tolist())
        reference=[json.loads(l) for l in checked(root/'chromatic-cards-dev-v1.jsonl','cccf8819aafb750e2a495a6c3ce0fa623ae3bd7b55d33a028999f8e5c174551b').splitlines()]
        ref8={(r['slot'],r['name']):r for r in reference if r['name'] in ('fixed_C2','fixed_C3')}
        if pilot=='full256':
            from chromatic_256_controls import FullAudit
            audit=FullAudit(root,fixed,fine,cap,K[0],EPS,ref8)
    sx=np.ascontiguousarray(np.sort(x.T,axis=1))
    cuts=sx[:,[(n-1)*j//8 for j in range(1,8)]].T
    tau=(cuts[5].astype('f8')-cuts[1])/8
    bounds=np.empty((9,d),'i4');bounds[0]=0;bounds[8]=n
    for j in range(d):bounds[1:8,j]=sx[j].searchsorted(cuts[:,j],'left')
    totals=np.diff(bounds,axis=0);bins=np.zeros_like(x,dtype='u1')
    for c in cuts:bins+=x>=c
    bins=bins[order];counts=np.stack([np.add.reduceat(bins==b,starts,axis=0,dtype='u1') for b in range(8)])
    topref=[json.loads(l) for l in (prev/'topk.jsonl').read_bytes().splitlines()][::3]
    scores=np.memmap(prev/'scores.u32','<u4','r',shape=(253,3,n))
    rows=[]
    for s,q in enumerate(dev):
        if pilot and pilot!='full256' and s not in sample:continue
        lo=q-tau;hi=q+tau
        l=np.fromiter((sx[j].searchsorted(lo[j],'left') for j in range(d)),dtype='i4',count=d)
        r=np.fromiter((sx[j].searchsorted(hi[j],'right') for j in range(d)),dtype='i4',count=d)
        p=(r-l)/n;info=-np.log(np.maximum(p,EPS))
        mass=np.maximum(0,np.minimum(r,bounds[1:])-np.maximum(l,bounds[:-1]))
        prob=np.divide(mass,totals,out=np.zeros((8,d),'f8'),where=totals>0)
        h=np.einsum('btd,bd->td',counts,prob,optimize=False)/cap[:,None]
        base=np.einsum('btd,bd->t',counts,prob,optimize=False)/cap
        if not np.allclose(h.sum(1),base,rtol=1e-12):raise ValueError('card mass')
        top=np.lexsort((ids,-scores[s,0].astype('i4')))[:10]
        if ids[top].tolist()!=[a['id'] for a in topref[s]]:raise ValueError('truth')
        def select(f):
            if not np.isfinite(f).all():raise ValueError('nonfinite field')
            chosen=[];used=0
            for t in np.lexsort((tiles,-f)):
                if used+cap[t]<=128:chosen.append(t);used+=int(cap[t])
                if used==128:break
            return set(ids[top[np.isin(tile[top],chosen)]].tolist()),used
        before,used=select(base)
        if (len(before),used)!=(old[s]['hits'],old[s]['points']):raise ValueError('C0 replay')
        if pilot:
            if pilot=='full256':
                audit.observe(s,h,select)
                continue
            for lab in ((fixed,fine) if len(rows)%4==0 else (fine,fixed)):
                result=measure(s,h,lab,cap,K[0],select,EPS)
                if result['cards']==8:
                    for name in ('C2','C3'):
                        ref=ref8[s,'fixed_'+name]
                        if (result[name],result[name+'pts'])!=(ref['hits'],ref['points']):raise ValueError('8-color replay')
                rows.append(result)
            continue
        def add(name,field,ref):
            wins,pts=select(field)
            rows.append(dict(slot=s,name=name,hits=len(wins),points=pts,gained=len(wins-ref),lost=len(ref-wins)))
            return wins
        add('C0',base,before);add('C1',h@info,before)
        qc=np.empty(d,'i4')
        for sign,idx in enumerate([np.flatnonzero(q<cuts[3]),np.flatnonzero(q>=cuts[3])]):
            if len(idx)<4:raise ValueError('empty query card')
            ranked=idx[np.lexsort((idx,info[idx]))]
            for k,part in enumerate(np.array_split(ranked,4)):qc[part]=4*sign+k
        for tag,lab in [('query',qc),('fixed',fixed)]:
            E=np.stack([h[:,lab==k].mean(1) for k in range(8)],axis=1)
            def soft(e):return np.log(e+EPS).mean(1)
            add(tag+'_arithmetic',E.mean(1),before)
            c2=add(tag+'_C2',soft(E),before)
            # Corpus-point-weighted background, not equal weight for the singleton tile.
            residual=E-np.average(E,axis=0,weights=cap)
            norm=np.linalg.norm(residual,axis=1,keepdims=True)
            hue=np.divide(residual,norm,out=np.zeros_like(residual),where=norm>1e-12)
            gate=np.maximum(0,hue@hue.T)
            add(tag+'_ungated',soft(.75*E+.25*(K[0]@E)),c2)
            for ix,kk in enumerate(K):
                W=kk*gate;sums=W.sum(1,keepdims=True)
                mixed=np.divide(W@E,sums,out=E.copy(),where=sums>1e-12)
                add(tag+('_C3' if ix==0 else '_rewire'+str(ix)),soft(.75*E+.25*mixed),c2)
    if pilot=='full256':return audit.finish()
    if pilot:return finish(root,rows)
    if len(rows)!=253*20:raise ValueError('matrix')
    target=root/'chromatic-cards-dev-v1.jsonl'
    with target.open('x') as f:
        for row in rows:f.write(json.dumps(row)+'\n')
    summary={}
    for name in dict.fromkeys(r['name'] for r in rows):
        key=name.split('_rewire')[0]+'_rewire' if '_rewire' in name else name
        if key in summary:continue
        rr=[r for r in rows if (r['name'].startswith(key) if key.endswith('_rewire') else r['name']==key)]
        summary[key]=dict(trajectories=len(rr),recall=sum(r['hits'] for r in rr)/(10*len(rr)),
            atLeastOne=sum(r['hits']>0 for r in rr)/len(rr),gained=sum(r['gained'] for r in rr),lost=sum(r['lost'] for r in rr),
            meanPoints=sum(r['points'] for r in rr)/len(rr))
    print(json.dumps(dict(rows=len(rows),fixedSizes=np.bincount(fixed).tolist(),fixedSha=hashlib.sha256(fixed.astype('<i4').tobytes()).hexdigest(),sha=hashlib.sha256(target.read_bytes()).hexdigest(),summary=summary)))
if __name__=='__main__':
    mode={():False,('--256-pilot',):True,('--256-controls',):'full256'}[tuple(sys.argv[2:])]
    main(Path(sys.argv[1]),pilot=mode)