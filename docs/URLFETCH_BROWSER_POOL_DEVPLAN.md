# UrlFetch 常驻浏览器池施工图

工程：pybei。用户批准默认 5 个活动标签页，超出排队。

## 不变量
- hybridservice/direct 常驻入口；CLI 仅作为手动单次调用兼容，不参与服务池。
- 全服务最多 5 个活动页面租约；队列 FIFO、有界、可取消。不能每个域名单独放大上限。
- Profile 路径与代理出口决定浏览器键；同键启动 single-flight。不同任务独占 page，不依赖活动标签页。
- 浏览器由服务拥有，任务只关闭自己的 page；只在空闲或 shutdown 时关闭自有浏览器。外部 managed 浏览器只断开连接，不按单任务关闭。
- 共享 Profile 的标签页共享站点会话；Cookie 注入不能在并发中切换账号。多账号隔离不在本期范围。
- 排队等待预算与执行预算分开；外层 direct timeout 必须覆盖两者。取消后不得继续回退代理或继续排队。
- shutdown 停止接单、取消队列与活动任务、等待资源清理。启动尚未完成时 shutdown 也必须收回迟到的浏览器。
- 不杀外部占用 Profile 的进程，不删除 Chromium 锁；旧 stdio 进程与新服务切换必须先排空旧任务。
- 初次上线先在源码仓库验证，不自动部署或重启后端。

## 实现
1. browserPool.js：有界 FIFO、五槽全局许可、按 Profile 的启动合并、页面租约、空闲回收与关闭。
2. UrlFetch.js：抽取 processToolCall，保留 require.main CLI；接入共享池；请求取消上下文隔离。
3. manifest：hybridservice/direct 与配置项；既有图片/PDF/下载契约保留。
4. 测试：十任务峰值 <=5、同 Profile 单次启动、失败后释放、排队取消、活动取消、shutdown/启动竞态、不同响应不串线；真实浏览器十请求实测。

## 进度
- 已完成 direct 生命周期与外层超时调查，尚未修改运行逻辑。