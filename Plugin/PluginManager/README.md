# PluginManager 元插件

PluginManager 是 VCPToolBox 的插件管理元工具，用于让 AI 在管理员授权后查询和管理当前 VCP 插件生态。

它采用 `hybridservice` + `direct` 协议运行，不启动额外子进程，而是直接调用核心 `PluginManager` 实例提供的内部管理方法。

## 功能

- 查询所有插件和工具：
  - 本地已启用插件
  - 本地已禁用插件
  - 云端 / 分布式工具
- 查询指定插件详情：
  - manifest 信息
  - 插件类型
  - 注册指令列表
  - 指令描述
  - VCP 占位符描述
  - 来源节点
- 启用本地禁用插件（仅限同步、异步、静态插件）
- 禁用本地插件（仅限同步、异步、静态插件）
- 手动触发插件热重载

## 安全机制

本插件在 `plugin-manifest.json` 中设置了 `requiresAdmin: true`。

调用任何命令时都必须提供管理员验证码参数：

```text
requireAdmin:「始」123456「末」
```

核心服务会把解密后的验证码通过 direct context 注入插件，插件会将用户提供的 `requireAdmin` 与真实验证码比对。

验证码缺失或错误时，命令会直接失败。

## 受保护插件

以下插件被视为核心/高风险插件，不能通过本工具禁用：

- `PluginManager`
- `UserAuth`
- `VCPLog`
- `VCPInfo`
- `VCPToolBridge`

## 启停范围限制

PluginManager 只允许启用或禁用以下本地插件类型：

- `synchronous`
- `asynchronous`
- `static`

以下插件类型只能查询，不能通过本工具启用或禁用：

- `service`
- `hybridservice`
- `messagePreprocessor`

这样做是为了避免热重载常驻进程、路由服务、消息预处理链时引入不可预测状态。

## 云端工具限制

云端 / 分布式工具只支持查询，不支持本地启用或禁用。

原因是云端工具来自远端节点注册，状态由远端节点控制，本机只能通过注册表看到它们，不能直接修改远端 manifest 文件。当前云端启停协议尚未打通。

## 命令

### ListPlugins

查询当前插件注册表。

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginManager「末」,
command:「始」ListPlugins「末」,
requireAdmin:「始」123456「末」
<<<[END_TOOL_REQUEST]>>>
```

返回内容包含：

- `total`
- `enabledCount`
- `disabledCount`
- `cloudCount`
- `localCount`
- `plugins`

每个插件条目包含：

- `name`
- `displayName`
- `pluginType`
- `status`
- `origin`
- `isDistributed`
- `serverId`
- `commands`
- `placeholder`

### GetPluginDetail

查询指定插件详情。

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginManager「末」,
command:「始」GetPluginDetail「末」,
pluginName:「始」LightMemo「末」,
requireAdmin:「始」123456「末」
<<<[END_TOOL_REQUEST]>>>
```

可用别名参数：

- `pluginName`
- `name`
- `toolName`

### EnablePlugin

启用一个本地禁用插件。

仅支持启用 `synchronous`、`asynchronous`、`static` 类型插件。

它会将目标插件目录中的：

```text
plugin-manifest.json.block
```

重命名为：

```text
plugin-manifest.json
```

随后触发插件重载。

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginManager「末」,
command:「始」EnablePlugin「末」,
pluginName:「始」SomePlugin「末」,
requireAdmin:「始」123456「末」
<<<[END_TOOL_REQUEST]>>>
```

### DisablePlugin

禁用一个本地插件。

仅支持禁用 `synchronous`、`asynchronous`、`static` 类型插件。

它会将目标插件目录中的：

```text
plugin-manifest.json
```

重命名为：

```text
plugin-manifest.json.block
```

随后触发插件重载。

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginManager「末」,
command:「始」DisablePlugin「末」,
pluginName:「始」SomePlugin「末」,
requireAdmin:「始」123456「末」
<<<[END_TOOL_REQUEST]>>>
```

注意：不能禁用受保护插件，不能禁用云端 / 分布式插件，也不能禁用 `service`、`hybridservice`、`messagePreprocessor` 类型插件。

### ReloadPlugins

手动触发插件热重载。

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginManager「末」,
command:「始」ReloadPlugins「末」,
requireAdmin:「始」123456「末」
<<<[END_TOOL_REQUEST]>>>
```

## 实现说明

本插件的 thin facade 位于：

```text
Plugin/PluginManager/PluginManager.js
```

核心能力位于根目录：

```text
Plugin.js
```

新增核心方法包括：

- `listPluginRegistry()`
- `getPluginRegistryDetail(pluginName)`
- `enableLocalPlugin(pluginName)`
- `disableLocalPlugin(pluginName)`
- `setLocalPluginEnabled(pluginName, enable)`

插件通过 direct dependency injection 获取核心 `pluginManager` 实例。

如果依赖注入不可用，会回退到 `require('../../Plugin.js')` 获取单例实例。

## 设计原则

PluginManager 是控制平面工具，不建议实现为普通同步 stdio 插件。

原因：

- 插件注册表是核心内存态数据
- 云端工具只存在于运行时注册表中
- 禁用插件需要扫描 `plugin-manifest.json.block`
- 启停插件需要配合核心热重载
- 管理操作需要严格复用核心权限和生命周期逻辑

因此本插件采用：

```text
核心 PluginManager 内部 API + direct 元插件门面
```

的方式实现。