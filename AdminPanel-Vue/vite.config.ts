import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { visualizer } from "rollup-plugin-visualizer";

function readVcpServerPort(): string {
  const configPath = resolve(__dirname, "..", "config.env");
  if (!existsSync(configPath)) return "6005";

  const content = readFileSync(configPath, "utf-8");
  const match = content.match(/^\s*PORT\s*=\s*([^\r\n#]+)/m);
  return match?.[1]?.trim() || "6005";
}

export default defineConfig(({ mode }) => {
  const shouldAnalyze = mode === "analyze" || process.env.ANALYZE === "true";
  const adminApiTarget =
    process.env.VCP_ADMIN_API_TARGET || `http://localhost:${readVcpServerPort()}`;

  return {
    plugins: [
      vue(),
      ...(shouldAnalyze
        ? [
            visualizer({
              // 生成 bundle 分析图
              open: true, // 仅分析模式下自动打开
              gzipSize: true, // 显示 gzip 大小
              brotliSize: true, // 显示 brotli 大小
              filename: "dist/stats.html", // 输出文件名
            }),
          ]
        : []),
    ],
    base: "/AdminPanel/",
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/admin_api": {
          target: adminApiTarget,
          changeOrigin: true,
        },
      },
    },
    optimizeDeps: {
      // 预优化依赖，加快开发启动速度
      include: ["vue", "vue-router", "pinia", "marked", "dompurify", "easymde"],
    },
    build: {
      outDir: "dist",
      assetsDir: "assets",
      minify: "esbuild", // 使用 esbuild 替代 terser，构建速度快 20-40 倍
      sourcemap: false, // 生产环境关闭 source map 以减小体积
      target: "esnext", // 使用最新 ES 特性，让 esbuild 更好地优化
      esbuildOptions: {
        drop: ["console", "debugger"], // 生产环境移除 console 和 debugger
        minifyIdentifiers: true, // 压缩变量名
        minifySyntax: true, // 压缩语法
        minifyWhitespace: true, // 压缩空白
        keepNames: false, // 不保留函数名（生产环境）
        legalComments: "none", // 移除法律注释
      },
      rollupOptions: {
        output: {
          // 代码分割策略 - 优化 bundle 大小
          manualChunks(id) {
            if (id.includes("node_modules")) {
              if (
                id.includes("vue") ||
                id.includes("vue-router") ||
                id.includes("pinia")
              ) {
                return "vue-vendor";
              }
              if (id.includes("marked") || id.includes("dompurify")) {
                return "markdown";
              }
              if (id.includes("easymde")) {
                return "easymde";
              }
            }
            // 不再强制把每个 Dashboard 卡片拆成手工命名 chunk。
            // 这些卡片本身已经由 import.meta.glob + defineAsyncComponent 按需加载；
            // 继续在 manualChunks 中把 .vue SFC 强行切成 dashboard-card-* chunk，
            // 会让首次进入 Dashboard 后快速路由切换时，更容易撞上异步卡片解析
            // 与父级卸载/Teleport 清理交叠的 Vue DOM remove 竞态。
            // 交给 Rollup/Vite 默认 chunk 图处理，可以保持异步边界，同时避免
            // dashboard-card-* chunk 在卸载阶段触发 parentNode/null 幽灵错误。
          },
          // CSS 文件输出到独立目录
          chunkFileNames: "assets/js/[name]-[hash].js",
          entryFileNames: "assets/js/[name]-[hash].js",
          assetFileNames: ({ name }) => {
            if (name && name.endsWith(".css")) {
              return "assets/css/[name]-[hash].[ext]";
            }
            return "assets/[name]-[hash].[ext]";
          },
        },
      },
      chunkSizeWarningLimit: 500, // 设置警告阈值为 500KB
      reportCompressedSize: true, // 报告压缩后大小
    },
    test: {
      globals: true,
      environment: "node",
      include: ["tests/**/*.test.ts"],
    },
  };
});
