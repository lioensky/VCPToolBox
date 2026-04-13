import { AuthExpiredError } from "@/platform/http/errors";

export type AuthExpiredSource = "httpClient";

export interface AuthExpiredEvent {
  source: AuthExpiredSource;
  status: 401;
  requestUrl?: string;
  error?: unknown;
  at: number;
}

export type AuthExpiredListener = (event: AuthExpiredEvent) => void;

const AUTH_EXPIRED_COOLDOWN_MS = 1000;

let authExpiredListener: AuthExpiredListener | null = null;
let lastEmittedAt = 0;

export function setAuthExpiredListener(
  listener: AuthExpiredListener | null | undefined
): void {
  authExpiredListener = listener ?? null;
}

export function notifyAuthExpired(event: {
  source: AuthExpiredSource;
  requestUrl?: string;
  error?: unknown;
}): void {
  const now = Date.now();
  if (now - lastEmittedAt < AUTH_EXPIRED_COOLDOWN_MS) {
    return;
  }

  lastEmittedAt = now;
  authExpiredListener?.({
    ...event,
    status: 401,
    at: now,
  });
}

export function isAuthRequiredError(error: unknown): boolean {
  if (error instanceof AuthExpiredError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & {
    status?: unknown;
    code?: unknown;
  };

  if (candidate.status === 401) {
    return true;
  }

  if (candidate.code === "AUTH_EXPIRED" || candidate.code === "AUTH_REQUIRED") {
    return true;
  }

  return error.message === "Unauthorized";
}

export function resetAuthExpiredStateForTest(): void {
  authExpiredListener = null;
  lastEmittedAt = 0;
}
