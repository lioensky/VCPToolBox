export interface HttpErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
}

export class HttpError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = "HttpError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

export class AuthExpiredError extends HttpError {
  constructor(message = "Unauthorized", details?: unknown) {
    super(message, {
      status: 401,
      code: "AUTH_EXPIRED",
      details,
    });
    this.name = "AuthExpiredError";
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof Error) {
    return new HttpError(error.message, {
      details: error,
    });
  }

  return new HttpError(String(error), {
    details: error,
  });
}
