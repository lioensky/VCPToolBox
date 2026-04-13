export type FeedbackMessageType = "info" | "success" | "error" | "warning";

export interface FeedbackSink {
  showLoading(show: boolean): void;
  showMessage(
    message: string,
    type?: FeedbackMessageType,
    duration?: number
  ): void;
}

const noopSink: FeedbackSink = {
  showLoading: () => undefined,
  showMessage: () => undefined,
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
};
