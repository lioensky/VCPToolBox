"""Read-only generation-808 CSR counterfactual: remove reserve only, not gain or hub penalties."""
import collections
import gzip
import hashlib
import json
import math
import sqlite3
from pathlib import Path

from replay_xw_huawei import SIGNATURE

ROOT = Path(__file__).resolve().parents[1]


def main():
    config = json.loads((ROOT / "rag_params.json").read_text(encoding="utf-8-sig"))["KnowledgeBaseManager"]
    mass = config["v9"]["outboundMass"]
    reserve = config["v9"]["associationReserveMass"]
    k = config["spikeRouting"].get("maxNeighborsPerNode", 20)
    if not 0 < reserve < mass:
        raise ValueError("reserve inversion needs 0 < reserve < outbound mass")
    uri = (ROOT / "VectorStore" / "knowledge_base.sqlite").resolve().as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    try:
        db.execute("BEGIN")
        generation, = db.execute("SELECT value FROM kbm_runtime_meta WHERE key='database_generation'").fetchone()
        if str(generation) != "808":
            raise ValueError("unexpected database generation")
        codec, checksum, blob = db.execute(
            "SELECT payload_codec,payload_checksum,payload FROM rivermemo_artifacts WHERE artifact_sig=? AND status='ready'",
            (SIGNATURE,)).fetchone()
    finally:
        db.close()
    raw = gzip.decompress(blob)
    if codec != "gzip-json-v1" or hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError("asset verification failed")
    asset = json.loads(raw)
    g = asset["sharedTransport"]
    ids, offsets, targets, weights = (g[key] for key in ("nodeIds", "rowOffsets", "targetIndices", "weights"))
    flags = {tuple(map(int, pair.split(":"))) for pair in asset["wormholeView"]}
    sources = {s for s, _ in flags}
    counts = collections.Counter()
    worst = 0.0
    huawei = None
    for i, s in enumerate(ids):
        if s not in sources:
            continue
        row = {ids[targets[j]]: weights[j] for j in range(offsets[i], offsets[i+1]) if weights[j] > 0}
        tagged = {t for t in row if (s, t) in flags}
        w = math.fsum(row[t] for t in tagged)
        if w <= reserve or abs(math.fsum(row.values()) - mass) > 1e-9:
            raise ValueError(f"cannot invert row {s}: tagged mass {w}, row mass {math.fsum(row.values())}")
        bare = {t: x * (1 - reserve / w if t in tagged else 1) * mass / (mass-reserve) for t, x in row.items()}
        tagged_mass = math.fsum(bare[t] for t in tagged)
        for t, x in bare.items():
            restored = x * (mass-reserve) / mass + (reserve * x / tagged_mass if t in tagged else 0)
            worst = max(worst, abs(restored-row[t]))
        if abs(math.fsum(bare.values())-mass) > 1e-9 or worst > 1e-9:
            raise ValueError(f"mass or round-trip failure at {s}")
        def ranks(values):
            return {t: n for n, t in enumerate(sorted(values, key=lambda t: (-values[t], t)), 1)}
        before, after = ranks(row), ranks(bare)
        for t in tagged:
            counts["marked"] += 1
            counts["top1_before"] += before[t] == 1
            counts["top1_after"] += after[t] == 1
            counts["topK_before"] += before[t] <= k
            counts["topK_after"] += after[t] <= k
            counts["falls_out_of_topK"] += before[t] <= k < after[t]
            if (s, t) == (40770, 39492):
                huawei = {"weightBefore": row[t], "weightAfter": bare[t],
                          "rankBefore": before[t], "rankAfter": after[t], "flaggedNeighbors": len(tagged)}
    if counts["marked"] != len(flags) or not huawei:
        raise ValueError("missing reference edges")
    print(json.dumps({"generation": generation, "signature": SIGNATURE, "assumedReserve": reserve,
                      "outboundMass": mass, "K": k, "maxRoundTripError": worst,
                      "counts": dict(counts), "huawei": huawei}, indent=2))


if __name__ == "__main__":
    main()