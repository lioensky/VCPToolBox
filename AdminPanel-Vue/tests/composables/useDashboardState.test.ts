import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type * as VueModule from "vue";

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof VueModule>("vue");
  return {
    ...actual,
    onMounted: () => {},
    onUnmounted: () => {},
  };
});

const {
  mockUseRequest,
  mockUsePolling,
  mockLoggerError,
  mockCreateLogger,
  mockGetSystemResources,
  mockGetPM2Processes,
  mockGetUserAuthCode,
  mockGetServerLog,
  mockGetIncrementalServerLog,
  mockGetWeather,
  mockGetGroupedNews,
  mockGetDashboardSnapshot,
} = vi.hoisted(() => {
  const useRequest = vi.fn();
  const usePolling = vi.fn();
  const loggerError = vi.fn();
  const createLogger = vi.fn((_scope: string) => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
  }));

  return {
    mockUseRequest: useRequest,
    mockUsePolling: usePolling,
    mockLoggerError: loggerError,
    mockCreateLogger: createLogger,
    mockGetSystemResources: vi.fn(async () => ({})),
    mockGetPM2Processes: vi.fn(async () => []),
    mockGetUserAuthCode: vi.fn(async () => ({ code: "" })),
    mockGetServerLog: vi.fn(async () => ({ content: "", offset: 0 })),
    mockGetIncrementalServerLog: vi.fn(async () => ({ content: "", offset: 0 })),
    mockGetWeather: vi.fn(async () => ({ hourly: [], daily: [] })),
    mockGetGroupedNews: vi.fn(async () => []),
    mockGetDashboardSnapshot: vi.fn(async () => ({
      summary: null,
      trend: [],
      models: [],
    })),
  };
});

vi.mock("@/stores/app", () => ({
  useAppStore: () => ({
    animationsEnabled: true,
    theme: "dark",
  }),
}));

vi.mock("@/composables/useRequest", () => ({
  useRequest: (...args: unknown[]) => mockUseRequest(...args),
}));

vi.mock("@/composables/usePolling", () => ({
  usePolling: (...args: unknown[]) => mockUsePolling(...args),
}));

vi.mock("@/api", () => ({
  systemApi: {
    getSystemResources: (...args: unknown[]) => mockGetSystemResources(...args),
    getPM2Processes: (...args: unknown[]) => mockGetPM2Processes(...args),
    getUserAuthCode: (...args: unknown[]) => mockGetUserAuthCode(...args),
    getServerLog: (...args: unknown[]) => mockGetServerLog(...args),
    getIncrementalServerLog: (...args: unknown[]) => mockGetIncrementalServerLog(...args),
  },
  weatherApi: {
    getWeather: (...args: unknown[]) => mockGetWeather(...args),
  },
  newsApi: {
    getGroupedNews: (...args: unknown[]) => mockGetGroupedNews(...args),
  },
  newApiMonitorApi: {
    getDashboardSnapshot: (...args: unknown[]) => mockGetDashboardSnapshot(...args),
  },
}));

vi.mock("@/utils/logger", () => ({
  createLogger: (scope: string) => mockCreateLogger(scope),
}));

import { useDashboardState } from "@/composables/useDashboardState";

describe("useDashboardState", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseRequest
      .mockReturnValueOnce({ data: ref(null), execute: vi.fn() })
      .mockReturnValueOnce({ data: ref(null), execute: vi.fn() })
      .mockReturnValueOnce({ data: ref(null), execute: vi.fn() });

    mockUsePolling
      .mockReturnValueOnce({ start: vi.fn(), stop: vi.fn() })
      .mockReturnValueOnce({ start: vi.fn(), stop: vi.fn() })
      .mockReturnValueOnce({ start: vi.fn(), stop: vi.fn() })
      .mockReturnValueOnce({ start: vi.fn(), stop: vi.fn() })
      .mockReturnValueOnce({ start: vi.fn(), stop: vi.fn() });
  });

  it("initializes request/polling pipelines and default state", () => {
    const state = useDashboardState();

    expect(mockLoggerError).not.toHaveBeenCalled();

    expect(mockUseRequest).toHaveBeenCalledTimes(3);
    expect(mockUsePolling).toHaveBeenCalledTimes(5);

    expect(mockUsePolling.mock.calls[0]?.[1]).toMatchObject({
      interval: 5000,
      immediate: true,
    });
    expect(mockUsePolling.mock.calls[1]?.[1]).toMatchObject({
      interval: 30 * 1000,
      immediate: true,
    });
    expect(mockUsePolling.mock.calls[2]?.[1]).toMatchObject({
      interval: 30 * 60 * 1000,
      immediate: true,
    });
    expect(mockUsePolling.mock.calls[3]?.[1]).toMatchObject({
      interval: 10 * 60 * 1000,
      immediate: true,
    });
    expect(mockUsePolling.mock.calls[4]?.[1]).toMatchObject({
      interval: 60 * 1000,
      immediate: true,
    });

    expect(state.cpuUsage.value).toBe(0);
    expect(state.memInfo.value).toBe("加载中…");
    expect(state.userAuthCode.value).toBe("加载中…");
    expect(state.pm2Processes.value).toEqual([]);
    expect(state.newsItems.value).toEqual([]);
    expect(state.activityCanvas.value).toBeNull();
  });

  it("passes timeout-aware request options and sanitizes unsafe news urls", async () => {
    const state = useDashboardState();
    const signal = new AbortController().signal;

    const systemRequest = mockUseRequest.mock.calls[0]?.[0] as (
      context?: { signal: AbortSignal }
    ) => Promise<unknown>;
    const pm2Request = mockUseRequest.mock.calls[1]?.[0] as (
      context?: { signal: AbortSignal }
    ) => Promise<unknown>;
    const authCodeRequest = mockUseRequest.mock.calls[2]?.[0] as (
      context?: { signal: AbortSignal }
    ) => Promise<unknown>;

    await systemRequest({ signal });
    expect(mockGetSystemResources).toHaveBeenCalledWith(
      { signal, timeoutMs: 10000 },
      { showLoader: false }
    );

    await pm2Request({ signal });
    expect(mockGetPM2Processes).toHaveBeenCalledWith(
      { signal, timeoutMs: 10000 },
      { showLoader: false }
    );

    await authCodeRequest({ signal });
    expect(mockGetUserAuthCode).toHaveBeenCalledWith(
      { signal, timeoutMs: 10000 },
      { showLoader: false }
    );

    const weatherPollingTask = mockUsePolling.mock.calls[2]?.[0] as () => Promise<void>;
    mockGetWeather.mockResolvedValueOnce({ hourly: [], daily: [] });
    await weatherPollingTask();
    expect(mockGetWeather).toHaveBeenCalledWith(
      { timeoutMs: 10000 },
      { showLoader: false, loadingKey: "dashboard.weather" }
    );

    const newsPollingTask = mockUsePolling.mock.calls[3]?.[0] as () => Promise<void>;
    mockGetGroupedNews.mockResolvedValueOnce([
      { title: "safe", url: "https://example.com", source: "A" },
      { title: "unsafe", url: "javascript:alert(1)", source: "B" },
    ]);
    await newsPollingTask();

    expect(mockGetGroupedNews).toHaveBeenCalledWith(
      2,
      10,
      { timeoutMs: 10000 },
      { showLoader: false, loadingKey: "dashboard.news" }
    );
    expect(state.newsItems.value).toEqual([
      { title: "safe", url: "https://example.com/", source: "A" },
      { title: "unsafe", url: null, source: "B" },
    ]);

    const newApiPollingTask = mockUsePolling.mock.calls[4]?.[0] as () => Promise<void>;
    mockGetDashboardSnapshot.mockResolvedValueOnce({
      summary: {
        source: "demo",
        start_timestamp: 1,
        end_timestamp: 2,
        model_name: null,
        total_requests: 3,
        total_tokens: 4,
        total_quota: 5,
        current_rpm: 6,
        current_tpm: 7,
      },
      trend: [],
      models: [],
    });
    await newApiPollingTask();
    expect(mockGetDashboardSnapshot).toHaveBeenCalledWith();
    expect(state.newApiMonitorStatus.value).toBe("ready");
  });
});
