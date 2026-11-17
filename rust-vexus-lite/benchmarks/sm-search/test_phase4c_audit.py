"""Independent tiny evidence fixture and corruption tests for the route auditor."""
import copy
import unittest
from summarize_phase4b import audit_route
from summarize_phase4c import eligible


def fixture():
    ids = list(range(1, 11))
    stage = dict(seed_ids=[1], visited_ids=ids, retained_ids=ids, stage05_ids=ids,
                 seed_hit_rate=.1, visited_hit_rate=1., beam_retained_hit_rate=1.,
                 stage05_top64_hit_rate=1., first_visit_rejection_expansion=None,
                 rejected_discoveries=0, expansions_after_visit_limit=0)
    sample = dict(query=0, split="development", layer=0, accepted=False,
                  query_energy=1., result_ids=ids, truth_ids=ids,
                  oracle_reads=20, cold_reads=10, control_reads=10,
                  nnls_additional_reads=0, oracle_fit_reads=10, ann_explained=.02,
                  own_recall=1., stages=stage, inner_control=copy.deepcopy(stage),
                  stats=dict(visited=10, expanded=2), search_us=10., nnls_us=2.)
    return dict(params=dict(max_visits=1024, max_expansions=256, compact_seeds=True),
                samples=[sample], terminals=[dict(query=0, accepted_layers=0,
                explained=0., total_reads=10, total_us=12.)])


class AuditTests(unittest.TestCase):
    def test_valid_and_validation_split(self):
        route = fixture()
        audit_route(route, 20, 1)
        route["samples"][0]["split"] = "holdout_v3"
        audit_route(route, 20, 1, ("holdout_v3",))
        with self.assertRaises(AssertionError):
            audit_route(route, 20, 1)

    def test_corruptions_are_rejected(self):
        def change(path, value):
            route = fixture()
            obj = route
            for key in path[:-1]:
                obj = obj[key]
            obj[path[-1]] = value
            return route
        mutations = [
            (("samples", 0, "cold_reads"), 65),
            (("samples", 0, "oracle_reads"), 19),
            (("samples", 0, "own_recall"), .9),
            (("samples", 0, "result_ids"), [1, 1]),
            (("samples", 0, "stats", "visited"), 1025),
            (("samples", 0, "stats", "expanded"), 257),
            (("samples", 0, "stages", "stage05_ids"), [19]),
            (("samples", 0, "stages", "seed_ids"), list(range(1, 18))),
            (("samples", 0, "stages", "rejected_discoveries"), 1),
            (("terminals", 0, "explained"), .02),
            (("terminals", 0, "total_reads"), 9),
            (("terminals", 0, "total_us"), 11.),
        ]
        for path, value in mutations:
            with self.subTest(path=path), self.assertRaises(AssertionError):
                audit_route(change(path, value), 20, 1)

    def test_only_full_repairs_with_locked_budget_are_eligible(self):
        p = dict(adaptive_compass=True, asymmetric=True, compact_seeds=True,
                 max_visits=1024, max_expansions=256)
        self.assertTrue(eligible(p))
        for key in ("adaptive_compass", "asymmetric", "compact_seeds"):
            self.assertFalse(eligible(dict(p, **{key: False})))
        self.assertFalse(eligible(dict(p, max_visits=512)))
        self.assertFalse(eligible(None))


if __name__ == "__main__":
    unittest.main()