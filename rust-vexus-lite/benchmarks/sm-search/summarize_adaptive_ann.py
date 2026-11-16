"""Audit frozen ANN evidence, never tune or read/write a source database."""
import argparse
from collections import Counter
import json
from pathlib import Path
from statistics import mean


def average(rows, key):
    values = [row[key] for row in rows if row.get(key) is not None]
    return mean(values) if values else None


def summarize(data):
    assert data["schema"] == "adaptive-ann-v1"
    summary = {
        "n": data["n"], "dim": data["dim"],
        "frozen_controls": data["frozen_controls"],
        "frozen_rule": data["frozen_rule"],
        "source_diagnostic_only": data["source_metadata"]["diagnostic_only"],
        "routes": [],
    }
    for report in data["reports"]:
        samples, terminals = report["samples"], report["terminals"]
        for terminal in terminals:
            rows = sorted((r for r in samples if r["query"] == terminal["query"]),
                          key=lambda r: r["layer"])
            accepted_ids = set()
            energy = 1.0
            for row in rows:
                assert row["retrieval_blob_reads"] <= 64
                assert row["nnls_additional_blob_reads"] == 0
                assert abs(row["query_energy_ratio"] - energy) < 1e-6
                ids = {word["id"] for word in row["words"]}
                assert len(ids) == len(row["words"])
                assert not ids & accepted_ids
                if row["cone"] is not None:
                    assert all(word["cosine"] > row["cone"]["background"]
                               for word in row["words"])
                if row["accepted"]:
                    assert row["explained_energy"] >= 0.03
                    accepted_ids.update(ids)
                    energy = row["candidate_next_energy_ratio"]
                else:
                    assert row is rows[-1]
            assert abs(energy - terminal["final_accepted_energy_ratio"]) < 1e-6
            assert sum(row["retrieval_blob_reads"] for row in rows) == terminal["total_retrieval_blob_reads"]
        for split in ["development", "holdout"]:
            rows = [r for r in samples if r["split"] == split]
            final = [r for r in terminals if r["split"] == split]
            assert len(final) == (12 if split == "development" else 32)
            item = {
                "route": report["route"], "split": split, "queries": len(final),
                "final_energy": average(final, "final_accepted_energy_ratio"),
                "total_explained": 1 - average(final, "final_accepted_energy_ratio"),
                "retrieval_reads_per_query": average(final, "total_retrieval_blob_reads"),
                "search_nnls_ms": mean(r["total_search_us"] + r["total_nnls_us"] for r in final) / 1000,
                "stop_reasons": dict(Counter(r["stop"] for r in final)),
                "layers": [],
            }
            for layer in range(3):
                attempted = [r for r in rows if r["layer"] == layer]
                accepted = [r for r in attempted if r["accepted"]]
                truth_nonempty = [r for r in attempted if r["own_exact_truth_size"]]
                words = [w for r in attempted for w in r["words"]]
                item["layers"].append({
                    "layer": layer, "attempted": len(attempted),
                    "nonempty": sum(r["valid_returns"] > 0 for r in attempted),
                    "accepted": len(accepted),
                    "accepted_rate_all_queries": len(accepted) / len(final),
                    "own_recall_nonempty_truth": average(truth_nonempty, "own_exact_recall"),
                    "empty_truth": len(attempted) - len(truth_nonempty),
                    "cosine_overlap": average(attempted, "cosine_top10_overlap"),
                    "candidate_tag_coverage": len({w["id"] for w in words}),
                    "accepted_tag_coverage": len({w["id"] for r in accepted for w in r["words"]}),
                    "valid_return_count": len(words),
                    "high_inbound_background_count": sum(r["high_inbound_background_return_count"] for r in attempted),
                    "background_count": sum(r["background_return_count"] for r in attempted),
                    "premature_stop_vs_score_truth": sum(r["premature_stop_vs_exact"] for r in attempted),
                    "clean_stop_vs_score_truth": sum(r["clean_stop_vs_exact"] for r in attempted),
                    "clean_stop_rate_attempted": (sum(r["clean_stop_vs_exact"] for r in attempted)
                                                  / len(attempted) if attempted else None),
                    "search_us": average(attempted, "search_us"),
                    "cold_reads": average(attempted, "retrieval_blob_reads"),
                    "mean_alignment": average(attempted, "mean_alignment"),
                    "max_exact_cosine": average(attempted, "max_exact_cosine"),
                })
            summary["routes"].append(item)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence")
    parser.add_argument("--output", required=True, help="new private summary JSON")
    args = parser.parse_args()
    data = json.loads(Path(args.evidence).read_bytes())
    result = summarize(data)
    with Path(args.output).open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=True, indent=2)
    print(json.dumps(result, ensure_ascii=True, indent=2))