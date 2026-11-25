"""Audit published B0/B1 candidate files; never open query text or eval assets."""
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from struct import iter_unpack

Q = 253


def require(ok, why):
    if not ok:
        raise ValueError(why)


def load(root):
    wire = (root/'plate-a/ids.u64le').read_bytes()
    require(hashlib.sha256(wire).hexdigest() == 'ae84b534d08b28887cfbf40dd5a2cfb1a13192c45b5c4a4b6198f5026fc122a9','ID digest')
    allowed = {i for (i,) in iter_unpack('<Q',wire)}
    require(len(allowed)==6849,'ID count')
    sums = defaultdict(int)
    digests = {}
    def records(path):
        data = path.read_bytes()
        digests[path.name] = hashlib.sha256(data).hexdigest()
        rows = [json.loads(s) for s in data.splitlines()]
        require([r['slot'] for r in rows]==list(range(Q)),f'slots: {path.name}')
        return rows
    def check(ids,k):
        require(len(ids)==k and len(set(ids))==k and set(ids)<=allowed,'invalid candidate IDs')
    def hits(pairs,k):
        ids=[i for i,_ in pairs]
        check(ids,k)
        require(all(math.isfinite(v) for _,v in pairs),'nonfinite distance')
        require(pairs==sorted(pairs,key=lambda p:(p[1],p[0])),'distance/tie order')
        return ids
    b1=root/'path-b1-dev-v1'
    manifest=json.loads((b1/'manifest.json').read_bytes())
    require((manifest['format'],manifest['rawA2ListsVerified'])==('lain-b1-dev-v1',506),'B1 manifest')
    for name,meta in manifest['files'].items():
        require(Path(name).name==name,'manifest filename')
        data=(b1/name).read_bytes()
        require(len(data)==meta['bytes'] and hashlib.sha256(data).hexdigest()==meta['sha256'],f'digest: {name}')
    spaces={s:records(b1/f'{s}-dev.jsonl') for s in ('raw','z')}
    b0=records(root/'path-b0-dev-v1/candidates.jsonl')
    max_err=0.
    for slot in range(Q):
        b=b0[slot]
        exact=hits(b['exact128'],128)
        require(math.isfinite(b['queryRadius']),'radius')
        require([arm['k'] for arm in b['nav']]==[64,128],'B0 budgets')
        for arm in b['nav']:
            k=arm['k']
            require((arm['width'],arm['rerankLimit'],arm['maxVisits'],arm['maxExpansions'])==
                    (2*k,2*k,1536,384),'wrong native config')
            nav=hits(arm['hits'],k)
            sums[f'b0.nav_exact_intersection@{k}']+=len(set(nav)&set(exact[:k]))
            sums[f'b0.distance_bit_mismatches@{k}']+=arm['distanceBitMismatches']
            sums[f'b0.order_disagreements@{k}']+=int(not arm['orderedByExact'])
            max_err=max(max_err,arm['maxAbsDistanceDiff'])
            for key in ('coldReads','visited','expanded'):
                sums[f'b0.{key}@{k}']+=arm[key]
        for s,rows in spaces.items():
            r=rows[slot]
            check(r['hard128'],128)
            for bits in ('2','3'):
                arm=r['bits'][bits]
                direct=arm['direct128']
                rerank=arm['hardWithin128']
                check(direct,128);check(rerank,128)
                require(set(rerank)==set(direct),'rerank changed pool')
                for k in (64,128):
                    sums[f'b1.{s}.{bits}bit.direct_hard_intersection@{k}']+=len(set(direct[:k])&set(r['hard128'][:k]))
        for bits in ('2','3'):
            for k in (64,128):
                a,c=(set(spaces[s][slot]['bits'][bits]['direct128'][:k]) for s in ('raw','z'))
                sums[f'b1.{bits}bit.raw_z_intersection@{k}']+=len(a&c)
    return dict(queries=Q,slotDenominators={'64':Q*64,'128':Q*128},totals=dict(sums),
                maxAbsB0DistanceDifference=max_err,candidateDigests=digests,
                semanticJudgments=0)


if __name__=='__main__':
    print(json.dumps(load(Path(sys.argv[1])),indent=2,sort_keys=True))