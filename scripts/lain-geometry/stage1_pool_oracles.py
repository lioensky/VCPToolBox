from collections import Counter

def decompose(actions,wtiles,cap,budget,actual,probes):
    if not actions: raise ValueError('empty trajectory')
    seen=set(); opened=set(); weights=Counter(wtiles)
    live={0}; cost=[0]; val=[0]
    keys=sorted(weights)
    for idx,t in enumerate(keys):
        cost += [x+cap[t] for x in cost]
        val += [x+weights[t] for x in val]
    for pool,t in actions:
        pool=set(pool)
        if not seen<=pool or t not in pool or t in opened: raise ValueError('invalid history')
        seen=pool; opened.add(t)
        # One tile per observed verification opportunity. An unspent opportunity
        # can be skipped but cannot be banked to open two tiles in a later round.
        nxt=set(live)
        for idx,j in enumerate(keys):
            if j not in pool: continue
            bit=1<<idx
            nxt.update(mask|bit for mask in live if not mask&bit and cost[mask|bit]<=budget)
        live=nxt
    if len(seen)!=probes or sum(weights[t] for t in opened)!=actual: raise ValueError('unaccounted action')
    avail=sum(1<<i for i,t in enumerate(keys) if t in seen)
    reachable=val[avail]
    final=max(val[m] for m in range(len(val)) if m&avail==m and cost[m]<=budget)
    timed=max(val[m] for m in live)
    if not actual<=timed<=final<=reachable<=10: raise ValueError('non-nested oracle')
    return dict(discovered=reachable,finalOracle=final,timedOracle=timed,actual=actual,
                outside=10-reachable,capacity=reachable-final,late=final-timed,selection=timed-actual,
                verifyRounds=len(actions))