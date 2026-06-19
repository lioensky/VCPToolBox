/**
 * 第三方仪表盘卡片元信息类型定义
 *
 * 每张第三方卡片的 .vue 文件必须用普通 `<script lang="ts">`（与 `<script setup>` 共存）
 * 导出名为 `cardMeta` 的常量，例如：
 *
 * ```vue
 * <script lang="ts">
 * import type { CardMeta } from "./_types";
 * export const cardMeta: CardMeta = {
 *   typeId: "contrib.disk-usage",
 *   title: "磁盘信息",
 *   description: "显示磁盘 IO 与剩余空间。",
 *   defaultEnabled: false,
 *   singleton: true,
 *   defaultSize: { desktopCols: 3, tabletCols: 3, rows: 11 },
 *   minSize:     { desktopCols: 3, tabletCols: 3, rows: 7 },
 *   maxSize:     { desktopCols: 6, tabletCols: 6, rows: 16 },
 * };
 * </script>
 * ```
 *
 * 详见同目录 README.md 与 docs/DASHBOARD_CONTRIB_GUIDE.md。
 */

import type { DashboardCardSize } from "@/dashboard/core/types";

export interface CardMeta {
  /**
   * 全局唯一 ID。
   * 第三方卡片必须以 `contrib.` 开头，例如 "contrib.disk-usage"，
   * 避免与官方 `builtin.*` 命名空间冲突，也避免不同贡献者撞名。
   */
  typeId: string;

  /** 卡片标题（在"管理卡片"面板与卡片头部显示） */
  title: string;

  /** 卡片描述（在"管理卡片"面板显示，建议 30 字以内） */
  description: string;

  /**
   * 是否在用户首次打开仪表盘时自动启用。
   *
   * 默认 false（推荐）：第三方卡片不污染默认布局，由用户主动到"管理卡片"启用。
   * 仅当卡片对绝大多数用户都有显著价值时才设为 true。
   */
  defaultEnabled?: boolean;

  /**
   * 是否为单例卡片（默认 true）。
   *
   * - true：同一类型卡片在仪表盘中至多存在一份；
   * - false：用户可重复添加（极少需要，慎用）。
   */
  singleton?: boolean;

  /** 默认尺寸（用户首次添加卡片时使用） */
  defaultSize: DashboardCardSize;

  /** 最小尺寸（拖拽缩放时不会小于此） */
  minSize: DashboardCardSize;

  /** 最大尺寸（拖拽缩放时不会大于此） */
  maxSize: DashboardCardSize;

  /**
   * 可选：贡献者署名（在"管理卡片"面板的卡片元信息处展示）
   * 建议格式："NickName <github-handle>"
   */
  author?: string;

  /**
   * 可选：版本号，建议遵循 semver。
   * 当卡片接口或行为变更时建议升版，便于排错。
   */
  version?: string;
}