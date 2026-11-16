"""Read-only JSONL audit; no parameter selection and no database access."""
import argparse
import json
from pathlib import Path
from statistics import mean


def summarize(path):
    routes = []
    final = None
    with Path(path).open(encoding="utf-8") as source:
        for line in source:
            record = json.loads(line)
            if "route_completed" in record:
                routes.append(record["route_completed"])
            elif record.get("schema") == "warped-field-v1":
                final = record
    if final is not None:
        assert final["reports"] == routes, "checkpoint/final mismatch"
    result = []
    for route in routes:
        samples = route["samples"]
        terminals = route["terminals"]
        for terminal in terminals:
            trajectory = [s for s in samples if s["query"] == terminal["query"]]
            assert sum(s["cold_reads"] for s in trajectory) == terminal["total_reads"]
            assert sum(bool(s["accepted"]) for s in trajectory) == terminal["accepted_layers"]
            selected = set()
            for sample in trajectory:
                assert 0 <= sample["cold_reads"] <= 64
                assert sample["nnls_additional_reads"] == 0
                ids = [word["id"] for word in sample["words"]]
                assert len(ids) == len(set(ids))
                assert not selected.intersection(ids), "cross-layer repeated result"
                assert sample["accepted"] == (bool(ids) and sample["explained"] >= 0.03)
                if sample["accepted"]:
                    selected.update(ids)
            assert -1e-9 <= terminal["explained"] <= 1.0 + 1e-9
        for split in sorted({t["split"] for t in terminals}):
            group = [s for s in samples if s["split"] == split]
            ends = [t for t in terminals if t["split"] == split]
            item = {
                "route": route["route"], "split": split, "queries": len(ends),
                "build_ms": route["build_ms"], "hot_bytes": route["hot_bytes"],
                "terminal_explained": mean(t["explained"] for t in ends),
                "mean_trajectory_reads": mean(t["total_reads"] for t in ends),
                "mean_trajectory_ms": mean(t["total_us"] for t in ends) / 1000,
                "layers": [],
            }
            for layer in range(3):
                rows = [s for s in group if s["layer"] == layer]
                accepted = [s for s in rows if s["accepted"]]
                item["layers"].append({
                    "layer": layer, "attempted": len(rows), "accepted": len(accepted),
                    "conditional_recall": mean(s["own_recall"] for s in rows) if rows else None,
                    "accepted_tag_coverage": len({
                        word["id"] for s in accepted for word in s["words"]
                    }),
                    "premature_stops": sum(s["premature_stop"] for s in rows),
                    "bound_rejections": sum(
                        (s["stats"] or {}).get("radial_rejections", 0) for s in rows
                    ),
                })
            result.append(item)
    return {"complete": final is not None, "completed_routes": len(routes),
            "audit": "passed", "summaries": result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("--output", required=True, help="new private output; never overwritten")
    args = parser.parse_args()
    report = summarize(args.source)
    with Path(args.output).open("x", encoding="utf-8") as target:
        json.dump(report, target, indent=2, ensure_ascii=True)
        target.write("\n")
    print("audit=%s complete=%s routes=%d" % (
        report["audit"], report["complete"], report["completed_routes"]))