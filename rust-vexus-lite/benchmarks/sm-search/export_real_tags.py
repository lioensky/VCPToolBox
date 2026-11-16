"""Read-only export from a frozen SQLite COPY; never migrates or writes source.
Default refuses stale geometry. --allow-stale-snapshot explicitly marks diagnostics.
Outputs contain private Tag names/vectors: keep them under ignored target/, not git.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import struct


def valid_vector(blob, dimension=None):
    if not blob or len(blob) % 4 or (dimension and len(blob) != dimension * 4):
        return False
    values = struct.unpack("<%df" % (len(blob) // 4), blob)
    return all(math.isfinite(v) for v in values) and sum(v * v for v in values) > 0


def export(source, destination, limit, queries, allow_stale=False):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or destination.exists():
        raise ValueError("destination must be a new file, separate from source")
    if limit < 512 or queries < 1:
        raise ValueError("need at least 512 tags and one query")
    connection = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    try:
        row = connection.execute(
            "SELECT artifact_sig,model_sig,payload_codec,payload_checksum,payload,"
            "database_generation,source_graph_generation FROM rivermemo_artifacts "
            "WHERE status='ready' AND payload IS NOT NULL ORDER BY updated_at DESC,artifact_sig LIMIT 1"
        ).fetchone()
        if not row:
            raise ValueError("no published transport artifact")
        signature, model, codec, checksum, blob, database_generation, graph_generation = row
        if codec != "gzip-json-v1":
            raise ValueError("unsupported payload codec")
        raw = gzip.decompress(blob)
        hashes = {hashlib.sha256(blob).hexdigest(), hashlib.sha256(raw).hexdigest()}
        if not checksum or checksum not in hashes:
            raise ValueError("transport checksum mismatch")
        payload = json.loads(raw)
        artifact = payload["artifact"]
        if artifact["artifactSig"] != signature or artifact["modelSig"] != model:
            raise ValueError("payload identity mismatch")
        facts = connection.execute(
            "SELECT value FROM kbm_runtime_meta WHERE key='memo_tag_facts'"
        ).fetchone()[0]
        geometry = connection.execute(
            "SELECT artifact_sig,graph_generation FROM tagmemo_artifacts "
            "WHERE asset_type='unified_geometry' AND status='ready' AND model_sig=? "
            "ORDER BY updated_at DESC LIMIT 1", (model,)
        ).fetchone()
        if not geometry:
            raise ValueError("no ready geometry for transport model")
        stale = geometry[1] != "facts:" + facts
        if stale and not allow_stale:
            raise ValueError("geometry stale: %s != facts:%s; diagnostic override required" % (geometry[1], facts))
        inbound = dict(payload["inboundMassView"])
        maximum = max(inbound.values())
        if not math.isfinite(maximum) or maximum <= 0:
            raise ValueError("invalid inbound normalization")
        if any(not math.isfinite(v) or v < 0 for v in inbound.values()):
            raise ValueError("invalid inbound masses")
        snapshot_raw = dict(payload.get("rawResidualRatioView", []))
        candidates = []
        rejected = 0
        mismatched = 0
        missing_snapshot_residuals = 0
        dimension = None
        for tag_id, name, vector, residual, residual_sig in connection.execute(
            "SELECT t.id,t.name,t.vector,r.raw_residual_ratio,r.artifact_sig "
            "FROM tags t JOIN tag_intrinsic_residuals r ON r.tag_id=t.id "
            "WHERE r.model_sig=? AND r.status='computed' ORDER BY t.id", (model,)
        ):
            if (tag_id not in inbound or residual is None or not math.isfinite(residual)
                    or not 0 <= residual <= 1 or not valid_vector(vector, dimension)):
                rejected += 1
                continue
            if dimension is None:
                dimension = len(vector) // 4
            if residual_sig != geometry[0]:
                rejected += 1
                continue
            if tag_id not in snapshot_raw:
                missing_snapshot_residuals += 1
            elif (not math.isfinite(snapshot_raw[tag_id])
                    or abs(snapshot_raw[tag_id] - residual) > 1e-10):
                mismatched += 1
            # Scalar metadata only; fetch original blobs after selecting IDs.
            candidates.append((tag_id, name, inbound[tag_id], residual))
        if (mismatched or missing_snapshot_residuals) and not allow_stale:
            raise ValueError("transport/SQL residual coverage: missing=%d mismatched=%d"
                             % (missing_snapshot_residuals, mismatched))
        candidates.sort(key=lambda r: r[0])
        count = min(limit, len(candidates))
        if count < 512:
            raise ValueError("not enough valid jointly covered tags")
        selected = [candidates[i * (len(candidates) - 1) // (count - 1)] for i in range(count)]
        query_ids = [r[0] for r in connection.execute(
            "SELECT id FROM chunks WHERE length(vector)=? ORDER BY id", (dimension * 4,)
        )]
        if len(query_ids) < queries:
            raise ValueError("not enough real chunk query vectors")
        chosen_queries = [query_ids[i * (len(query_ids) - 1) // max(queries - 1, 1)] for i in range(queries)]
        metadata = dict(
            schema="pelorus-real-tags-v2", source=str(source), source_size=source.stat().st_size,
            source_artifact=signature, model_sig=model, database_generation=database_generation,
            source_graph_generation=graph_generation, geometry_sig=geometry[0],
            geometry_facts=geometry[1], current_facts=facts, stale_geometry=stale,
            transport_sql_residual_mismatches=mismatched,
            transport_residual_entries=len(snapshot_raw),
            transport_residual_missing=missing_snapshot_residuals,
            residual_source="SQL computed residuals for ready geometry; NOT transport residual view",
            diagnostic_only=stale or bool(mismatched) or bool(missing_snapshot_residuals),
            valid_joint_tags=len(candidates),
            skipped_tags=rejected, exported_tags=count, dimension=dimension,
            max_inbound=maximum, queries=queries,
            sampling="ID-sorted evenly spaced; independent of queries; truth limited to exported scope",
            query_source="real chunks.vector; no text exported; not user-authored query embeddings",
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive create prevents accidental replacement, even across processes.
        with destination.open("xb"):
            pass
        output = sqlite3.connect(str(destination))
        try:
            output.executescript(
                "CREATE TABLE tags(slot INTEGER PRIMARY KEY,id INTEGER UNIQUE,name TEXT,"
                "vector BLOB,inbound REAL,raw_residual_ratio REAL);"
                "CREATE TABLE queries(id INTEGER PRIMARY KEY,source_chunk_id INTEGER,vector BLOB);"
                "CREATE TABLE metadata(value TEXT NOT NULL);"
            )
            for slot, (tag_id, name, mass, residual) in enumerate(selected):
                vector = connection.execute("SELECT vector FROM tags WHERE id=?", (tag_id,)).fetchone()[0]
                output.execute("INSERT INTO tags VALUES(?,?,?,?,?,?)",
                               (slot, tag_id, name, vector, mass, residual))
            for number, chunk_id in enumerate(chosen_queries):
                vector = connection.execute("SELECT vector FROM chunks WHERE id=?", (chunk_id,)).fetchone()[0]
                if not valid_vector(vector, dimension):
                    raise ValueError("invalid chunk query vector")
                output.execute("INSERT INTO queries VALUES(?,?,?)", (number, chunk_id, vector))
            output.execute("INSERT INTO metadata VALUES(?)", (json.dumps(metadata),))
            output.commit()
        finally:
            output.close()
        return metadata
    finally:
        connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="frozen test/copy SQLite")
    parser.add_argument("--output", required=True, help="new private export SQLite")
    parser.add_argument("--limit", type=int, default=4096)
    parser.add_argument("--queries", type=int, default=12)
    parser.add_argument("--allow-stale-snapshot", action="store_true")
    args = parser.parse_args()
    result = export(args.source, args.output, args.limit, args.queries, args.allow_stale_snapshot)
    print(json.dumps(result, ensure_ascii=True, indent=2))