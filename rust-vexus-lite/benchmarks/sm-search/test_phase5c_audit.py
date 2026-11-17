import copy
import unittest
from summarize_phase5c import audit, ROUTES


def fixture():
    manifest = {g: [{"chunk_id": start + q, "file_id": start + q} for q in range(32)]
                for g, start in (("development", 100), ("file_holdout_v1", 200))}
    manifest["historical_files"] = [999]
    snapshot = {"snapshot_sha256": "a", "partition_sha256": "b"}
    rows = [{"type": "header", "schema": "phase5c-navigation-v1",
             "mode": "observed_diagnostic", "queries": 64,
             "snapshotSha256": "a", "partitionSha256": "b",
             "budget": {"width": 128, "maxVisits": 2048, "maxExpansions": 512, "rerank": 64}},
            {"type": "build", "nodes": 40, "connectivity": [40, 0], "landmarks": 512,
             "hotBytes": 3048, "referenceHotBytes": 1000, "extraDirectoryBytes": 2048}]
    for group in ("development", "file_holdout_v1"):
        for entry in manifest[group]:
            q = entry["chunk_id"]
            for route in ROUTES:
                fast = route in ("reuse", "combined")
                attempts, accepted, events = [], [], []
                for level in (0, 1):
                    ids = list(range(1 + level * 10, 11 + level * 10))
                    events.extend([["pyramid:sql", i] for i in ids])
                    a = {"level": level, "ids": ids, "converged": True, "visited": 10,
                         "expanded": 5, "rerankFetches": 10, "sqlReads": 10,
                         "cacheHits": 0, "distanceEvals": 10, "quadSkips": 0}
                    attempts.append(a)
                    accepted.append({"energyExplained": .3, "tags": [{"id": i} for i in ids]})
                    rows.append({"type": "layer", "group": group, "chunk": q, "route": route,
                                 "level": level, "foundIds": ids, "truthIds": ids,
                                 "accepted": True, "annExplained": .3, "exactExplained": .3,
                                 "visited": 10, "expanded": 5, "converged": True,
                                 "visitedIds": ids, "seeds": ids[:1], "retainedIds": ids,
                                 "stage05Ids": ids, "coldIds": ids, "distanceBits": [[i, i] for i in ids],
                                 "stage05Evaluations": 0 if fast else 10,
                                 "workspaceBytes": 500 if fast else 0, "seedMs": .01})
                    for repeat in range(1, 6):
                        rows.append({"type": "search_timing", "group": group, "chunk": q,
                                     "route": route, "level": level, "repeat": repeat, "ms": .1})
                rows.append({"type": "pipeline", "group": group, "chunk": q, "file": q,
                             "route": route, "routing": {"used": "warped_ags", "fallback": False,
                                "shellDirectory": route in ("directory512", "combined"),
                                "reuseBeam": fast, "legacyBudget": False},
                             "sqlReadEvents": events, "uniqueSqlReads": 20, "attempts": attempts,
                             "pyramid": {"levels": accepted}, "enhancedBits": [1, 2], "explained": .6})
                for repeat in (1, 2, 3):
                    rows.append({"type": "pipeline_timing", "group": group, "chunk": q,
                                 "route": route, "repeat": repeat, "totalMs": 1.,
                                 "pyramidMs": .5, "checkMs": .1})
    rows.append({"type": "complete", "queries": 64, "snapshotSha256": "a"})
    return rows, manifest, snapshot


class AuditTests(unittest.TestCase):
    def test_complete(self):
        self.assertTrue(audit(*fixture())["eligibleForFreshValidation"])

    def test_faults_rejected(self):
        def first(rows, kind):
            return next(r for r in rows if r["type"] == kind)
        mutations = [
            lambda r, m, s: r.pop(),
            lambda r, m, s: r.append(r[-1]),
            lambda r, m, s: first(r, "build").update(extraDirectoryBytes=0),
            lambda r, m, s: first(r, "pipeline").update(uniqueSqlReads=0),
            lambda r, m, s: first(r, "pipeline").update(explained=.7),
            lambda r, m, s: first(r, "layer").update(distanceBits=[]),
            lambda r, m, s: first(r, "layer").update(visited=9999),
            lambda r, m, s: first(r, "layer").update(coldIds=[1, 1]),
            lambda r, m, s: first(r, "pipeline_timing").update(totalMs=float("nan")),
            lambda r, m, s: r.remove(first(r, "search_timing")),
            lambda r, m, s: m["historical_files"].append(100),
            lambda r, m, s: s.update(snapshot_sha256="changed"),
        ]
        for i, mutate in enumerate(mutations):
            with self.subTest(fault=i):
                args = copy.deepcopy(fixture())
                mutate(*args)
                with self.assertRaises((ValueError, KeyError)):
                    audit(*args)

    def test_energy_regression_is_valid_negative_evidence(self):
        rows, manifest, snapshot = fixture()
        # Reduce both directory routes, retaining implementation-only equivalence.
        for r in rows:
            if r.get("route") not in ("directory512", "combined"):
                continue
            if r["type"] == "layer":
                r["annExplained"] = .29
            if r["type"] == "pipeline":
                r["explained"] = .58
                for level in r["pyramid"]["levels"]:
                    level["energyExplained"] = .29
        result = audit(rows, manifest, snapshot)
        self.assertFalse(result["eligibleForFreshValidation"])
        self.assertFalse(result["developmentGates"]["energyNonRegression"])


if __name__ == "__main__":
    unittest.main()