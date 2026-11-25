"""Source-row experiment only; reads the frozen snapshot. No writes to DB or network."""
import gzip
import hashlib
import json
import os
import sqlite3
import struct
import uuid
import zlib
from pathlib import Path

import numpy as np
from scipy.optimize import nnls

BASE = Path(os.environ["LOCALAPPDATA"]) / "VCP-Experiments/RiverMemoV6"
FROZEN = BASE / "frozen-1051-v1"
SIG = "51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3"
SOURCE = 40770
HASHES = {
    "auto": "c1c1ef1f4ca83f0dd2fadf138f6ba343656f14a314ba4c7b98acd59a4767fe4f",
    "phone": "2a8a67325540bbe20422268f6b6e1a1638bb954546c5ab29f0c978565722d9a0",
    "general": "de6440ea4c38ac92b66165d48ffdfd6f751b812fe4475eb264b9cbe2632786b5",
}


def neighbors():
    digest = hashlib.sha256(SIG.encode()).hexdigest()
    file = FROZEN / f"knowledge_base.sqlite.warped-{digest}-locked_2.vcpwf"
    data = file.read_bytes()
    manifest = json.loads((FROZEN/"manifest.json").read_text(encoding="utf8"))
    assert hashlib.sha256(data).hexdigest() == manifest["sha256"][file.name]
    assert data[:8] == b"VCPWF001" and zlib.crc32(data[:-4]) == struct.unpack_from("<I", data, len(data)-4)[0]
    h, size = struct.unpack_from("<QQ", data, 8)
    header = json.loads(data[24:24+h])
    n = header["nodes"]
    assert header["identity"]["artifact"] == SIG and header["dimension"] == 3072
    buf = memoryview(data)[24+h+4*n:-4]
    assert len(buf) == size
    pos = 0

    def take(count):
        nonlocal pos
        assert 0 <= count <= len(buf)-pos
        pos += count
        return buf[pos-count:pos]

    def u64():
        return struct.unpack("<Q", take(8))[0]

    def array(dtype):
        count = u64()
        return np.frombuffer(take(count*np.dtype(dtype).itemsize), dtype=dtype)

    assert u64() == 1 and u64() == 3072
    take(8*(1+10+3))  # profile kind, ten f64s, degree/width/adaptive
    ids = array("<u8")
    assert len(ids) == n and np.all(ids[1:] > ids[:-1])
    array("<u8"); array("<u8"); array("<f4")  # slots, mean, proxy table
    assert u64() == n
    take(32*n)
    planes = u64()
    assert planes == n*48*2
    take(planes*8)
    graph, offsets = array("<u4"), array("<u4")
    for _ in range(3): array("<u4")
    assert pos == size and len(offsets) == n+1 and offsets[-1] == len(graph)
    i = int(np.searchsorted(ids,SOURCE))
    assert ids[i] == SOURCE
    return [int(ids[j]) for j in graph[offsets[i]:offsets[i+1]]]


def unit(v):
    v = np.asarray(v,dtype=np.float64)
    assert v.shape == (3072,) and np.isfinite(v).all()
    n = np.linalg.norm(v)
    return v/n if n else v


def distribute(w, gains, lam, valid=True):
    if not valid or lam == 0 or np.ptp(gains) == 0:
        return w.copy()
    z = w*np.exp(lam*(gains-np.max(gains)))
    return z*(w.sum()/z.sum())


def main():
    srcrow = json.loads((BASE/"transport-row40770-dec81e4dd6a545ff85de682ecbcfcfd2.json").read_text(encoding="utf8"))
    assert srcrow["sig"] == SIG and srcrow["source"] == SOURCE and srcrow["flagMismatch"] == 0 and srcrow["calibrationMaxAbs"] < 1e-10
    row = srcrow["arms"]["ordinary"]
    targets = sorted(map(int,row))
    w = np.array([row[str(t)] for t in targets])
    assert len(w) == 16 and np.all(w>0) and abs(sum(w)-.95)<1e-12
    assert np.array_equal(distribute(w,np.ones(16),4),w)
    assert np.array_equal(distribute(w,np.arange(16),4,False),w)
    nav = neighbors()
    db = FROZEN/"knowledge_base.sqlite"
    with sqlite3.connect(db.as_uri()+"?mode=ro&immutable=1",uri=True) as c:
        raw = gzip.decompress(c.execute("SELECT payload FROM rivermemo_artifacts WHERE artifact_sig=? AND status='ready'",(SIG,)).fetchone()[0])
        assert hashlib.sha256(raw).hexdigest()=="d2b3e55c2e7cfbe1b82e3aa777298c3d9c8aa1aff23e3838cb99890536bb7c5c"
        flags = set(json.loads(raw)["wormholeView"])
        ordinary = sorted({t for t in nav if t!=SOURCE and f"{SOURCE}:{t}" not in flags})
        vectors,names = {},{}
        for t in sorted(set(ordinary+targets+[SOURCE])):
            name,b = c.execute("SELECT name,vector FROM tags WHERE id=?",(t,)).fetchone()
            names[t],vectors[t] = name,unit(np.frombuffer(b,dtype="<f4"))
            assert np.linalg.norm(vectors[t])>0
    print("navigation degree:",len(nav),"ordinary controls:",[(t,names[t]) for t in ordinary],flush=True)
    report = {"sig":SIG,"source":SOURCE,"nav":nav,"ordinary":ordinary,"targets":targets,"names":names,"p0":w.tolist(),"cases":[]}
    for query,h in HASHES.items():
        f = np.array(json.loads((BASE/"gen1051-gemini2-q3-v1"/(query+".json")).read_text(encoding="utf8"))["embedding"],dtype="<f4")
        assert hashlib.sha256(f.tobytes()).hexdigest()==h
        q = unit(f)
        for mode in ("neighbors","neighbors+source","source-only"):
            gains=[]; valid=True
            for t in targets:
                controls = [k for k in ordinary if k!=t] if mode!="source-only" else []
                if mode!="source-only" and not controls:
                    valid=False;break
                if mode!="neighbors": controls.append(SOURCE)
                A=np.column_stack([vectors[k] for k in controls])
                r0=nnls(A,q)[1]; r1=nnls(np.column_stack((A,vectors[t])),q)[1]
                gain=r0*r0-r1*r1
                assert -1e-10<=gain<=1+1e-10
                gains.append(max(0.,gain))
            g=np.array(gains if valid else np.zeros(len(w)))
            for lam in (0,1,4):
                p=distribute(w,g,lam,valid and bool(np.any(q)))
                assert np.all(p>0) and abs(p.sum()-w.sum())<1e-12
                if lam==0: assert np.array_equal(p,w)
                d=p-w
                report["cases"].append(dict(query=query,mode=mode,lam=lam,valid=valid,gains=g.tolist(),weights=p.tolist()))
                if lam:
                    a,b=int(np.argmax(d)),int(np.argmin(d))
                    print(query,mode,lam,"pedal/PC",*(round(p[targets.index(t)],7) for t in (39492,40773)),
                          "largest +/-",names[targets[a]],round(d[a],7),names[targets[b]],round(d[b],7),flush=True)
    out=BASE/("neighborhood-row40770-"+uuid.uuid4().hex+".json")
    with out.open("x",encoding="utf8") as f:json.dump(report,f,ensure_ascii=False,indent=2)
    print(out)


if __name__=="__main__":
    main()