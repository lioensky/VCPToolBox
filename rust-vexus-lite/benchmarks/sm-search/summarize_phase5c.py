"""Audit Phase 5C observed-file four-route diagnostic, not fresh validation."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import mean, median

ROUTES = ("reference", "directory512", "reuse", "combined")
PAIRS = (("reference", "reuse"), ("directory512", "combined"))


def require(ok, message):
    if not ok:
        raise ValueError(message)


def finite(v):
    require(type(v) in (float, int) and math.isfinite(v), "nonfinite metric")
    return v


def audit(rows, manifest, snapshot):
    require(rows[0]["type"] == "header" and rows[-1]["type"] == "complete", "boundaries")
    head, end = rows[0], rows[-1]
    require(head["schema"] == "phase5c-navigation-v1"
            and head["mode"] == "observed_diagnostic", "protocol")
    require(head["snapshotSha256"] == end["snapshotSha256"] == snapshot["snapshot_sha256"],
            "snapshot identity")
    require(head["partitionSha256"] == snapshot["partition_sha256"], "partition identity")
    require(head["queries"] == end["queries"] == 64, "query count")
    require(head["budget"] == {"width": 128, "maxVisits": 2048,
                              "maxExpansions": 512, "rerank": 64}, "budget")
    wanted = {(g, e["chunk_id"]): e["file_id"] for g in ("development", "file_holdout_v1")
              for e in manifest[g]}
    require(len(wanted) == 64 and len(set(wanted.values())) == 64, "file overlap")
    require(not (set(wanted.values()) & set(manifest["historical_files"])), "historical overlap")
    builds, pipelines, layers, ptimes, stimes = [], {}, {}, {}, {}
    for r in rows[1:-1]:
        kind = r["type"]
        if kind == "build":
            builds.append(r)
            continue
        require(kind in ("pipeline", "layer", "pipeline_timing", "search_timing"), "unknown row")
        require((r["group"], r["chunk"]) in wanted and r["route"] in ROUTES, "query/route")
        key = (r["group"], r["chunk"], r["route"])
        table = pipelines if kind == "pipeline" else layers if kind == "layer" else (
            ptimes if kind == "pipeline_timing" else stimes)
        if kind in ("layer", "search_timing"):
            key += (r["level"],)
        if kind.endswith("_timing"):
            key += (r["repeat"],)
            for metric in (("ms",) if kind == "search_timing"
                           else ("totalMs", "pyramidMs", "checkMs")):
                require(finite(r[metric]) >= 0, "timing range")
        require(key not in table, "duplicate record")
        table[key] = r
    require(len(builds) == 1, "build count")
    build = builds[0]
    require(build["connectivity"] == [build["nodes"], 0] and build["landmarks"] == 512,
            "directory/connectivity")
    require(build["hotBytes"] - build["referenceHotBytes"] == build["extraDirectoryBytes"] == 2048,
            "directory memory")
    require(set(pipelines) == {(g, q, r) for g, q in wanted for r in ROUTES}, "pipeline coverage")
    require(set(ptimes) == {(*key, repeat) for key in pipelines for repeat in (1, 2, 3)},
            "pipeline timings")
    used_layers = set()
    for key, p in pipelines.items():
        require(p["file"] == wanted[key[:2]], "file identity")
        routing = p["routing"]
        require(routing["used"] == "warped_ags" and not routing["fallback"]
                and routing["shellDirectory"] == (key[2] in ("directory512", "combined"))
                and routing["reuseBeam"] == (key[2] in ("reuse", "combined"))
                and not routing["legacyBudget"], "routing identity")
        events = p["sqlReadEvents"]
        require(len(events) == len({e[1] for e in events}) == p["uniqueSqlReads"], "duplicate SQL")
        accepted = p["pyramid"]["levels"]
        energy = 0.
        excluded = set()
        require([a["level"] for a in p["attempts"]] == list(range(len(p["attempts"]))),
                "attempt continuity")
        require(len(accepted) <= len(p["attempts"]) <= len(accepted) + 1, "acceptance count")
        for a in p["attempts"]:
            lk = (*key, a["level"])
            require(lk in layers, "missing layer")
            used_layers.add(lk)
            layer = layers[lk]
            found, truth = layer["foundIds"], layer["truthIds"]
            require(found == a["ids"] and len(found) == len(set(found))
                    and len(truth) == len(set(truth)) == 10, "IDs")
            require(not (set(found) & excluded), "excluded result")
            require(layer["accepted"] == (a["level"] < len(accepted)), "acceptance")
            require(0 <= finite(layer["annExplained"]) <= 1
                    and 0 <= finite(layer["exactExplained"]) <= 1, "energy range")
            require(layer["visited"] <= 2048 and layer["expanded"] <= 512
                    and layer["visited"] == len(set(layer["visitedIds"])), "hot work")
            require(set(truth) and set(layer["seeds"]) <= set(layer["visitedIds"])
                    and set(layer["retainedIds"]) <= set(layer["visitedIds"])
                    and set(layer["stage05Ids"]) <= set(layer["retainedIds"]), "stage sets")
            require(len(layer["coldIds"]) <= 64
                    and len(layer["coldIds"]) == len(set(layer["coldIds"]))
                    and not (set(layer["coldIds"]) & excluded), "cold work")
            require(layer["converged"] == a["converged"] and layer["visited"] == a["visited"]
                    and layer["expanded"] == a["expanded"], "actual trajectory")
            require(a["rerankFetches"] == a["sqlReads"] + a["cacheHits"] <= 64
                    and a["distanceEvals"] + a["quadSkips"] == a["rerankFetches"], "rerank ledger")
            if layer["accepted"]:
                require(abs(layer["annExplained"] - accepted[a["level"]]["energyExplained"]) < 1e-10,
                        "accepted energy")
                energy += layer["annExplained"]
                excluded.update(found)
        require(abs(energy - p["explained"]) < 1e-10, "final energy")
    require(set(layers) == used_layers, "orphan layers")
    require(set(stimes) == {(*key, repeat) for key in layers for repeat in range(1, 6)},
            "search timings")
    for group, chunk in wanted:
        for old, fast in PAIRS:
            a, b = pipelines[(group, chunk, old)], pipelines[(group, chunk, fast)]
            for metric in ("pyramid", "enhancedBits", "sqlReadEvents", "explained"):
                require(a[metric] == b[metric], "reuse pipeline equivalence")
            for attempt in a["attempts"]:
                la = layers[(group, chunk, old, attempt["level"])]
                lb = layers[(group, chunk, fast, attempt["level"])]
                for metric in ("foundIds", "truthIds", "distanceBits", "coldIds", "seeds",
                               "visitedIds", "retainedIds", "stage05Ids", "annExplained",
                               "exactExplained", "visited", "expanded", "converged"):
                    require(la[metric] == lb[metric], "reuse search equivalence")
                require(lb["stage05Evaluations"] == 0, "score not reused")
    summaries = {}
    for group in ("development", "file_holdout_v1"):
        summaries[group] = {}
        for route in ROUTES:
            ps = [p for (g, _, r), p in pipelines.items() if (g, r) == (group, route)]
            require(len(ps) == 32, "group size")
            ls = [l for (g, _, r, _), l in layers.items() if (g, r) == (group, route)]
            times = [t["totalMs"] for (g, _, r, _), t in ptimes.items() if (g, r) == (group, route)]
            search = [t["ms"] for (g, _, r, _, _), t in stimes.items() if (g, r) == (group, route)]
            summaries[group][route] = {
                "explained": mean(p["explained"] for p in ps),
                "pipelineMeanMs": mean(times), "pipelineMedianMs": median(times),
                "searchMeanMs": mean(search), "searchMedianMs": median(search),
                "recall": {str(level): mean(len(set(l["foundIds"]) & set(l["truthIds"])) / 10
                           for l in ls if l["level"] == level) for level in (0, 1)},
                "workspaceMaxBytes": max(l["workspaceBytes"] for l in ls),
                "seedMeanMs": mean(l["seedMs"] for l in ls),
            }
    dev = summaries["development"]
    candidate = dev["combined"]
    gates = {"L0": candidate["recall"]["0"] >= .90, "L1": candidate["recall"]["1"] >= .85,
             "energyNonRegression": candidate["explained"] >= dev["reference"]["explained"],
             "hotMemory": build["hotBytes"] <= 42000000}
    return {"schema": "phase5c-navigation-audit-v1", "mode": "observed_diagnostic",
            "groups": summaries, "build": build, "developmentGates": gates,
            "eligibleForFreshValidation": all(gates.values())}


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
    rows = [json.loads(line) for line in args.report.read_text(encoding="utf-8").splitlines()]
    result = audit(rows, manifest, snapshot)
    result["reportSha256"] = hashlib.sha256(args.report.read_bytes()).hexdigest()
    with args.output.open("x", encoding="utf-8") as out:
        json.dump(result, out, indent=2, allow_nan=False)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()