import { notifyAuthExpired } from "@/platform/auth/session";
import { AuthExpiredError, HttpError } from "@/platform/http/errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RetryPolicy {
  maxRetries?: number;
  retryDelayMs?: number;
  backoffMultiplier?: number;
}

export interface HttpRequest<TBody = unknown> {
  url: string;
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | undefined>;
  body?: TBody;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  auth?: "session" | "none";
  retry?: RetryPolicy;
  timeoutMs?: number;
}

export interface HttpClient {
  request<TResponse, TBody = unknown>(
    request: HttpRequest<TBody>
  ): Promise<TResponse>;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  maxRetries: 0,
  retryDelayMs: 600,
  backoffMultiplier: 2,
};

function createAbortError(message = "Request aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

function buildUrl(
  url: string,
  query?: Record<string, string | number | boolean | undefined>
): string {
  if (!query) {
    return url;
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const serialized = params.toString();
  if (!serialized) {
    return url;
  }

  return url.includes("?") ? `${url}&${serialized}` : `${url}?${serialized}`;
}

function createTimeoutSignal(timeoutMs?: number): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: undefined,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort(createAbortError(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => globalThis.clearTimeout(timer),
  };
}

function mergeAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const availableSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );

  if (availableSignals.length === 0) {
    return {
      signal: undefined,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  for (const signal of availableSignals) {
    if (signal.aborted) {
      abort(signal.reason);
      return {
        signal: controller.signal,
        cleanup: () => undefined,
      };
    }
  }

  const listeners = availableSignals.map((signal) => {
    const handleAbort = () => abort(signal.reason);
    signal.addEventListener("abort", handleAbort, { once: true });
    return {
      signal,
      handleAbort,
    };
  });

  return {
    signal: controller.signal,
    cleanup: () => {
      listeners.forEach(({ signal, handleAbort }) => {
        signal.removeEventListener("abort", handleAbort);
      });
    },
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

function isRetryableStatus(status?: number): boolean {
  if (status === undefined) {
    return true;
  }

  return status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return false;
  }

  if (error instanceof AuthExpiredError) {
    return false;
  }

  if (error instanceof HttpError) {
    return isRetryableStatus(error.status);
  }

  if (error instanceof TypeError) {
    return true;
  }

  return true;
}

function withContextMessage(message: string, fallback: string): string {
  const normalized = message.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function parseHttpErrorMessage(status: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const data = payload as Record<string, unknown>;
    const message =
      (typeof data.message === "string" && data.message) ||
      (typeof data.error === "string" && data.error) ||
      (typeof data.details === "string" && data.details);

    if (message) {
      return withContextMessage(message, `HTTP ${status}`);
    }
  }

  if (typeof payload === "string" && payload.trim().length > 0) {
    return withContextMessage(payload, `HTTP ${status}`);
  }

  return `HTTP ${status}`;
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const handleAbort = () => {
      globalThis.clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export function createHttpClient(): HttpClient {
  return {
    async request<TResponse, TBody = unknown>(
      req: HttpRequest<TBody>
    ): Promise<TResponse> {
      const retryPolicy = {
        ...DEFAULT_RETRY_POLICY,
        ...(req.retry || {}),
      };

      let lastError: unknown;
      const maxAttempts = retryPolicy.maxRetries + 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const mergedSignals = mergeAbortSignals([req.signal, timeoutSignal.signal]);

        try {
          const headers: Record<string, string> = {
            ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(req.headers || {}),
          };

          const requestInit: RequestInit = {
            method: req.method ?? "GET",
            headers,
            credentials: req.auth === "none" ? "omit" : "same-origin",
            signal: mergedSignals.signal,
          };

          if (req.body !== undefined) {
            requestInit.body =
              typeof req.body === "string"
                ? req.body
                : JSON.stringify(req.body);
          }

          const response = await fetch(buildUrl(req.url, req.query), requestInit);
          const payload = await readResponseBody(response);

          if (!response.ok) {
            if (response.status === 401) {
              notifyAuthExpired({
                source: "httpClient",
                requestUrl: req.url,
                error: payload,
              });
              throw new AuthExpiredError("Unauthorized", payload);
            }

            throw new HttpError(parseHttpErrorMessage(response.status, payload), {
              status: response.status,
              code: "HTTP_ERROR",
              details: payload,
            });
          }

          return payload as TResponse;
        } catch (error) {
          lastError = error;
          const canRetry = attempt < maxAttempts && isRetryableError(error);

          if (!canRetry) {
            throw error;
          }

          const nextDelay =
            retryPolicy.retryDelayMs *
            Math.pow(retryPolicy.backoffMultiplier, attempt - 1);
          await sleep(nextDelay, mergedSignals.signal);
        } finally {
          mergedSignals.cleanup();
          timeoutSignal.cleanup();
        }
      }

      throw lastError;
    },
  };
}

export const httpClient = createHttpClient();
