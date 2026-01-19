#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, RwLock};
use usearch::Index;
use rusqlite::Connection;

/// 搜索结果 (返回 ID 而非 Tag 文本)
/// 上层 JS 会拿着 ID 去 SQLite 里查具体的文本内容
#[napi(object)]
pub struct SearchResult {
    pub id: u32,   // 对应 SQLite 中的 chunks.id 或 tags.id
    pub score: f64,
}

#[napi(object)]
pub struct SvdResult {
    pub u: Vec<f64>, // 扁平化的正交基底向量集 (k * dim)
    pub s: Vec<f64>, // 特征值 (奇异值)
    pub k: u32,
    pub dim: u32,
}

#[napi(object)]
pub struct OrthogonalProjectionResult {
    pub projection: Vec<f64>,
    pub residual: Vec<f64>,
    pub basis_coefficients: Vec<f64>,
}

#[napi(object)]
pub struct HandshakeResult {
    pub magnitudes: Vec<f64>,
    pub directions: Vec<f64>, // 扁平化的方向向量 (n * dim)
}

#[napi(object)]
pub struct ProjectResult {
    pub projections: Vec<f64>,
    pub probabilities: Vec<f64>,
    pub entropy: f64,
    pub total_energy: f64,
}

/// 统计信息
#[napi(object)]
pub struct VexusStats {
    pub total_vectors: u32,
    pub dimensions: u32,
    pub capacity: u32,
    pub memory_usage: u32,
}

/// 核心索引结构 (无状态，只存向量)
#[napi]
pub struct VexusIndex {
    index: Arc<RwLock<Index>>,
    dimensions: u32,
}

#[napi]
impl VexusIndex {
    /// 创建新的空索引
    #[napi(constructor)]
    pub fn new(dim: u32, capacity: u32) -> Result<Self> {
        let index = Index::new(&usearch::IndexOptions {
            dimensions: dim as usize,
            metric: usearch::MetricKind::L2sq, // 余弦相似度通常用 L2sq 或 Cosine (如果是归一化向量，L2sq 等价于 Cosine)
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .map_err(|e| Error::from_reason(format!("Failed to create index: {:?}", e)))?;

        index
            .reserve(capacity as usize)
            .map_err(|e| Error::from_reason(format!("Failed to reserve capacity: {:?}", e)))?;

        Ok(Self {
            index: Arc::new(RwLock::new(index)),
            dimensions: dim,
        })
    }

    /// 从磁盘加载索引
    /// 注意：移除了 map_path，因为映射关系现在由 SQLite 管理
    #[napi(factory)]
    pub fn load(index_path: String, _unused_map_path: Option<String>, dim: u32, capacity: u32) -> Result<Self> {
        // 为了保持 JS 调用签名兼容，保留了 map_path 参数但忽略它
        // 或者你可以修改 JS 里的调用去掉第二个参数

        // 创建空索引配置
        let index = Index::new(&usearch::IndexOptions {
            dimensions: dim as usize,
            metric: usearch::MetricKind::L2sq,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .map_err(|e| Error::from_reason(format!("Failed to create index wrapper: {:?}", e)))?;

        // 加载二进制文件
        index.load(&index_path)
            .map_err(|e| Error::from_reason(format!("Failed to load index from disk: {:?}", e)))?;

        // 检查容量并扩容
        let current_capacity = index.capacity();
        if capacity as usize > current_capacity {
            // eprintln!("[Vexus] Expanding capacity on load: {} -> {}", current_capacity, capacity);
            index
                .reserve(capacity as usize)
                .map_err(|e| Error::from_reason(format!("Failed to expand capacity: {:?}", e)))?;
        }

        Ok(Self {
            index: Arc::new(RwLock::new(index)),
            dimensions: dim,
        })
    }

    /// 保存索引到磁盘
    #[napi]
    pub fn save(&self, index_path: String) -> Result<()> {
        let index = self.index.read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;
        
        // 原子写入：先写临时文件，再重命名
        let temp_path = format!("{}.tmp", index_path);

        index
            .save(&temp_path)
            .map_err(|e| Error::from_reason(format!("Failed to save index: {:?}", e)))?;

        std::fs::rename(&temp_path, &index_path)
            .map_err(|e| Error::from_reason(format!("Failed to rename index file: {}", e)))?;

        Ok(())
    }

    /// 单个添加 (JS 循环调用)
    #[napi]
    pub fn add(&self, id: u32, vector: Buffer) -> Result<()> {
        let index = self.index.write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let vec_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(
                vector.as_ptr() as *const f32,
                vector.len() / std::mem::size_of::<f32>(),
            )
        };

        if vec_slice.len() != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Dimension mismatch: expected {}, got {}",
                self.dimensions,
                vec_slice.len()
            )));
        }

        // 自动扩容检查
        if index.size() + 1 >= index.capacity() {
             let new_cap = (index.capacity() as f64 * 1.5) as usize;
             let _ = index.reserve(new_cap);
        }

        index
            .add(id as u64, vec_slice)
            .map_err(|e| Error::from_reason(format!("Add failed: {:?}", e)))?;

        Ok(())
    }

    /// 批量添加 (更高效，建议未来 JS 改用此接口)
    #[napi]
    pub fn add_batch(&self, ids: Vec<u32>, vectors: Buffer) -> Result<()> {
        let index = self.index.write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let count = ids.len();
        let dim = self.dimensions as usize;
        
        let vec_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(
                vectors.as_ptr() as *const f32,
                vectors.len() / std::mem::size_of::<f32>(),
            )
        };

        if vec_slice.len() != count * dim {
             return Err(Error::from_reason("Batch size mismatch".to_string()));
        }

        // 预扩容
        if index.size() + count >= index.capacity() {
            let new_cap = ((index.size() + count) as f64 * 1.5) as usize;
            let _ = index.reserve(new_cap);
        }

        for (i, id) in ids.iter().enumerate() {
            let start = i * dim;
            let v = &vec_slice[start..start+dim];
            // remove + add = update (usearch 行为)
            // let _ = index.remove(*id as u64); 
            index.add(*id as u64, v)
                .map_err(|e| Error::from_reason(format!("Batch add failed idx {}: {:?}", i, e)))?;
        }

        Ok(())
    }

    /// 搜索
    #[napi]
    pub fn search(&self, query: Buffer, k: u32) -> Result<Vec<SearchResult>> {
        let index = self.index.read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let query_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(
                query.as_ptr() as *const f32,
                query.len() / std::mem::size_of::<f32>(),
            )
        };

        // 🔥🔥🔥【新增】维度安全检查 🔥🔥🔥
        if query_slice.len() != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Search dimension mismatch: expected {}, got {}. (Check your JS Buffer slicing!)",
                self.dimensions,
                query_slice.len()
            )));
        }

        // 执行搜索
        let matches = index
            .search(query_slice, k as usize)
            .map_err(|e| Error::from_reason(format!("Search failed: {:?}", e)))?;

        let mut results = Vec::with_capacity(matches.keys.len());
        
        for (key, &dist) in matches.keys.iter().zip(matches.distances.iter()) {
            results.push(SearchResult {
                id: *key as u32,
                score: 1.0 - dist as f64, // L2sq 距离转相似度分数 (近似)
            });
        }

        Ok(results)
    }

    /// 删除 (按 ID)
    #[napi]
    pub fn remove(&self, id: u32) -> Result<()> {
        let index = self.index.write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;
        
        index.remove(id as u64)
             .map_err(|e| Error::from_reason(format!("Remove failed: {:?}", e)))?;
             
        Ok(())
    }

    /// 获取当前索引状态
    #[napi]
    pub fn stats(&self) -> Result<VexusStats> {
        let index = self.index.read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        Ok(VexusStats {
            total_vectors: index.size() as u32,
            dimensions: self.dimensions,
            capacity: index.capacity() as u32,
            memory_usage: index.memory_usage() as u32,
        })
    }

    /// 从 SQLite 数据库恢复索引 (异步版本，不阻塞主线程)
    #[napi]
    pub fn recover_from_sqlite(
        &self,
        db_path: String,
        table_type: String,
        filter_diary_name: Option<String>,
    ) -> AsyncTask<RecoverTask> {
        AsyncTask::new(RecoverTask {
            index: self.index.clone(),
            db_path,
            table_type,
            filter_diary_name,
            dimensions: self.dimensions,
        })
    }

    /// 高性能 SVD 分解 (用于 EPA 基底构建)
    /// flattened_vectors: n * dim 的扁平化向量数组
    /// n: 向量数量
    /// max_k: 最大保留的主成分数量
    #[napi]
    pub fn compute_svd(&self, flattened_vectors: Buffer, n: u32, max_k: u32) -> Result<SvdResult> {
        let dim = self.dimensions as usize;
        let n = n as usize;
        let max_k = max_k as usize;

        let vec_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(
                flattened_vectors.as_ptr() as *const f32,
                flattened_vectors.len() / std::mem::size_of::<f32>(),
            )
        };

        if vec_slice.len() != n * dim {
            return Err(Error::from_reason(format!(
                "Flattened vectors length mismatch: expected {}, got {}",
                n * dim,
                vec_slice.len()
            )));
        }

        // 使用 nalgebra 进行 SVD 分解
        // M 是 n x dim 矩阵
        use nalgebra::DMatrix;
        let matrix = DMatrix::from_row_slice(n, dim, vec_slice);
        
        // 计算 SVD: M = U * S * V^T
        // 我们需要的是 V^T 的行，它们是原始空间中的主成分
        let svd = matrix.svd(false, true);
        
        let s = svd.singular_values.as_slice().iter().map(|&x| x as f64).collect::<Vec<_>>();
        let v_t = svd.v_t.ok_or_else(|| Error::from_reason("Failed to compute V^T matrix".to_string()))?;
        
        let k = std::cmp::min(s.len(), max_k);
        let mut u_flattened = Vec::with_capacity(k * dim);
        
        for i in 0..k {
            let row = v_t.row(i);
            // nalgebra 的 row view 可能不连续，手动迭代以确保安全
            for &val in row.iter() {
                u_flattened.push(val as f64);
            }
        }

        Ok(SvdResult {
            u: u_flattened,
            s: s[..k].to_vec(),
            k: k as u32,
            dim: dim as u32,
        })
    }

    /// 高性能 Gram-Schmidt 正交投影
    #[napi]
    pub fn compute_orthogonal_projection(
        &self,
        vector: Buffer,
        flattened_tags: Buffer,
        n_tags: u32,
    ) -> Result<OrthogonalProjectionResult> {
        let dim = self.dimensions as usize;
        let n = n_tags as usize;

        let query: &[f32] = unsafe {
            std::slice::from_raw_parts(vector.as_ptr() as *const f32, vector.len() / 4)
        };
        let tags_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(flattened_tags.as_ptr() as *const f32, flattened_tags.len() / 4)
        };

        if query.len() != dim || tags_slice.len() != n * dim {
            return Err(Error::from_reason("Dimension mismatch".to_string()));
        }

        let mut basis: Vec<Vec<f64>> = Vec::with_capacity(n);
        let mut basis_coefficients = vec![0.0; n];
        let mut projection = vec![0.0; dim];

        for i in 0..n {
            let start = i * dim;
            let tag_vec = &tags_slice[start..start + dim];
            let mut v: Vec<f64> = tag_vec.iter().map(|&x| x as f64).collect();

            for u in &basis {
                let mut dot = 0.0;
                for d in 0..dim {
                    dot += v[d] * u[d];
                }
                for d in 0..dim {
                    v[d] -= dot * u[d];
                }
            }

            let mut mag_sq = 0.0;
            for d in 0..dim {
                mag_sq += v[d] * v[d];
            }
            let mag = mag_sq.sqrt();

            if mag > 1e-6 {
                for d in 0..dim {
                    v[d] /= mag;
                }
                
                let mut coeff = 0.0;
                for d in 0..dim {
                    coeff += (query[d] as f64) * v[d];
                }
                basis_coefficients[i] = coeff.abs();
                
                for d in 0..dim {
                    projection[d] += coeff * v[d];
                }
                basis.push(v);
            }
        }

        let mut residual = vec![0.0; dim];
        for d in 0..dim {
            residual[d] = (query[d] as f64) - projection[d];
        }

        Ok(OrthogonalProjectionResult {
            projection,
            residual,
            basis_coefficients,
        })
    }

    /// 高性能握手分析
    #[napi]
    pub fn compute_handshakes(&self, query: Buffer, flattened_tags: Buffer, n_tags: u32) -> Result<HandshakeResult> {
        let dim = self.dimensions as usize;
        let n = n_tags as usize;

        let q: &[f32] = unsafe {
            std::slice::from_raw_parts(query.as_ptr() as *const f32, query.len() / 4)
        };
        let tags: &[f32] = unsafe {
            std::slice::from_raw_parts(flattened_tags.as_ptr() as *const f32, flattened_tags.len() / 4)
        };

        let mut magnitudes = Vec::with_capacity(n);
        let mut directions = Vec::with_capacity(n * dim);

        for i in 0..n {
            let start = i * dim;
            let tag_vec = &tags[start..start + dim];
            let mut mag_sq = 0.0;
            let mut delta = vec![0.0; dim];

            for d in 0..dim {
                let diff = (q[d] - tag_vec[d]) as f64;
                delta[d] = diff;
                mag_sq += diff * diff;
            }

            let mag = mag_sq.sqrt();
            magnitudes.push(mag);

            if mag > 1e-9 {
                for d in 0..dim {
                    directions.push(delta[d] / mag);
                }
            } else {
                for _ in 0..dim {
                    directions.push(0.0);
                }
            }
        }

        Ok(HandshakeResult {
            magnitudes,
            directions,
        })
    }

    /// 高性能 EPA 投影
    #[napi]
    pub fn project(
        &self,
        vector: Buffer,
        flattened_basis: Buffer,
        mean_vector: Buffer,
        k: u32,
    ) -> Result<ProjectResult> {
        let dim = self.dimensions as usize;
        let k = k as usize;

        let vec: &[f32] = unsafe {
            std::slice::from_raw_parts(vector.as_ptr() as *const f32, vector.len() / 4)
        };
        let basis_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(flattened_basis.as_ptr() as *const f32, flattened_basis.len() / 4)
        };
        let mean: &[f32] = unsafe {
            std::slice::from_raw_parts(mean_vector.as_ptr() as *const f32, mean_vector.len() / 4)
        };

        if vec.len() != dim || basis_slice.len() != k * dim || mean.len() != dim {
            return Err(Error::from_reason("Dimension mismatch".to_string()));
        }

        let mut centered = vec![0.0; dim];
        for d in 0..dim {
            centered[d] = (vec[d] - mean[d]) as f64;
        }

        let mut projections = vec![0.0; k];
        let mut total_energy = 0.0;

        for i in 0..k {
            let start = i * dim;
            let b = &basis_slice[start..start + dim];
            let mut dot = 0.0;
            for d in 0..dim {
                dot += centered[d] * (b[d] as f64);
            }
            projections[i] = dot;
            total_energy += dot * dot;
        }

        let mut probabilities = vec![0.0; k];
        let mut entropy = 0.0;

        if total_energy > 1e-12 {
            for i in 0..k {
                let p = (projections[i] * projections[i]) / total_energy;
                probabilities[i] = p;
                if p > 1e-9 {
                    entropy -= p * p.log2();
                }
            }
        }

        Ok(ProjectResult {
            projections,
            probabilities,
            entropy,
            total_energy,
        })
    }
}

pub struct RecoverTask {
    index: Arc<RwLock<Index>>,
    db_path: String,
    table_type: String,
    filter_diary_name: Option<String>,
    dimensions: u32,
}

impl Task for RecoverTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        let conn = Connection::open(&self.db_path)
            .map_err(|e| Error::from_reason(format!("Failed to open DB: {}", e)))?;

        let sql: String;
        
        if self.table_type == "tags" {
            sql = "SELECT id, vector FROM tags WHERE vector IS NOT NULL".to_string();
        } else if self.table_type == "chunks" && self.filter_diary_name.is_some() {
            sql = "SELECT c.id, c.vector FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.diary_name = ?1 AND c.vector IS NOT NULL".to_string();
        } else {
            return Ok(0);
        }

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::from_reason(format!("Failed to prepare statement: {}", e)))?;

        // 参数在下面的 query_map 调用中直接处理，这里不再需要准备 params 变量
        
        // 为了避免复杂的生命周期问题，我们简单地分别处理
        let mut count = 0;
        let mut skipped_dim_mismatch = 0;
        let expected_byte_len = self.dimensions as usize * std::mem::size_of::<f32>();
        
        // 获取写锁
        let index = self.index.write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        // 定义处理单行的闭包
        let mut process_row = |id: i64, vector_bytes: Vec<u8>| {
             if vector_bytes.len() == expected_byte_len {
                let vec_slice: &[f32] = unsafe {
                    std::slice::from_raw_parts(
                        vector_bytes.as_ptr() as *const f32,
                        self.dimensions as usize,
                    )
                };
                
                if index.size() + 1 >= index.capacity() {
                    let new_cap = (index.capacity() as f64 * 1.5) as usize;
                    let _ = index.reserve(new_cap);
                }

                if index.add(id as u64, vec_slice).is_ok() {
                    count += 1;
                }
            } else {
                skipped_dim_mismatch += 1;
            }
        };

        if let Some(name) = &self.filter_diary_name {
            let rows = stmt.query_map([name], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)))
                .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;
            
            for row_result in rows {
                if let Ok((id, vector_bytes)) = row_result {
                    process_row(id, vector_bytes);
                }
            }
        } else {
            let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)))
                .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;
            
            for row_result in rows {
                if let Ok((id, vector_bytes)) = row_result {
                    process_row(id, vector_bytes);
                }
            }
        }
        
        if skipped_dim_mismatch > 0 {
            // 这里使用 println!，它会输出到 Node.js 的 stdout
            println!("[Vexus-Lite] ⚠️ Skipped {} vectors due to dimension mismatch (Expected {} bytes, got various)", skipped_dim_mismatch, expected_byte_len);
        }

        Ok(count)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}