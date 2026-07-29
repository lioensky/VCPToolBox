# LibreHardwareMonitor 资源准备说明

此目录只保留接入说明，不再随仓库分发 LibreHardwareMonitor 的任何官方二进制文件。

## 想启用这个功能，需要什么

本功能有两条路线，请按你的目标准备环境：

### 路线 A：DLL 直连传感器（推荐）

如果你想在 VCPdesktop 中直接读取温度、风扇、电压、功耗等传感器，而不依赖外部 LibreHardwareMonitor 进程，请同时满足以下条件：

1. Windows 环境。
2. 已安装 `electron-edge-js`。
3. 系统中可用 `.NET Framework` 自带的 C# 编译器 `csc.exe`。
4. 已自行准备 `LibreHardwareMonitor v0.9.6` 的 `LibreHardwareMonitorLib.dll` 及其伴随 DLL，并放到当前目录或通过环境变量指定路径。

缺少以上任一条件时，DLL 直连路线不会启用。

### 路线 B：WMI 回退

如果你不准备 `electron-edge-js`、`csc.exe` 或整套 DLL，也仍然可能使用传感器功能，但前提是：

1. 你已经单独安装并运行了 LibreHardwareMonitor。
2. 该程序已在系统中暴露 `root/LibreHardwareMonitor` WMI 命名空间。

这种情况下，VCPdesktop 会回退到 WMI 路线。

### 如果两条路线都不满足

程序仍可使用 CPU、内存、磁盘、网络等基础指标，但主板温度、风扇、电压、功耗等增强传感器通常不可用。

## 依赖来源

如需启用 Windows 传感器 DLL 桥接，请自行从 LibreHardwareMonitor 官方仓库准备依赖：

- 仓库：`https://github.com/LibreHardwareMonitor/LibreHardwareMonitor`
- 版本：`v0.9.6`
- 提交：`3d331e3370efb858411f19511373eff65a218701`

建议使用与上述版本一致的发布物或自行基于该提交构建，避免桥接程序集与运行时依赖不匹配。

## 需要放置的文件

至少需要把 `LibreHardwareMonitorLib.dll` 及其伴随依赖复制到当前目录。常见文件包括：

- `LibreHardwareMonitorLib.dll`
- `HidSharp.dll`
- `DiskInfoToolkit.dll`
- `RAMSPDToolkit-NDD.dll`
- `BlackSharp.Core.dll`
- `System.Text.Json.dll`
- `System.Memory.dll`
- 以及同目录下其他 `System.*` / `Microsoft.*` 兼容程序集

## 默认查找顺序
1. 环境变量 `VCP_LHM_DLL_PATH`
2. 环境变量 `LIBRE_HARDWARE_MONITOR_DLL_PATH`
3. `vendor/LibreHardwareMonitor/LibreHardwareMonitorLib.dll`
4. `vendor/LibreHardwareMonitorLib.dll`

## 使用说明
- 宿主层会优先尝试通过 `electron-edge-js` + 预编译 CLR 桥接程序集加载此目录中的 DLL。
- 若目录缺少伴随依赖、Edge 模块不可用或桥接编译失败，Windows 传感器采集会回退到 LibreHardwareMonitor WMI 路线。
- 这些官方二进制仅供本地运行时使用，不应随本仓库提交或分发。

## 快速检查清单

如果你希望 DLL 直连路线生效，请确认：

- `electron-edge-js` 已成功安装。
- 系统存在 `csc.exe`。
- 当前目录中已放置 `LibreHardwareMonitorLib.dll` 及伴随 DLL。
- 或者你已用 `VCP_LHM_DLL_PATH` / `LIBRE_HARDWARE_MONITOR_DLL_PATH` 指向正确的 DLL 路径。

---

## Agent 如何获取本机指标（推荐方式）

> 重要：本目录仅用于 **Windows 传感器**（温度/风扇/电压/功耗等）提供方的 DLL 依赖管理。  
> Agent 不应直接加载/调用这些 DLL；应通过 VCPdesktop 的“统一指标 API”读取快照数据。

### 前提
- 已打开 **VCPdesktop 桌面窗口**（桌面渲染进程已加载 `Desktopmodules/api/desktopMetrics.js` 与系统监控挂件模块）。
- 宿主侧已启用桌面指标 IPC：`desktop-metrics-get-capabilities` / `desktop-metrics-get-snapshot`。

### 方式：调用 `VCPDesktop.agentAPI.metrics`（含作用域探测 + 就绪等待）

#### 1) 作用域探测（壁纸 / 挂件环境常见）
壁纸通常运行在 `iframe` 内；挂件脚本也可能在隔离包装内执行。此时 `window.VCPDesktop` 不一定存在，需要向上探测父窗口：

```js
function resolveDesktopHostWindow() {
  if (window.VCPDesktop) return window;
  try { if (window.parent && window.parent.VCPDesktop) return window.parent; } catch (_) {}
  try { if (window.top && window.top.VCPDesktop) return window.top; } catch (_) {}
  return null;
}
```

#### 2) 就绪等待（异步注入时序）
桌面端脚本初始化是异步的；壁纸/挂件脚本可能跑得更快，导致首次访问返回 `undefined`。建议加入轮询等待：

```js
async function waitForMetricsApi(timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const host = resolveDesktopHostWindow();
    const metrics = host?.VCPDesktop?.agentAPI?.metrics;
    if (metrics?.getSnapshot && metrics?.getComponent) return metrics;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("VCPDesktop.agentAPI.metrics 未就绪（请确认已打开桌面窗口，且壁纸/挂件与桌面同源可访问 parent/top）");
}
```

#### 3) 读取能力与快照（低频）
`getSnapshot()` 会采集较多字段（CPU/内存/磁盘/网络/电池/GPU/传感器/系统等），建议用于 **低频**（例如 2~5 秒一次）：
```js
const metrics = await waitForMetricsApi();

const caps = await metrics.getCapabilities(false);
const snapshot = await metrics.getSnapshot({
  includeProcesses: false,
  includeDocker: false
});
```

#### 4) 读取单组件（按需）
建议优先按需读取组件（例如仅 CPU / 仅传感器），并控制刷新频率（例如 >= 1000ms）：
```js
const metrics = await waitForMetricsApi();

const cpu = await metrics.getComponent('cpu');
const sensors = await metrics.getComponent('sensors');
```

### 指标与 LibreHardwareMonitor 的关系
- `getSnapshot()` / `getComponent()` 返回的是统一快照模型；在 Windows 上，`sensors` 字段会优先尝试使用本目录的 `LibreHardwareMonitorLib.dll` 桥接补齐传感器数据。
- 若 DLL 链路不可用，会自动回退到 LibreHardwareMonitor WMI（如可用），并在快照中返回可读的降级原因。

### 传感器字段注意事项（Schema）
传感器数据为数组结构，**数值字段稳定**，但传感器名称/来源字符串是动态的（不同机器/主板/驱动会不同），不要依赖固定 name。

- `snapshot.sensors.temperatures[]`：`{ name, valueC, hardware, hardwareType, source, identifier }`
- `snapshot.sensors.fans[]`：`{ name, rpm, ... }`
- `snapshot.sensors.voltages[]`：`{ name, volts, ... }`
- `snapshot.sensors.powers[]`：`{ name, watts, ... }`

示例：尽量“模糊匹配”拿到一个可用温度（先匹配 CPU/Package/核心字样，找不到则取最高温）：
```js
function pickCpuTempC(snapshot) {
  const temps = snapshot?.sensors?.temperatures || [];
  const hit = temps.find(t => /cpu|package|core/i.test(String(t.name || "")) || /cpu/i.test(String(t.hardware || "")));
  if (hit && typeof hit.valueC === "number") return hit.valueC;
  const max = temps.reduce((acc, t) => (typeof t.valueC === "number" && t.valueC > acc ? t.valueC : acc), -Infinity);
  return Number.isFinite(max) ? max : null;
}
```

### 采样负载建议（Sampling Load）
- 壁纸/动画这类高频场景不建议频繁调用 `getSnapshot()`（数据量较大，可能造成 IPC 堵塞）。
- 优先选择：
  1) DesktopRemote 的 `SetStyleAutomation`：把“指标→样式”下发给桌面端持续执行（避免自己轮询）
  2) `getComponent('cpu')` / `getComponent('sensors')` 等按需读取，并把刷新间隔控制在 >= 1000ms（或更慢）

---

## 附：通过 DesktopRemote 下发“指标驱动全局样式自动化”

> 用途：让 Agent 不必持续轮询指标，而是把“指标 → 全局样式”的映射规则下发给桌面端，由桌面端按 `intervalMs` 持续应用。

### 命令
- `SetStyleAutomation`：下发配置/启停（可选 `persist` 写入 `layout.json` 的 `globalSettings.styleAutomation`）
- `GetStyleAutomationStatus`：查询运行状态与配置摘要

### 示例：CPU 占用驱动 Dock 图标大小
下发规则：把 `cpu.usagePct` 线性映射到 `--desktop-dock-icon-size`（px）。

```json
{
  "command": "SetStyleAutomation",
  "enabled": true,
  "intervalMs": 2000,
  "persist": true,
  "rules": [
    {
      "id": "dockFromCpu",
      "sourcePath": "cpu.usagePct",
      "map": { "inMin": 0, "inMax": 100, "outMin": 28, "outMax": 44, "clamp": true, "round": 0 },
      "target": { "type": "cssVar", "name": "--desktop-dock-icon-size", "unit": "px", "round": 0 }
    }
  ]
}
```

### 回滚/停用
将 `enabled` 设为 `false`：桌面端会停止轮询并回滚运行时覆盖，恢复 `globalSettings` 基线样式。
