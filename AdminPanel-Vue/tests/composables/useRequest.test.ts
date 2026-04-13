import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStart = vi.fn<(key: string) => void>();
const mockStop = vi.fn<(key: string) => void>();

vi.mock("pinia", () => ({
  getActivePinia: () => ({ id: "test-pinia" }),
}));

vi.mock("@/stores/loading", () => ({
  useLoadingStore: () => ({
    start: (key: string) => mockStart(key),
    stop: (key: string) => mockStop(key),
  }),
}));

import { useRequest } from "@/composables/useRequest";

describe("useRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("integrates global loading key lifecycle", async () => {
    let resolveRequest!: (value: string) => void;
    const requestFn = () =>
      new Promise<string>((resolve) => {
        resolveRequest = resolve;
      });

    const request = useRequest(requestFn, {
      globalLoadingKey: "dashboard-refresh",
    });

    const pending = request.execute({ retry: false });

    expect(request.isLoading.value).toBe(true);
    expect(mockStart).toHaveBeenCalledWith("dashboard-refresh");

    resolveRequest("ok");

    const result = await pending;

    expect(result.success).toBe(true);
    expect(request.data.value).toBe("ok");
    expect(request.isLoading.value).toBe(false);
    expect(mockStop).toHaveBeenCalledWith("dashboard-refresh");
  });

  it("returns an aborted result when the request is cancelled", async () => {
    const requestFn = vi.fn((context?: { signal: AbortSignal }) => {
      if (!context) {
        return Promise.reject(new Error("missing request context"));
      }

      const { signal } = context;

      return new Promise<string>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Request aborted", "AbortError")),
          { once: true }
        );

        globalThis.setTimeout(() => {
          resolve("late-result");
        }, 50);
      });
    });

    const request = useRequest(requestFn, {
      globalLoadingKey: "dashboard-refresh",
    });

    const pending = request.execute({ retry: false });
    request.cancel();

    const result = await pending;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected aborted request result");
    }
    expect(result.aborted).toBe(true);
    expect(request.error.value?.name).toBe("AbortError");
    expect(request.isLoading.value).toBe(false);
    expect(mockStart).toHaveBeenCalledWith("dashboard-refresh");
    expect(mockStop).toHaveBeenCalledWith("dashboard-refresh");
  });
});
