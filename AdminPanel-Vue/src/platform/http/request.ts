import { AuthExpiredError, HttpError } from "@/platform/http/errors";
import { type HttpRequest, httpClient } from "@/platform/http/httpClient";
import { createLogger } from "@/utils/logger";
import { performanceMonitor } from "@/utils/performance";

export type HttpRequestContext = Pick<
  HttpRequest,
  "signal" | "timeoutMs" | "retry"
>;

export interface RequestLifecycleOptions {
  onStart?: () => void;
  onFinish?: () => void;
  onFailure?: (error: unknown) => void;
}

const logger = createLogger("HttpRequest");

function extractErrorStatus(error: unknown): number | undefined {
  if (error instanceof HttpError) {
    return error.status;
  }

  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }

  return undefined;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AuthExpiredError || extractErrorStatus(error) === 401;
}

function reportRequestFailure(url: string, error: unknown): void {
  if (isAbortError(error)) {
    logger.warn("API request aborted:", url);
    return;
  }

  if (isAuthError(error)) {
    logger.warn("API request requires authentication:", url);
    return;
  }

  logger.error("API request failed:", url, error);
}

export async function executeRequest<TResponse, TBody = unknown>(
  request: HttpRequest<TBody>,
  lifecycle: RequestLifecycleOptions = {}
): Promise<TResponse> {
  const startTime = performance.now();

  lifecycle.onStart?.();

  try {
    const response = await httpClient.request<TResponse, TBody>(request);
    performanceMonitor.recordApiRequest(performance.now() - startTime, true);
    return response;
  } catch (error) {
    performanceMonitor.recordApiRequest(performance.now() - startTime, false);
    reportRequestFailure(request.url, error);
    lifecycle.onFailure?.(error);
    throw error;
  } finally {
    lifecycle.onFinish?.();
  }
}
