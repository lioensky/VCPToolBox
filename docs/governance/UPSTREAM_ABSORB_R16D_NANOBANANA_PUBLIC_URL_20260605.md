# Upstream Absorb R16D NanoBananaGen2 Public URL Switch - 2026-06-05

本文件记录 R16D 对 upstream commit `8977a56a 为NanoBananaGen2公网适配开关` 的本地安全化吸收结果。

本批是 NanoBananaGen2 图片返回 URL 的配置开关包，不执行真实生图请求。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `main` |
| 本地基线 | `9ea73357 Merge pull request #123 from JENN2046/codex/r16-candidate-classification-20260605` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| upstream commit | `8977a56a 为NanoBananaGen2公网适配开关` |
| 本地分支 | `codex/r16d-nanobanana-public-url-20260605` |

## 2. 本地适配内容

| 文件 | 变更 |
|------|------|
| `Plugin/NanoBananaGen2/NanoBananaGen.mjs` | 增加 `USE_PUBLIC_URL` 和 `VarHttpsUrl` 支持；默认保持局域网 `VarHttpUrl:SERVER_PORT`；显式 `USE_PUBLIC_URL=true` 时使用 `VarHttpsUrl`。 |
| `Plugin/NanoBananaGen2/config.env.example` | 增加 `USE_PUBLIC_URL=false` 示例和说明。 |
| `Plugin/NanoBananaGen2/plugin-manifest.json` | 在 `configSchema` 中声明 `USE_PUBLIC_URL`。 |
| `Plugin/NanoBananaGen2/README.md` | 在通用配置表中补充 `USE_PUBLIC_URL`。 |
| `tests/gptimagegen-safety.test.js` | 增加静态回归，锁定默认 false、显式公网、缺少 `VarHttpsUrl` 报错和 manifest/example 可发现性。 |

## 3. 与 upstream 的差异

未原样吸收 upstream：

- upstream 默认 `USE_PUBLIC_URL=true`；本地保持默认 `false`，避免默认扩大公网暴露。
- upstream 使用 `VarHttpUrl` 拼接公网 URL；本地公网模式使用全局 `VarHttpsUrl`。
- upstream 公网拼接出现 `//pw=` 形态；本地统一去除尾部 `/` 后拼接 `/pw=...`。
- upstream 只改代码和 example；本地同步更新 manifest 与 README，并加静态回归测试。

## 4. 安全边界

- 不 raw merge `upstream/main`。
- 不修改真实 `.env`、`config.env`、token/key、运行态、缓存、日志或图片输出。
- 不启动服务，不执行真实 NanoBananaGen2 生图请求。
- 不改变 file/image 输入安全边界。
- 不改变默认 URL 输出行为，除非 operator 显式设置 `USE_PUBLIC_URL=true`。

## 5. 验证

计划验证：

```powershell
node --check Plugin/NanoBananaGen2/NanoBananaGen.mjs
node -e "JSON.parse(require('fs').readFileSync('Plugin/NanoBananaGen2/plugin-manifest.json','utf8'))"
node --test tests/gptimagegen-safety.test.js
git diff --check
```

## 6. 结论

R16D 可以作为本地安全小包吸收。

该变更只让 NanoBananaGen2 的图片返回 URL 可显式切换到公网基址，并保持默认局域网输出。
