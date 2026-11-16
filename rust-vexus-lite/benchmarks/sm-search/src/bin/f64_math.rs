//! Ordered FP64 compatibility experiment; synthetic data, no database I/O.
use serde_json::json;
use std::{hint::black_box, time::Instant};
use vcp_tdb_index::metric_math;

#[inline(never)]
fn old_norm(a: &[f32], _: &[f32]) -> f64 {
    a.iter().map(|&v| (v as f64).powi(2)).sum()
}

#[inline(never)]
fn old_delta(a: &[f32], b: &[f32]) -> f64 {
    let mut sum = 0f64;
    for (&a, &b) in a.iter().zip(b) {
        let d = a as f64 - b as f64;
        sum += d * d;
    }
    sum
}

#[inline(never)]
fn old_cosine(a: &[f32], b: &[f32]) -> f64 {
    let (mut dot, mut aa, mut bb) = (0f64, 0f64, 0f64);
    for (&x, &y) in a.iter().zip(b) {
        let (x, y) = (x as f64, y as f64);
        dot += x * y; aa += x * x; bb += y * y;
    }
    let value = if aa == 0. || bb == 0. { 0. }
        else { (dot / (aa.sqrt() * bb.sqrt())).clamp(-1., 1.) as f32 };
    value as f64
}

fn sample(run: impl Fn(&[f32], &[f32]) -> f64, q: &[f32], rows: &[Vec<f32>]) -> serde_json::Value {
    let sweep = || {
        for row in rows { black_box(run(black_box(q), black_box(row))); }
    };
    for _ in 0..3 { sweep(); }
    let mut samples = (0..9).map(|_| {
        let start = Instant::now();
        for _ in 0..8 { sweep(); }
        start.elapsed().as_secs_f64() * 1e9 / (rows.len() * 8) as f64
    }).collect::<Vec<_>>();
    samples.sort_by(f64::total_cmp);
    json!({"median_ns":samples[4],"min_ns":samples[0],"max_ns":samples[8],"samples_ns":samples})
}

fn main() {
    assert!(["TRIVIUM_NO_AVX512", "QUIVER_DISABLE_AVX512"].iter()
        .any(|key| std::env::var(key).as_deref() == Ok("1")), "disable AVX-512 explicitly");
    let mut reports = Vec::new();
    let mut seed = 0x9876_4321_abcd_789fu64;
    for dim in [65usize, 384, 768, 1536, 3072] {
        let rows = (0..2048).map(|_| (0..dim).map(|_| {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
            seed as i32 as f32 / i32::MAX as f32
        }).collect::<Vec<_>>()).collect::<Vec<_>>();
        let q = &rows[17];
        for row in &rows {
            assert_eq!(old_norm(row, row).to_bits(), metric_math::norm_squared_f64(row).to_bits());
            assert_eq!(old_delta(q, row).to_bits(), metric_math::delta_squared_f64(q, row).to_bits());
            assert_eq!(old_cosine(q, row).to_bits(), (metric_math::cosine(q, row) as f64).to_bits());
        }
        // Norm varies each row too, rather than timing a constant query norm.
        let report = json!({
            "dim":dim,"rows":rows.len(),"integer_bit_comparison":true,
            "norm":{"old":sample(|_, r| old_norm(r,r),q,&rows),
                "simd":sample(|_, r| metric_math::norm_squared_f64(r),q,&rows)},
            "delta":{"old":sample(old_delta,q,&rows),
                "simd":sample(metric_math::delta_squared_f64,q,&rows)},
            "cosine":{"old":sample(old_cosine,q,&rows),
                "simd":sample(|a,b| metric_math::cosine(a,b) as f64,q,&rows)}
        });
        eprintln!("dim={dim} complete");
        reports.push(report);
    }
    let report = json!({
        "scope":"single-thread synthetic ordered FP64 kernels; no SQLite or end-to-end claim",
        "kernel":metric_math::kernel_name(),"reports":reports
    });
    if let Ok(path) = std::env::var("F64_MATH_OUT") {
        use std::io::Write;
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(path).unwrap();
        out.write_all(&serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}