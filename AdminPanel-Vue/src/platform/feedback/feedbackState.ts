import { computed, reactive } from "vue";
import type { FeedbackMessageType, FeedbackSink } from "@/platform/feedback/feedbackBus";

interface FeedbackMessageState {
  id: number;
  text: string;
  type: FeedbackMessageType;
  visible: boolean;
}

interface FeedbackState {
  loadingCount: number;
  message: FeedbackMessageState;
}

const DEFAULT_MESSAGE_DURATION = 3500;

const state = reactive<FeedbackState>({
  loadingCount: 0,
  message: {
    id: 0,
    text: "",
    type: "info",
    visible: false,
  },
});

let messageHideTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

function clearMessageTimer(): void {
  if (messageHideTimer !== null) {
    globalThis.clearTimeout(messageHideTimer);
    messageHideTimer = null;
  }
}

function normalizeDuration(duration?: number): number {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return DEFAULT_MESSAGE_DURATION;
  }

  return duration;
}

function showLoading(show: boolean): void {
  state.loadingCount = show
    ? state.loadingCount + 1
    : Math.max(0, state.loadingCount - 1);
}

function showMessage(
  message: string,
  type: FeedbackMessageType = "info",
  duration?: number
): void {
  state.message.id += 1;
  const currentMessageId = state.message.id;

  clearMessageTimer();

  state.message.text = message;
  state.message.type = type;
  state.message.visible = true;

  messageHideTimer = globalThis.setTimeout(() => {
    if (state.message.id !== currentMessageId) {
      return;
    }

    state.message.visible = false;
    messageHideTimer = null;
  }, normalizeDuration(duration));
}

export const feedbackState = state;

export const isLoadingVisible = computed(() => state.loadingCount > 0);

export const feedbackSink: FeedbackSink = {
  showLoading,
  showMessage,
};
