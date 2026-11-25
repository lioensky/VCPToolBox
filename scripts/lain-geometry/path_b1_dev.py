"""Offline B1 only. No query text, eval payload, database or network access."""
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

from point_packed_a1 import pack, scalar_decode
from point_packed_a2 import decode
from starry_field_probe import checked

INPUT = {
    'raw': ('plate-a/vectors.f32le', '1332370ce7088a29b71a0f09cf60d0aa7679dcde9ba4fbbee0504e449b8fed9a',
            'queries-a/dev.f32le', 'c6eda7714a6335a3ab4fd192c1aa979ce0b93ed0290232ed35ce85898f8acacf'),
    'z': ('path-b1-native-z-v1/points.f32le', '93c7ea9263054127721778fb0490e4007f64ba99a2090a020882e787f16ab50a',
          'path-b1-native-z-v1/dev.f32le', '0a95ebd97a00e7fc4a13bb13a1630dcfdd5ff0d5883c873ac778140ce86aa2ad'),
}
N, D, Q = 6849, 3072, 253


def run(root):
    root = root.resolve()
    if any((p / '.git').exists() for p in (root, *root.parents)):
        raise ValueError('private output required')
    dest = root / 'path-b1-dev-v1'
    if dest.exists():
        raise FileExistsError(dest)
    ids = np.frombuffer(checked(root/'plate-a/ids.u64le',
        'ae84b534d08b28887cfbf40dd5a2cfb1a13192c45b5c4a4b6198f5026fc122a9'), '<u8').reshape(N)
    replay = np.frombuffer(checked(root/'point-packed-a2-dev-v1/candidates.u64le',
        '78c698c057b8143a3e604f2ee795f18dbd04aafac56ee98ef96b4a75e9f693a8'), '<u8').reshape(Q,2,128)
    with tempfile.TemporaryDirectory(dir=root, prefix='b1-build-') as tmp:
        stage = Path(tmp)/'verified'
        stage.mkdir()
        for space,(xf,xh,qf,qh) in INPUT.items():
            x = np.frombuffer(checked(root/xf,xh),'<f4').reshape(N,D)
            queries = np.frombuffer(checked(root/qf,qh),'<f4').reshape(Q,D)
            sx = np.ascontiguousarray(np.sort(x.T,axis=1))
            cuts = np.ascontiguousarray(sx[:,[(N-1)*j//8 for j in range(1,8)]].T)
            cuts.tofile(stage/f'{space}-cuts8.f32le')
            tau = (cuts[5].astype('f8')-cuts[1])/8
            dims = np.arange(D)
            bounds = np.empty((9,D),'i4')
            bounds[0],bounds[-1] = 0,N
            for j in dims:
                bounds[1:-1,j] = sx[j].searchsorted(cuts[:,j],'left')
            streams = {}
            for bits,edges in ((2,cuts[1::2]),(3,cuts)):
                path = stage/f'{space}-{bits}bit.bin'
                with path.open('xb') as f:
                    for i in range(0,N,128):
                        block = x[i:i+128]
                        codes = np.zeros(block.shape,'u1')
                        for edge in edges:
                            codes += block >= edge
                        f.write(pack(codes,bits))
                wire = path.read_bytes()
                streams[bits] = np.frombuffer(wire,'u1').reshape(N,D*bits//8)
                oracle = np.frombuffer(scalar_decode(wire,N*D,bits),'u1').reshape(N,D)
                for j in dims:
                    if not np.array_equal(oracle[:,j],edges[:,j].searchsorted(x[:,j],'right')):
                        raise ValueError(f'code mismatch: {space}/{bits}/{j}')
                for i in range(0,N,128):
                    if not np.array_equal(decode(streams[bits][i:i+128],bits),oracle[i:i+128]):
                        raise ValueError('block decoder differs from scalar')
                del oracle
            with (stage/f'{space}-dev.jsonl').open('x',encoding='utf8',newline='\n') as out:
                for slot,q in enumerate(queries):
                    lo,hi = q-tau,q+tau
                    left = np.fromiter((sx[j].searchsorted(lo[j],'left') for j in dims),'i4',D)
                    right = np.fromiter((sx[j].searchsorted(hi[j],'right') for j in dims),'i4',D)
                    hard = ((x>=lo)&(x<=hi)).sum(1)
                    exact = np.lexsort((ids,-hard))[:128]
                    rec = dict(slot=slot,hard128=ids[exact].tolist(),bits={})
                    for bits in (2,3):
                        bd = bounds[::2] if bits==2 else bounds
                        mass = np.maximum(0,np.minimum(right,bd[1:])-np.maximum(left,bd[:-1]))
                        den = np.diff(bd,axis=0)
                        lut = np.divide(mass,den,out=np.zeros(mass.shape,'f8'),where=den>0)
                        score = np.empty(N,'f8')
                        for i in range(0,N,128):
                            sl = slice(i,i+128)
                            score[sl] = lut[decode(streams[bits][sl],bits),dims].sum(1)
                        pool = np.lexsort((ids,-score))[:128]
                        if space=='raw' and not np.array_equal(ids[pool],replay[slot,bits-2]):
                            raise ValueError(f'A2 replay mismatch: {slot}/{bits}')
                        reranked = pool[np.lexsort((ids[pool],-hard[pool]))]
                        rec['bits'][bits] = dict(direct128=ids[pool].tolist(),
                            hardWithin128=ids[reranked].tolist())
                    out.write(json.dumps(rec,separators=(',',':'))+'\n')
                    if (slot+1)%32==0:
                        print(space,slot+1,flush=True)
        files = {p.name:dict(bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest())
                 for p in sorted(stage.iterdir())}
        manifest = dict(format='lain-b1-dev-v1',inputs=INPUT,n=N,d=D,dev=Q,rawA2ListsVerified=Q*2,
            direct64='first 64 of direct128',hard64='first 64 of hard128',
            rerank128to64='first 64 of hardWithin128',semanticJudgments=0,files=files)
        (stage/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf8')
        stage.rename(dest)
        print('published',dest,flush=True)


if __name__=='__main__':
    run(Path(sys.argv[1]))