"""Isolated optimized Rust kernel comparison on one read-only SQLite snapshot.
No database writes, no production binary replacement, no text/vector output.
Python 3.13 + numpy; rustc on PATH. Timings exclude SQL, gating and full publication.
"""
import argparse
import collections
import hashlib
import itertools
import json
import math
import pathlib
import random
import sqlite3
import struct
import subprocess
import tempfile
import time

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = "rust-vexus-lite/src/memo_geometry.rs"
BASELINE = "dce07f44"

HARNESS = r'''
use std::{fs, time::Instant, hint::black_box};
struct Input<'a> { bytes: &'a [u8], pos: usize }
impl Input<'_> {
    fn u64(&mut self)->u64 { let a=self.pos; self.pos+=8; u64::from_le_bytes(self.bytes[a..self.pos].try_into().unwrap()) }
    fn f64(&mut self)->f64 { f64::from_bits(self.u64()) }
}
fn main() {
    let args:Vec<_>=std::env::args().collect();
    let bytes=fs::read(&args[1]).unwrap();
    let repeats:usize=args[2].parse().unwrap();
    let mut input=Input{bytes:&bytes,pos:0};
    let count=input.u64() as usize;
    println!("sample,mode,neighbors,budget,axes,residual,ns");
    for sample in 0..count {
        let n=input.u64() as usize;
        let dim=input.u64() as usize;
        let target:Vec<_>=(0..dim).map(|_|input.f64()).collect();
        let mut vectors=Vec::new(); let mut ids=Vec::new(); let mut priors=Vec::new();
        for _ in 0..n {
            ids.push(input.u64() as i64); priors.push(input.f64());
            vectors.push((0..dim).map(|_|input.f64()).collect::<Vec<_>>());
        }
        // Rotate execution order across samples and repeats to reduce ordering bias.
        let configs=[(48,4),(48,24),(96,4),(96,24),(96,32)];
        for repeat in 0..repeats {
            for slot in 0..10 {
                let case=(slot+sample+repeat)%10;
                let mode=case%2; let (neighbors,budget)=configs[case/2];
                let len=n.min(neighbors);
                if len<3 {continue}
                let refs:Vec<_>=vectors[..len].iter().map(Vec::as_slice).collect();
                let diag:Vec<_>=refs.iter().map(|v|v.iter().fold(0.0,|s,x|s+x*x)).collect();
                let corr:Vec<_>=refs.iter().map(|v|target.iter().zip(v.iter()).fold(0.0,|s,(a,b)|s+a*b)).collect();
                let (picked,residual,elapsed)=if mode==0 {
                    let c:Vec<_>=(0..len).map(|i|old::AgsCandidate{id:ids[i],prior:priors[i]}).collect();
                    let start=Instant::now();
                    let trace=black_box(old::bench(&target,&c,&refs,&diag,&corr,budget));
                    (trace.picked.len(),trace.residual_norm.unwrap(),start.elapsed().as_nanos())
                } else {
                    let c:Vec<_>=(0..len).map(|i|new::AgsCandidate{id:ids[i],prior:priors[i]}).collect();
                    let start=Instant::now();
                    let trace=black_box(new::bench(&target,&c,&refs,&diag,&corr,budget));
                    (trace.picked.len(),trace.residual_norm.unwrap(),start.elapsed().as_nanos())
                };
                println!("{sample},{mode},{neighbors},{budget},{picked},{residual:.17e},{elapsed}");
            }
        }
    }
    assert_eq!(input.pos,bytes.len());
}
'''

def kernel(text, name):
    # Extract only the dependency-free actual AGS kernel, not the workspace module.
    start = text.index("pub(crate) enum AgsTarget")
    end = text.index("use crate::storage::")
    body = text[start:end]
    wrapper = """
pub(crate) fn bench(t:&[f64],c:&[AgsCandidate],v:&[&[f64]],d:&[f64],r:&[f64],k:usize)->AgsTrace {
    direct_axes_core(AgsTarget::Explain(t),c,v,Some(d),Some(r),k,0.015,false)
}
"""
    return f"mod {name} {{\n{body}\n{wrapper}\n}}"

def stats(values):
    if not values:
        return {"n": 0}
    a = np.asarray(values, dtype=float)
    return {"n": len(values), "mean": float(a.mean()),
            **{f"p{p}": float(np.percentile(a, p)) for p in (0, 50, 95, 99, 100)}}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sample", type=int, default=512)
    ap.add_argument("--stress", type=int, default=16)
    ap.add_argument("--repeats", type=int, default=5)
    args = ap.parse_args()
    if args.sample < 1 or args.stress < 0 or args.repeats < 1:
        raise ValueError("invalid sample/stress/repeats")
    old = subprocess.check_output(["git", "show", f"{BASELINE}:{SOURCE}"], cwd=ROOT).decode("utf-8-sig")
    new = (ROOT / SOURCE).read_text(encoding="utf-8-sig")
    started = time.perf_counter()
    con = sqlite3.connect(pathlib.Path(args.db).resolve().as_uri()+"?mode=ro", uri=True, timeout=30)
    con.execute("PRAGMA query_only=ON")
    con.execute("BEGIN")
    try:
        ids = [r[0] for r in con.execute("SELECT id FROM tags ORDER BY id")]
        # Use explicit fixed experiment parameters, independent of stored asset config.
        adjacency = collections.defaultdict(lambda: collections.defaultdict(float))
        for _, group in itertools.groupby(con.execute(
                "SELECT file_id,tag_id,COALESCE(position,0) FROM file_tags ORDER BY file_id,position,tag_id"),
                key=lambda r: r[0]):
            tags = list(group)
            if not 2 <= len(tags) <= 100:
                continue
            for i, (_, a, p) in enumerate(tags):
                for _, b, q in tags[i+1:]:
                    if a == b:
                        continue
                    delta = max(1, abs(p-q)) if p > 0 and q > 0 else 1
                    w = math.exp(-.15*(delta-1))
                    adjacency[a][b] += w
                    adjacency[b][a] += w
        uniform = set(random.Random(20261114).sample(ids, min(args.sample, len(ids))))
        hubs = set(sorted(ids, key=lambda i: (-len(adjacency[i]), i))[:args.stress])
        chosen = sorted(uniform | hubs)
        cache = {}
        def vector(tag):
            if tag not in cache:
                row = con.execute("SELECT vector FROM tags WHERE id=?", (tag,)).fetchone()
                v = np.frombuffer(row[0], dtype="<f4").astype(np.float64) if row and row[0] else None
                if v is not None:
                    # Match Rust sequential norm/normalization, not BLAS reductions.
                    norm = math.sqrt(sum(float(x)*float(x) for x in v))
                    v = v / norm if math.isfinite(norm) and norm > 1e-12 else None
                cache[tag] = v
            return cache[tag]
        rows = []
        with tempfile.TemporaryDirectory(prefix="memo-d-native-") as temp:
            temp = pathlib.Path(temp)
            data = temp / "input.bin"
            blocks = []
            for tag in chosen:
                target = vector(tag)
                if target is None:
                    continue
                valid = []
                for nid, w in sorted(adjacency[tag].items(), key=lambda x: (-x[1], x[0])):
                    v = vector(nid)
                    if v is None or len(v) != len(target):
                        continue
                    valid.append((nid, w, v))
                    if len(valid) == 96:
                        break
                # Production truncates valid neighbors before semantic gating.
                entries = []
                for nid, w, v in valid:
                    sim = max(-1., min(1., sum(float(a)*float(b) for a, b in zip(target, v))))
                    semantic = .35 if sim <= 0 else max(.35, .5+.8*math.exp(-(sim-.65)**2/(2*.25**2)))
                    entries.append((nid, math.log1p(w)*semantic, v))
                block = bytearray(struct.pack("<QQ", len(entries), len(target)))
                block.extend(target.astype("<f8").tobytes())
                for nid, prior, v in entries:
                    block.extend(struct.pack("<Qd", nid, prior))
                    block.extend(v.astype("<f8").tobytes())
                blocks.append(block)
                rows.append({"id": tag, "uniform": tag in uniform, "hub": tag in hubs,
                             "degree": len(adjacency[tag]), "valid_neighbors": len(entries)})
            with data.open("wb") as out:
                out.write(struct.pack("<Q", len(blocks)))
                for block in blocks:
                    out.write(block)
            facts = dict(con.execute("SELECT key,value FROM kbm_runtime_meta WHERE key IN ('memo_tag_facts','database_generation')"))
            con.rollback()
            print(f"Snapshot prepared: {len(rows)} samples, {len(cache)} vectors; compiling real kernels", flush=True)
            src, exe = temp / "probe.rs", temp / "probe.exe"
            src.write_text(kernel(old, "old")+kernel(new, "new")+HARNESS, encoding="utf-8")
            subprocess.run(["rustc", "--edition=2021", "-O", "-A", "dead_code", str(src), "-o", str(exe)], check=True)
            result = subprocess.check_output([str(exe), str(data), str(args.repeats)], text=True)
        measurements = collections.defaultdict(list)
        for line in result.splitlines()[1:]:
            sample, mode, neighbors, budget, axes, residual, ns = line.split(",")
            key = (int(sample), int(mode), int(neighbors), int(budget))
            measurements[key].append((int(axes), float(residual), int(ns)/1e6))
        cases = {}
        for (sample, mode, neighbors, budget), values in measurements.items():
            assert all(v[:2] == values[0][:2] for v in values), "non-deterministic result"
            case = f"{'old' if mode == 0 else 'new'}-M{neighbors}-K{budget}"
            record = {**rows[sample], "axes": values[0][0], "residual": values[0][1],
                      "anchor_gain": max(.5, min(2., .75+1.25*values[0][1])),
                      "kernel_ms_median": float(np.median([v[2] for v in values]))}
            cases.setdefault(case, []).append(record)
        summary = {}
        for case, records in cases.items():
            baseline = {r["id"]: r for r in cases["old-M48-K4"]}
            summary[case] = {}
            for group in ("uniform", "hub"):
                selected = [r for r in records if r[group]]
                summary[case][group] = {field: stats([r[field] for r in selected])
                    for field in ("axes", "residual", "anchor_gain", "kernel_ms_median")}
                summary[case][group]["residual_delta_C"] = stats([
                    r["residual"]-baseline[r["id"]]["residual"] for r in selected])
                summary[case][group]["gain_delta_C"] = stats([
                    r["anchor_gain"]-baseline[r["id"]]["anchor_gain"] for r in selected])
        report = {"baseline_commit": BASELINE, "old_kernel_sha256": hashlib.sha256(old.encode()).hexdigest(),
                  "new_kernel_sha256": hashlib.sha256(new.encode()).hexdigest(),
                  "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(),
                  "facts": facts, "tags": len(ids), "sample_seed": 20261114,
                  "repeats_rotated": args.repeats, "summary": summary, "cases": cases,
                  "elapsed_seconds": time.perf_counter()-started,
                  "limits": ["Optimized isolated real Rust cached core, not full pipeline or cargo LTO build.",
                             "Single snapshot; in-memory warm timings exclude SQL, gating, global build and publication.",
                             "Fixed default gate/minGain/anchor mapping, not arbitrary stored config.",
                             "Geometry/gain changes do not establish semantic retrieval quality."]}
        path = pathlib.Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({"summary": summary, "elapsed_seconds": report["elapsed_seconds"]}, indent=2))
    finally:
        if con.in_transaction:
            con.rollback()
        con.close()

if __name__ == "__main__":
    main()