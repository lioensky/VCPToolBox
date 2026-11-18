# CPU 温度监控配置指南

**适用场景：** 家庭服务器、本地旧电脑、Windows 笔记本、迷你主机等自部署环境。  
**主要目标：** 让 VCPToolBox 管理面板的 CPU 卡片显示服务器本机 CPU 温度。

---

## 功能说明

VCPToolBox 的管理面板 CPU 卡片支持显示 CPU 温度，但 VCPToolBox 本身不直接读取硬件传感器。

在 Windows 上，推荐通过 LibreHardwareMonitor 提供本机硬件传感器数据：

```text
LibreHardwareMonitor
  ↓ 提供本机 HTTP JSON
http://localhost:8085/data.json
  ↓ VCPToolBox 后端读取
/admin_api/system-monitor/system/resources
  ↓ AdminPanel CPU 卡片显示
CPU 温度
```

注意：这里的 `localhost` 指的是 **运行 VCPToolBox 服务器的那台机器**，不是浏览器客户端所在机器。

例如：

```text
服务器运行在家庭电脑 A
用户从手机/电脑 B 打开管理面板
  → 浏览器 B 不直接访问 localhost:8085
  → VCPToolBox 后端在电脑 A 上访问 http://localhost:8085/data.json
  → 温度数据回传给面板显示
```

---

## Windows 配置步骤

### 1. 下载 LibreHardwareMonitor

前往 GitHub Releases 页面下载最新版：

https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases

下载文件：

```text
LibreHardwareMonitor.zip
```

这是便携版，不需要安装。

---

### 2. 解压并运行

解压 `LibreHardwareMonitor.zip` 后，运行：

```text
LibreHardwareMonitor.exe
```

建议：

- 使用管理员权限运行
- 保持 LibreHardwareMonitor 常驻运行
- 如果温度读取不完整，优先尝试管理员权限

管理员权限通常能让 CPU、主板、风扇、电压等传感器读取更完整。

---

### 3. 启用 Remote Web Server

在 LibreHardwareMonitor 界面中打开：

```text
Options → Remote Web Server
```

然后：

1. 勾选 `Run`
2. 端口使用 `8085`
3. 不要开启用户名/密码认证

端口要求：

```text
8085
```

VCPToolBox 当前默认读取地址固定为：

```text
http://localhost:8085/data.json
```

因此 LibreHardwareMonitor 的 Web Server 端口必须是 `8085`。

---

### 4. 验证数据接口

在运行 VCPToolBox 的服务器机器上打开浏览器，访问：

```text
http://localhost:8085/data.json
```

如果配置正确，会看到一大段 JSON 数据，结构大致类似：

```json
{
  "Text": "Sensor",
  "Children": [
    {
      "Text": "DESKTOP-XXXX",
      "Children": [
        {
          "Text": "Intel Core i7-8750H",
          "HardwareId": "/intelcpu/0",
          "Children": [
            {
              "Text": "Temperatures",
              "Children": [
                {
                  "Text": "CPU Package",
                  "Value": "60.0 °C",
                  "SensorId": "/intelcpu/0/temperature/8",
                  "Type": "Temperature"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

只要能访问这个 JSON，VCPToolBox 后端就能读取 CPU 温度。

---

## 面板显示逻辑

VCPToolBox 后端会在系统资源接口中尝试读取：

```text
http://localhost:8085/data.json
```

然后从传感器树中查找 CPU 温度。

温度传感器筛选条件：

```text
Type = Temperature
SensorId 包含 /intelcpu/
```

优先显示顺序：

1. `CPU Package`
2. `Core Max`
3. `Core Average`
4. `CPU Core #1`
5. 其他非 `Distance to TjMax` 的 CPU 温度项

面板显示示例：

```text
温度：60.0 °C · CPU Package
平台：win32
架构：x64
```

如果 LibreHardwareMonitor 未运行、端口不正确、没有可用传感器，CPU 卡片会自动隐藏温度行，不影响 CPU 使用率显示。

---

## 轮询与性能

CPU 温度不会由 VCPToolBox 后端后台常驻轮询。

实际触发条件：

```text
用户打开管理面板
  ↓
启用了 CPU / 内存 / PM2 进程 / Node 信息等系统监控卡片
  ↓
前端每 5 秒请求一次系统资源
  ↓
后端在处理这次请求时读取一次 http://localhost:8085/data.json
```

因此：

- 无人打开管理面板时，不读取温度
- 页面切到后台不可见时，前端轮询会停止
- LibreHardwareMonitor 不可用时，后端会快速降级
- 当前读取超时约为 800ms，避免长时间阻塞系统资源接口

家庭服务器场景下，5 秒一次本机 HTTP JSON 读取负担很低。

---

## 安全注意事项

建议保持以下配置：

1. LibreHardwareMonitor Web Server 只用于本机读取
2. 使用默认本机地址：

```text
http://localhost:8085/data.json
```

3. 不要把 LibreHardwareMonitor Web Server 暴露到公网
4. 不要在路由器上给 `8085` 做公网端口转发
5. 不要开启认证，因为 VCPToolBox 当前按无认证本机接口读取
6. 如果机器有防火墙提示，优先选择仅允许本机/专用网络

VCPToolBox 读取的是服务器本机的 `localhost:8085`，正常情况下不需要让外部设备访问这个端口。

---

## 常见问题

### 面板没有显示温度

请检查：

1. LibreHardwareMonitor 是否正在运行
2. 是否启用了：

```text
Options → Remote Web Server → Run
```

3. 端口是否为：

```text
8085
```

4. 是否能在服务器本机打开：

```text
http://localhost:8085/data.json
```

5. JSON 中是否存在 `/intelcpu/` 和 `Type: "Temperature"` 的传感器

---

### 从其他电脑访问面板，温度还是服务器的吗？

是。

温度由 VCPToolBox 后端在服务器本机读取：

```text
服务器 localhost:8085
```

不是由浏览器客户端读取。

所以用户从手机、平板、另一台电脑打开管理面板时，显示的仍然是 VCPToolBox 服务器所在机器的 CPU 温度。

---

### 为什么不直接让浏览器访问 localhost:8085？

因为浏览器里的 `localhost` 指向的是用户正在使用的设备。

例如：

```text
服务器：家庭电脑 A
浏览器：手机 B
浏览器访问 localhost:8085
  → 实际访问的是手机 B 的 localhost
  → 不是服务器 A
```

因此正确方式是：

```text
浏览器 → VCPToolBox 后端 → 服务器本机 localhost:8085
```

---

### Linux 服务器需要这样配置吗？

这份文档主要面向 Windows + LibreHardwareMonitor。

Linux 通常可以通过 `lm-sensors` 或 `/sys/class/hwmon` 获取温度。当前 VCPToolBox 的 CPU 温度显示优先支持 LibreHardwareMonitor 的 `data.json` 方式，适合 Windows 家庭服务器和旧笔记本部署场景。

---

## 相关实现位置

- 后端系统资源接口：`routes/admin/system.js`
- 前端系统资源请求：`AdminPanel-Vue/src/api/system.ts`
- 仪表盘状态管理：`AdminPanel-Vue/src/composables/useDashboardState.ts`
- CPU 卡片展示：`AdminPanel-Vue/src/components/dashboard/CpuCard.vue`