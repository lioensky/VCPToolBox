# 插件中心 JevCall 管理

插件详情可展开查看 manifest.jev 的 category、jevDescPrompt、jevPrompt、agentPrompt。命令搜索区分别搜索 manifest.capabilities.invocationCommands 与 manifest.jev.commands，包含本地及分布式插件。

第三方面板使用既有 GET /admin_api/jev/registry 和 POST /admin_api/jev/registry/rebuild。注册来源由 PluginManager 汇总，不自行扫描或信任客户端提交的 manifest。注册表只收录 jev.enabled=true 的声明；无效声明可见但不能新增授权。

## 白名单策略

POST /admin_api/jev/registry/policy 保存固定路径 ToolConfigs/jev_third_party_policy.json，沿用 admin_api 管理员鉴权。请求为 {mode, allowlist}：

- mode=selected：精确插件名数组，空数组拒绝全部第三方插件。
- mode=unrestricted：不限插件，仍执行全部原有安全校验。
- 策略文件不存在：沿用 JEV_THIRD_PARTY_ALLOWLIST 的旧语义（空值不限）。
- 策略文件存在：优先于环境变量；损坏或格式非法时拒绝全部。
- 不修改 JEV_THIRD_PARTY_EXP 实验总开关，不影响官方 JevCall。

策略写入串行、同目录临时文件 rename 发布，保存后调用侧立即读取生效。离线插件的已有名单保留，管理员可取消移除；未注册插件不可新增。声明重新校验失败的已有插件必须先取消授权才能保存。

## 部署与验收

本功能位于 VCPToolBox/AdminPanel-Vue，需部署配套前端构建与后端路由/注册表改动。首次部署后重启后端以加载新路由；后续保存名单无需重启。生产白名单文件为实例配置，不要把实际授权名单作为通用默认配置分发。

回归：node --test tests/jevThirdPartyPolicy.test.js tests/jevThirdPartyRegistry.test.js
前端：在 AdminPanel-Vue 执行 npm run build。