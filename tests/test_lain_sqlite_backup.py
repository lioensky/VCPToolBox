import hashlib
import json
import runpy
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
backup = runpy.run_path(str(ROOT / "scripts/lain-geometry/backup_sqlite.py"))["backup"]


class BackupTest(unittest.TestCase):
    def test_live_wal(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "knowledge_base.sqlite"
            out = Path(tmp) / "frozen"
            with closing(sqlite3.connect(src)) as writer:
                self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("CREATE TABLE marker(id INTEGER)")
                writer.commit()
                self.assertEqual(writer.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0], 0)
                writer.execute("INSERT INTO marker VALUES (104)")
                writer.commit()
                writer.execute("INSERT INTO marker VALUES (7)")
                self.assertGreater(Path(str(src) + "-wal").stat().st_size, 32)
                manifest = backup(src, out)
                writer.rollback()
            target = out / src.name
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), manifest["sha256"])
            self.assertEqual(json.loads((out / "backup.json").read_text()), manifest)
            with closing(sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)) as frozen:
                self.assertEqual(frozen.execute("SELECT id FROM marker").fetchall(), [(104,)])
            with self.assertRaises(FileExistsError):
                backup(src, out)
            self.assertEqual(set(p.name for p in out.iterdir()), {src.name, "backup.json"})


if __name__ == "__main__":
    unittest.main()