import { describe, expect, it } from "vitest";
import {
  clampDashboardCardSize,
  GENERIC_DASHBOARD_CARD_MAX_SIZE,
  GENERIC_DASHBOARD_CARD_MIN_SIZE,
} from "@/dashboard/core/types";
import { reorderIdsByPlacement } from "@/utils/pointerReorder";

describe("dashboard layout utilities", () => {
  it("reorders ids before and after target", () => {
    const source = ["newapi-monitor", "weather", "process", "cpu", "news"];

    expect(reorderIdsByPlacement(source, "news", "cpu", "before")).toEqual([
      "newapi-monitor",
      "weather",
      "process",
      "news",
      "cpu",
    ]);

    expect(reorderIdsByPlacement(source, "weather", "cpu", "after")).toEqual([
      "newapi-monitor",
      "process",
      "cpu",
      "weather",
      "news",
    ]);
  });

  it("returns a cloned array when ids are invalid", () => {
    const source = ["a", "b", "c"];
    const result = reorderIdsByPlacement(source, "missing", "b", "before");

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });

  it("clamps card size by bounds and keeps tablet <= desktop", () => {
    const fallback = {
      desktopCols: 6,
      tabletCols: 4,
      rows: 16,
    };

    expect(
      clampDashboardCardSize(
        {
          desktopCols: 99,
          tabletCols: 99,
          rows: 2,
        },
        fallback,
        GENERIC_DASHBOARD_CARD_MIN_SIZE,
        GENERIC_DASHBOARD_CARD_MAX_SIZE
      )
    ).toEqual({
      desktopCols: 12,
      tabletCols: 6,
      rows: 4,
    });

    expect(
      clampDashboardCardSize(
        {
          desktopCols: 4.4,
          tabletCols: 8,
          rows: 25.8,
        },
        fallback,
        GENERIC_DASHBOARD_CARD_MIN_SIZE,
        GENERIC_DASHBOARD_CARD_MAX_SIZE
      )
    ).toEqual({
      desktopCols: 4,
      tabletCols: 4,
      rows: 26,
    });
  });
});
