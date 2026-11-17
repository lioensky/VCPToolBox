"""Audit Phase 4D replay, including bitwise compatibility and archived trajectories."""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from statistics import mean
from summarize_phase4b import audit_route, summarize


def bits(value):
    return struct.pack("<d", value)


def load(path):
    rows = [json.loads(line) for line in path.read_bytes().splitlines()]
    header, end = rows[0], rows[-1]
    routes = {r["route_completed"]["route"]: r["route_completed"]
              for r in rows if "route_completed" in r}
    assert end["complete"] and end["routes"] == header["config_count"] == len(routes)
    return header, end, routes


def compare(a, b, distances=True):
    assert len(a["samples"]) == len(b["samples"])
    for x, y in zip(a["samples"], b["samples"]):
        for key in ("query", "split", "layer", "accepted", "result_ids", "cold_reads"):
            assert x[key] == y[key], key
        for key in ("query_energy", "ann_explained"):
            assert bits(x[key]) == bits(y[key]), key
        if distances:
            assert x["distance_bits"] == y["distance_bits"]
            assert x["ann_explained_bits"] == y["ann_explained_bits"]
    for x, y in zip(a["terminals"], b["terminals"]):
        assert x["query"] == y["query"]
        assert x["accepted_layers"] == y["accepted_layers"]
        assert x["total_reads"] == y["total_reads"]
        assert bits(x["explained"]) == bits(y["explained"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("archive", type=Path)
    parser.add_argument("lock", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    header, end, routes = load(args.source)
    archived_header, _, archive = load(args.archive)
    lock_bytes = args.lock.read_bytes()
    lock = json.loads(lock_bytes)
    lock_hash = hashlib.sha256(lock_bytes).hexdigest()
    assert header["experiment"] == "phase4d-v1"
    assert header["mode"] == "validation" and len(set(header["query_ids"])) == 32
    assert header["query_ids"] == archived_header["query_ids"]
    assert header["lock_sha256"] == archived_header["lock_sha256"] == lock_hash
    n = header["n"]
    assert len(routes) == (11 if n == 4096 else 14)
    for i, config in enumerate(lock["configs"]):
        old = routes[f"locked_{i}"]
        for k, v in config.items():
            assert old["params"][k] == v
        compare(old, archive[f"locked_{i}"], distances=False)
        compare(old, routes[f"locked_{i}_reuse"])
        compare(old, routes[f"locked_{i}_envelope"])
    aggregates = []
    for name, route in routes.items():
        audit_route(route, n, 32, ("holdout_v3",))
        p = route["params"] or {}
        for s in route["samples"]:
            if s["stats"] is not None:
                stats = s["stats"]
                assert stats["exact_quad_skips"] + stats["exact_distance_evals"] == s["cold_reads"]
                assert s["compatibility_checked"] == bool(p.get("reuse_transform"))
                assert s["compatibility_reads"] == (s["cold_reads"] if p.get("reuse_transform") else 0)
        item = {k: route[k] for k in ("route", "params", "build_ms", "hot_bytes")}
        item["all"] = summarize(route)
        item["search_trajectory_ms"] = sum(s["search_us"] for s in route["samples"]) / 32000
        item["nnls_trajectory_ms"] = sum(s["nnls_us"] for s in route["samples"]) / 32000
        for layer in item["all"]["layers"]:
            ss = [s for s in route["samples"] if s["layer"] == layer["layer"]]
            layer["search_us"] = mean(s["search_us"] for s in ss)
            if ss[0]["stats"] is not None:
                for key in ("exact_quad_skips", "exact_distance_evals", "visited", "expanded"):
                    layer[key] = mean(s["stats"][key] for s in ss)
        aggregates.append(item)
    output = dict(schema="phase4d-summary-v1", audit="passed", n=n,
                  source=str(args.source), source_sha256=hashlib.sha256(args.source.read_bytes()).hexdigest(),
                  archive=str(args.archive), lock_sha256=lock_hash, completion=end, routes=aggregates)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(output, stream, ensure_ascii=False, indent=2)
    print("AUDIT PASSED", n, output["source_sha256"])
    for r in aggregates:
        a = r["all"]
        print(r["route"], "search_ms", round(r["search_trajectory_ms"], 4),
              "nnls_ms", round(r["nnls_trajectory_ms"], 4),
              "energy", round(a["terminal_explained"], 6),
              "L0/L1", [round(l["own_recall"], 6) for l in a["layers"][:2]],
              "skips", [round(l.get("exact_quad_skips", 0), 2) for l in a["layers"]])


if __name__ == "__main__":
    main()