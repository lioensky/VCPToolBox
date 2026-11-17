"""Audit completed Phase 4C evidence and optionally lock development winners."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import mean
from summarize_phase4b import audit_route, summarize


def eligible(p):
    return bool(p and all(p.get(k) for k in
                         ("adaptive_compass", "asymmetric", "compact_seeds"))
                and p.get("max_visits") == 1024 and p.get("max_expansions") == 256)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--lock", type=Path)
    args = parser.parse_args()
    raw = args.source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    records = [json.loads(line) for line in raw.splitlines()]
    header, completion = records[0], records[-1]
    assert header["experiment"] == "phase4c-v1"
    assert completion["complete"] is True
    routes = [r["route_completed"] for r in records if "route_completed" in r]
    assert completion["routes"] == header["config_count"] == len(routes)
    assert len({r["route"] for r in routes}) == len(routes)
    mode = header["mode"]
    assert mode in ("development", "validation", "smoke")
    splits = ("holdout_v3",) if mode == "validation" else ("development", "holdout")
    count = 32 if mode == "validation" else (2 if mode == "smoke" else 44)
    assert len(set(header["query_ids"])) == len(header["query_ids"]) == count
    if mode == "development":
        assert len(routes) == 57
        assert sum(eligible(r["params"]) for r in routes) == 32
    aggregates = []
    for route in routes:
        audit_route(route, header["n"], count, splits)
        item = {k: route[k] for k in ("route", "params", "build_ms", "hot_bytes")}
        item["all"] = summarize(route)
        for split in splits:
            if any(t["split"] == split for t in route["terminals"]):
                item[split] = summarize(route, split)
        for layer in item["all"]["layers"]:
            rows = [s for s in route["samples"] if s["layer"] == layer["layer"] and s["stages"]]
            if rows:
                for key in ("visited", "expanded"):
                    layer[key] = mean(s["stats"][key] for s in rows)
                layer["visit_limit_count"] = sum(s["stats"]["visit_limit_reached"] for s in rows)
                for key in ("seed_evaluations", "navigation_evaluations",
                            "rejected_discoveries", "expansions_after_visit_limit"):
                    layer[key] = mean(s["stages"][key] for s in rows)
                first = [s["stages"]["first_visit_rejection_expansion"] for s in rows
                         if s["stages"]["first_visit_rejection_expansion"] is not None]
                layer["first_rejection_expansion_mean"] = mean(first) if first else None
        item["radial_rejections"] = sum(s["stats"]["radial_rejections"]
                                        for s in route["samples"] if s["stats"])
        aggregates.append(item)
    baseline = next(r for r in aggregates if r["route"] == "cosine")
    base0 = baseline["all"]["layers"][0]
    thresholds = {"max_inbound_exclusive": .85,
                  "min_ann_explained": .98 * base0["ann_explained"],
                  "min_exact_explained": .98 * base0["exact_explained"]}
    for r in aggregates:
        l0 = r["all"]["layers"][0]
        r["development_gate"] = (mode == "development" and eligible(r["params"])
                                 and l0["avg_inbQ"] < .85
                                 and l0["ann_explained"] >= thresholds["min_ann_explained"]
                                 and l0["exact_explained"] >= thresholds["min_exact_explained"])
    ranked = sorted((r for r in aggregates if r["development_gate"]),
                    key=lambda r: (-r["all"]["terminal_explained"],
                                   tuple(r["params"][k] for k in
                                         ("upper", "phi0", "alpha", "beta", "kappa"))))
    output = {"schema": "phase4c-summary-v1", "mode": mode, "audit": "passed",
              "source": str(args.source), "source_sha256": digest,
              "completion": completion, "n": header["n"],
              "lock_sha256": header["lock_sha256"], "thresholds": thresholds,
              "passing_count": len(ranked),
              "ranked_passing_routes": [r["route"] for r in ranked], "routes": aggregates}
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(output, stream, ensure_ascii=False, indent=2)
    if args.lock:
        assert mode == "development" and len(ranked) >= 2, "insufficient passing configurations"
        lock = {"schema": "phase4b-lock-v1", "protocol": "phase4c-v1",
                "development_gate_passed": True, "source": str(args.source),
                "source_sha256": digest, "thresholds": thresholds,
                "metadata": header["metadata"], "baseline": baseline,
                "selected_routes": [r["route"] for r in ranked[:3]],
                "configs": [r["params"] for r in ranked[:3]]}
        with args.lock.open("x", encoding="utf-8") as stream:
            json.dump(lock, stream, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in output.items() if k != "routes"}, indent=2))
    for r in ranked[:3]:
        print("SELECTED", r["route"], json.dumps(r["all"]))


if __name__ == "__main__":
    main()