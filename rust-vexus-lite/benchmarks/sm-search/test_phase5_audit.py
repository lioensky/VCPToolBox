import copy
import unittest
from summarize_phase5 import PARTS, ROUTES, audit, locked_routes


def fixture():
    manifest = {
        "development": [{"chunk_id": q, "file_id": q} for q in range(1, 33)],
        "file_holdout_v1": [{"chunk_id": q, "file_id": q} for q in range(101, 133)],
        "historical_files": [999],
    }
    snapshot = {"snapshot_sha256": "a" * 64, "partition_sha256": "b" * 64}
    rows = [{"type": "header", "schema": "phase5b-pipeline-v1", "mode": "development",
             "queries": 32, "snapshotSha256": "a" * 64, "partitionSha256": "b" * 64}]
    for preset in ("Locked0", "Locked2"):
        rows.append({"type": "warped_build", "preset": preset, "nodes": 40,
                     "connectivity": [40, 0], "hotBytes": 1000, "kernelHotBytes": 900})
    rows.append({"type": "coverage", "active": 40, "indexed": 40, "exceptions": []})
    for q in range(1, 33):
        for route in ROUTES:
            warped = route != "cosine"
            legacy = route.endswith("/1536")
            e = .31 if warped else .30
            attempts = [{"level": level, "ids": [1, 2] if level == 0 else [3, 4],
                         "rerankFetches": 2, "sqlReads": 2, "cacheHits": 0,
                         "distanceEvals": 1, "quadSkips": 1, "visited": 100,
                         "expanded": 25} for level in range(2)]
            d = {part: .01 for part in PARTS}
            d.update(totalMs=.2, pyramidAttempts=attempts)
            if warped:
                d["tagRouting"] = {"used": "warped_ags", "fallback": False,
                                   "legacyBudget": legacy, "attempts": attempts}
            accepted = [{"energyExplained": e, "tags": [{"id": i} for i in a["ids"]]}
                        for a in attempts]
            rows.append({"type": "pipeline", "chunk": q, "file": q, "routeKey": route,
                         "route": "warped_ags" if warped else "cosine",
                         "legacyBudget": legacy, "explained": 2 * e, "diagnostics": d,
                         "downstreamStable": True, "candidateIds": [400, 401],
                         "sqlReadEvents": [["pyramid:bulk", i] for i in range(1, 5)],
                         "uniqueSqlReads": 4, "duplicateSqlReads": 0, "replaySqlReads": 0,
                         "acceptedLevels": accepted})
            for level, a in enumerate(attempts):
                rows.append({"type": "layer_truth", "chunk": q, "routeKey": route,
                             "level": level, "foundIds": a["ids"], "truthIds": a["ids"],
                             "recall": 1., "annExplained": e, "exactExplained": e,
                             "accepted": True})
    rows.append({"type": "complete", "queries": 32, "snapshotSha256": "a" * 64})
    return rows, manifest, snapshot


class AuditTests(unittest.TestCase):
    def test_complete_evidence_and_selection(self):
        result = audit(*fixture())
        self.assertEqual(len(result["qualified"]), 2)

    def test_fault_injection_rejects_corrupt_evidence(self):
        def pipeline(rows):
            return next(r for r in rows if r["type"] == "pipeline" and r["route"] == "warped_ags")

        def truth(rows):
            return next(r for r in rows if r["type"] == "layer_truth")

        faults = [
            lambda r, m, s: r.pop(),
            lambda r, m, s: r.insert(4, copy.deepcopy(pipeline(r))),
            lambda r, m, s: m["file_holdout_v1"][0].update(file_id=1),
            lambda r, m, s: m["historical_files"].append(1),
            lambda r, m, s: r[-1].update(snapshotSha256="wrong"),
            lambda r, m, s: truth(r).update(recall=.5),
            lambda r, m, s: truth(r).update(annExplained=.9),
            lambda r, m, s: pipeline(r).update(uniqueSqlReads=99),
            lambda r, m, s: pipeline(r)["sqlReadEvents"].append(["readout_replay:bulk", 1]),
            lambda r, m, s: pipeline(r)["diagnostics"]["tagRouting"].update(fallback=True),
            lambda r, m, s: pipeline(r)["diagnostics"]["tagRouting"]["attempts"][0].update(visited=9000),
            lambda r, m, s: pipeline(r)["diagnostics"].update(totalMs=float("nan")),
            lambda r, m, s: pipeline(r).update(candidateIds=[1, 1]),
            lambda r, m, s: r.remove(truth(r)),
        ]
        for number, mutate in enumerate(faults):
            with self.subTest(fault=number):
                rows, manifest, snapshot = fixture()
                mutate(rows, manifest, snapshot)
                with self.assertRaises((ValueError, KeyError)):
                    audit(rows, manifest, snapshot)

    def test_validation_uses_only_frozen_routes(self):
        rows, manifest, snapshot = fixture()
        selected = ["locked_2/EpaGuided/2048", "locked_2/EpaGuided/1536"]
        lock = {"schema": "phase5b-lock-v1", "selectedRoutes": selected,
                "snapshotSha256": snapshot["snapshot_sha256"],
                "partitionSha256": snapshot["partition_sha256"]}
        routes = locked_routes(lock, snapshot)
        rows = [r for r in rows if r["type"] not in ("pipeline", "layer_truth")
                or r["routeKey"] in routes]
        rows[0]["mode"] = "validation"
        for r in rows:
            if "chunk" in r:
                r["chunk"] += 100
            if r["type"] == "pipeline":
                r["file"] += 100
        self.assertEqual(set(audit(rows, manifest, snapshot, routes)["routes"]), set(routes))
        with self.assertRaises(ValueError):
            audit(rows, manifest, snapshot)
        for field, value in (("selectedRoutes", []), ("selectedRoutes", [selected[0]] * 2),
                             ("selectedRoutes", ["cosine"]), ("snapshotSha256", "changed"),
                             ("partitionSha256", "changed"), ("schema", "unknown")):
            bad = copy.deepcopy(lock)
            bad[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                locked_routes(bad, snapshot)

    def test_performance_failures_preserve_negative_report(self):
        for metric in ("memory", "check", "unaccounted"):
            rows, manifest, snapshot = fixture()
            for r in rows:
                if metric == "memory" and r["type"] == "warped_build":
                    r["hotBytes"] = 42000001
                if r["type"] == "pipeline" and r["route"] == "warped_ags":
                    if metric == "check":
                        r["diagnostics"]["tagRoutingCheckMs"] = 9.
                        r["diagnostics"]["totalMs"] += 8.99
                    if metric == "unaccounted":
                        r["diagnostics"]["totalMs"] += 2.
            self.assertEqual(audit(rows, manifest, snapshot)["qualified"], [])


if __name__ == "__main__":
    unittest.main()