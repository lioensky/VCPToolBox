import { getActivePinia } from "pinia";
import { feedbackBus } from "@/platform/feedback/feedbackBus";
import type { HttpRequest } from "@/platform/http/httpClient";
import {
  executeRequest,
  isAbortError,
  isAuthError,
} from "@/platform/http/request";
import { useLoadingStore } from "@/stores/loading";

export type { HttpRequestContext } from "@/platform/http/request";

export interface RequestUiOptions {
  showLoader?: boolean;
  loadingKey?: string;
  suppressErrorMessage?: boolean;
}

type NormalizedRequestUiOptions = Required<
  Pick<RequestUiOptions, "showLoader" | "suppressErrorMessage">
> &
  Pick<RequestUiOptions, "loadingKey">;

const DEFAULT_UI_OPTIONS: NormalizedRequestUiOptions = {
  showLoader: true,
  loadingKey: undefined,
  suppressErrorMessage: false,
};

function normalizeUiOptions(
  uiOptions: RequestUiOptions = {}
): NormalizedRequestUiOptions {
  return {
    ...DEFAULT_UI_OPTIONS,
    ...uiOptions,
  };
}

function createUiErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return "Network request failed. Check the connection or service status.";
  }

  if (error instanceof Error) {
    return `Operation failed: ${error.message}`;
  }

  return `Operation failed: ${String(error)}`;
}

function resolveLoadingStore(loadingKey?: string) {
  if (!loadingKey) {
    return null;
  }

  const pinia = getActivePinia();
  return pinia ? useLoadingStore(pinia) : null;
}

export async function requestWithUi<TResponse, TBody = unknown>(
  request: HttpRequest<TBody>,
  uiOptions: RequestUiOptions = {}
): Promise<TResponse> {
  const normalizedUiOptions = normalizeUiOptions(uiOptions);
  const loadingStore = resolveLoadingStore(normalizedUiOptions.loadingKey);

  return executeRequest<TResponse, TBody>(request, {
    onStart: () => {
      if (normalizedUiOptions.showLoader) {
        feedbackBus.showLoading(true);
      }
      if (loadingStore && normalizedUiOptions.loadingKey) {
        loadingStore.start(normalizedUiOptions.loadingKey);
      }
    },
    onFailure: (error) => {
      if (
        !normalizedUiOptions.suppressErrorMessage &&
        !isAbortError(error) &&
        !isAuthError(error)
      ) {
        feedbackBus.showMessage(createUiErrorMessage(error), "error");
      }
    },
    onFinish: () => {
      if (normalizedUiOptions.showLoader) {
        feedbackBus.showLoading(false);
      }
      if (loadingStore && normalizedUiOptions.loadingKey) {
        loadingStore.stop(normalizedUiOptions.loadingKey);
      }
    },
  });
}
