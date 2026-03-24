# VCP Panel 扩展

VCP控制面板 - 在VSCode/VCPcode中集成Agent切换和TagMemo知识库搜索功能。

## 功能特性

- **Agent切换** - 快速切换VCP的不同Agent人格
- **知识库搜索** - 直接搜索TagMemo知识库内容
- **统计信息** - 查看知识库概况（知识簇数量、向量维度等）
- **配置灵活** - 可自定义VCP服务器地址

## 安装方法

### 方法1: 开发者模式安装（推荐）

1. 打开VSCode/VCPcode
2. 按 `Ctrl+Shift+P` 打开命令面板
3. 输入 `Extensions: Install from VSIX`
4. 选择 `vcp-panel-1.0.0.vsix` 文件（需要先打包）

### 方法2: 手动安装

1. 将 `vcp-panel-extension` 文件夹复制到VSCode扩展目录:
   - Windows: `%USERPROFILE%\.vscode\extensions\`
   - macOS: `~/.vscode/extensions/`
   - Linux: `~/.vscode/extensions/`
2. 重启VSCode/VCPcode
3. 在侧边栏找到 "VCP Panel" 图标

## 打包VSIX（可选）

如果你想创建可分发的 `.vsix` 文件:

```bash
# 安装 vsce 工具
npm install -g vsce

# 进入扩展目录
cd vcp-panel-extension

# 打包
vsce package
```

这会生成 `vcp-panel-1.0.0.vsix` 文件，可以直接分发安装。

## 配置

首次使用需要配置VCP服务器地址:

1. 点击侧边栏的 "VCP Panel" 图标
2. 切换到 "配置" 标签页
3. 输入VCP服务器地址（默认: `http://localhost:5050`）
4. 点击 "保存配置"

## API依赖

此扩展需要VCP服务器（VCPToolBox）运行，并提供以下API:

- `GET /api/agents/active` - 获取当前Agent
- `POST /api/agents/activate` - 激活Agent
- `GET /api/agents/map` - 获取Agent列表
- `POST /api/rag/search` - 搜索知识库
- `GET /api/rag/stats` - 获取知识库统计

## 使用方法

1. 启动VCP服务器（VCPToolBox）
2. 在VSCode侧边栏点击VCP Panel图标
3. 使用标签页切换不同功能:
   - **Agent**: 切换当前激活的Agent
   - **知识库**: 搜索TagMemo知识库内容
   - **统计**: 查看知识库概况

## 文件结构

```
vcp-panel-extension/
├── package.json          # 扩展配置
├── extension.js          # 扩展入口
├── webview-ui/
│   └── assets/
│       └── icon.png      # 扩展图标
└── README.md             # 本文件
```

## 版本

- 1.0.0 - 初始版本