# B0 开发集：现役 Chunk 导航与全库精确双曲

配套：`LAIN_GEOMETRY_PATH_B_RETRIEVAL_BLUEPRINT.md`、`LAIN_GEOMETRY_PATH_B1_DEV_READOUT.md`。253 个 dev slot，6849 个冻结稳定 ID，无 eval 载荷、无正文标签。只测同代全库范围，不测试生产 SQLite 延迟、线上过滤或增量尾部。

测试驱动 `rust-vexus-lite/src/lain_b0_replay.rs` 调用 WarpedChunks::decode，不走 load_or_build。检查整文件 SHA-256、模型、规则、facts、训练行序和无退休节点。查询半径使用原生 field.radius；每个 slot 对每个索引节点执行 exact_distance 得到参考次序（距离升序、稳定 ID 升序）。导航使用原生 search_chunks 和生产预算，回调读取相同行序的冻结 FP32 原件。64、128 各自发一次请求，不作前缀替代。

| K | width / rerank_limit | max_visits / max_expansions | 实际 visited / expanded / cold_reads（253 题合计） | 与全库精确 Top-K 交集 | 未取回的精确席位 |
|---|---|---|---|---|---|
| 64 | 128 / 128 | 1536 / 384 | 293589 / 42512 / 32384 | 15078 / 16192 | 1114 |
| 128 | 256 / 256 | 1536 / 384 | 383337 / 84410 / 64768 | 29656 / 32384 | 2728 |

两档所有实际返回 ID 的精排距离均与全库参考逐位相等，最大绝对差 0；候选内按精确距离和稳定 ID 排序无分歧。此结果仅定位到有限预算的选择阶段，不将差异归于单独编码、种子或裁剪机制。

## 产物与复核
仓外 `path-b0-dev-v1/candidates.jsonl` SHA-256：`f439e236b0264d63d67110b1e9caf7682da541174ea195f7cddb7af3611f9840`。每题含 slot、查询半径、全库精确 Top-128（64 取前缀）、两次独立导航的有序 ID/距离/实际计数。B1 另见配套报告。

从实验工作树根执行（只在已准备冻结输入且尚无同名成品的隔离 TEMP 中生成；验收已有成品只运行最后一条）：
```powershell
$r = Join-Path ([IO.Path]::GetTempPath()) 'lain-p0-qo_bvspm'
cargo test --release --manifest-path rust-vexus-lite/Cargo.toml --lib replay_frozen_b0_dev -- --ignored --nocapture
if ($LASTEXITCODE -ne 0) { throw 'B0 native replay failed' }
python scripts/lain-geometry/path_b_audit.py $r
```
实跑：指定测试 1 passed / 0 failed；联合验收退出码 0。几何候选已交付，语义判定为零。须先锁题、锁作答标准并盲审，才可报告配对 Hit@64。不要拿某块在精确双曲里的位置代替其正文可作答性。