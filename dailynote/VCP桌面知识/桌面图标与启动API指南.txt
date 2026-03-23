# 桌面图标与启动 API 指南

> 本文档面向 AI，帮助你在桌面 Widget 中创建可点击的应用图标，绑定到 VChat 子应用、桌面快捷方式或内置挂件的启动动作，尤其是创建个性化文件夹时非常便利。

---

## 一、统一启动函数

所有图标的启动动作都通过一个统一入口：

```javascript
window.VCPDesktop.dock.launch(item)
```

`item` 通过 `type` 字段决定启动方式：

| type | 含义 | 关键字段 |
|------|------|----------|
| `'vchat-app'` | VChat 内部子应用 | `appAction` |
| `'shortcut'` | Windows 桌面快捷方式 | `targetPath` |
| `'builtin'` | 内置桌面挂件 | `builtinId` |

---

## 二、VChat 应用 ID 注册表

### 2.1 VChat 核心应用

| id | name | appAction | emoji |
|----|------|-----------|-------|
| `vchat-app-main` | VChat | `show-main-window` | 💬 |
| `vchat-app-notes` | 用户笔记中心 | `open-notes-window` | 📝 |
| `vchat-app-memo` | AI记忆中心 | `open-memo-window` | 🧠 |
| `vchat-app-forum` | 论坛模块 | `open-forum-window` | 🏛️ |
| `vchat-app-rag-observer` | RAG监听 | `open-rag-observer-window` | 📡 |
| `vchat-app-dice` | 丢骰子 | `open-dice-window` | 🎲 |
| `vchat-app-canvas` | Canvas | `open-canvas-window` | 🎨 |
| `vchat-app-translator` | 翻译模块 | `open-translator-window` | 🌐 |
| `vchat-app-music` | 音乐播放器 | `open-music-window` | 🎵 |
| `vchat-app-themes` | 主题商店 | `open-themes-window` | 🎭 |
| `vchat-app-toolbox` | 人类工具箱 | `launch-human-toolbox` | 🧰 |
| `vchat-app-dbmanager` | Vchat数据 | `launch-vchat-manager` | 🗄️ |

### 2.2 Windows 系统工具

| id | name | appAction | emoji |
|----|------|-----------|-------|
| `sys-tool-display-settings` | 显示设置 | `open-system-tool:ms-settings:display` | 🖥️ |
| `sys-tool-win-settings` | Windows 设置 | `open-system-tool:ms-settings:` | ⚙️ |
| `sys-tool-control-panel` | 控制面板 | `open-system-tool:control` | 🎛️ |
| `sys-tool-recycle-bin` | 回收站 | `open-system-tool:shell:RecycleBinFolder` | 🗑️ |
| `sys-tool-my-computer` | 我的电脑 | `open-system-tool:shell:MyComputerFolder` | 💻 |

### 2.3 内置桌面挂件

| builtinId | name |
|-----------|------|
| `builtinWeather` | 天气挂件 |
| `builtinMusic` | 音乐播放条 |
| `builtinAppTray` | 应用托盘 |

---

## 三、快速用法

### 启动 VChat 子应用

```javascript
window.VCPDesktop.dock.launch({
    type: 'vchat-app',
    appAction: 'open-music-window',
    name: '音乐'
});
```

### 启动内置挂件

```javascript
window.VCPDesktop.dock.launch({
    type: 'builtin',
    builtinId: 'builtinWeather',
    name: '天气'
});
```

### 读取并启动 Dock 中的桌面快捷方式

```javascript
var items = window.VCPDesktop.state.dock.items;
var app = items.find(function(i) { return i.name.includes('Chrome'); });
if (app) window.VCPDesktop.dock.launch(app);
```

### 直接调用 VChat 应用模块

```javascript
var apps = window.VCPDesktop.vchatApps.VCHAT_APPS;     // 12个核心应用
var tools = window.VCPDesktop.vchatApps.SYSTEM_TOOLS;   // 5个系统工具
window.VCPDesktop.vchatApps.launch(apps[0]);             // 启动第一个
```

---

## 四、Widget 中创建图标文件夹（简要示例）

在 Widget 的 `<script>` 中，遍历应用列表渲染图标，点击时调用 `dock.launch()`：

```javascript
var D = window.VCPDesktop;
var apps = [
    { type:'vchat-app', appAction:'show-main-window', emoji:'💬', name:'VChat' },
    { type:'vchat-app', appAction:'open-music-window', emoji:'🎵', name:'音乐' },
    { type:'vchat-app', appAction:'open-notes-window', emoji:'📝', name:'笔记' },
];

apps.forEach(function(app) {
    var el = document.createElement('div');
    el.textContent = app.emoji + ' ' + app.name;
    el.style.cursor = 'pointer';
    el.addEventListener('click', function() { D.dock.launch(app); });
    document.getElementById('grid').appendChild(el);
});

// 也可以混入 Dock 中的桌面快捷方式
var shortcuts = D.state.dock.items.filter(function(i) { return i.type === 'shortcut'; });
shortcuts.forEach(function(item) {
    var el = document.createElement('div');
    el.textContent = (item.emoji || '📄') + ' ' + item.name;
    el.style.cursor = 'pointer';
    el.addEventListener('click', function() { D.dock.launch(item); });
    document.getElementById('grid').appendChild(el);
});
```

---

## 五、图标渲染优先级

| 优先级 | 字段 | 说明 |
|--------|------|------|
| 1 | `icon` | PNG/SVG 文件路径 |
| 2 | `animatedIcon` | GIF（hover 播放） |
| 3 | `svgIcon` | 内联 SVG，支持 `currentColor` 主题适配 |
| 4 | `emoji` | 最终回退 |

---

## 六、注意事项

- Widget 沙箱中 `window.VCPDesktop` 可直接访问，无需额外配置
- `dock.launch()` 内置 2 秒防抖，防止连续点击
- Dock 列表是动态的，应实时读取 `state.dock.items`
- `VCHAT_APPS` 和 `SYSTEM_TOOLS` 是代码硬编码的，始终可用
- 支持拖拽到桌面：`e.dataTransfer.setData('application/x-desktop-dock-item', JSON.stringify(item))`