"""Independent Phase 5B evidence audit. Never reads vectors or validation results."""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
from statistics import mean

PARTS = ("epaMs", "pyramidMs", "gatingMs", "sensingMs", "fusionMs",
         "dualFieldSolveMs", "dualFieldProjectMs", "dualFieldDomainMs",
         "tagRoutingCheckMs")
ROUTES = ["cosine"] + [f"locked_{p}/{s}/{b}" for b in (1536, 2048)
                       for p in (0, 2) for s in ("LayerSchedule", "EpaGuided")]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def finite(value):
    require(type(value) in (int, float) and math.isfinite(value), "nonfinite number")
    return value


def audit(rows, manifest, snapshot, expected_routes=None):
    require(rows and rows[0]["type"] == "header" and rows[-1]["type"] == "complete",
            "missing header/completion")
    require(sum(r["type"] == "header" for r in rows) == 1
            and sum(r["type"] == "complete" for r in rows) == 1, "duplicate boundaries")
    head, end = rows[0], rows[-1]
    require(head["schema"] == "phase5b-pipeline-v1", "wrong report schema")
    require(head["mode"] in ("development", "validation"), "wrong mode")
    require(head["queries"] == end["queries"] == 32, "incomplete query count")
    require(head["snapshotSha256"] == end["snapshotSha256"] == snapshot["snapshot_sha256"],
            "snapshot identity mismatch")
    require(head["partitionSha256"] == snapshot["partition_sha256"], "partition identity mismatch")
    dev, val = manifest["development"], manifest["file_holdout_v1"]
    historic = set(manifest["historical_files"])
    for entries in (dev, val):
        require(len(entries) == 32 and len({e["file_id"] for e in entries}) == 32,
                "duplicate or missing files")
        require(not ({e["file_id"] for e in entries} & historic), "historical file leakage")
    require(not ({e["file_id"] for e in dev} & {e["file_id"] for e in val}), "file leakage")
    entries = dev if head["mode"] == "development" else val
    wanted = {e["chunk_id"]: e["file_id"] for e in entries}
    require(len(wanted) == 32, "duplicate chunks")
    routes = set(expected_routes or ROUTES)
    require("cosine" in routes, "missing baseline")
    pipelines, truths, builds = {}, {}, {}
    coverage = []
    for r in rows[1:-1]:
        kind = r["type"]
        if kind == "warped_build":
            require(r["preset"] not in builds, "duplicate build")
            require(r["connectivity"] == [r["nodes"], 0], "disconnected field")
            require(0 < r["kernelHotBytes"] <= r["hotBytes"], "invalid memory accounting")
            builds[r["preset"]] = r
        elif kind == "coverage":
            coverage.append(r)
        elif kind == "cosine_build":
            require(r["hotBytes"] > 0 and r["nodes"] > 0, "invalid baseline build")
        elif kind == "pipeline":
            key = (r["chunk"], r["routeKey"])
            require(key not in pipelines, "duplicate pipeline")
            require(r["chunk"] in wanted and r["file"] == wanted[r["chunk"]], "query identity")
            require(r["routeKey"] in routes, "unregistered route")
            require(r["downstreamStable"] is True, "unstable readout")
            ids = r["candidateIds"]
            require(ids and len(ids) == len(set(ids)) and r["chunk"] not in ids,
                    "candidate scope/self leak")
            diagnostics = r["diagnostics"]
            for part in (*PARTS, "totalMs"):
                require(finite(diagnostics[part]) >= 0, "negative timing")
            events = r["sqlReadEvents"]
            require(all(isinstance(e[0], str) and type(e[1]) is int and e[1] > 0 for e in events),
                    "bad cold-read event")
            unique = len({e[1] for e in events})
            replay = sum(e[0].startswith("readout_replay:") for e in events)
            require(unique == r["uniqueSqlReads"]
                    and len(events) - unique == r["duplicateSqlReads"]
                    and replay == r["replaySqlReads"], "cold-read reconciliation")
            require(replay == 0, "replay rereads Tags")
            if r["route"] == "warped_ags":
                require(r["duplicateSqlReads"] == 0, "warped duplicate Tag SQL")
                routing = diagnostics["tagRouting"]
                require(routing["used"] == "warped_ags" and not routing["fallback"],
                        "silent fallback")
                require(routing["legacyBudget"] == r["legacyBudget"], "budget identity")
                for a in routing["attempts"]:
                    require(a["rerankFetches"] == a["sqlReads"] + a["cacheHits"] <= 64,
                            "rerank budget/accounting")
                    require(a["distanceEvals"] + a["quadSkips"] == a["rerankFetches"],
                            "quadrature reconciliation")
                    cap = 1536 if r["legacyBudget"] else 2048
                    require(a["visited"] <= cap and a["expanded"] <= cap // 4, "hot budget")
            require(0 <= finite(r["explained"]) <= 1, "explained range")
            pipelines[key] = r
        elif kind == "layer_truth":
            key = (r["chunk"], r["routeKey"], r["level"])
            require(key not in truths, "duplicate truth")
            found, truth = r["foundIds"], r["truthIds"]
            require(truth and len(truth) == len(set(truth)) <= 10
                    and len(found) == len(set(found)), "bad truth IDs")
            recall = len(set(found) & set(truth)) / len(truth)
            require(abs(finite(r["recall"]) - recall) < 1e-12, "recall reconciliation")
            for metric in ("annExplained", "exactExplained"):
                require(0 <= finite(r[metric]) <= 1, "layer energy")
            truths[key] = r
        else:
            raise ValueError(f"unknown row: {kind}")
    require(set(pipelines) == {(q, route) for q in wanted for route in routes}, "incomplete routes")
    require(len(coverage) == 1, "missing coverage")
    cov = coverage[0]
    require(cov["active"] - cov["indexed"] == len(cov["exceptions"]), "coverage reconciliation")
    require(len({r["id"] for r in cov["exceptions"]}) == len(cov["exceptions"]), "duplicate exception")
    used_truth = set()
    for (q, route), p in pipelines.items():
        attempts = p["diagnostics"]["pyramidAttempts"]
        accepted = p["acceptedLevels"]
        require([a["level"] for a in attempts] == list(range(len(attempts))), "layer continuity")
        require(len(accepted) <= len(attempts) <= len(accepted) + 1, "acceptance count")
        energy = 0
        excluded = set()
        for a in attempts:
            key = (q, route, a["level"])
            require(key in truths, "missing layer truth")
            t = truths[key]
            used_truth.add(key)
            require(t["foundIds"] == a["ids"], "actual trajectory mismatch")
            require(t["accepted"] == (a["level"] < len(accepted)), "acceptance mismatch")
            if route != "cosine":
                require(not (set(a["ids"]) & excluded), "cross-layer exclusion")
            if t["accepted"]:
                layer = accepted[a["level"]]
                require(abs(t["annExplained"] - layer["energyExplained"]) < 1e-10,
                        "NNLS actual energy mismatch")
                energy += t["annExplained"]
                excluded.update(tag["id"] for tag in layer["tags"])
        require(abs(energy - p["explained"]) < 1e-10, "final energy reconciliation")
        require((q, route, 0) in truths and (q, route, 1) in truths, "L0/L1 missing")
        baseline = pipelines[(q, "cosine")]
        require(p["candidateIds"] == baseline["candidateIds"], "candidate mismatch across routes")
    require(set(truths) == used_truth, "orphan truth")
    summaries = {}
    for route in sorted(routes):
        ps = [pipelines[(q, route)] for q in wanted]
        layers = {level: [truths[(q, route, level)] for q in wanted] for level in (0, 1)}
        s = {
            "explained": mean(p["explained"] for p in ps),
            "totalMs": mean(p["diagnostics"]["totalMs"] for p in ps),
            "checkMs": mean(p["diagnostics"]["tagRoutingCheckMs"] for p in ps),
            "unaccountedMs": mean(p["diagnostics"]["totalMs"]
                                  - sum(p["diagnostics"][part] for part in PARTS) for p in ps),
            "uniqueSqlReads": mean(p["uniqueSqlReads"] for p in ps),
            "duplicateSqlReads": sum(p["duplicateSqlReads"] for p in ps),
            "replaySqlReads": sum(p["replaySqlReads"] for p in ps),
            "stages": {part: mean(p["diagnostics"][part] for p in ps) for part in PARTS},
            "layers": {str(level): {
                "recall": mean(t["recall"] for t in ts),
                "exactExplained": mean(t["exactExplained"] for t in ts),
                "annExplained": mean(t["annExplained"] for t in ts),
                "uniqueTags": len({i for t in ts for i in t["foundIds"]}),
            } for level, ts in layers.items()},
        }
        if route != "cosine":
            preset = "Locked" + route.split("/")[0][-1]
            require(preset in builds, "missing field build")
            s["hotBytes"] = builds[preset]["hotBytes"]
        summaries[route] = s
    baseline = summaries["cosine"]["explained"]
    qualified = [r for r, s in summaries.items() if r != "cosine"
                 and s["hotBytes"] <= 42000000 and s["layers"]["0"]["recall"] >= .90
                 and s["layers"]["1"]["recall"] >= .85 and s["explained"] > baseline
                 and s["checkMs"] < .25 and abs(s["unaccountedMs"]) < .5]
    qualified.sort(key=lambda r: (-summaries[r]["explained"], summaries[r]["totalMs"], r))
    return {"schema": "phase5b-audit-v1", "mode": head["mode"], "queries": 32,
            "routes": summaries, "qualified": qualified[:2], "coverage": cov,
            "snapshotSha256": head["snapshotSha256"], "partitionSha256": head["partitionSha256"]}


def locked_routes(lock, snapshot):
    require(lock["schema"] == "phase5b-lock-v1", "lock schema")
    require(lock["snapshotSha256"] == snapshot["snapshot_sha256"]
            and lock["partitionSha256"] == snapshot["partition_sha256"], "lock identity")
    selected = lock["selectedRoutes"]
    require(1 <= len(selected) <= 2 and len(set(selected)) == len(selected)
            and all(r in ROUTES and r != "cosine" for r in selected), "lock routes")
    return ["cosine", *selected]


def create_lock(result, report, manifest, snapshot_audit, regression_path, crate):
    require(result["mode"] == "development" and result["qualified"], "no qualified development")
    regression = json.loads(regression_path.read_text(encoding="utf-8"))
    require(regression["schema"] == "phase5b-regression-v1"
            and regression["hostPassed"] >= 240 and regression["kernelPassed"] >= 121
            and regression["pythonPassed"] >= 3 and regression["failed"] == 0,
            "incomplete regression evidence")
    paths = set(crate.joinpath("src").rglob("*.rs"))
    paths.update(crate.joinpath("crates/vcp-tdb-index/src").rglob("*.rs"))
    paths.update([crate / "Cargo.toml", crate / "Cargo.lock",
                  crate / "crates/vcp-tdb-index/Cargo.toml",
                  Path(__file__).resolve(),
                  Path(__file__).resolve().with_name("test_phase5_audit.py"),
                  report, manifest, snapshot_audit, regression_path])
    bound = [{"path": p.resolve().relative_to(crate.resolve()).as_posix(), "sha256": digest(p)}
             for p in sorted(paths)]
    return {"schema": "phase5b-lock-v1", "selectedRoutes": result["qualified"],
            "snapshotSha256": result["snapshotSha256"], "partitionSha256": result["partitionSha256"],
            "developmentReportSha256": digest(report), "boundFiles": bound,
            "selection": "explained descending, totalMs ascending, route lexical; top two",
            "geometry": {"radiusMin": .35, "radiusMax": .65, "throat": 1.5,
                         "angularScale": 2., "softening": .15, "width": 128, "rerankLimit": 64,
                         "meanBeta": {"locked_0": 1., "locked_2": .7}},
            "regression": regression}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--snapshot-audit", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--lock-output", type=Path)
    parser.add_argument("--regression-evidence", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    snapshot = json.loads(args.snapshot_audit.read_text(encoding="utf-8"))
    require(digest(args.manifest) == snapshot["partition_sha256"], "manifest hash")
    rows = [json.loads(line) for line in args.report.read_text(encoding="utf-8").splitlines()]
    expected = None
    if rows[0]["mode"] == "validation":
        require(args.lock is not None and args.lock_output is None, "validation requires existing lock")
        lock = json.loads(args.lock.read_text(encoding="utf-8"))
        expected = locked_routes(lock, snapshot)
        require(rows[0]["lockSha256"] == digest(args.lock), "validation lock hash")
    else:
        require(args.lock is None, "development does not consume validation lock")
    result = audit(rows, manifest, snapshot, expected)
    result["reportSha256"] = digest(args.report)
    if args.lock_output is not None:
        require(args.regression_evidence is not None, "lock requires regressions")
        crate = Path(__file__).resolve().parents[2]
        locked = create_lock(result, args.report, args.manifest, args.snapshot_audit,
                             args.regression_evidence, crate)
        with args.lock_output.open("x", encoding="utf-8") as out:
            json.dump(locked, out, ensure_ascii=True, indent=2, allow_nan=False)
    if args.lock is not None:
        result["lockSha256"] = digest(args.lock)
        result["qualified"] = []  # Validation is measurement, never a second selection.
    with args.output.open("x", encoding="utf-8") as out:
        json.dump(result, out, ensure_ascii=True, indent=2, allow_nan=False)
    print(json.dumps({"audited": True, "qualified": result["qualified"]}))


if __name__ == "__main__":
    main()