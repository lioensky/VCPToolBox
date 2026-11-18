# V配音 SoVITS 引擎施工图
## 已确认契约
- 只改后端；只复制 presets.json，不复制 refs，不上传参考音频。
- engine=mimo|sovits，默认 mimo；mode 保留 MiMo 原语义。
- SOVITS_API_URL 为引擎服务地址，SOVITS_API_KEY 可空，空时不发送 Authorization。
- SOVITS_REFERENCE_DIR 是推理器电脑上的真实绝对路径，不能在后端 resolve、stat 或读取。
- 将目录与 presets.json 内哈希 WAV 文件名拼接，发送 /tts 的 ref_audio_path。不是 HTTP 音频 URL。
- command=list_voices 返回预设 ID、名称、情绪、参考语言、默认输出语言。
- voice 指定预设 ID（支持 gsv: 前缀），text_lang/speed 支持全局及逐段覆盖。
- 保留对白拼接、时间轴、异步回调、query 和结果文件协议。
- SoVITS 不支持 MiMo 导演/设计/克隆参数，显式报错，不静默忽略。
- 输出统一到现有 24kHz 单声道 PCM16；不同输入 WAV 由 FFmpeg 转换，限制大小与超时。
## 已核查
VChat GsvPresetStore 的 /tts 请求使用 ref_audio_path；原 /reference 上传是可选实现。
引擎 GAG_tools/api_manager_tab.py 提示 allow_dirs 空值允许全部目录；当前配置为空。
真实远端路径合成尚未验证；公网部署应启用鉴权并收窄 allow_dirs。
## 待办
1. 独立 sovits.js：预设解析、路径校验、请求生成、有界音频读取与转换。
2. core.js 复用编排，仅抽出每段生成分支。
3. 入口按引擎配置、预校验、列表查询；清单/配置/文档更新。
4. 离线回归与真实服务验证（如可达），不把模拟测试写成真实验证。
## 2026-11-12 源码验收
- 实现已完成：sovits.js、公共编排分支、入口预校验/list_voices、清单、配置示例、README、测试。
- Node 真实读取清单成功，版本 1.2.0；新增示例使用 ESCAPE 字段写入。
- MIMO_TEST_FFMPEG=true 下 node --test tests/mimoDubbing.test.js tests/sovitsDubbing.test.js：19/19 通过，无跳过。
- 覆盖仅 /tts 请求、空 Key 无鉴权头、远端路径字符串、中日逐段语种、FFmpeg 重采样、MiMo 编排及异步闭环回归。
- git diff --check 通过（添加最终忽略规则前执行）。
- 本机 127.0.0.1:9880 未监听，未进行真实引擎合成。
- 未部署到实际后端运行目录，未复制用户预设，未改实际 config.env，未重启服务。
- 后续部署：同步插件源码至后端；只复制 presets.json；配置实际可达 URL、远端参考目录和可选 Key，确认后端 FFmpeg；启动推理器后联调。