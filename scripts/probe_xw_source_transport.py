"""Single-source static Sense counterfactual on the frozen generation-808 graph; no retrieval."""
import gzip
import hashlib
import json
import math
import sqlite3
from collections import defaultdict
from pathlib import Path

from replay_xw_huawei import SIGNATURE

ROOT = Path(__file__).resolve().parents[1]
SOURCE, TARGET = 40770, 39492
OBSERVED_FLOW = 0.09070766827512118


def main():
    cfg = json.loads((ROOT / "rag_params.json").read_text(encoding="utf-8-sig"))["KnowledgeBaseManager"]["spikeRouting"]
    db = sqlite3.connect((ROOT / "VectorStore" / "knowledge_base.sqlite").resolve().as_uri()+"?mode=ro", uri=True)
    try:
        db.execute("BEGIN")
        assert db.execute("SELECT value FROM kbm_runtime_meta WHERE key='database_generation'").fetchone() == ("808",)
        codec, checksum, blob = db.execute("SELECT payload_codec,payload_checksum,payload FROM rivermemo_artifacts WHERE artifact_sig=? AND status='ready'", (SIGNATURE,)).fetchone()
    finally:
        db.close()
    raw = gzip.decompress(blob)
    assert codec == "gzip-json-v1" and hashlib.sha256(raw).hexdigest() == checksum
    asset = json.loads(raw)
    graph = asset["sharedTransport"]
    ids, offsets, targets, weights = (graph[k] for k in ("nodeIds", "rowOffsets", "targetIndices", "weights"))
    index = {v:i for i,v in enumerate(ids)}
    flags = set(asset["wormholeView"])
    gains = dict(asset["anchorGainView"])
    k = cfg.get("maxNeighborsPerNode", 20)
    normal, fast = cfg.get("baseDecay", .25), cfg.get("wormholeDecay", .70)
    fire, floor = cfg.get("firingThreshold", .1), cfg.get("minimumInjectedCurrent", .01)
    hops = cfg.get("maxSafeHops", 4)
    cap = max(100, cfg.get("maxPropagationStates", 2000))

    def row(s):
        i = index[s]
        return sorted(((ids[targets[j]], weights[j]) for j in range(offsets[i], offsets[i+1])),
                      key=lambda v: (-v[1], v[0]))[:k]

    w = dict(row(SOURCE))[TARGET]
    assert f"{SOURCE}:{TARGET}" in flags
    energy = OBSERVED_FLOW / (w * fast)
    print(json.dumps(dict(signature=SIGNATURE, source=SOURCE, target=TARGET, sourceEnergy=energy,
                          sourceEnergyBasis="inferred for one forward injection", firingThreshold=fire,
                          minCurrent=floor, maxHops=hops, dynamicReservations=False)))

    def run(mode):
        states = {(-1, SOURCE): (energy, cfg.get("baseMomentum", 2.0))}
        report = []
        for hop in range(1, hops+1):
            dest = {}
            target_out = 0.0
            direct = 0.0
            for (prev,s),(e,m) in sorted(states.items(), key=lambda z: (index.get(z[0][0],-1),index[z[0][1]])):
                if e < fire or m < 0:
                    continue
                for t,c in row(s):
                    if c <= 0:
                        break
                    special = f"{s}:{t}" in flags or c*gains.get(t,1) >= cfg.get("tensionThreshold",1)
                    if (s,t) == (SOURCE,TARGET):
                        if mode == "blocked":
                            continue
                        special = mode == "wormhole"
                    f = e*c*(fast if special else normal)*(cfg.get("returnFlowFactor",.15) if prev == t else 1)
                    if f < floor:
                        continue
                    if (s,t) == (SOURCE,TARGET):
                        direct += f
                    if s == TARGET:
                        target_out += f
                    momentum = m - (0 if special else 1)
                    if momentum < 0:
                        continue
                    old, old_m = dest.get((s,t),(0.0,-math.inf))
                    dest[s,t] = (old+f,max(old_m,momentum))
            if len(dest) > cap:
                kept = sorted(dest,key=lambda key:(-dest[key][0],index[key[0]],index[key[1]]))[:cap]
                dest = {key:dest[key] for key in kept}
            nodes = defaultdict(float)
            for (_,t),(e,_) in dest.items():
                nodes[t] += e
            report.append(dict(hop=hop,directFlow=direct,targetEnergy=nodes.get(TARGET,0),
                               targetOutgoingFlow=target_out,acceptedStates=len(dest),nodes=sorted(nodes)))
            if not any(e > floor for e in nodes.values()):
                break
            states = dest
        return report

    results = {mode:run(mode) for mode in ("blocked","ordinary","wormhole")}
    assert math.isclose(results["wormhole"][0]["directFlow"],OBSERVED_FLOW)
    assert math.isclose(results["ordinary"][0]["directFlow"],OBSERVED_FLOW*normal/fast)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()