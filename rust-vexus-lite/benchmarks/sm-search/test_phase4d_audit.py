"""Fault injection for Phase 4D bit-preservation auditing."""
import copy
import unittest
from summarize_phase4d import compare, bits
from test_phase4c_audit import fixture


class Phase4DAuditTests(unittest.TestCase):
    def make(self):
        r = fixture()
        r["samples"][0]["distance_bits"] = list(range(10))
        r["samples"][0]["ann_explained_bits"] = 123
        return r

    def test_equal_and_archive_without_distance_bits(self):
        a = self.make()
        compare(a, copy.deepcopy(a))
        archived = copy.deepcopy(a)
        del archived["samples"][0]["distance_bits"]
        del archived["samples"][0]["ann_explained_bits"]
        compare(a, archived, distances=False)

    def test_distance_energy_and_read_corruption_rejected(self):
        a = self.make()
        for key, value in (("distance_bits", [1] * 10),
                           ("ann_explained_bits", 124),
                           ("ann_explained", .020000000000000004),
                           ("cold_reads", 11),
                           ("result_ids", list(range(2, 12)))):
            b = copy.deepcopy(a)
            b["samples"][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                compare(a, b)

    def test_signed_zero_is_not_treated_as_bit_equal(self):
        self.assertNotEqual(bits(0.), bits(-0.))


if __name__ == "__main__":
    unittest.main()