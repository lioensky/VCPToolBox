export type FeedbackMessageType = "info" | "success" | "error" | "warning";

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export type ConfirmDialogPayload = string | ConfirmDialogOptions;

export interface InputDialogOptions {
  title?: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  cancelText?: string;
  multiline?: boolean;
  required?: boolean;
  /** Return an error string to block submit, or null to accept. */
  validate?: (value: string) => string | null;
}

export interface FeedbackSink {
  showLoading(show: boolean): void;
  showMessage(
    message: string,
    type?: FeedbackMessageType,
    duration?: number
  ): void;
  askConfirm(payload: ConfirmDialogPayload): Promise<boolean>;
  askInput(payload: InputDialogOptions): Promise<string | null>;
}

const noopSink: FeedbackSink = {
  showLoading: () => undefined,
  showMessage: () => undefined,
  askConfirm: async (payload) => {
    const message = typeof payload === "string" ? payload : payload.message;
    if (typeof globalThis.confirm === "function") {
      return globalThis.confirm(message);
    }

    return false;
  },
  askInput: async (payload) => {
    if (typeof globalThis.prompt === "function") {
      const result = globalThis.prompt(
        payload.message || payload.title || "",
        payload.initialValue ?? ""
      );
      return result;
    }
    return null;
  },
};

let activeSink: FeedbackSink = noopSink;

export function setFeedbackSink(sink: FeedbackSink | null | undefined): void {
  activeSink = sink ?? noopSink;
}

export function showLoading(show: boolean): void {
  activeSink.showLoading(show);
}

export function showMessage(
  message: string,
  type: FeedbackMessageType = "info",
  duration?: number
): void {
  activeSink.showMessage(message, type, duration);
}

export function askConfirm(payload: ConfirmDialogPayload): Promise<boolean> {
  return activeSink.askConfirm(payload);
}

export function askInput(payload: InputDialogOptions): Promise<string | null> {
  return activeSink.askInput(payload);
}

export const feedbackBus = {
  showLoading(show: boolean): void {
    showLoading(show);
  },

  showMessage(
    message: string,
    type: FeedbackMessageType = "info",
    duration?: number
  ): void {
    showMessage(message, type, duration);
  },

  askConfirm(payload: ConfirmDialogPayload): Promise<boolean> {
    return askConfirm(payload);
  },

  askInput(payload: InputDialogOptions): Promise<string | null> {
    return askInput(payload);
  },
};
