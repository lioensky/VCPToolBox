"""Synthetic temporary fixtures only; no production or diary data."""
from contextlib import closing
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
import tempfile
import unittest

from export_real_tags import export, inbound_log_quantiles


class QuantileTests(unittest.TestCase):
    def test_extreme_magnitude_does_not_move_other_ranks(self):
        original = inbound_log_quantiles(enumerate([0.0, 1.0, 2.0, 134.7]))
        extreme = inbound_log_quantiles(enumerate([0.0, 1.0, 2.0, 1e300]))
        self.assertEqual(original, extreme)
        self.assertEqual(original, {0: 0.0, 1: 1/3, 2: 2/3, 3: 1.0})

    def test_ties_do_not_use_id_to_invent_specificity(self):
        self.assertEqual(inbound_log_quantiles([(9, 0.0), (1, 0.0), (5, 2.0)]),
                         {9: 0.25, 1: 0.25, 5: 1.0})
        self.assertEqual(inbound_log_quantiles([(8, 1.0), (2, 1.0)]),
                         {8: 0.5, 2: 0.5})

    def test_empty_singleton_and_permutations(self):
        self.assertEqual(inbound_log_quantiles([]), {})
        self.assertEqual(inbound_log_quantiles([(99, 3.0)]), {99: 0.5})
        pairs = [(i, i % 4) for i in range(20)]
        self.assertEqual(inbound_log_quantiles(pairs),
                         inbound_log_quantiles(reversed(pairs)))

    def test_invalid_rank_inputs_fail(self):
        for value in [-1.0, float("inf"), float("nan")]:
            with self.assertRaisesRegex(ValueError, "rank input"):
                inbound_log_quantiles([(1, value)])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            inbound_log_quantiles([(1, 1.0), (1, 2.0)])


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / "source.sqlite"
        self.output = Path(self.directory.name) / "export.sqlite"
        self.payload = {
            "artifact": {"artifactSig": "transport", "modelSig": "model"},
            "inboundMassView": [[i, 1.0] for i in range(1, 513)],
            "rawResidualRatioView": [[i, 0.25] for i in range(1, 513)],
        }
        with closing(sqlite3.connect(self.source)) as c, c:
            c.executescript("""
                CREATE TABLE rivermemo_artifacts(
                    artifact_sig,model_sig,payload_codec,payload_checksum,payload,
                    database_generation,source_graph_generation,status,updated_at);
                CREATE TABLE kbm_runtime_meta(key,value);
                CREATE TABLE tagmemo_artifacts(
                    artifact_sig,graph_generation,asset_type,status,model_sig,updated_at);
                CREATE TABLE tag_intrinsic_residuals(
                    tag_id,raw_residual_ratio,artifact_sig,model_sig,status);
                CREATE TABLE tags(id INTEGER PRIMARY KEY,name,vector);
                CREATE TABLE chunks(id INTEGER PRIMARY KEY,vector);
                INSERT INTO kbm_runtime_meta VALUES('memo_tag_facts','100');
                INSERT INTO tagmemo_artifacts VALUES('geometry','facts:100',
                    'unified_geometry','ready','model',1);
                INSERT INTO rivermemo_artifacts VALUES('transport','model',
                    'gzip-json-v1',NULL,NULL,1,'graph','ready',1);
            """)
            vector = struct.pack("<65f", *([1.0] * 65))
            for i in range(1, 513):
                c.execute("INSERT INTO tags VALUES(?,?,?)", (i, "tag-%d" % i, vector))
                c.execute("INSERT INTO tag_intrinsic_residuals VALUES(?,?,?,?,?)",
                          (i, 0.25, "geometry", "model", "computed"))
            c.execute("INSERT INTO chunks VALUES(1,?)", (vector,))
        self.publish()

    def publish(self):
        blob = gzip.compress(json.dumps(self.payload).encode())
        with closing(sqlite3.connect(self.source)) as c, c:
            c.execute("UPDATE rivermemo_artifacts SET payload=?,payload_checksum=?",
                      (blob, hashlib.sha256(blob).hexdigest()))

    def execute(self, sql):
        with closing(sqlite3.connect(self.source)) as c, c:
            c.execute(sql)

    def test_export_preserves_source_and_refuses_overwrite(self):
        before = hashlib.sha256(self.source.read_bytes()).digest()
        meta = export(self.source, self.output, 512, 1)
        self.assertFalse(meta["diagnostic_only"])
        self.assertEqual(meta["transport_residual_missing"], 0)
        self.assertEqual(meta["exported_tags"], 512)
        self.assertEqual(before, hashlib.sha256(self.source.read_bytes()).digest())
        self.assertEqual(meta["inbound_quantile_population"], 512)
        with closing(sqlite3.connect(self.output)) as c:
            values = c.execute("SELECT DISTINCT inbound_log_quantile FROM tags").fetchall()
            self.assertEqual(values, [(0.5,)])
        output_before = self.output.read_bytes()
        with self.assertRaisesRegex(ValueError, "new file"):
            export(self.source, self.output, 512, 1)
        self.assertEqual(output_before, self.output.read_bytes())
        with self.assertRaisesRegex(ValueError, "new file"):
            export(self.source, self.source, 512, 1)

    def test_stale_facts_rejected_without_creating_output(self):
        self.execute("UPDATE kbm_runtime_meta SET value='101'")
        with self.assertRaisesRegex(ValueError, "geometry stale"):
            export(self.source, self.output, 512, 1)
        self.assertFalse(self.output.exists())
        self.assertTrue(export(self.source, self.output, 512, 1, True)["diagnostic_only"])

    def test_empty_snapshot_is_missing_not_conflicting(self):
        self.payload["rawResidualRatioView"] = []
        self.publish()
        with self.assertRaisesRegex(ValueError, "missing=512 mismatched=0"):
            export(self.source, self.output, 512, 1)
        self.assertFalse(self.output.exists())
        meta = export(self.source, self.output, 512, 1, True)
        self.assertEqual(meta["transport_sql_residual_mismatches"], 0)
        self.assertEqual(meta["transport_residual_missing"], 512)

    def test_actual_residual_conflict_is_distinct(self):
        self.payload["rawResidualRatioView"][0][1] = 0.75
        self.publish()
        with self.assertRaisesRegex(ValueError, "missing=0 mismatched=1"):
            export(self.source, self.output, 512, 1)

    def test_checksum_and_model_identity(self):
        self.execute("UPDATE rivermemo_artifacts SET payload_checksum='bad'")
        with self.assertRaisesRegex(ValueError, "checksum"):
            export(self.source, self.output, 512, 1)
        self.payload["artifact"]["modelSig"] = "other"
        self.publish()
        with self.assertRaisesRegex(ValueError, "identity"):
            export(self.source, self.output, 512, 1)

    def test_missing_inbound_is_not_zero_mass(self):
        self.payload["inboundMassView"].pop()
        self.publish()
        with self.assertRaisesRegex(ValueError, "not enough valid"):
            export(self.source, self.output, 512, 1, True)

    def test_wrong_residual_model_has_no_joint_coverage(self):
        self.execute("UPDATE tag_intrinsic_residuals SET model_sig='other'")
        with self.assertRaisesRegex(ValueError, "not enough valid"):
            export(self.source, self.output, 512, 1, True)


if __name__ == "__main__":
    unittest.main()