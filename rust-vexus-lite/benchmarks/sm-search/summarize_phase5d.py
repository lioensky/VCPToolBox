"""Independent Phase5D observed-development audit; does not read query vectors."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import mean, median
from summarize_phase5c import require, finite
from summarize_phase5 import PARTS

ROUTES = {"reference": (False, 0), "shell512": (True, 0),
          "union": (True, 1), "nms": (True, 2)}


def audit(rows, manifest, snapshot):
    require(rows[0]["type"] == "header" and rows[-1]["type"] == "complete", "boundaries")
    h, end = rows[0], rows[-1]
    require(h["schema"] == "phase5d-seeds-v1" and h["mode"] == "development", "protocol")
    require(h["queries"] == end["queries"] == 64 and h["repeats"] == 3, "query/repeat count")
    require(h["snapshotSha256"] == end["snapshotSha256"] == snapshot["snapshot_sha256"]
            and h["partitionSha256"] == snapshot["partition_sha256"], "identity")
    require(h["threshold"] == .60 and h["inner"] == 4 and h["seedCap"] == 16
            and h["candidate"] == "nms", "fixed candidate")
    require(h["budget"] == {"width": 128, "maxVisits": 2048,
                           "maxExpansions": 512, "rerank": 64}, "budget")
    wanted = {(g, e["chunk_id"]): e["file_id"] for g in ("development", "file_holdout_v1")
              for e in manifest[g]}
    require(len(wanted) == len(set(wanted.values())) == 64, "file partition")
    historical = set(manifest["historical_files"])
    require(len(historical) == 108 and not historical & set(wanted.values()), "historical leakage")
    ps, ls, ts, builds = {}, {}, {}, []
    for r in rows[1:-1]:
        kind = r["type"]
        if kind == "build":
            builds.append(r)
            continue
        require(kind in ("pipeline", "layer", "timing"), "unknown record")
        key = (r["group"], r["chunk"], r["route"])
        require(key[:2] in wanted and key[2] in ROUTES, "query/route identity")
        table = ps if kind == "pipeline" else ls if kind == "layer" else ts
        if kind != "pipeline":
            key += (r["level"] if kind == "layer" else r["repeat"],)
        require(key not in table, "duplicate record")
        table[key] = r
    require(len(builds) == 1, "build count")
    build = builds[0]
    require(build["connectivity"] == [build["nodes"], 0] and build["landmarks"] == 512,
            "connectivity/directory")
    require(build["hotBytes"] - build["referenceHotBytes"] == 2048, "memory ledger")
    require(set(ps) == {(g, q, route) for g, q in wanted for route in ROUTES},
            "pipeline completeness")
    require(set(ts) == {(*k, repeat) for k in ps for repeat in (1, 2, 3)},
            "timing completeness")
    for key, t in ts.items():
        d = t["diagnostics"]
        for part in (*PARTS, "totalMs"):
            require(finite(d[part]) >= 0, "timing range")
    used = set()
    for key, p in ps.items():
        require(p["file"] == wanted[key[:2]], "file mapping")
        shell, policy = ROUTES[key[2]]
        route = p["routing"]
        require(route["used"] == "warped_ags" and not route["fallback"]
                and route["reuseBeam"] and route["shellDirectory"] == shell
                and route["seedPolicy"] == policy and not route["legacyBudget"], "routing mismatch")
        cfg = p["config"]
        require(cfg["warpedPreset"] == "locked_2" and cfg["warpedRadiusStrategy"] == "EpaGuided"
                and cfg["warpedSeedPolicy"] == policy
                and cfg["warpedShellDirectory"] == shell and cfg["warpedReuseBeam"], "config mismatch")
        events = p["sqlReadEvents"]
        require(all(isinstance(e[0], str) and type(e[1]) is int and e[1] > 0 for e in events),
                "SQL event shape")
        require(len(events) == len({e[1] for e in events}) == p["uniqueSqlReads"], "SQL duplicates")
        accepted, attempts = p["pyramid"]["levels"], p["attempts"]
        require([a["level"] for a in attempts] == list(range(len(attempts))), "level continuity")
        require(len(accepted) <= len(attempts) <= len(accepted) + 1, "acceptance count")
        require({a["level"] for a in attempts} >= {0, 1}, "L0/L1 missing")
        energy, excluded = 0., set()
        for a in attempts:
            lk = (*key, a["level"])
            require(lk in ls, "missing layer")
            used.add(lk)
            l = ls[lk]
            found, truth = l["foundIds"], l["truthIds"]
            require(found == a["ids"] and len(set(found)) == len(found)
                    and len(set(truth)) == len(truth) == 10, "result/truth IDs")
            require(not set(found) & excluded, "cross-layer exclusion")
            require(l["accepted"] == (a["level"] < len(accepted)), "acceptance mismatch")
            require(0 <= finite(l["annExplained"]) <= 1
                    and 0 <= finite(l["exactExplained"]) <= 1, "energy range")
            require(l["distanceBits"] == l["referenceDistanceBits"]
                    and l["coldIds"] == l["referenceColdIds"], "reuse equivalence")
            require([v[0] for v in l["distanceBits"]] == found, "distance ID mismatch")
            require(len(l["coldIds"]) == len(set(l["coldIds"])) <= 64
                    and not set(l["coldIds"]) & excluded, "cold budget/exclusion")
            require(a["rerankFetches"] == a["sqlReads"] + a["cacheHits"] <= 64
                    and a["distanceEvals"] + a["quadSkips"] == a["rerankFetches"], "rerank ledger")
            require(l["visited"] == len(set(l["visitedIds"])) == a["visited"] <= 2048
                    and l["expanded"] == a["expanded"] <= 512
                    and l["converged"] == a["converged"], "navigation ledger")
            require(set(l["seeds"]) <= set(l["visitedIds"])
                    and set(l["retainedIds"]) <= set(l["visitedIds"])
                    and set(l["stage05Ids"]) <= set(l["retainedIds"]), "stage inclusion")
            seeds, directions = l["seeds"], l["directionSeeds"]
            inner = 8 if policy == 0 else 4
            require(len(seeds) == len(set(seeds)) <= 16
                    and len(directions) == len(set(directions))
                    and seeds[min(inner, len(seeds)):] == directions, "seed quotas")
            pairs = l["directionPairs"]
            require([(p[0], p[1]) for p in pairs] ==
                    [(a, b) for i, a in enumerate(directions) for b in directions[i + 1:]],
                    "pair identity")
            for pair in pairs:
                finite(pair[2])
            require(0 <= l["directoryCandidates"] <= (576 if policy else 512), "directory quota")
            require(all(type(l[k]) is int and l[k] >= 0 for k in
                        ("nmsComparisons", "nmsRejections", "nmsFills")), "NMS counters")
            if policy != 2:
                require(l["nmsComparisons"] == l["nmsRejections"] == l["nmsFills"] == 0,
                        "NMS enabled in control")
            else:
                require(l["nmsRejections"] <= l["nmsComparisons"]
                        and l["nmsFills"] <= len(directions), "NMS accounting")
                first_pass = set(directions[:len(directions) - l["nmsFills"]])
                require(all(p[2] < .60 for p in pairs
                            if p[0] in first_pass and p[1] in first_pass), "NMS threshold")
            if l["accepted"]:
                require(abs(l["annExplained"] - accepted[a["level"]]["energyExplained"]) < 1e-10,
                        "NNLS energy")
                energy += l["annExplained"]
                excluded.update(found)
        require(abs(energy - p["explained"]) < 1e-10, "final energy")
    require(set(ls) == used, "orphan layer")
    groups = {}
    for group in ("development", "file_holdout_v1"):
        groups[group] = {}
        for route in ROUTES:
            pipes = [p for (g, _, r), p in ps.items() if (g, r) == (group, route)]
            layers = [l for (g, _, r, _), l in ls.items() if (g, r) == (group, route)]
            timing = [t["diagnostics"] for (g, _, r, _), t in ts.items() if (g, r) == (group, route)]
            levels = [l for l in layers if l["level"] == 1]
            pairs = [pair[2] for l in levels for pair in l["directionPairs"]]
            groups[group][route] = {
                "explained": mean(p["explained"] for p in pipes),
                "recall": {str(i): mean(len(set(l["foundIds"]) & set(l["truthIds"])) / 10
                           for l in layers if l["level"] == i) for i in (0, 1)},
                "totalMs": mean(t["totalMs"] for t in timing),
                "medianMs": median(t["totalMs"] for t in timing),
                "checkMs": mean(t["tagRoutingCheckMs"] for t in timing),
                "unaccountedMs": mean(t["totalMs"] - sum(t[k] for k in PARTS) for t in timing),
                "L1directionPairMean": mean(pairs),
                "L1directionPairsAboveThreshold": sum(v >= .60 for v in pairs),
                "nmsComparisons": sum(l["nmsComparisons"] for l in layers),
                "nmsRejections": sum(l["nmsRejections"] for l in layers),
                "nmsFills": sum(l["nmsFills"] for l in layers),
            }
    dev, old = groups["development"]["nms"], groups["file_holdout_v1"]["nms"]
    gates = {"developmentEnergy": dev["explained"] >= .6395382451084317
             and dev["explained"] >= groups["development"]["reference"]["explained"],
             "developmentL0": dev["recall"]["0"] >= .90,
             "developmentL1": dev["recall"]["1"] >= .88,
             "observedHoldoutL0": old["recall"]["0"] >= .90,
             "observedHoldoutL1": old["recall"]["1"] >= .85,
             "hotMemory": build["hotBytes"] < 42000000}
    # Per-query matching is stricter evidence than equal means.
    different = sum(ps[(g, q, "union")]["pyramid"] != ps[(g, q, "nms")]["pyramid"]
                    for g, q in wanted)
    return {"schema": "phase5d-development-audit-v1", "groups": groups, "build": build,
            "gates": gates, "eligibleForFreshValidation": all(gates.values()),
            "unionVsNmsDifferentPyramids": different}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--snapshot-audit", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    snapshot = json.loads(args.snapshot_audit.read_text(encoding="utf-8"))
    require(hashlib.sha256(args.manifest.read_bytes()).hexdigest() == snapshot["partition_sha256"],
            "manifest digest")
    rows = [json.loads(l) for l in args.report.read_text(encoding="utf-8").splitlines()]
    result = audit(rows, manifest, snapshot)
    result["reportSha256"] = hashlib.sha256(args.report.read_bytes()).hexdigest()
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()