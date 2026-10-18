// 独立研究模块：构建精度、剪枝公式、回填和固定候选池的受控比较。
use super::*;

/// 与已冻结b2_le_f1研究图一致：两轮、alpha为1和1.2、非严格遮挡及回填。
pub struct SmBuildConfig {
    pub degree: usize,
    pub ef_construction: usize,
    pub seed: u64,
}

impl Default for SmBuildConfig {
    fn default() -> Self {
        Self {
            degree: 64,
            ef_construction: 128,
            seed: 20260916,
        }
    }
}

impl CorrectedSmIndex {
    /// 使用TDB批量并行BQ构图，再转换为静态SM查询快照；构图不使用校正系数。
    /// 此入口返回独立快照。TDB运行期对象可直接快速构图后调用enable_corrected_sm。
    pub fn build_fast(
        base: &[f32],
        coefficients: &[f32],
        config: &super::super::QuIVerConfig,
        threads: usize,
    ) -> io::Result<Self> {
        Self::build_fast_with_dimension(DIM, base, coefficients, config, threads)
    }

    /// 明确指定维度的TDB快速并行构图；覆盖全部合法维度和尾部长度。
    pub fn build_fast_with_dimension(
        dim: usize,
        base: &[f32],
        coefficients: &[f32],
        config: &super::super::QuIVerConfig,
        threads: usize,
    ) -> io::Result<Self> {
        dynamic::check_dimension(dim)?;
        let n = base.len() / dim;
        if n < 2
            || !base.len().is_multiple_of(dim)
            || n > u32::MAX as usize
            || threads == 0
            || config.m == 0
            || config.m > MAX_DEGREE / 2
            || config.ef_construction < config.m * 2
            || !config.alpha.is_finite()
            || config.alpha <= 0.
            || (!coefficients.is_empty() && coefficients.len() != n)
            || coefficients.iter().any(|x| !x.is_finite())
            || base.chunks_exact(dim).any(|row| {
                let norm = row.iter().map(|&x| (x as f64).powi(2)).sum::<f64>();
                !norm.is_finite() || (norm - 1.).abs() > 1e-5
            })
        {
            return Err(invalid(
                "快速SM构建要求合法维度单位向量、有效系数、线程数和出度参数",
            ));
        }
        let mut index = QuIVer::new(dim, config);
        let ids = (0..n as u64).collect::<Vec<_>>();
        let slots = (0..n).collect::<Vec<_>>();
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .map_err(|error| invalid(&format!("无法创建快速构图线程池：{error}")))?
            .install(|| index.batch_build_experimental_v2(base, &ids, &slots));
        index.corrected_sm_snapshot(base, coefficients)
    }

    /// 使用两位重建L2距离构建平图；coefficients须由调用方仅用允许的训练查询拟合。
    /// 本函数不读取查询或真值，不进行校正拟合，数据库节点ID为零起始行号。
    /// 此入口仅保留串行研究参考规则；TDB快速构图请调用build_fast或原QuIVer构建入口。
    pub fn build(base: &[f32], coefficients: &[f32], config: &SmBuildConfig) -> io::Result<Self> {
        let n = base.len() / DIM;
        if n < 2
            || !base.len().is_multiple_of(DIM)
            || n > u32::MAX as usize
            || config.degree == 0
            || config.degree > MAX_DEGREE
            || config.degree >= n
            || config.ef_construction < config.degree
            || config.seed == 0
            || (!coefficients.is_empty() && coefficients.len() != n)
            || !coefficients.iter().all(|x| x.is_finite())
            || base.as_chunks::<DIM>().0.iter().any(|row| {
                row.iter().any(|x| !x.is_finite())
                    || row.iter().map(|&x| x as f64 * x as f64).sum::<f64>() > 1.01
            })
        {
            return Err(invalid(
                "SM构建要求有效的归一化768维向量、系数、出度和随机种子",
            ));
        }
        let metric = GcMetric::new(base, 2);
        let mut seed = config.seed;
        let mut graph: Vec<Vec<u32>> = (0..n)
            .map(|u| {
                let mut row = Vec::with_capacity(config.degree);
                while row.len() < config.degree {
                    let v = (gc_rng(&mut seed) % n as u64) as u32;
                    if v != u as u32 && !row.contains(&v) {
                        row.push(v);
                    }
                }
                row
            })
            .collect();
        let mut order = (0..n as u32).collect::<Vec<_>>();
        for i in (1..n).rev() {
            let j = (gc_rng(&mut seed) % (i + 1) as u64) as usize;
            order.swap(i, j);
        }
        let mut scratch = GcScratch {
            seen: vec![0; n],
            stamp: 0,
        };
        for pass in 0..2 {
            let alpha = if pass == 0 { 1. } else { 1.2 };
            for &u in &order {
                let pool = gc_candidates(&graph, &metric, u, config.ef_construction, &mut scratch);
                let row = gc_prune(u, &pool, config.degree, alpha, "le", true, &|a, b| {
                    metric.distance(a, b)
                });
                graph[u as usize] = row.clone();
                for v in row {
                    if !graph[v as usize].contains(&u) {
                        graph[v as usize].push(u);
                        if graph[v as usize].len() > config.degree {
                            graph[v as usize] = gc_prune(
                                v,
                                &graph[v as usize],
                                config.degree,
                                alpha,
                                "le",
                                true,
                                &|a, b| metric.distance(a, b),
                            );
                        }
                    }
                }
            }
        }
        Self::from_parts(base, coefficients, graph, (0..n as u64).collect(), 0, 0)
    }

    /// 导出仅供旧研究实现逐边核验的图格式，不改变SM快照格式。
    pub fn export_research_graph(&self, path: &Path) -> io::Result<()> {
        let mut file = std::io::BufWriter::new(
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?,
        );
        file.write_all(&(self.len() as u32).to_le_bytes())?;
        for u in 0..self.len() {
            let row = self.graph.neighbors(u as u32);
            file.write_all(&(row.len() as u32).to_le_bytes())?;
            for v in row {
                file.write_all(&v.to_le_bytes())?;
            }
        }
        file.flush()
    }
}
#[derive(Clone)]
struct GcCode {
    sign: [u64; 16],
    groups: [[u64; 16]; 4],
    amplitude: [f32; 4],
    norm: f32,
    count: usize,
}
struct GcMetric {
    codes: Vec<GcCode>,
}
impl GcMetric {
    fn new(base: &[f32], bits: usize) -> Self {
        let codes = base
            .as_chunks::<768>()
            .0
            .iter()
            .map(|x| {
                let signature = Bq2Signature::from_vector(x);
                let mut means = [0.; 2];
                let mut counts = [0usize; 2];
                for (j, &v) in x.iter().enumerate() {
                    let k = ((signature.strong[j / 64] >> (j % 64)) & 1) as usize;
                    means[k] += v.abs() as f64;
                    counts[k] += 1;
                }
                for k in 0..2 {
                    if counts[k] > 0 {
                        means[k] /= counts[k] as f64;
                    }
                }
                let mut c = GcCode {
                    sign: [0; 16],
                    groups: [[0; 16]; 4],
                    amplitude: [0.; 4],
                    norm: 0.,
                    count: if bits == 2 { 2 } else { 4 },
                };
                let mut sums = [0f64; 4];
                let mut ns = [0usize; 4];
                c.sign[..12].copy_from_slice(&signature.pos[..12]);
                for (j, &v) in x.iter().enumerate() {
                    let s = ((signature.strong[j / 64] >> (j % 64)) & 1) as usize;
                    let k = if bits == 2 {
                        s
                    } else {
                        s * 2 + usize::from(v.abs() as f64 >= means[s])
                    };
                    c.groups[k][j / 64] |= 1 << (j % 64);
                    sums[k] += v.abs() as f64;
                    ns[k] += 1;
                }
                for k in 0..c.count {
                    if ns[k] > 0 {
                        c.amplitude[k] = (sums[k] / ns[k] as f64) as f32;
                    }
                    c.norm += ns[k] as f32 * c.amplitude[k] * c.amplitude[k];
                }
                c
            })
            .collect();
        Self { codes }
    }
    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx512f,avx512vpopcntdq")]
    unsafe fn distance_inner(&self, a: usize, b: usize) -> f32 {
        use std::arch::x86_64::*;
        let x = &self.codes[a];
        let y = &self.codes[b];
        let mut inner = 0.;
        unsafe {
            for i in 0..x.count {
                for j in 0..y.count {
                    let mut total = _mm512_setzero_si512();
                    let mut wrong = _mm512_setzero_si512();
                    for off in [0, 8] {
                        let mask = _mm512_and_si512(
                            _mm512_loadu_si512(x.groups[i].as_ptr().add(off) as *const __m512i),
                            _mm512_loadu_si512(y.groups[j].as_ptr().add(off) as *const __m512i),
                        );
                        let sign = _mm512_xor_si512(
                            _mm512_loadu_si512(x.sign.as_ptr().add(off) as *const __m512i),
                            _mm512_loadu_si512(y.sign.as_ptr().add(off) as *const __m512i),
                        );
                        total = _mm512_add_epi64(total, _mm512_popcnt_epi64(mask));
                        wrong = _mm512_add_epi64(
                            wrong,
                            _mm512_popcnt_epi64(_mm512_and_si512(mask, sign)),
                        );
                    }
                    let signed = (_mm512_reduce_add_epi64(total)
                        - 2 * _mm512_reduce_add_epi64(wrong))
                        as f32;
                    inner += x.amplitude[i] * y.amplitude[j] * signed;
                }
            }
        }
        (x.norm + y.norm - 2. * inner).max(0.)
    }
    #[inline]
    fn distance(&self, a: u32, b: u32) -> f32 {
        #[cfg(target_arch = "x86_64")]
        if simd_available() {
            return unsafe { self.distance_inner(a as usize, b as usize) };
        }
        let x = &self.codes[a as usize];
        let y = &self.codes[b as usize];
        let mut inner = 0.;
        for i in 0..x.count {
            for j in 0..y.count {
                let mut signed = 0i32;
                for k in 0..12 {
                    let mask = x.groups[i][k] & y.groups[j][k];
                    signed += mask.count_ones() as i32
                        - 2 * (mask & (x.sign[k] ^ y.sign[k])).count_ones() as i32;
                }
                inner += x.amplitude[i] * y.amplitude[j] * signed as f32;
            }
        }
        (x.norm + y.norm - 2. * inner).max(0.)
    }
    #[cfg(test)]
    #[allow(dead_code)]
    fn verify(&self, base: &[f32]) -> f32 {
        let reconstruct = |id: usize| -> Vec<f32> {
            let c = &self.codes[id];
            (0..768)
                .map(|j| {
                    let k = (0..c.count)
                        .find(|&k| c.groups[k][j / 64] >> (j % 64) & 1 == 1)
                        .unwrap();
                    c.amplitude[k]
                        * if c.sign[j / 64] >> (j % 64) & 1 == 1 {
                            1.
                        } else {
                            -1.
                        }
                })
                .collect()
        };
        let mut maxerr = 0f32;
        for i in 0..512 {
            let a = i * 137 % self.codes.len();
            let b = i * 9137 % self.codes.len();
            let x = reconstruct(a);
            let y = reconstruct(b);
            let reference = x
                .iter()
                .zip(&y)
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f32>();
            let error = (reference - self.distance(a as u32, b as u32)).abs();
            maxerr = maxerr.max(error);
            assert!(error < 0.00003, "位内核与显式重建距离不一致");
        }
        assert_eq!(base.len() / 768, self.codes.len());
        maxerr
    }
}
fn gc_rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}
fn gc_prune<F: Fn(u32, u32) -> f32>(
    u: u32,
    pool: &[u32],
    limit: usize,
    alpha: f32,
    formula: &str,
    fill: bool,
    d: &F,
) -> Vec<u32> {
    let mut ids = pool.to_vec();
    ids.sort_unstable();
    ids.dedup();
    ids.retain(|&v| v != u);
    let mut cand: Vec<_> = ids.into_iter().map(|v| (d(u, v), v)).collect();
    cand.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut selected = Vec::with_capacity(limit);
    for &(du, v) in &cand {
        if selected.len() == limit {
            break;
        }
        let dominated = selected.iter().any(|&w| {
            let dv = d(v, w);
            match formula {
                "legacy" => dv < alpha * du,
                "strict" => alpha * dv < du,
                "le" => alpha * dv <= du,
                _ => panic!("未知剪枝公式"),
            }
        });
        if !dominated {
            selected.push(v);
        }
    }
    if fill {
        for &(_, v) in &cand {
            if selected.len() == limit {
                break;
            }
            if !selected.contains(&v) {
                selected.push(v);
            }
        }
    }
    selected
}
struct GcScratch {
    seen: Vec<u32>,
    stamp: u32,
}
fn gc_candidates(
    graph: &[Vec<u32>],
    metric: &GcMetric,
    target: u32,
    ef: usize,
    s: &mut GcScratch,
) -> Vec<u32> {
    s.stamp = s.stamp.wrapping_add(1);
    if s.stamp == 0 {
        s.seen.fill(0);
        s.stamp = 1;
    }
    let stamp = s.stamp;
    let mut q = BinaryHeap::new();
    let mut result = BinaryHeap::new();
    let first = NonNanF32(metric.distance(target, 0));
    q.push(Reverse((first, 0u32)));
    result.push((first, 0u32));
    s.seen[0] = stamp;
    let mut expanded = Vec::new();
    while let Some(Reverse((du, u))) = q.pop() {
        if result.len() >= ef && du > result.peek().unwrap().0 {
            break;
        }
        expanded.push(u);
        for &v in &graph[u as usize] {
            if s.seen[v as usize] == stamp {
                continue;
            }
            s.seen[v as usize] = stamp;
            let nd = NonNanF32(metric.distance(target, v));
            if result.len() < ef || nd < result.peek().unwrap().0 {
                q.push(Reverse((nd, v)));
                result.push((nd, v));
                if result.len() > ef {
                    result.pop();
                }
            }
        }
    }
    expanded.extend_from_slice(&graph[target as usize]);
    expanded
}
