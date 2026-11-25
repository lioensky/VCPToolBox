"""Offline, NumPy, immutable frozen DB. Usage: script pair_dir new-report.json"""
import gzip, hashlib, json, sqlite3, sys
from pathlib import Path
from functools import lru_cache
import numpy as np

def unit(x):
    n=np.linalg.norm(x)
    if not np.isfinite(n) or n<1e-10: raise ValueError("invalid vector")
    return x/n

def rotate(q,s,t,others):
    basis=np.empty((q.size,0))
    if others:
        u,d,_=np.linalg.svd(np.stack(others,axis=1),full_matrices=False)
        basis=u[:,d>1e-10*d[0]]
    def perp(x): return x-basis@(basis.T@x)
    x,y=perp(s),perp(t)
    if min(np.linalg.norm(x),np.linalg.norm(y))<1e-9: return q,"degenerate"
    x,y=unit(x),unit(y)
    co=float(np.clip(x@y,-1,1)); z=y-co*x; si=np.linalg.norm(z)
    if si<1e-9: return q,"degenerate"
    z=z/si
    a,b=q@x,q@z
    new=q+(a*(co-1)-b*si)*x+(a*si+b*(co-1))*z
    assert abs(np.linalg.norm(new)-1)<1e-9
    assert all(abs((new-q)@v)<1e-9 for v in others)
    return new,"rotated"

def main(pair,out):
    base=pair.parent
    data={}
    db=base/"frozen-1051-v1/knowledge_base.sqlite"
    with sqlite3.connect(db.resolve().as_uri()+"?immutable=1&mode=ro",uri=True) as c:
        @lru_cache(None)
        def vector(table,i):
            assert table in ("tags","chunks")
            b=c.execute(f"SELECT vector FROM {table} WHERE id=?",(i,)).fetchone()[0]
            return unit(np.frombuffer(b,dtype="<f4").astype(float))
        for arm in ("current","relaxed"):
            for key in ("auto","phone","general"):
                q=unit(np.array(json.loads((base/f"gen1051-gemini2-q3-v1/{key}.json").read_bytes())["embedding"],dtype="<f4").astype(float))
                doc=json.loads((pair/arm/(key+".json")).read_bytes())
                for track,r in doc["tracks"].items():
                    g=r["queryRiverGraph"]; nodes={n["id"]:n for n in g["nodes"]}
                    assert not g["truncated"] and r["omega"]["completeObservation"]
                    focus={i for i,n in nodes.items() if n["hop"]==0 and n["sourceType"] in ("core","lexical_seed")}
                    routes=sorted((e for e in g["edges"] if e["wormhole"] and not e["immediateReturn"] and e["flow"]>0 and e["sourceId"] in focus and nodes[e["targetId"]]["hop"]==1),key=lambda e:(-e["flow"],e["sourceId"],e["targetId"]))
                    new=q; route=None; state="no-route"
                    if routes:
                        s,t=(routes[0][k] for k in ("sourceId","targetId"))
                        route=[s,t]
                        new,state=rotate(q,vector("tags",s),vector("tags",t),[vector("tags",i) for i in sorted(focus-{s})])
                    conf=r["parameters"]["queryCalibration"]["differentiaConfidence"]; rows=[]
                    for item in r["results"]:
                        cid=item["chunkId"]; v=vector("chunks",cid); j=item["topologyV3"]
                        old=float(q@v); moved=float(new@v)
                        assert abs(float(np.clip(old,0,1))-j["queryScore"])<1e-6
                        delta=(1-.5*conf)*(float(np.clip(moved,0,1))-float(np.clip(old,0,1)))
                        score=j["finalScore"]; gate=j["graphGate"]
                        rows.append(dict(id=cid,old=old,moved=moved,shift=moved-old,base=score,
                            signed=float(np.clip(score+gate*delta,0,1)),
                            atlas=float(np.clip(score+gate*max(0,delta),0,1))))
                    orders={k:[x["id"] for x in sorted(rows,key=lambda x:-x[k])] for k in ("base","signed","atlas")}
                    ctr={i:round(float((new-q)@vector("chunks",i)),6) for i in (11124,11220,4620,11761,9086,10460)}
                    label=f"{arm}/{key}/{track}"
                    data[label]=dict(route=route,count=len(routes),state=state,focus=sorted(focus),directionCos=float(q@new),rows=rows,orders=orders,controlShift=ctr)
                    print(label,route,state,"cos(q,new)",round(float(q@new),4),"shift",ctr,"top3",orders["atlas"][:3],"11124",orders["atlas"].index(11124)+1 if 11124 in orders["atlas"] else "outside","top10 in/out",[i for i in orders["atlas"][:10] if i not in orders["base"][:10]],[i for i in orders["base"][:10] if i not in orders["atlas"][:10]])
    with out.open("x",encoding="utf8") as f: json.dump(data,f,ensure_ascii=False)
    print(out,hashlib.sha256(out.read_bytes()).hexdigest())
if __name__=="__main__": main(*map(Path,sys.argv[1:]))