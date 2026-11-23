import hashlib,json,sys,tempfile
from pathlib import Path
import numpy as np
from point_packed_a1 import PLATE
from starry_field_probe import checked

PAY={2:'fb2c2ee53c87cbb0a93e7819fe14ec0b0f749ce71d854ccc0a49f3288937e03d',
     3:'62ab79d368435785aaf3037a4e5b772306c9dcc6a1a9b1add7916d20606e0b1d'}

def decode(block,bits):
    # Eight consecutive codes occupy exactly bits bytes; byte offsets repeat.
    a=block.reshape(len(block),-1,bits)
    out=np.empty((*a.shape[:2],8),dtype='u1')
    for j in range(8):
        pos,shift=divmod(j*bits,8)
        v=a[:,:,pos]>>shift
        if shift+bits>8:
            v=v|(a[:,:,pos+1]<<(8-shift))
        out[:,:,j]=v&((1<<bits)-1)
    return out.reshape(len(block),-1)

def main(root):
    root=root.resolve()
    if any((p/'.git').exists() for p in (root,*root.parents)):raise ValueError('private storage only')
    dest=root/'point-packed-a2-dev-v1'
    if dest.exists():raise FileExistsError(dest)
    pd,qd,ad=root/'plate-a',root/'queries-a',root/'point-packed-a1-v1'
    m=json.loads(checked(pd/'plate.json',PLATE))
    am=json.loads((ad/'manifest.json').read_bytes())
    if (am['format'],am['plateSha256'],am['shape'])!=('lain-point-packed-v1',PLATE,[6849,3072]):raise ValueError('generation')
    def arr(name,t):
        a=m['arrays'][name]
        if am[name+'Sha256']!=a['sha256']:raise ValueError(name)
        return np.frombuffer(checked(pd/a['file'],a['sha256']),t)
    ids=arr('ids','<u8');n=len(ids);d=m['dimensions'];x=arr('vectors','<f4').reshape(n,d)
    qm=json.loads(checked(qd/'queries.json','b95761334c85c3d7f48e95010b32413d11397eef0069d721263cc58cacc27005'))
    dev=np.frombuffer(checked(qd/'dev.f32le',qm['files']['dev.f32le']['sha256']),'<f4').reshape(253,d)
    old={(r['slot'],r['bits'],r['budget']):r['winners'] for r in map(json.loads,checked(root/'point-bitdepth-dev-v1.jsonl','4cc19c89d3e2df1a9cec462261f9c0bf88066eb07bba822ffad1f91a408d8fdb').splitlines())}
    sx=np.ascontiguousarray(np.sort(x.T,axis=1))
    cuts=sx[:,[(n-1)*j//8 for j in range(1,8)]].T
    if cuts.astype('<f4').tobytes()!=checked(ad/'cuts8.f32le',am['cutsSha256']):raise ValueError('cut mismatch')
    tau=(cuts[5].astype('f8')-cuts[1])/8
    bounds=np.empty((9,d),'i4');bounds[0]=0;bounds[-1]=n
    for j in range(d):bounds[1:-1,j]=sx[j].searchsorted(cuts[:,j],'left')
    raw={};ref={}
    for bits in PAY:
        raw[bits]=np.frombuffer(checked(ad/f'codes-{bits}.bin',PAY[bits]),'u1').reshape(n,d*bits//8)
        ref[bits]=np.zeros((n,d),'u1')
        for edge in (cuts if bits==3 else cuts[1::2]):ref[bits]+=x>=edge
    dims=np.arange(d);num=0;digest=hashlib.sha256()
    with tempfile.TemporaryDirectory(dir=root,prefix='a2-build-') as tmp:
        stage=Path(tmp)/'verified';stage.mkdir()
        with (stage/'candidates.u64le').open('xb') as f:
            for s,q in enumerate(dev):
                lo,hi=q-tau,q+tau
                left=np.fromiter((sx[j].searchsorted(lo[j],'left') for j in dims),'i4',d)
                right=np.fromiter((sx[j].searchsorted(hi[j],'right') for j in dims),'i4',d)
                exact=((x>=lo)&(x<=hi)).sum(1)
                truth=set(map(int,ids[np.lexsort((ids,-exact))[:10]]))
                for bits in (2,3):
                    bd=bounds[::2] if bits==2 else bounds
                    mass=np.maximum(0,np.minimum(right,bd[1:])-np.maximum(left,bd[:-1]))
                    den=np.diff(bd,axis=0)
                    p=np.divide(mass,den,out=np.zeros(mass.shape,'f8'),where=den>0)
                    a=np.empty(n);b=np.empty(n)
                    for i in range(0,n,128):
                        sl=slice(i,i+128)
                        a[sl]=p[ref[bits][sl],dims].sum(axis=1)
                        b[sl]=p[decode(raw[bits][sl],bits),dims].sum(axis=1)
                    if not np.array_equal(a.view('u8'),b.view('u8')):raise ValueError(f'score {s}:{bits}')
                    rank=ids[np.lexsort((ids,-b))[:128]]
                    control=ids[np.lexsort((ids,-a))[:128]]
                    for budget in (32,64,128):
                        if not np.array_equal(rank[:budget],control[:budget]):raise ValueError('rank')
                        if sorted(truth.intersection(map(int,rank[:budget])))!=old[s,bits,budget]:raise ValueError('winner replay')
                        num+=1
                    buf=rank.astype('<u8').tobytes();f.write(buf);digest.update(buf)
                if (s+1)%32==0:print(f'validated {s+1}/253',flush=True)
        result=dict(queries=len(dev),scorePairs=len(dev)*2*n,orderedLists=num,order='slot, bits [2,3], top128; prefixes 32/64',
                    candidateSha256=digest.hexdigest(),evalUsed=False)
        (stage/'summary.json').write_text(json.dumps(result),encoding='utf8')
        stage.rename(dest)
    print(json.dumps(result),flush=True)

if __name__=='__main__':main(Path(sys.argv[1]))