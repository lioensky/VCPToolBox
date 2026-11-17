"""Read-only Phase 4B development audit; create a new aggregate evidence file."""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from statistics import mean


def audit_route(route, n, query_count, allowed_splits=("development", "holdout")):
    params = route.get("params") or {}
    visits = params.get("max_visits", 0) or 256
    expansions = params.get("max_expansions", 0) or 128
    seed_cap = min(64, visits // 4, 16 if params.get("compact_seeds") else 64)
    samples = route["samples"]
    terminals = route["terminals"]
    assert len(terminals) == query_count
    assert len({t["query"] for t in terminals}) == query_count
    for terminal in terminals:
        rows = sorted(
            (s for s in samples if s["query"] == terminal["query"]),
            key=lambda s: s["layer"],
        )
        assert rows and [s["layer"] for s in rows] == list(range(len(rows)))
        assert len(rows) <= 3
        excluded = set()
        explained = 0.0
        for i, s in enumerate(rows):
            assert s["split"] in allowed_splits
            assert abs(s["query_energy"] - (1 - explained)) < 2e-6
            result = s["result_ids"]
            truth = s["truth_ids"]
            assert len(result) == len(set(result)) <= 10
            assert len(truth) == len(set(truth)) == 10
            assert not excluded.intersection(result)
            assert not excluded.intersection(truth)
            assert s["oracle_reads"] == n - len(excluded)
            assert s["cold_reads"] <= 64 and s["nnls_additional_reads"] == 0
            assert s["control_reads"] <= 64 and s["oracle_fit_reads"] <= 20
            assert s["accepted"] == (bool(result) and s["ann_explained"] >= 0.03)
            recall = len(set(result).intersection(truth)) / len(truth)
            assert abs(recall - s["own_recall"]) < 1e-12
            if s["stages"] is not None:
                assert s["stats"]["visited"] <= visits
                assert s["stats"]["expanded"] <= expansions
                for stage in (s["stages"], s["inner_control"]):
                    sets = [set(stage[k]) for k in
                            ("seed_ids", "visited_ids", "retained_ids", "stage05_ids")]
                    assert len(sets[0]) <= seed_cap and len(sets[1]) <= visits
                    assert len(sets[2]) <= 256 and len(sets[3]) <= 64
                    if "first_visit_rejection_expansion" in stage:
                        first = stage["first_visit_rejection_expansion"]
                        assert stage["rejected_discoveries"] >= 0
                        if first is None:
                            assert stage["rejected_discoveries"] == 0
                            assert stage["expansions_after_visit_limit"] == 0
                        else:
                            assert 0 <= first <= expansions
                            assert stage["rejected_discoveries"] > 0
                        assert stage["expansions_after_visit_limit"] <= expansions
                    assert sets[0] <= sets[1] and sets[3] <= sets[2] <= sets[1]
                    assert not excluded.intersection(sets[3])
                    for ids, key in zip(sets, ("seed_hit_rate", "visited_hit_rate",
                                              "beam_retained_hit_rate", "stage05_top64_hit_rate")):
                        assert abs(len(ids.intersection(truth)) / 10 - stage[key]) < 1e-12
                assert abs(s["stages"]["stage05_top64_hit_rate"] - recall) < 1e-12
            if s["accepted"]:
                explained += s["ann_explained"]
                excluded.update(result)
            else:
                assert i == len(rows) - 1
        assert abs(terminal["explained"] - explained) < 2e-6
        assert terminal["accepted_layers"] == sum(s["accepted"] for s in rows)
        assert terminal["total_reads"] == sum(s["cold_reads"] for s in rows)
        assert abs(terminal["total_us"] - sum(s["search_us"] + s["nnls_us"] for s in rows)) < 1e-5


def summarize(route, split=None):
    samples = [s for s in route["samples"] if split is None or s["split"] == split]
    terminals = [t for t in route["terminals"] if split is None or t["split"] == split]
    layers = []
    for layer in range(3):
        rows = [s for s in samples if s["layer"] == layer]
        if not rows:
            continue
        entry = {"layer": layer, "attempts": len(rows),
                 "accepted": sum(s["accepted"] for s in rows),
                 "accepted_tag_coverage": len({i for s in rows if s["accepted"] for i in s["result_ids"]}),
                 "explainable_but_rejected": sum(not s["accepted"] and s["exact_explained"] >= .03 for s in rows)}
        for key in ("ann_explained", "exact_explained", "same_query_cosine_exact_explained",
                    "own_recall", "avg_inbQ", "exact_avg_inbQ", "avg_R", "avg_cos"):
            entry[key] = mean(s[key] for s in rows)
        if rows[0]["stages"] is not None:
            for prefix, field in (("", "stages"), ("inner_", "inner_control")):
                for key in ("seed_hit_rate", "visited_hit_rate", "beam_retained_hit_rate", "stage05_top64_hit_rate"):
                    entry[prefix + key] = mean(s[field][key] for s in rows)
        layers.append(entry)
    return {"query_count": len(terminals), "terminal_explained": mean(t["explained"] for t in terminals),
            "trajectory_reads": mean(t["total_reads"] for t in terminals),
            "trajectory_ms": mean(t["total_us"] for t in terminals) / 1000,
            "layers": layers}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    digest = hashlib.sha256(args.source.read_bytes()).hexdigest()
    with args.source.open(encoding="utf-8") as stream:
        header = json.loads(next(stream))
        records = [json.loads(line) for line in stream]
    routes = [r["route_completed"] for r in records if "route_completed" in r]
    assert records[-1]["complete"] is True
    assert records[-1]["routes"] == header["config_count"] == len(routes) == 164
    assert header["mode"] == "development" and len(header["query_ids"]) == 44
    assert len({r["route"] for r in routes}) == len(routes)
    aggregates = []
    for route in routes:
        audit_route(route, header["n"], 44)
        item = {k: route[k] for k in ("route", "params", "build_ms", "hot_bytes")}
        item["all"] = summarize(route)
        item["development"] = summarize(route, "development")
        item["holdout"] = summarize(route, "holdout")
        item["radial_rejections"] = sum(s["stats"]["radial_rejections"] for s in route["samples"] if s["stats"])
        aggregates.append(item)
    baseline = next(r for r in aggregates if r["route"] == "cosine")
    base0 = baseline["all"]["layers"][0]
    thresholds = {"max_inbound_exclusive": .85, "min_ann_explained": .98 * base0["ann_explained"],
                  "min_exact_explained": .98 * base0["exact_explained"]}
    for item in aggregates:
        l0 = item["all"]["layers"][0]
        item["development_gate"] = (item["params"] is not None and item["route"] != "phase4a_reference"
                                   and l0["avg_inbQ"] < .85
                                   and l0["ann_explained"] >= thresholds["min_ann_explained"]
                                   and l0["exact_explained"] >= thresholds["min_exact_explained"])
    ranked = sorted((r for r in aggregates if r["development_gate"]),
                    key=lambda r: (-r["all"]["terminal_explained"],
                                   tuple(r["params"][k] for k in ("upper", "phi0", "alpha", "beta", "kappa"))))
    output = {"schema": "phase4b-development-summary-v1", "source": str(args.source),
              "source_sha256": digest, "completion": records[-1], "audit": "passed",
              "query_splits": dict(Counter(t["split"] for t in routes[0]["terminals"])),
              "thresholds": thresholds, "passing_count": len(ranked),
              "ranked_passing_routes": [r["route"] for r in ranked], "routes": aggregates}
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(output, stream, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in output.items() if k != "routes"}, ensure_ascii=False, indent=2))
    print("TOP TERMINAL (development selection, not validation):")
    for item in sorted(aggregates, key=lambda r: -r["all"]["terminal_explained"])[:12]:
        print(json.dumps(item, ensure_ascii=False))
    print("BASELINE:", json.dumps(baseline, ensure_ascii=False))


if __name__ == "__main__":
    main()