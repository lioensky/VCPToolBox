# B1 开发集：raw / z 候选对照

协议：`LAIN_GEOMETRY_PATH_B_RETRIEVAL_BLUEPRINT.md`。实验起点 5fc7e77b5fa97b6888b54d4ff271f7673c6f6a3d，另需本实验分支新增的导出测试及脚本。只用冻结 Plate 的 6849 个 ID、3072 维、253 条 dev；未读 eval 载荷，无正文判定。

## 证据链
- 冻结 .vcpwc 的整文件 SHA-256 为 `1c2a145e212dd220f9380ef876bcff331e8412dc05472a66c7feed9cb7fa84a5`。源为实验工作树 VectorStore；经把副本与 plate-a 清单对哈希后固定在仓外 `path-b-inputs/`，不重建、不访问主仓。
- 测试 `export_frozen_dev_z` 实际运行 1 项通过，点与查询均使用内层索引 mean_axis，beta=0.7，逐分量核对 `transform_into` / `transform` 的 f32 位模式。外层 Header.mean 用于半径，不拿它冒充内层轴。
- z 点 84,160,512 B，SHA-256 `93c7ea9263054127721778fb0490e4007f64ba99a2090a020882e787f16ab50a`；z dev 3,108,864 B，`0a95ebd97a00e7fc4a13bb13a1630dcfdd5ff0d5883c873ac778140ce86aa2ad`。
- 两个空间分别重建 IQR/8、切点、ECDF、2/3-bit 紧凑码；落盘后校验每个桶号。raw 253×2 份量化有序 Top-128 均复现 A2；z 使用自身码流。
- `path-b1-dev-v1/manifest.json` 绑定输出。raw-dev.jsonl SHA-256 `35d986b5865ec96f013b585a972218d578be5f49d2aa272099f3de8eeb871b1c`；z-dev.jsonl `763610e8cee7178807410c6b104db5b2aa60d317ed74a1f5ea79d02ccceec335`。独立回读校验清单每项长度与哈希、253 个连续 slot、每份名单含 128 个不重复冻结 ID、候选内重排不换池。
- 输出字段：`hard128` 为全库硬窗；`bits[宽度].direct128` 为交付的量化直出；`hardWithin128` 为 128 点池内按硬窗重排。主预算取 direct128 前 64。hardWithin128 的前 64 单列为 128→64，不冒称 64 点池。

## 配对读出（均为席位数）
| bits / K | 总席位 | raw-z 共有 | z 换入 | 每题换入 min / median / max | raw 直出∩自身硬窗 | z 直出∩自身硬窗 |
|---|---:|---:|---:|---:|---:|---:|
| 2 / 64 | 16192 | 11570 | 4622 | 2 / 18 / 37 | 7078 | 8171 |
| 3 / 64 | 16192 | 9141 | 7051 | 6 / 28 / 47 | 8858 | 9937 |
| 2 / 128 | 32384 | 23013 | 9371 | 10 / 36 / 72 | 14572 | 16776 |
| 3 / 128 | 32384 | 18258 | 14126 | 23 / 55 / 89 | 18140 | 20301 |

换入/换出是相对席位的变化，不等于正确答案的得失。raw、z 硬窗本身是两套排序；最后两列不共用语义真值。本实验没有正文 Hit@64 结果，也没有性能结论。

## 重放（PS7，从实验工作树根启动）
下面是生成指令，不是覆盖指令：保留已有成品；如需独立复跑，使用隔离 TEMP/TMP 根，在其 `lain-p0-qo_bvspm` 子目录准备已核验的同代必需输入，不复制 eval。B1 原生测试按系统 temp_dir 定位；Python 接显式根路径。
```powershell
$r = Join-Path ([IO.Path]::GetTempPath()) 'lain-p0-qo_bvspm'
cargo test --release --manifest-path rust-vexus-lite/crates/vcp-tdb-index/Cargo.toml --lib export_frozen_dev_z -- --ignored --nocapture
if ($LASTEXITCODE -ne 0) { throw 'native z export failed' }
python scripts/lain-geometry/path_b1_dev.py $r
if ($LASTEXITCODE -ne 0) { throw 'B1 candidate export failed' }
```
原始输入、查询及候选全部保存在私有仓外目录，临时目录不是永久备份。B0 与 B1 都发布后用 `python scripts/lain-geometry/path_b_audit.py $r` 做联合验收。