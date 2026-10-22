import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createDefaultDiarySyntaxState, scanDiarySyntaxes } from "../src/views/AgentFilesEditor/diarySyntaxParser";

describe("日记 DSL 单轨化", () => {
  it("新状态不提供旧引擎开关或权重", () => {
    const state = createDefaultDiarySyntaxState();
    expect(state.retiredSuffixes).toEqual([]);
    expect(state.enabledSuffixes).not.toHaveProperty("tagMemo");
    expect(state.enabledSuffixes).not.toHaveProperty("tagMemoPlus");
    expect(state).not.toHaveProperty("tagMemoWeight");
  });

  it.each(["TagMemo", "TagMemo+", "TagMemo0.3", "tagmemo+0.6"])(
    "检测 %s，保留其他后缀且不静默映射",
    (suffix) => {
      const [match] = scanDiarySyntaxes(`[[公共日记本::Time0.3::${suffix}::Rerank+0.7:1.5]]`);
      expect(match.state.retiredSuffixes).toEqual([suffix]);
      expect(match.state.enabledSuffixes.riverMemo).toBe(false);
      expect(match.state.timeRatio).toBe("0.3");
      expect(match.state.rerankPlusAlpha).toBe("0.7");
      expect(match.state.kMultiplier).toBe("1.5");
      expect(match.raw).toContain(suffix);
    }
  );

  it("已有 RiverMemo 不掩盖同时存在的退休后缀", () => {
    const [match] = scanDiarySyntaxes("《《公共日记本::RiverMemo::TagMemo+::Expand》》");
    expect(match.state.enabledSuffixes.riverMemo).toBe(true);
    expect(match.state.retiredSuffixes).toEqual(["TagMemo+"]);
    expect(match.state.enabledSuffixes.expand).toBe(true);
  });

  it("轻量直读及高级组合保持原有语义", () => {
    const [direct, advanced] = scanDiarySyntaxes(
      "{{公共日记本::Last3}} [[公共日记本::RiverMemo::BM25+0.7::Group::Truncate0.4]]"
    );
    expect(direct.state.directRecallMode).toBe("lastN");
    expect(direct.state.directLastCount).toBe("3");
    expect(advanced.state.bm25PlusWeight).toBe("0.7");
    expect(advanced.state.enabledSuffixes.group).toBe(true);
    expect(advanced.state.retiredSuffixes).toEqual([]);
  });

  it("编辑器不生成旧后缀，并对复制及替换设置迁移门禁", () => {
    const source = readFileSync(new URL("../src/views/AgentFilesEditor/DiarySyntaxEditorModal.vue", import.meta.url), "utf8");
    expect(source).not.toMatch(/suffixes\.push\(`::TagMemo/);
    expect(source).not.toContain("setExclusiveSuffix('tagMemo");
    expect(source).toContain('function confirmRetiredMigration()');
    expect(source).toContain('if (retiredSuffixes.value.length > 0) return;');
    expect(source.match(/:disabled="retiredSuffixes.length > 0"/g)).toHaveLength(2);
  });
});

describe("Jev 日记后缀", () => {
  it.each(["Jev", "Jev+", "Jev+0.6", "Jev2", "Jev2+", "Jev2+0.6", "Jev4+0"])(
    "还原 %s 的预设与双排选项",
    (suffix) => {
      const [match] = scanDiarySyntaxes(`[[公共|项目日记本::${suffix}:1.5]]`);
      expect(match.state.enabledSuffixes.jev).toBe(true);
      expect(match.state.enabledSuffixes.rerank).toBe(false);
      expect(match.state.enabledSuffixes.rerankPlus).toBe(false);
      expect(match.state.jevPreset).toBe(suffix.match(/^Jev([1-4])/)?.[1] ?? "");
      expect(match.state.jevPlus).toBe(suffix.includes("+"));
      expect(match.state.jevAlpha).toBe(suffix.split("+")[1] ?? "");
      expect(match.state.kMultiplier).toBe("1.5");
    }
  );

  it.each(["Rerank+::Jev2", "Jev2::Rerank+"] )("显式 Jev 优先：%s", (suffix) => {
    const [match] = scanDiarySyntaxes(`《《公共日记本::${suffix}》》`);
    expect(match.state.enabledSuffixes.jev).toBe(true);
    expect(match.state.enabledSuffixes.rerankPlus).toBe(false);
  });

  it("原有 Rerank+ 仍保持原选项", () => {
    const [match] = scanDiarySyntaxes("[[公共日记本::Rerank+0.6]]");
    expect(match.state.enabledSuffixes.jev).toBe(false);
    expect(match.state.enabledSuffixes.rerankPlus).toBe(true);
    expect(match.state.rerankPlusAlpha).toBe("0.6");
  });
});