import hashlib
import json
import runpy
import sqlite3
import struct
import subprocess
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/lain-geometry/freeze-plate.cjs"
backup = runpy.run_path(str(CLI.with_name("backup_sqlite.py")))["backup"]
D = 3072
IDS = (104, 7, 52)


def words(*xs):
    return struct.pack("<" + "Q" * len(xs), *xs)


def list32(*xs):
    return words(len(xs)) + struct.pack("<" + "I" * len(xs), *xs)


def field():
    n = len(IDS)
    meta = bytearray(32 * n)
    for i in range(n):
        struct.pack_into("<f", meta, i * 32 + 8, (i + 1) / 4)
    plane_words = n * ((D + 63) // 64) * 2
    index = b"".join([
        words(1, D, 0), bytes(10 * 8), words(2, 2, 0),
        words(n, *IDS), words(0), words(D), bytes(D * 8), words(0),
        words(n), meta, words(plane_words), bytes(plane_words * 8),
        list32(1, 2, 0), list32(0, 1, 2, 3), list32(0), list32(1), list32(2),
    ])
    header = b'{"identity":{"model":"fixture","rule":"unit","facts":"fixture-only"}}'
    body = b"VCPWC001" + words(len(header)) + header + index
    return body + hashlib.sha256(body).digest()


class PlateExportTest(unittest.TestCase):
    def test_replay_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "fixture.vcpwc"
            snapshot.write_bytes(field())
            db = root / "knowledge_base.sqlite"
            with closing(sqlite3.connect(db)) as conn:
                conn.execute("CREATE TABLE chunks(id INTEGER PRIMARY KEY, vector BLOB)")
                for ident in sorted(IDS):
                    blob = struct.pack("<f", ident + 0.125) + bytes((D - 1) * 4)
                    conn.execute("INSERT INTO chunks VALUES (?,?)", (ident, blob))
                conn.commit()
            kb = root / "backup"
            backup(db, kb)

            def invoke(dest, source=kb):
                return subprocess.run(["node", str(CLI), str(snapshot), str(source), str(dest)],
                                      capture_output=True, text=True, timeout=30)

            manifests = []
            for name in ("a", "b"):
                out = root / name
                result = invoke(out)
                self.assertEqual(result.returncode, 0, result.stderr)
                manifests.append((out / "plate.json").read_bytes())
                m = json.loads(manifests[-1])
                self.assertEqual(m["snapshotSha256"], hashlib.sha256(field()).hexdigest())
                for desc in m["arrays"].values():
                    data = (out / desc["file"]).read_bytes()
                    self.assertEqual(len(data), desc["bytes"])
                    self.assertEqual(hashlib.sha256(data).hexdigest(), desc["sha256"])
                self.assertEqual(struct.unpack("<3Q", (out / "ids.u64le").read_bytes()), IDS)
                self.assertEqual(struct.unpack("<3f", (out / "radius.f32le").read_bytes()), (.25, .5, .75))
                data = (out / "vectors.f32le").read_bytes()
                self.assertEqual(len(data), len(IDS) * D * 4)
                for i, ident in enumerate(IDS):
                    self.assertEqual(struct.unpack_from("<f", data, i * D * 4)[0], ident + .125)
            self.assertEqual(*manifests)

            with closing(sqlite3.connect(db)) as conn:
                conn.execute("DELETE FROM chunks WHERE id=7")
                conn.commit()
            broken = root / "missing-row"
            backup(db, broken)
            result = invoke(root / "incomplete", broken)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("chunks.id=7", result.stderr)
            self.assertFalse((root / "incomplete").exists())

            snapshot.write_bytes(field()[:-1] + bytes([field()[-1] ^ 1]))
            result = invoke(root / "corrupt")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "corrupt").exists())


if __name__ == "__main__":
    unittest.main()