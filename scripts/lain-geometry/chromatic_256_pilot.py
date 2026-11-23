import json,time
import numpy as np

def refine(x,base):
    # Within each parent, split at the median contrast of two separated feature axes.
    y=x.T.astype('f8');y-=y.mean(axis=1,keepdims=True)
    y/=np.maximum(np.linalg.norm(y,axis=1,keepdims=True),1e-15)
    groups=[np.flatnonzero(base==k) for k in range(8)]
    for _ in range(5):
        children=[]
        for g in groups:
            a=y[g]; other=int(np.argmin(a@a[0]))
            contrast=a@(a[0]-a[other])
            order=g[np.lexsort((g,contrast))]
            children.extend(np.array_split(order,2))
        groups=children
    label=np.empty(len(base),'i4')
    for i,g in enumerate(groups):label[g]=i
    if not np.array_equal(label//32,base):raise ValueError('non-nested split')
    return label

def measure(s,h,lab,cap,K,select,eps):
    c=int(lab.max()+1)
    order=np.argsort(lab,kind='stable'); sizes=np.bincount(lab); starts=np.r_[0,sizes.cumsum()[:-1]]
    timings=[]
    for rep in range(4):
        clock=time.perf_counter_ns
        t=clock()
        E=np.add.reduceat(np.ascontiguousarray(h[:,order]),starts,axis=1)/sizes
        t1=clock()
        plain=np.log(E+eps).mean(axis=1)
        t2=clock()
        res=E-np.average(E,axis=0,weights=cap)
        norm=np.linalg.norm(res,axis=1,keepdims=True)
        hue=np.divide(res,norm,out=np.zeros_like(res),where=norm>1e-12)
        W=K*np.maximum(0,hue@hue.T)
        den=W.sum(axis=1,keepdims=True)
        mix=np.divide(W@E,den,out=E.copy(),where=den>1e-12)
        gated=np.log(.75*E+.25*mix+eps).mean(axis=1)
        t3=clock()
        if rep:timings.append([(t1-t)/1e6,(t2-t1)/1e6,(t3-t2)/1e6])
    if not np.allclose(E@sizes,h.sum(axis=1),rtol=1e-12):raise ValueError('mass conservation')
    w2,p2=select(plain);w3,p3=select(gated)
    return dict(slot=s,cards=c,C2=len(w2),C3=len(w3),C2pts=p2,C3pts=p3,
                w2=sorted(w2),w3=sorted(w3),ms=np.median(timings,axis=0).tolist(),fieldBytes=E.nbytes)

def finish(root,rows):
    if len(rows)!=32:raise ValueError('incomplete pilot')
    summary={}
    for c in (8,256):
        rr=sorted((r for r in rows if r['cards']==c),key=lambda r:r['slot'])
        summary[c]=dict(C2hits=sum(r['C2'] for r in rr),C3hits=sum(r['C3'] for r in rr),
                        msMedian=np.median([r['ms'] for r in rr],axis=0).tolist(),fieldBytes=rr[0]['fieldBytes'])
    for key in ('w2','w3'):
        pairs=[(set(a[key]),set(b[key])) for a in rows if a['cards']==8 for b in rows if b['cards']==256 and a['slot']==b['slot']]
        summary[key]=dict(gained=sum(len(b-a) for a,b in pairs),lost=sum(len(a-b) for a,b in pairs))
    with (root/'chromatic-256-pilot-v1.json').open('x') as f:json.dump(dict(summary=summary,rows=rows),f)
    print(json.dumps(summary))