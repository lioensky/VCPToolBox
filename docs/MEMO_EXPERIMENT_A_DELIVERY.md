# Memo 实验 A 交付
## 版本
- 基线：73fd165d；分支：fix/memo-pyramid-wormhole-invariants。
- 目标：Windows x64 MSVC，Node-API；本地加载验证 Node v22.18.0。
- A文件：vexus-lite.win32-x64-msvc.node，14870016 bytes。
- A SHA256：B7737D3C31D97E5F1E0246E5BBFEC73F88445BDCD5B6C9BADDBCD735C8DEF99A。
- 随仓基线二进制 SHA256：9B202B9C114828C7E29E68DB1FF88DAC3AE3D425166337EF8E2ADD6D2597B879。

## 改动
1. 握手方向scratch复用，仅保留前5方向供pairwise；所有Tag仍参与平均，各层输出保留。
2. 查询词法tokens复用。
3. 虫洞总目标预算：最大父脉冲通量降序，真实Tag ID升序。保留候选门控与残差层级定义。
4. 不修改投影、coverage、种子归因、握手定义、SQL schema、配置或ABI。
预算未饱和时预期选择集合不变；饱和时策略会变化，通量优先并不保证弱边高共振目标的召回改善。

## 验证
- Rust --lib：201 passed，0 failed。
- memo_pipeline：29 passed，含握手逐位参考对照、词法边界和投影反例。
- git diff --check通过。
- npm run build release成功，2m11s。
- Node加载三个原生导出成功。
- 4个Node回归文件：20项，18通过、2失败。
- 独立73fd165d worktree配随仓旧二进制复跑：同样18通过、2失败。
  - memoSingleTrack第275行测试桩缺少_executeLightMemoQueryAdmitted。
  - nativeMemoManifestCompatibility第502行切库后传入旧observation handle。
- 未修改上述测试或无关生命周期业务逻辑，不宣称Node全绿。
- Rust独立测试进程打印缺Node-API宿主符号提示，但退出码0；Node真实加载另行通过。

## 服务器上机
由莱恩操作，不自动部署：
1. 停止服务器Node进程，备份服务器当前rust-vexus-lite/vexus-lite.win32-x64-msvc.node。
2. 将封存A目录里的同名.node覆盖该平台加载文件；无需替换index.js或改配置。
3. 校验SHA256，重启进程；已加载的DLL不能靠复制热替换。
4. 同库、同查询、同配置跑200组对照；记录质量、耗时、预算耗尽和动态虫洞提拔计数。
5. 回退优先使用服务器自己备份的原文件；包内baseline只是本地73fd165d参考，不保证与服务器当前版本一致。
6. A仅本地win32/x64加载验证；服务器Win10实际加载及评分仍待用户完成。

## 后续
A封存后，从A提交另开NNLS实验分支，便于A/B只差真正非负锥分解及其归因设计。NNLS必须验证KKT、收敛、近共线和确定性；不将正向Gram-Schmidt轴启发式冒称非负锥投影。