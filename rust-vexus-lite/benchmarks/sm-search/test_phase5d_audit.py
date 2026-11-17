import copy
import itertools
import unittest
from summarize_phase5 import PARTS
from summarize_phase5d import audit, ROUTES
from test_phase5c_audit import fixture as old_fixture


def fixture():
    old, manifest, snapshot = old_fixture()
    rename = {"reference": "reference", "directory512": "shell512",
              "reuse": "union", "combined": "nms"}
    h = old[0]
    h.update(schema="phase5d-seeds-v1", mode="development", repeats=3,
             candidate="nms", threshold=.60, inner=4, seedCap=16)
    rows = [h]
    manifest["historical_files"] = list(range(1000, 1108))
    for r in old[1:]:
        kind = r["type"]
        if kind == "search_timing":
            continue
        if "route" in r:
            r["route"] = rename[r["route"]]
            shell, policy = ROUTES[r["route"]]
        if kind == "pipeline":
            r["config"] = {"warpedPreset": "locked_2", "warpedRadiusStrategy": "EpaGuided",
                           "warpedSeedPolicy": policy, "warpedShellDirectory": shell,
                           "warpedReuseBeam": True}
            r["routing"].update(reuseBeam=True, shellDirectory=shell, seedPolicy=policy)
        if kind == "layer":
            r["referenceDistanceBits"] = copy.deepcopy(r["distanceBits"])
            r["referenceColdIds"] = r["coldIds"][:]
            r["seeds"] = r["visitedIds"][:]
            r["directionSeeds"] = r["seeds"][8 if policy == 0 else 4:]
            r["directionPairs"] = [[a, b, .1] for a, b in
                                   itertools.combinations(r["directionSeeds"], 2)]
            r.update(directoryCandidates=20, nmsComparisons=15 if policy == 2 else 0,
                     nmsRejections=0, nmsFills=0)
        if kind == "pipeline_timing":
            r["type"] = "timing"
            r["diagnostics"] = {k: .01 for k in PARTS}
            r["diagnostics"]["totalMs"] = 1.
        rows.append(r)
    return rows, manifest, snapshot


class AuditTests(unittest.TestCase):
    def test_complete_but_energy_failure_is_preserved(self):
        result = audit(*fixture())
        self.assertFalse(result["eligibleForFreshValidation"])
        self.assertFalse(result["gates"]["developmentEnergy"])
        self.assertEqual(result["unionVsNmsDifferentPyramids"], 0)

    def test_fault_injection(self):
        def first(rows, kind):
            return next(r for r in rows if r["type"] == kind)
        def nms(rows):
            return next(r for r in rows if r["type"] == "layer" and r["route"] == "nms")
        faults = [
            lambda r, m, s: r.pop(),
            lambda r, m, s: r.insert(1, copy.deepcopy(first(r, "pipeline"))),
            lambda r, m, s: r[0].update(threshold=.55),
            lambda r, m, s: r[0].update(seedCap=20),
            lambda r, m, s: first(r, "pipeline")["routing"].update(fallback=True),
            lambda r, m, s: first(r, "pipeline").update(uniqueSqlReads=999),
            lambda r, m, s: first(r, "pipeline").update(explained=.8),
            lambda r, m, s: first(r, "layer").update(referenceDistanceBits=[]),
            lambda r, m, s: first(r, "layer").update(referenceColdIds=[]),
            lambda r, m, s: first(r, "layer").update(visited=9999),
            lambda r, m, s: nms(r)["directionPairs"][0].__setitem__(2, .60),
            lambda r, m, s: nms(r).update(nmsFills=999),
            lambda r, m, s: first(r, "layer").update(directionPairs=[]),
            lambda r, m, s: first(r, "timing")["diagnostics"].update(totalMs=float("nan")),
            lambda r, m, s: r.remove(first(r, "timing")),
            lambda r, m, s: s.update(snapshot_sha256="wrong"),
            lambda r, m, s: m["historical_files"].append(100),
        ]
        for i, mutate in enumerate(faults):
            with self.subTest(fault=i):
                args = copy.deepcopy(fixture())
                mutate(*args)
                with self.assertRaises((ValueError, KeyError)):
                    audit(*args)

    def test_gate_pass_is_possible_without_changing_threshold(self):
        rows, manifest, snapshot = fixture()
        for r in rows:
            if r.get("route") != "nms":
                continue
            if r["type"] == "layer":
                r["annExplained"] = .32
            if r["type"] == "pipeline":
                r["explained"] = .64
                for level in r["pyramid"]["levels"]:
                    level["energyExplained"] = .32
        self.assertTrue(audit(rows, manifest, snapshot)["eligibleForFreshValidation"])


if __name__ == "__main__":
    unittest.main()