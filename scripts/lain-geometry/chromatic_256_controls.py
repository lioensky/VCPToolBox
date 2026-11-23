import hashlib,json,time
import numpy as np

class FullAudit:
    def __init__(self,root,base,fine,cap,K,eps,ref8):
        self.cap,self.K,self.eps,self.ref8=cap,K,eps,ref8
        self.out=root/'chromatic-256-controls-dev-v1'
        self.out.mkdir(mode=0o700)
        self.pilot={(r['slot'],r['cards']):r for r in json.loads((root/'chromatic-256-pilot-v1.json').read_bytes())['rows']}
        self.plans={};self.rows=[]
        def plan(name,lab):
            sizes=np.bincount(lab)
            self.plans[name]=(np.argsort(lab,kind='stable'),sizes,np.r_[0,sizes.cumsum()[:-1]])
        plan('base8',base);plan('coherent',fine)
        for seed in range(1,6):
            rng=np.random.Generator(np.random.PCG64(seed));lab=fine.copy()
            for c in range(8):
                ix=np.flatnonzero(base==c);lab[ix]=rng.permutation(fine[ix])
            if not np.array_equal(lab//32,base) or not np.array_equal(np.bincount(lab),np.bincount(fine)):raise ValueError('invalid control')
            plan('random'+str(seed),lab)

    def observe(self,s,h,select):
        names=list(self.plans); names=names[s%7:]+names[:s%7]
        batch=[]
        for name in names:
            order,sizes,starts=self.plans[name];c=len(sizes);clock=time.perf_counter_ns
            t=clock();E=np.add.reduceat(np.ascontiguousarray(h[:,order]),starts,axis=1)/sizes;t1=clock()
            logE=np.log(E+self.eps);plain=logE.mean(axis=1);t2=clock()
            res=E-np.average(E,axis=0,weights=self.cap)
            norm=np.linalg.norm(res,axis=1,keepdims=True)
            hue=np.divide(res,norm,out=np.zeros_like(res),where=norm>1e-12)
            W=self.K*np.maximum(0,hue@hue.T);den=W.sum(axis=1,keepdims=True)
            mix=np.divide(W@E,den,out=E.copy(),where=den>1e-12)
            gated=np.log(.75*E+.25*mix+self.eps).mean(axis=1);t3=clock()
            if not np.allclose(E@sizes,h.sum(axis=1),rtol=1e-12):raise ValueError('mass conservation')
            a,p=select(plain);b,q=select(gated)
            if c==8:
                for key,w,cost in [('C2',a,p),('C3',b,q)]:
                    ref=self.ref8[s,'fixed_'+key]
                    if (len(w),cost)!=(ref['hits'],ref['points']):raise ValueError('eight-card replay')
            if (s,c) in self.pilot and name in ('base8','coherent'):
                ref=self.pilot[s,c]
                if sorted(a)!=ref['w2'] or sorted(b)!=ref['w3']:raise ValueError('pilot winners mismatch')
            diag={}
            if c==256:
                wt=sizes.reshape(8,32);wt=wt/wt.sum(1,keepdims=True)
                z=E.reshape(-1,8,32);mu=(z*wt).sum(2)
                gap=(np.log(mu+self.eps)-(logE.reshape(-1,8,32)*wt).sum(2)).mean(1)
                if gap.min() < -1e-12:raise ValueError('Jensen violation')
                tiles=np.arange(len(E))
                def picked(field):
                    result=[];used=0
                    for i in np.lexsort((tiles,-field)):
                        if used+self.cap[i]<=128:result.append(i);used+=self.cap[i]
                        if used==128:break
                    return set(result)
                selected=picked(plain)
                parents=picked(np.log(mu+self.eps).mean(1))
                removed=sorted(parents-selected);added=sorted(selected-parents)
                diag=dict(zero=float((E==0).mean()),variance=float((((z-mu[:,:,None])**2*wt).sum(2)).mean()),
                          gap=float(gap.mean()),removed=len(removed),added=len(added),
                          gapRemovedSum=float(gap[removed].sum()),gapAddedSum=float(gap[added].sum()))
            batch.append(dict(slot=s,name=name,C2=len(a),C3=len(b),p2=p,p3=q,w2=sorted(a),w3=sorted(b),
                              ms=[(t1-t)/1e6,(t2-t1)/1e6,(t3-t2)/1e6],**diag))
        self.rows.extend(batch)
        with (self.out/'rows.jsonl').open('a',encoding='utf8') as f:
            for r in batch:f.write(json.dumps(r,separators=(',',':'))+'\n')

    def finish(self):
        D={(r['slot'],r['name']):r for r in self.rows}
        if len(D)!=len(self.rows) or set(D)!={(s,k) for s in range(253) for k in self.plans}:raise ValueError('incomplete matrix')
        names=list(self.plans); groups={'base8':['base8'],'coherent':['coherent'],'random':names[2:]}
        def series(g,key):
            return np.array([np.mean([D[s,k][key] for k in groups[g]]) for s in range(253)])
        report={}
        for g,ks in groups.items():
            rr=[r for r in self.rows if r['name'] in ks]
            report[g]=dict(trajectories=len(rr),recall2=float(series(g,'C2').mean()/10),
                           recall3=float(series(g,'C3').mean()/10),points=[float(series(g,k).mean()) for k in ('p2','p3')],
                           msMedian=np.median([r['ms'] for r in rr],axis=0).tolist(),
                           lockGained=sum(len(set(r['w3'])-set(r['w2'])) for r in rr)/len(ks),
                           lockLost=sum(len(set(r['w2'])-set(r['w3'])) for r in rr)/len(ks))
            if g!='base8':
                for k in ('zero','variance','gap'):report[g][k]=float(series(g,k).mean())
                for count,total in [('removed','gapRemovedSum'),('added','gapAddedSum')]:
                    n=sum(r[count] for r in rr);report[g][count+'MeanGap']=sum(r[total] for r in rr)/n if n else None
        comparisons={}
        for g,h in [('coherent','random'),('coherent','base8'),('random','base8')]:
            for k in ('C2','C3','lock'):
                def v(a):return series(a,'C3')-series(a,'C2') if k=='lock' else series(a,k)
                z=v(g)-v(h)
                comparisons[f'{g}-{h}:{k}']=dict(meanRecallDelta=float(z.mean()/10),win=int((z>1e-8).sum()),
                        tie=int((np.abs(z)<=1e-8).sum()),loss=int((z< -1e-8).sum()))
        result=dict(rows=len(D),sha256=hashlib.sha256((self.out/'rows.jsonl').read_bytes()).hexdigest(),
                    groups=report,paired=comparisons)
        with (self.out/'summary.json').open('x') as f:json.dump(result,f,indent=2)
        print(json.dumps(result))