import type { DiaryNote } from "@/stores/diary";

export interface RagTagsConfig {
  thresholdEnabled: boolean;
  threshold: number;
  tags: string[];
}

export const DEFAULT_RAG_TAGS_CONFIG: RagTagsConfig = {
  thresholdEnabled: false,
  threshold: 0.7,
  tags: [],
};

const COMMON_RAG_TAGS = [
  "任务闭环",
  "社区贡献",
  "逻辑共鸣",
  "架构讨论",
  "性能优化",
  "Bug 修复",
  "功能请求",
  "用户反馈",
  "版本发布",
  "技术债务",
  "文档更新",
  "测试覆盖",
  "代码审查",
  "安全加固",
  "用户体验",
] as const;

export function filterDiaryNotes(notes: readonly DiaryNote[], query: string): DiaryNote[] {
  if (!query) {
    return [...notes];
  }

  const normalizedQuery = query.toLowerCase();
  return notes.filter(
    (note) =>
      note.title?.toLowerCase().includes(normalizedQuery) ||
      note.file.toLowerCase().includes(normalizedQuery)
  );
}

export function getMissingCommonRagTags(tags: readonly string[]): string[] {
  const existingTags = new Set(
    tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
  );

  return COMMON_RAG_TAGS.filter((tag) => !existingTags.has(tag.toLowerCase()));
}
