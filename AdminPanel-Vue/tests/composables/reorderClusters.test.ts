import { describe, expect, it } from "vitest";
import { reorderByDragIndex } from "@/features/thinking-chains-editor/reorderClusters";

describe("reorderByDragIndex", () => {
  it("moves item forward and keeps relative order", () => {
    const source = ["A", "B", "C", "D"];
    const result = reorderByDragIndex(source, 1, 4);

    expect(result.moved).toBe(true);
    expect(result.items).toEqual(["A", "C", "D", "B"]);
    expect(source).toEqual(["A", "B", "C", "D"]);
  });

  it("moves item backward and keeps relative order", () => {
    const source = ["A", "B", "C", "D"];
    const result = reorderByDragIndex(source, 3, 1);

    expect(result.moved).toBe(true);
    expect(result.items).toEqual(["A", "D", "B", "C"]);
  });

  it("returns moved=false when target index equals source position", () => {
    const source = ["A", "B", "C"];
    const result = reorderByDragIndex(source, 1, 2);

    expect(result.moved).toBe(false);
    expect(result.items).toEqual(["A", "B", "C"]);
  });

  it("returns moved=false for out-of-range indexes", () => {
    const source = ["A", "B", "C"];

    expect(reorderByDragIndex(source, -1, 1)).toEqual({
      moved: false,
      items: ["A", "B", "C"],
    });
    expect(reorderByDragIndex(source, 1, 5)).toEqual({
      moved: false,
      items: ["A", "B", "C"],
    });
  });
});
