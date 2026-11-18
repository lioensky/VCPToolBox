"""Read-only geometry probe; Python + numpy + scipy. No production imports/writes."""
import os
for key in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "OMP_NUM_THREADS"):
    os.environ[key] = "1"
import argparse
import collections
import json
import math
import pathlib
import random
import sqlite3
import time
import numpy as np
from scipy.linalg import qr
from scipy.optimize import nnls
from contextlib import nullcontext
try:
    from threadpoolctl import threadpool_limits
except ImportError:
    threadpool_limits = None

def stats(values):
    a = np.asarray(values, dtype=float)
    return {"n": len(a), **({str(p): float(np.percentile(a, p)) for p in (0, 50, 90, 95, 99, 100)} if len(a) else {}),
            "mean": float(a.mean()) if len(a) else None}

def ags(y, A, priors, ids, k, minimum, curve=None):
    basis, picked = [], []
    residual = y.copy()
    started = time.perf_counter()
    for _ in range(min(k, A.shape[1])):
        best = None
        for j in range(A.shape[1]):
            if j in picked:
                continue
            v = A[:, j].copy()
            for _pass in range(2):
                for axis in basis:
                    v -= np.dot(v, axis) * axis
            norm = np.linalg.norm(v)
            if norm <= 1e-6:
                continue
            signed = np.dot(y, v) / norm
            score = abs(signed) * norm * priors[j]
            if best is None or (score, -ids[j]) > (best[0], -ids[best[1]]):
                best = (score, j, v / norm, abs(signed))
        if best is None or best[3] < minimum:
            break
        _, j, axis, _ = best
        residual -= np.dot(y, axis) * axis
        basis.append(axis)
        picked.append(j)
        if curve is not None:
            curve.append({"k": len(basis), "residual": float(np.linalg.norm(residual)),
                          "elapsed_python_ms": (time.perf_counter()-started)*1000})
    return float(np.linalg.norm(residual)), len(basis)

def cone(y, A):
    start = time.perf_counter()
    Q, R = qr(A, mode="economic", check_finite=False)
    z = Q.T @ y
    prepared = time.perf_counter()
    x, _ = nnls(R, z, maxiter=max(1000, A.shape[1] * 30))
    solved = time.perf_counter()
    residual = y - A @ x
    dual = A.T @ residual
    return x, float(np.linalg.norm(residual)), {
        "qr_ms": (prepared-start)*1000, "kernel_ms": (solved-prepared)*1000,
        "total_ms": (time.perf_counter()-start)*1000,
        "dual_violation": float(max(0, dual.max(initial=0))),
        "complementarity": float(np.max(np.abs(x*dual), initial=0))}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sample", type=int, default=64)
    ap.add_argument("--stress", type=int, default=8)
    ap.add_argument("--expand", type=int, default=96)
    ap.add_argument("--neighbors", type=int, default=None)
    ap.add_argument("--axis-limit", type=int, default=None)
    args = ap.parse_args()
    p = pathlib.Path(args.db).resolve()
    con = sqlite3.connect(p.as_uri()+"?mode=ro", uri=True, timeout=15)
    con.execute("PRAGMA query_only=ON")
    con.execute("BEGIN")
    asset = con.execute("SELECT effective_config,artifact_sig,algorithm_version FROM tagmemo_artifacts WHERE asset_type='unified_geometry' AND status='ready' ORDER BY updated_at DESC LIMIT 1").fetchone()
    config = json.loads(asset[0]) if asset else {}
    local = config.get("local", config)
    gate = local.get("semanticGate", local)
    def num(obj, key, default, low, high):
        v = obj.get(key, default)
        return max(low, min(high, float(v)))
    max_n = int(num(local, "maxNeighbors", 48, 1, 256))
    if args.neighbors is not None:
        if not 1 <= args.neighbors <= 256:
            raise ValueError("neighbors must be in [1,256]")
        max_n = args.neighbors
    min_n = int(num(local, "minNeighbors", 3, 1, 256))
    max_k = int(num(local, "maxBasis", 4, 1, 32))
    gain = num(local, "minGain", .015, 0, 1)
    decay = num(local, "positionDecay", .15, 0, 4)
    enabled = gate.get("enabled", gate.get("semanticEnabled", True))
    peak = num(gate, "peak", local.get("semanticPeak", .65), -1, 1)
    sigma = num(gate, "sigma", local.get("semanticSigma", .25), .02, 2)
    floor = num(gate, "floor", local.get("semanticFloor", .35), 0, 1)
    hard = num(gate, "hardFloor", local.get("semanticHardFloor", -1), -1, 1)
    ids = [r[0] for r in con.execute("SELECT id FROM tags ORDER BY id")]
    adjacency = collections.defaultdict(lambda: collections.defaultdict(float))
    start = time.perf_counter()
    rows = con.execute("SELECT file_id,tag_id,COALESCE(position,0) FROM file_tags ORDER BY file_id,position,tag_id")
    import itertools
    for _, group in itertools.groupby(rows, key=lambda r: r[0]):
        tags = list(group)
        if not 2 <= len(tags) <= 100:
            continue
        for i, (_, a, pos) in enumerate(tags):
            for _, b, other in tags[i+1:]:
                if a == b:
                    continue
                distance = max(1, abs(pos-other)) if pos > 0 and other > 0 else 1
                w = math.exp(-decay*(distance-1))
                adjacency[a][b] += w
                adjacency[b][a] += w
    graph_ms = (time.perf_counter()-start)*1000
    rng = random.Random(20261114)
    uniform = rng.sample(ids, min(args.sample, len(ids)))
    stress = sorted(ids, key=lambda i: (-len(adjacency[i]), i))[:args.stress]
    selected = list(dict.fromkeys(uniform+stress))
    cache = {}
    sql_ms = 0.
    def vector(i):
        nonlocal sql_ms
        if i not in cache:
            t = time.perf_counter()
            row = con.execute("SELECT vector FROM tags WHERE id=?", (i,)).fetchone()
            sql_ms += (time.perf_counter()-t)*1000
            v = np.frombuffer(row[0], dtype="<f4").astype(np.float64) if row and row[0] else None
            if v is not None and (not np.all(np.isfinite(v)) or np.linalg.norm(v) <= 1e-12):
                v = None
            if v is not None:
                v /= np.linalg.norm(v)
            cache[i] = v
        return cache[i]
    results = []
    for index, tag in enumerate(selected):
        y = vector(tag)
        if y is None:
            continue
        ns = []
        for other, weight in sorted(adjacency[tag].items(), key=lambda it: (-it[1], it[0])):
            v = vector(other)
            if v is not None and len(v) == len(y):
                ns.append((other, weight, v))
            if len(ns) >= max(max_n, args.expand):
                break
        record = {"id": tag, "uniform": tag in uniform, "degree": len(adjacency[tag]), "valid_neighbors": len(ns)}
        def dictionary(entries):
            kept, prior = [], []
            for other, w, v in entries:
                sim = np.clip(y @ v, -1, 1)
                sem = 1. if not enabled else (0. if sim < hard else floor if sim <= 0 else max(floor, .5+.8*math.exp(-(sim-peak)**2/(2*sigma*sigma))))
                if sem > 0:
                    kept.append((other, v))
                    prior.append(math.log1p(w)*sem)
            return kept, prior
        kept, priors = dictionary(ns[:max_n])
        record["gated"] = len(kept)
        if len(kept) >= min_n:
            A = np.column_stack([v for _, v in kept])
            t = time.perf_counter()
            old, picked = ags(y, A, priors, [i for i, _ in kept], max_k, gain)
            record.update(ags=old, picked=picked, ags_python_ms=(time.perf_counter()-t)*1000)
            t = time.perf_counter()
            ls, _, rank, singular = np.linalg.lstsq(A, y, rcond=1e-12)
            record.update(span=float(np.linalg.norm(y-A@ls)), rank=int(rank),
                          negative_ls=int(np.sum(ls < -1e-8)), ls_ms=(time.perf_counter()-t)*1000)
            x, r, timings = cone(y, A)
            record.update(cone=r, **timings)
            record["cone_minus_span"] = r-record["span"]
            record["ags_minus_span"] = old-record["span"]
            record["cone_minus_ags"] = r-old
            curve = [{"k": 0, "residual": 1.0, "elapsed_python_ms": 0.0}]
            ags(y, A, priors, [i for i, _ in kept],
                min(len(kept), args.axis_limit or len(kept)), gain, curve)
            record["axis_curve"] = []
            for budget in (4, 8, 12, 16, 24, 32, 48):
                point = curve[min(budget, len(curve)-1)]
                record["axis_curve"].append({
                    "budget": budget, "picked": point["k"],
                    "residual": point["residual"],
                    "residual_energy": point["residual"]**2,
                    "gap_to_span": point["residual"]-record["span"],
                    "elapsed_python_ms": point["elapsed_python_ms"],
                    "anchor_gain_default": min(2.0, max(0.5, 0.75+1.25*point["residual"]))
                })
            larger, _ = dictionary(ns)
            if len(larger) > len(kept):
                B = np.column_stack([v for _, v in larger])
                _, expanded, _ = cone(y, B)
                record.update(expanded_cone=expanded, neighborhood_gap=r-expanded)
            # Remove the strongest used generator: sensitivity, not a semantic truth test.
            if A.shape[1] > 1 and x.max(initial=0) > 0:
                _, removed, _ = cone(y, np.delete(A, int(x.argmax()), axis=1))
                record["leave_one_gap"] = removed-r
            if sum("reference_error" in row for row in results) < 8:
                t = time.perf_counter()
                ref, _ = nnls(A, y, maxiter=max(1000, len(kept)*30))
                record.update(reference_ms=(time.perf_counter()-t)*1000,
                              reference_error=float(abs(np.linalg.norm(y-A@ref)-r)),
                              reference_projection_error=float(np.linalg.norm(A@(x-ref))))
        results.append(record)
        print(f"PROGRESS {index+1}/{len(selected)}", flush=True)
    con.rollback()
    con.close()
    fields = ["gated","rank","negative_ls","cone_minus_span","ags_minus_span",
              "cone_minus_ags","neighborhood_gap","leave_one_gap","qr_ms","kernel_ms",
              "total_ms","dual_violation","complementarity","reference_error","reference_projection_error"]
    uniform_results = [r for r in results if r["uniform"]]
    summary = {k: stats([r[k] for r in uniform_results if k in r]) for k in fields}
    report = {"db": str(p), "tags": len(ids), "asset": asset[1:] if asset else None,
              "thread_control": {
                  "environment_threads": 1,
                  "threadpoolctl_available": threadpool_limits is not None,
                  "note": "Environment limits requested before NumPy import; without threadpoolctl runtime pool size is not independently verified."
              },
              "probe_overrides": {"neighbors": max_n, "axis_limit": args.axis_limit},
              "effective_config": config, "graph_build_python_ms": graph_ms,
              "degree_all_tags": stats([len(adjacency[i]) for i in ids]),
              "sql_vector_read_ms": sql_ms, "cached_vectors": len(cache),
              "uniform_summary": summary, "rows": results,
              "limits": ["Python/SciPy single-thread timings are not Rust production timings.",
                         "Geometric reconstruction and neighborhood stability are not retrieval accuracy.",
                         "Expansion uses cooccurrence order; it cannot prove full semantic coverage.",
                         "Python AGS emulates the greedy rule but is not bitwise Rust equivalence."]}
    valid = [r["total_ms"] for r in uniform_results if "total_ms" in r]
    report["single_thread_solver_hours_extrapolated"] = (sum(valid)/len(uniform_results)*len(ids)/3.6e6) if uniform_results else None
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k:v for k,v in report.items() if k not in ("rows","effective_config")}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    with (threadpool_limits(limits=1) if threadpool_limits is not None else nullcontext()):
        main()