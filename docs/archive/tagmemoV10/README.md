# TagMemo V10 历史实现封存（P2-2）

2026-10-18，以分支基线 dc248f61 为准。这里的代码仅供历史算法研究，不是生产回退路径，不应重新接入中央数据库。

## 生产引用表

| 原模块 | 外部生产调用方 | 处置 |
| --- | --- | --- |
| [immutable.js](../../../modules/tagmemoV10/immutable.js) | [KnowledgeBaseManager.js](../../../KnowledgeBaseManager.js)、[TagMemoV10Engine.js](../../../TagMemoV10Engine.js)；另有原生 manifest 测试 | 保留 |
| [riverObservability.js](../../../modules/tagmemoV10/riverObservability.js) | [RiverMemoEngine.js](../../../RiverMemoEngine.js)，经 KBM 观测接口调用 | 保留 |
| [agentConditioner.js](agentConditioner.js) | 无 | 封存 |
| [candidateSuperset.js](candidateSuperset.js) | 无；插件与配置中的同名属性不是模块加载 | 封存 |
| [derivedAssetManager.js](derivedAssetManager.js) | 无；V10 门面的同名注入字段不是该类的实例化 | 封存，禁止重新接入旧 JS SQL 写路径 |
| [directAnchorReadout.js](directAnchorReadout.js) | 无 | 封存 |
| [dstcObservables.js](dstcObservables.js) | 无 | 封存 |
| [experimentArms.js](experimentArms.js) | 无 | 封存 |
| [fieldWorkspace.js](fieldWorkspace.js) | 无；仅封存组内部引用 | 封存 |
| [provenance.js](provenance.js) | 无 | 封存 |
| [relativeTopologyMatcher.js](relativeTopologyMatcher.js) | 无 | 封存 |
| [riverMemoArtifactRepository.js](riverMemoArtifactRepository.js) | 无 | 封存，禁止重新接入旧 JS SQL 写路径 |
| [scaledFieldSolver.js](scaledFieldSolver.js) | 无 | 封存 |
| [unifiedPathGeometry.js](unifiedPathGeometry.js) | 无；仅封存组内部引用 | 封存 |

## 审计方法与封存边界

- 全仓静态搜索包含隐藏及忽略文件；排除依赖目录、版本控制内部、编译产物、数据库及原生二进制。
- 检索原文件名、字符串路径、导出符号及目录名，覆盖插件（包括只读审计的禁止修改区域）、路由、管理前端、声明文件、脚本与测试。
- 12 个封存模块作为一个无外部加载入口的依赖组移动，内部相对引用不变。
- 仅将对两个保留模块的相对引用调整到现役目录；不复制现役工具，避免产生新的生产实现分叉。
- 旧文档中的原路径属于历史证据，不代表生产调用。原型源码保持原样，不承诺算法行为仍符合当前原生契约。
- [回归测试](../../../tests/kbmDeadCodeCleanup.test.js) 验证全部封存模块可加载、旧入口不存在、三个生产 Memo 入口的静态依赖图不进入封存目录。测试不打开数据库。