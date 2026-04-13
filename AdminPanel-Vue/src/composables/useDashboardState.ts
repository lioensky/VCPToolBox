import {
  ref,
  onMounted,
  onUnmounted,
  computed,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from "vue";
import {
  newApiMonitorApi,
  newsApi,
  systemApi,
  weatherApi,
  type NewApiMonitorModelItem,
  type NewApiMonitorSummary,
  type NewApiMonitorTrendItem,
  type ServerLogResponse,
} from "@/api";
import { useAppStore } from "@/stores/app";
import { useRequest } from "@/composables/useRequest";
import { usePolling } from "@/composables/usePolling";
import type { DashboardWeatherDisplay, NewsItem } from "@/dashboard/types";
import { createLogger } from "@/utils/logger";
import { sanitizeExternalUrl } from "@/utils/url";
import type { NodeProcessInfo } from "@/types/api.system";

interface PollingController {
  start: () => void;
  stop: () => void;
}

const logger = createLogger("Dashboard");

const MONITOR_INTERVAL = 5000;
const LOG_ACTIVITY_REFRESH_INTERVAL = 30 * 1000;
const WEATHER_REFRESH_INTERVAL = 30 * 60 * 1000;
const NEWS_REFRESH_INTERVAL = 10 * 60 * 1000;
const NEWAPI_REFRESH_INTERVAL = 60 * 1000;
const MAX_ACTIVITY_DATA_POINTS = 60;
const LOG_RETRY_POLICY = {
  maxRetries: 2,
  retryDelayMs: 500,
} as const;
const SYSTEM_MONITOR_COMPONENT_KEYS = ["cpu", "memory", "process", "node-info"] as const;
const AUTH_CODE_COMPONENT_KEYS = ["process"] as const;
const WEATHER_COMPONENT_KEYS = ["weather"] as const;
const NEWS_COMPONENT_KEYS = ["news"] as const;
const NEWAPI_COMPONENT_KEYS = ["newapi-monitor"] as const;
const ACTIVITY_CHART_COMPONENT_KEYS = ["activity-chart"] as const;

const WEATHER_ICON_MAP: Record<string, string> = {
  "100": "sunny",
  "101": "cloudy",
  "102": "cloudy",
  "103": "partly_cloudy_day",
  "104": "cloud",
  "150": "clear_night",
  "151": "nights_stay",
  "152": "nights_stay",
  "153": "nights_stay",
  "154": "cloud",
  "300": "rainy",
  "301": "rainy",
  "302": "rainy_heavy",
  "303": "rainy_heavy",
  "304": "rainy_heavy",
  "305": "rainy",
  "306": "rainy",
  "307": "rainy_heavy",
  "308": "rainy_heavy",
  "309": "rainy",
  "310": "rainy_heavy",
  "311": "rainy_heavy",
  "312": "rainy_heavy",
  "313": "rainy_heavy",
  "314": "rainy",
  "315": "rainy_heavy",
  "316": "rainy_heavy",
  "317": "rainy_heavy",
  "318": "rainy_heavy",
  "350": "rainy",
  "351": "rainy_heavy",
  "399": "rainy",
  晴: "clear_day",
  多云: "partly_cloudy_day",
  阴: "cloud",
  小雨: "rainy",
  中雨: "rainy",
  大雨: "rainy",
  暴雨: "thunderstorm",
  雷阵雨: "thunderstorm",
  雪: "snowing",
  雾: "foggy",
  霾: "haze",
};

const DEFAULT_WEATHER_ICON = "wb_sunny";

function normalizeLogContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function splitLogChunk(content: string, carry = ""): {
  completeLines: string[];
  displayedLines: string[];
  trailingFragment: string;
} {
  const normalized = normalizeLogContent(content);
  const combined = `${carry}${normalized}`;
  const segments = combined.split("\n");
  const endsWithNewline = combined.endsWith("\n");

  if (endsWithNewline && segments[segments.length - 1] === "") {
    segments.pop();
  }

  const trailingFragment = endsWithNewline ? "" : (segments.pop() ?? "");
  const displayedLines = trailingFragment
    ? [...segments, trailingFragment]
    : segments;

  return {
    completeLines: segments,
    displayedLines,
    trailingFragment,
  };
}

function hasActiveBuiltinComponent(
  activeComponentKeys: ReadonlySet<string>,
  candidateKeys: readonly string[]
) {
  return candidateKeys.some((componentKey) =>
    activeComponentKeys.has(componentKey)
  );
}

export function useDashboardState(
  activeComponentKeys: MaybeRefOrGetter<readonly string[]> = []
) {
  const appStore = useAppStore();
  const animationsEnabled = computed(() => appStore.animationsEnabled);
  const theme = computed(() => appStore.theme);

  const activityCanvas = ref<HTMLCanvasElement | null>(null);

  const { data: systemData, execute: fetchSystemData } =
    useRequest<Awaited<ReturnType<typeof systemApi.getSystemResources>>>(
      (context) =>
        systemApi.getSystemResources(
          {
            signal: context?.signal,
            timeoutMs: 10000,
          },
          { showLoader: false }
        ),
      {
        globalLoadingKey: "dashboard.system-monitor",
      }
    );

  const { data: pm2Data, execute: fetchPM2Data } = useRequest<
    Awaited<ReturnType<typeof systemApi.getPM2Processes>>
  >(
    (context) =>
      systemApi.getPM2Processes(
        {
          signal: context?.signal,
          timeoutMs: 10000,
        },
        { showLoader: false }
      ),
    {
      globalLoadingKey: "dashboard.pm2-processes",
    }
  );

  const { data: authCodeData, execute: fetchAuthCode } =
    useRequest<Awaited<ReturnType<typeof systemApi.getUserAuthCode>>>(
      (context) =>
        systemApi.getUserAuthCode(
          {
            signal: context?.signal,
            timeoutMs: 10000,
          },
          { showLoader: false }
        ),
      {
        globalLoadingKey: "dashboard.auth-code",
      }
    );

  const cpuUsage = ref(0);
  const cpuPlatform = ref("");
  const cpuArch = ref("");
  const memUsage = ref(0);
  const memInfo = ref("加载中…");
  const vcpMemUsage = ref(0);
  const pm2Processes = ref<Awaited<ReturnType<typeof systemApi.getPM2Processes>>>([]);
  const nodeInfo = ref<Partial<NodeProcessInfo>>({});
  const userAuthCode = ref("加载中…");
  const weather = ref<DashboardWeatherDisplay>({
    icon: "--",
    temp: 0,
    text: "加载中…",
    humidity: 0,
    wind: "--",
    pressure: 0,
    forecast: [],
  });
  const newsItems = ref<NewsItem[]>([]);
  const newApiMonitorSummary = ref<NewApiMonitorSummary | null>(null);
  const newApiMonitorTrend = ref<NewApiMonitorTrendItem[]>([]);
  const newApiMonitorModels = ref<NewApiMonitorModelItem[]>([]);
  const newApiMonitorStatus = ref<"loading" | "ready" | "unavailable" | "error">("loading");
  const newApiMonitorError = ref("");
  const activityDataPoints = ref<number[]>(new Array(60).fill(0));
  const lastLogCheckTime = ref<Date | null>(null);
  const lastLogOffset = ref(0);
  const pendingLogFragment = ref("");
  const isPageVisible = ref(
    typeof document === "undefined"
      ? true
      : document.visibilityState === "visible"
  );
  const activeBuiltinComponentKeySet = computed(
    () => new Set(toValue(activeComponentKeys))
  );
  const shouldPollSystemMonitor = computed(() =>
    hasActiveBuiltinComponent(
      activeBuiltinComponentKeySet.value,
      SYSTEM_MONITOR_COMPONENT_KEYS
    )
  );
  const shouldLoadAuthCode = computed(() =>
    hasActiveBuiltinComponent(
      activeBuiltinComponentKeySet.value,
      AUTH_CODE_COMPONENT_KEYS
    )
  );
  const shouldPollWeather = computed(() =>
    hasActiveBuiltinComponent(
      activeBuiltinComponentKeySet.value,
      WEATHER_COMPONENT_KEYS
    )
  );
  const shouldPollNews = computed(() =>
    hasActiveBuiltinComponent(
      activeBuiltinComponentKeySet.value,
      NEWS_COMPONENT_KEYS
    )
  );
  const shouldPollNewApiMonitor = computed(() =>
    hasActiveBuiltinComponent(
      activeBuiltinComponentKeySet.value,
      NEWAPI_COMPONENT_KEYS
    )
  );
  const shouldPollActivityChart = computed(() =>
    hasActiveBuiltinComponent(
      activeBuiltinComponentKeySet.value,
      ACTIVITY_CHART_COMPONENT_KEYS
    )
  );

  let activityChartCtx: CanvasRenderingContext2D | null = null;
  let hasMounted = false;
  let authCodeLoadPromise: Promise<void> | null = null;

  async function monitorSystemResources() {
    await Promise.all([fetchSystemData(), fetchPM2Data()]);

    if (systemData.value?.cpu?.usage !== undefined) {
      cpuUsage.value = systemData.value.cpu.usage;
      cpuPlatform.value = systemData.value.nodeProcess?.platform || "";
      cpuArch.value = systemData.value.nodeProcess?.arch || "";
    }

    if (
      systemData.value?.memory?.used !== undefined &&
      systemData.value?.memory?.total !== undefined
    ) {
      const usedGB = systemData.value.memory.used / 1024 / 1024 / 1024;
      const totalGB = systemData.value.memory.total / 1024 / 1024 / 1024;
      memUsage.value = systemData.value.memory.usage;
      memInfo.value = `已用：${usedGB.toFixed(2)} GB / 总共：${totalGB.toFixed(
        2
      )} GB`;

      if (systemData.value.nodeProcess?.memory?.rss) {
        vcpMemUsage.value =
          (systemData.value.nodeProcess.memory.rss /
            systemData.value.memory.total) *
          100;
      }
    }

    if (pm2Data.value) {
      pm2Processes.value = pm2Data.value;
    }

    if (systemData.value?.nodeProcess) {
      nodeInfo.value = {
        pid: systemData.value.nodeProcess.pid,
        version: systemData.value.nodeProcess.version,
        memory: systemData.value.nodeProcess.memory,
        uptime: systemData.value.nodeProcess.uptime,
      };
    }
  }

  async function loadAuthCodeValue() {
    await fetchAuthCode();

    if (authCodeData.value?.code) {
      userAuthCode.value = authCodeData.value.code;
    }
  }

  function ensureAuthCodeLoaded() {
    if (!shouldLoadAuthCode.value || authCodeData.value?.code || authCodeLoadPromise) {
      return authCodeLoadPromise;
    }

    authCodeLoadPromise = loadAuthCodeValue()
      .catch((error) => {
        logger.error("Failed to load auth code:", error);
      })
      .finally(() => {
        authCodeLoadPromise = null;
      });

    return authCodeLoadPromise;
  }

  async function loadWeather() {
    try {
      const response = await weatherApi.getWeather(
        {
          timeoutMs: 10000,
        },
        {
          showLoader: false,
          loadingKey: "dashboard.weather",
        }
      );

      if (response) {
        if (response.hourly && response.hourly.length > 0) {
          const now = new Date();
          let current = response.hourly[0];
          let minDiff = Infinity;

          for (const hourData of response.hourly) {
            const forecastTime = new Date(hourData.fxTime);
            const diff = Math.abs(now.getTime() - forecastTime.getTime());
            if (diff < minDiff) {
              minDiff = diff;
              current = hourData;
            }
          }

          weather.value = {
            icon: mapWeatherIcon(current.icon),
            temp: parseInt(current.temp) || 0,
            text: current.text || "加载中…",
            humidity: parseInt(current.humidity) || 0,
            wind: `${current.windDir || "--"} ${current.windScale || "--"}`,
            pressure: parseInt(current.pressure) || 0,
            forecast: [],
          };
        }

        if (response.daily && response.daily.length > 0) {
          weather.value.forecast = response.daily.slice(1, 5).map((day) => {
            const date = new Date(day.fxDate);
            return {
              fxDate: day.fxDate,
              dayName: date.toLocaleDateString("zh-CN", { weekday: "short" }),
              icon: mapWeatherIcon(day.iconDay),
              tempMin: parseInt(day.tempMin) || 0,
              tempMax: parseInt(day.tempMax) || 0,
              text: day.textDay || "未知",
            };
          });
        }
      }
    } catch (error) {
      logger.error("Failed to load weather:", error);
      weather.value.text = "加载失败";
    }
  }

  async function loadNews() {
    try {
      const response = await newsApi.getGroupedNews(
        2,
        10,
        {
          timeoutMs: 10000,
        },
        {
          showLoader: false,
          loadingKey: "dashboard.news",
        }
      );

      /*
      newsItems.value = response.map((item) => ({
        title: item.title,
        url: sanitizeExternalUrl(item.url),
        source: item.source || "鐑偣",
      }));
      */
      newsItems.value = response.map((item) => ({
        title: item.title,
        url: sanitizeExternalUrl(item.url),
        source: item.source || "hot",
      }));
      /*
          const source = item.source || "其他";
          if (!grouped[source]) grouped[source] = [];
          if (grouped[source].length < 2) {
            grouped[source].push(item);
          }
        }

        newsItems.value = Object.values(grouped)
          .flat()
          .slice(0, 10)
          .map((item) => ({
            title: item.title,
            url: sanitizeExternalUrl(item.url),
            source: item.source || "热点",
          }));
      */
      /* legacy fallback removed
        newsItems.value = [];
      */
    } catch (error) {
      logger.error("Failed to load news:", error);
      newsItems.value = [];
    }
  }

  async function loadNewApiMonitor() {
    try {
      const snapshot = await newApiMonitorApi.getDashboardSnapshot();

      newApiMonitorSummary.value = snapshot.summary;
      newApiMonitorTrend.value = snapshot.trend;
      newApiMonitorModels.value = snapshot.models;
      newApiMonitorError.value = "";
      newApiMonitorStatus.value = "ready";
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStatus =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
          ? ((error as { status: number }).status)
          : undefined;
      logger.warn("Failed to load NewAPI monitor:", errorMessage);

      if (!newApiMonitorSummary.value) {
        newApiMonitorError.value = errorMessage;
        newApiMonitorStatus.value =
          errorStatus === 502 ||
          errorStatus === 503 ||
          errorMessage.includes("503") ||
          errorMessage.includes("502") ||
          errorMessage.includes("未配置")
            ? "unavailable"
            : "error";
      }
    }
  }

  function mapWeatherIcon(code: string): string {
    return WEATHER_ICON_MAP[code] || DEFAULT_WEATHER_ICON;
  }

  function initActivityChart() {
    if (!activityCanvas.value) return;

    activityChartCtx = activityCanvas.value.getContext("2d");
    if (!activityChartCtx) return;

    const container = activityCanvas.value.parentElement;
    if (container) {
      activityCanvas.value.width = container.clientWidth;
      activityCanvas.value.height = 200;
    }

    drawActivityChart();
  }

  function drawActivityChart() {
    if (!activityChartCtx || !activityCanvas.value) return;

    const ctx = activityChartCtx;
    const width = activityCanvas.value.width;
    const height = activityCanvas.value.height;

    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = "var(--border-color)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 5; i++) {
      const y = (height / 5) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const data = activityDataPoints.value;
    const stepX = width / (data.length - 1);
    const maxValue = Math.max(...data, 100);

    ctx.beginPath();
    ctx.strokeStyle = theme.value === "dark" ? "#38bdf8" : "#0284c7";
    ctx.lineWidth = 2;

    data.forEach((value, index) => {
      const x = index * stepX;
      const y = height - (value / maxValue) * height * 0.8 - 10;

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle =
      theme.value === "dark"
        ? "rgba(56, 189, 248, 0.1)"
        : "rgba(2, 132, 199, 0.1)";
    ctx.fill();
  }

  function extractLatestLogTime(logLines: string[]): Date | null {
    const regex = /\[(\d{4}\/\d{1,2}\/\d{1,2}\s\d{1,2}:\d{2}:\d{2})\]/;
    let latestTime: Date | null = null;

    for (const line of logLines) {
      const match = line.match(regex);
      if (!match || !match[1]) continue;

      const timestamp = new Date(match[1]);
      if (isNaN(timestamp.getTime())) continue;

      if (!latestTime || timestamp > latestTime) {
        latestTime = timestamp;
      }
    }

    return latestTime;
  }

  async function updateActivityDataFromLog() {
    try {
      const logData =
        lastLogOffset.value > 0
          ? await systemApi.getIncrementalServerLog(
              lastLogOffset.value,
              {
                timeoutMs: 10000,
                retry: LOG_RETRY_POLICY,
              },
              {
                showLoader: false,
              }
            )
          : await systemApi.getServerLog(
              {
                timeoutMs: 10000,
                retry: LOG_RETRY_POLICY,
              },
              {
                showLoader: false,
              }
            );

      if (logData.needFullReload) {
        lastLogOffset.value = 0;
        pendingLogFragment.value = "";
        await resetActivityBaseline();
        return;
      }

      consumeActivityLogSnapshot(logData);
    } catch (error) {
      logger.error("Failed to update activity data:", error);
      activityDataPoints.value.push(0);
      if (activityDataPoints.value.length > MAX_ACTIVITY_DATA_POINTS) {
        activityDataPoints.value.shift();
      }
    }

    if (animationsEnabled.value) {
      drawActivityChart();
    }
  }

  function pushActivityPoint(value: number) {
    activityDataPoints.value.push(value);
    if (activityDataPoints.value.length > MAX_ACTIVITY_DATA_POINTS) {
      activityDataPoints.value.shift();
    }
  }

  function consumeActivityLogSnapshot(logData: ServerLogResponse) {
    const content = logData.content || "";
    const offsetFallback =
      logData.offset ?? logData.fileSize ?? lastLogOffset.value + content.length;
    lastLogOffset.value = offsetFallback;

    if (lastLogCheckTime.value === null) {
      const { displayedLines, trailingFragment } = splitLogChunk(content);
      pendingLogFragment.value = trailingFragment;
      lastLogCheckTime.value = extractLatestLogTime(displayedLines);
      pushActivityPoint(0);
      return;
    }

    const { completeLines, displayedLines, trailingFragment } = splitLogChunk(
      content,
      pendingLogFragment.value
    );
    pendingLogFragment.value = trailingFragment;

    let newLogsCount = 0;
    let latestTimeInThisBatch: Date | null = null;
    const regex = /\[(\d{4}\/\d{1,2}\/\d{1,2}\s\d{1,2}:\d{2}:\d{2})\]/;

    for (const line of completeLines) {
      const match = line.match(regex);
      if (!match || !match[1]) continue;

      const timestamp = new Date(match[1]);
      if (isNaN(timestamp.getTime())) continue;

      if (!lastLogCheckTime.value || timestamp > lastLogCheckTime.value) {
        newLogsCount++;
      }

      if (!latestTimeInThisBatch || timestamp > latestTimeInThisBatch) {
        latestTimeInThisBatch = timestamp;
      }
    }

    const latestDisplayedTime = extractLatestLogTime(displayedLines);
    if (
      latestDisplayedTime &&
      (!latestTimeInThisBatch || latestDisplayedTime > latestTimeInThisBatch)
    ) {
      latestTimeInThisBatch = latestDisplayedTime;
    }

    if (latestTimeInThisBatch) {
      lastLogCheckTime.value = latestTimeInThisBatch;
    }

    pushActivityPoint(newLogsCount);
  }

  async function resetActivityBaseline() {
    const fullLogData = await systemApi.getServerLog(
      {
        timeoutMs: 10000,
        retry: LOG_RETRY_POLICY,
      },
      { showLoader: false }
    );
    const { displayedLines, trailingFragment } = splitLogChunk(
      fullLogData.content || ""
    );

    pendingLogFragment.value = trailingFragment;
    lastLogOffset.value =
      fullLogData.offset ??
      fullLogData.fileSize ??
      normalizeLogContent(fullLogData.content || "").length;
    lastLogCheckTime.value = extractLatestLogTime(displayedLines);
    pushActivityPoint(0);
  }

  watch(
    [activityCanvas, shouldPollActivityChart],
    ([canvas, shouldRender]) => {
      if (!(canvas instanceof HTMLCanvasElement) || !shouldRender) {
        activityChartCtx = null;
        return;
      }

      initActivityChart();
    },
    { flush: "post" }
  );

  watch(theme, () => {
    if (animationsEnabled.value) {
      drawActivityChart();
    }
  });

  function syncPollingState(polling: PollingController, shouldRun: boolean) {
    if (shouldRun) {
      polling.start();
      return;
    }

    polling.stop();
  }

  const monitorPolling = usePolling(
    async () => {
      await monitorSystemResources();
    },
    {
      interval: MONITOR_INTERVAL,
      immediate: true,
      onError: (error) => {
        logger.error("Monitor polling failed:", error);
      },
    }
  );

  const logPolling = usePolling(updateActivityDataFromLog, {
    interval: LOG_ACTIVITY_REFRESH_INTERVAL,
    immediate: true,
    onError: (error) => {
      logger.error("Log polling failed:", error);
    },
  });

  const weatherPolling = usePolling(loadWeather, {
    interval: WEATHER_REFRESH_INTERVAL,
    immediate: true,
    onError: (error) => {
      logger.error("Weather polling failed:", error);
    },
  });

  const newsPolling = usePolling(loadNews, {
    interval: NEWS_REFRESH_INTERVAL,
    immediate: true,
    onError: (error) => {
      logger.error("News polling failed:", error);
    },
  });

  const newApiMonitorPolling = usePolling(loadNewApiMonitor, {
    interval: NEWAPI_REFRESH_INTERVAL,
    immediate: true,
    onError: (error) => {
      logger.error("NewAPI monitor polling failed:", error);
    },
  });

  const conditionalPollings = [
    {
      controller: monitorPolling,
      enabled: shouldPollSystemMonitor,
    },
    {
      controller: logPolling,
      enabled: shouldPollActivityChart,
    },
    {
      controller: weatherPolling,
      enabled: shouldPollWeather,
    },
    {
      controller: newsPolling,
      enabled: shouldPollNews,
    },
    {
      controller: newApiMonitorPolling,
      enabled: shouldPollNewApiMonitor,
    },
  ] as const;

  function stopAllPollings() {
    conditionalPollings.forEach(({ controller }) => {
      controller.stop();
    });
  }

  function syncPollingWithVisibility() {
    if (!hasMounted) {
      return;
    }

    const pageVisible = isPageVisible.value;
    conditionalPollings.forEach(({ controller, enabled }) => {
      syncPollingState(controller, pageVisible && enabled.value);
    });
  }

  function handleVisibilityChange() {
    isPageVisible.value = document.visibilityState === "visible";
    syncPollingWithVisibility();
  }

  watch(
    [
      isPageVisible,
      shouldPollSystemMonitor,
      shouldPollActivityChart,
      shouldPollWeather,
      shouldPollNews,
      shouldPollNewApiMonitor,
    ],
    () => {
      syncPollingWithVisibility();
    }
  );

  watch([shouldLoadAuthCode, isPageVisible], ([shouldLoad, pageVisible]) => {
    if (!hasMounted || !shouldLoad || !pageVisible) {
      return;
    }

    void ensureAuthCodeLoaded();
  });

  onMounted(() => {
    hasMounted = true;
    if (activityCanvas.value && shouldPollActivityChart.value) {
      initActivityChart();
    }
    if (shouldLoadAuthCode.value && isPageVisible.value) {
      void ensureAuthCodeLoaded();
    }
    syncPollingWithVisibility();
    document.addEventListener("visibilitychange", handleVisibilityChange);
  });

  onUnmounted(() => {
    hasMounted = false;
    stopAllPollings();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  });

  return {
    cpuUsage,
    cpuPlatform,
    cpuArch,
    memUsage,
    memInfo,
    vcpMemUsage,
    pm2Processes,
    nodeInfo,
    userAuthCode,
    weather,
    newsItems,
    newApiMonitorSummary,
    newApiMonitorTrend,
    newApiMonitorModels,
    newApiMonitorStatus,
    newApiMonitorError,
    activityCanvas,
  };
}
