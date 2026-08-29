========================================
VCP Installer - VCP一键部署工具
========================================

版本：2.0.0
内部精修版：v18.12
许可证：CC-BY-NC-SA-4.0
技术栈：Rust + ratatui (TUI)，单 exe，零依赖
目标平台：Windows 10/11 (x64)

========================================
一、软件功能
========================================

VCP Installer 是一个 Windows 平台的终端交互界面（TUI）安装工具，单 exe
可执行文件（约 3-5MB），无需任何前置依赖。它自动完成 VCP（Variable &
Command Protocol）环境的完整部署，包括：

【环境检测】
- 自动检测系统已安装的 Git、Node.js、Python、MSVC Build Tools
- 检查磁盘空间（建议 ≥3GB）
- 检测 GitHub/npm/PyPI 官网连通性
- GitHub 全不通时止损（阻止继续安装，提示重测/返回）

【智能镜像站管理】
- 支持通过 vcp-mirrors.ini 配置文件自定义镜像站点
- 启动时自动执行三阶段镜像站测试：
  - Phase0：项目存在性校验（检查是否存在 VCPToolBox 项目，剔除不支持的站点）
  - Phase1：快速连通测试（下载10MB，10秒超时，剔除无法下载的站点）
  - Phase2：完整下载验证（下载174MB验证真实速度，筛选出速度最快的3个）
- 优选结果持久化到 vcp-mirrors.ini [preferred_github]，下次安装直接复用
- 下载失败时自动按速度排序依次尝试其他可用站点（Fallback 机制）

【运行时环境安装】
- PortableGit：自动获取最新稳定版（64位），多镜像降级 + 断点续传
- Node.js：npmmirror 国内CDN 优先 + nodejs.org 兜底，速度提升 10-20 倍
- Python：自动获取 python-build-standalone 最新稳定版（当前为 3.14.7）
- MSVC Build Tools：必需组件（VCP 原生模块编译依赖），自动检测并强制安装

【项目克隆与配置】
- 部署 VCPToolBox（后端服务，Node.js + Python）
- 部署 VCPChat（前端客户端，Electron）
- 下载 NewAPI（API 聚合管理，Go 语言，预编译 exe）
- 支持 Git Clone（完整仓库）/ Tarball（轻量压缩包）双安装方式，功能等价
- 安装 Node.js/Python 依赖（npm install / pip install）
- 自动生成配置文件（config.env）和启动脚本
- 自动执行 electron-rebuild，重建 Electron 原生模块（防前端静默失败）

【安装优化与韧性】
- DL_runtimes 目录缓存所有安装包，重复安装无需重复下载
- 三层韧性链路：git clone 断流 → 同站重试 → 换镜像站 → Tarball 兜底
- 看门狗 + 心跳机制：拔网线/断网时自动杀进程树重试，零卡死
- 断点续传：下载中断后自动续传，不从头重下
- INI 统一版本校验：缓存版本与最新版本比对，过期自动重新下载
- Windows Defender 排除路径自动添加（防止 EPERM 错误）
- headless 模式支持无界面自动化安装
- --ui-preview 模式预览 TUI 全部页面

========================================
二、快速开始
========================================

【方式一：图形界面（推荐）】

1. 将 vcp-installer.exe 复制到目标目录
2. 在同目录放置 vcp-mirrors.ini 自定义镜像（可选）
3. 在 DL_runtimes 目录预放下载好的安装包（可选）
4. 双击运行 vcp-installer.exe
5. 按提示选择组件、配置参数、开始安装
6. 安装完成后按 Enter 进入第七页，查看 VCP 使用引导

【方式二：命令行（headless 模式）】
vcp-installer.exe --headless D:\\path\\to\\install\\dir
适用于自动化部署、CI/CD 场景。

【方式三：TUI 页面预览】
vcp-installer.exe --ui-preview
预览 TUI 全部页面（PgDn 下一页 / PgUp 上一页 / Q 退出），不执行真实安装。

========================================
三、安装后目录结构
========================================

安装完成后，目录结构如下：

安装目录/
├── runtimes/                      # Portable 运行时（项目内）
│   ├── git/                       # Git for Windows
│   ├── node/                      # Node.js
│   ├── python/                    # Python
│   └── new-api.exe                # NewAPI 服务
├── VCPToolBox/                    # 后端服务
│   ├── server.js
│   ├── config.env                 # 自动生成的配置文件
│   └── ...
├── VCPChat/                       # 前端客户端（Electron）
├── VCPBackUpDEV/                  # 备份开发（可选）
├── VCPDistributedServer/          # 分布式服务器（可选）
├── start-backend.bat              # 启动后端服务（PM2 双进程）
├── start-frontend.bat             # 启动前端客户端
├── start-upgrade.bat              # 组件升级（git pull，3次重试）
├── upgrade_log/                   # 升级日志目录
│   └── upgrade.log
└── Install_log/                   # 安装日志目录（分段 + 全量）
    ├── 00_full_log.txt            # 全量日志
    ├── 01_prepare.log ~ 09_scripts.log  # 分段日志
    └── install_summary.log        # 安装总结

exe 所在目录/
├── vcp-installer.exe              # 安装器本体
├── vcp-mirrors.ini                # 镜像站配置（可选）
└── DL_runtimes/                   # 下载缓存（永久保留）
    ├── PortableGit.7z.exe         # Git 安装包（可复用）
    ├── node-v*.zip                # Node.js 安装包（可复用）
    ├── cpython-*.tar.gz           # Python 安装包（可复用）
    ├── new-api.exe                # NewAPI 缓存（可复用）
    ├── VCPToolBox.tar.gz          # 组件 tarball 缓存（可复用）
    └── vs_BuildTools.exe          # MSVC 安装器

说明：
- DL_runtimes 与 exe/ini 同级，不随安装目录清除
- 重复安装或离线安装时，DL_runtimes 中的缓存会被直接复用
- Install_log 分段日志 + 全量日志，便于定位问题

========================================
四、安装后使用指南
========================================

【启动 VCP】

1. 启动后端服务：
   运行 start-backend.bat（PM2 守护 vcp-main + vcp-admin 双进程）
   - 主 API：http://localhost:6005（需 Key 鉴权）
   - 管理面板：http://localhost:6006/AdminPanel/（Basic Auth）

2. 启动前端客户端：
   运行 start-frontend.bat（Electron 应用）
   - 首次使用需在 VCPChat 全局设置中填写：
     * 用户名（必填）
     * 服务器地址（http://localhost:6005/v1/chat/completions）
     * 通知地址（ws://localhost:6005）

3. 配置 AI 服务（重要）：
   安装器生成的 config.env 使用占位符密码，生产环境必须替换：
   - API_Key、API_URL、Key、AdminPassword 等
   替换真实值后，前后端通信和 AI 对话才能正常工作。

【停止 VCP】
runtimes\node\node_modules\pm2\bin\pm2 stop all
taskkill /IM electron.exe /F

【升级 VCP 组件】
运行 start-upgrade.bat
- 自动检测 4 个组件，逐个 git pull（3 次重试）
- 日志写入 upgrade_log/upgrade.log

========================================
五、镜像站配置
========================================

在 exe 同级目录放置 vcp-mirrors.ini 自定义镜像站点：

示例：

[github]
gh-proxy.com = https://gh-proxy.com/https://github.com/
ghfast.top = https://ghfast.top/https://github.com/

[npm]
npmmirror(淘宝) = https://registry.npmmirror.com/

[pip]
清华 = https://pypi.tuna.tsinghua.edu.cn/simple/

说明：
- 每行一个镜像：显示名称 = URL
- 支持注释行（; 开头）
- 不配置时使用内置默认镜像列表
- 安装时自动测试所有站点，优选最快的写入 [preferred_github]
- 双机制：[github] 备用列表（离线维护）+ [preferred_github] 可用列表（动态生成）

========================================
六、headless 模式
========================================

headless 模式支持无界面的自动化安装，适用于脚本调用。

基本用法：
vcp-installer.exe --headless D:\\path\\to\\install\\dir

完整参数：
vcp-installer.exe --headless --install-dir D:\\path\\to\\install\\dir --mirror-config vcp-mirrors.ini

网络代理支持：
设置 https_proxy / http_proxy 环境变量后运行。

MSYS2/Git Bash 中的路径问题：
MSYS2 路径格式（如 /d/Desktop/path）会自动转换为 Windows 路径（D:\\Desktop\\path），
无需手动转换。

========================================
七、常见问题
========================================

Q: 安装需要多长时间？
A: 首次安装约需 10-30 分钟（取决于网络环境），需下载约 2-3GB 文件。
   建议开启 VPN 或使用代理。

Q: 为什么安装时有很多镜像站测试？
A: 镜像站 HEAD 响应快不代表大数据传输可靠。VCP Installer 采用三阶段测试
   （项目预验 + 快速连通 + 完整下载），确保选择的镜像站真正可用。

Q: 重复安装需要重新下载吗？
A: 不需要。DL_runtimes 目录永久缓存安装包，重复安装直接复用。

Q: MSVC Build Tools 安装很慢怎么办？
A: MSVC Build Tools 是必需组件（VCP 原生模块编译依赖），约需下载 1-2GB，
   预计 5-15 分钟。安装器会自动显示心跳提示（每 180 秒一次）并有 30 分钟
   总超时 + 3 次重试，请耐心等待。安装失败会中止整体安装。

Q: pip install 失败怎么办？
A: Python portable 版本内置 ensurepip，不依赖外部网络安装 pip。
   如仍有问题，查看 Install_log/01_prepare.log ~ 09_scripts.log 获取详细日志。

Q: 拔网线或断网时安装会卡死吗？
A: 不会。安装器采用看门狗 + 心跳机制，90 秒无活动自动杀进程树并换镜像站
   重试，最终 Tarball 兜底。拔线测试全程零卡死。

Q: VCPChat 前端启动后窗口不显示？
A: 可能是 Electron 原生模块 ABI 不匹配。安装器已自动执行 electron-rebuild
   重建。如仍出现问题，手动运行：
   cd VCP_AIOS\VCPChat
   node node_modules\@electron\rebuild\lib\cli.js -f -o better-sqlite3

Q: 如何升级已安装的 VCP 组件？
A: 运行安装目录下的 start-upgrade.bat，自动对 4 个组件执行 git pull
   （3 次重试），日志写入 upgrade_log/upgrade.log。

========================================
八、技术特点
========================================

- Rust 编写，零依赖，单 exe 可分发（约 3-5MB）
- Tokio 异步运行时，支持并发检测/下载
- ratatui TUI 界面，进度条实时显示
- 三层韧性链路：git clone 断流 → 同站重试 → 换镜像站 → Tarball 兜底
- 看门狗 + 心跳机制：防拔线挂死、防管道死锁
- 多镜像降级 + 断点续传：Node.js 走 npmmirror CDN，速度提升 10-20 倍
- electron-rebuild：自动重建 Electron 原生模块，防前端静默失败
- INI 统一版本校验：缓存版本比对，过期自动重新下载
- 完善的错误处理和降级策略
- headless 模式 + --ui-preview 预览模式
- 安装日志输出（Install_log/ 分段 + 全量）

========================================
九、代码来源
========================================

VCP Installer 整合了以下开源项目：

项目        仓库地址                            说明
----------  ----------------------------------  ----------------------------
VCPToolBox  github.com/lioensky/VCPToolBox     后端核心 (Node.js + Python)
VCPChat     github.com/lioensky/VCPChat        前端客户端 (Electron)
NewAPI      github.com/QuantumNous/new-api     API聚合管理 (Go, 预编译exe)

本安装包工具（vcp-installer）为独立开发，用于简化上述项目的部署流程。

========================================
© 2026 VCP Community
========================================
