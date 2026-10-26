# bin/ — 预编译原生二进制

发布时把 `cargo build --release` 的产物按平台三元组命名复制到本目录：

- `MinerUParser-x86_64-pc-windows-msvc.exe`（Windows x64）
- `MinerUParser-x86_64-unknown-linux-gnu`（Linux x64）
- `MinerUParser-aarch64-apple-darwin`（macOS Apple Silicon）

开发期可以留空：`MinerUParser.js` 桥接器会依次回退到
`src/target/<triple>/release/`、`src/target/release/`、`src/target/<triple>/debug/`、
`src/target/debug/` 下的构建产物。
