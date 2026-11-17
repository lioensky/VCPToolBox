"""Synthetic-only audit of Phase 5 file partitioning."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from phase5_partition import choose, file_hash, partition


class PartitionTests(unittest.TestCase):
    def test_selection_is_order_independent_and_excludes_files(self):
        rows = [(i, i * 10, f"diary-{i % 3}") for i in range(1, 40)]
        selected = choose(rows, {1, 2, 3}, 12, 20261119)
        self.assertEqual(selected, choose(list(reversed(rows)), {1, 2, 3}, 12, 20261119))
        ids = [row["file_id"] for row in selected]
        self.assertEqual(len(set(ids)), 12)
        self.assertFalse(set(ids) & {1, 2, 3})
        with self.assertRaises(ValueError):
            choose(rows, set(range(40)), 1, 1)

    def test_partition_preserves_source_disjointness_and_closes_connections(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.sqlite"
            history = root / "history"
            history.mkdir()
            old_path = history / "old-tags.sqlite"
            connection = sqlite3.connect(source)
            try:
                connection.executescript(
                    "CREATE TABLE files(id INTEGER PRIMARY KEY,diary_name TEXT);"
                    "CREATE TABLE chunks(id INTEGER PRIMARY KEY,file_id INTEGER,vector BLOB);"
                )
                for file_id in range(1, 25):
                    connection.execute("INSERT INTO files VALUES (?,?)", (file_id, f"d{file_id % 3}"))
                    for offset in [0, 1]:
                        connection.execute(
                            "INSERT INTO chunks VALUES (?,?,zeroblob(12288))",
                            (file_id * 10 + offset, file_id),
                        )
                connection.commit()
            finally:
                connection.close()
            connection = sqlite3.connect(old_path)
            try:
                connection.executescript(
                    "CREATE TABLE queries(source_chunk_id INTEGER);"
                    "INSERT INTO queries VALUES (10),(11),(20);"
                )
                connection.commit()
            finally:
                connection.close()
            digest = file_hash(source)
            output = root / "manifest.json"
            stats = partition(source, history, output, count=6)
            self.assertEqual(stats, {"historical_files": 2, "development": 6, "file_holdout_v1": 6})
            report = json.loads(output.read_text(encoding="utf-8"))
            development = {row["file_id"] for row in report["development"]}
            validation = {row["file_id"] for row in report["file_holdout_v1"]}
            self.assertFalse(development & validation)
            self.assertFalse((development | validation) & {1, 2})
            self.assertEqual(report["source_sha256"], digest)
            self.assertEqual(file_hash(source), digest)
            before = output.read_bytes()
            with self.assertRaises(FileExistsError):
                partition(source, history, output, count=6)
            self.assertEqual(output.read_bytes(), before)
            # Windows refuses these renames if a SQLite connection leaked.
            source.rename(root / "renamed.sqlite")
            old_path.rename(history / "renamed.sqlite")

    def test_missing_historical_mapping_fails_before_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.sqlite"
            connection = sqlite3.connect(source)
            try:
                connection.executescript(
                    "CREATE TABLE files(id INTEGER,diary_name TEXT);"
                    "CREATE TABLE chunks(id INTEGER,file_id INTEGER,vector BLOB);"
                )
                connection.commit()
            finally:
                connection.close()
            old_path = root / "old-tags.sqlite"
            connection = sqlite3.connect(old_path)
            try:
                connection.executescript(
                    "CREATE TABLE queries(source_chunk_id INTEGER);"
                    "INSERT INTO queries VALUES (999);"
                )
                connection.commit()
            finally:
                connection.close()
            output = root / "manifest.json"
            with self.assertRaisesRegex(ValueError, "cannot be mapped"):
                partition(source, root, output, count=1)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()