import { computed, reactive } from "vue";
import type {
  ConfirmDialogPayload,
  FeedbackMessageType,
  FeedbackSink,
  InputDialogOptions,
} from "@/platform/feedback/feedbackBus";

interface FeedbackMessageState {
  id: number;
  text: string;
  type: FeedbackMessageType;
  visible: boolean;
}

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  visible: boolean;
}

interface InputDialogState {
  title: string;
  message: string;
  placeholder: string;
  confirmText: string;
  cancelText: string;
  multiline: boolean;
  required: boolean;
  value: string;
  error: string;
  visible: boolean;
}

interface FeedbackState {
  loadingCount: number;
  message: FeedbackMessageState;
  confirm: ConfirmDialogState;
  input: InputDialogState;
}

interface NormalizedConfirmDialogOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
}

interface PendingConfirmRequest {
  options: NormalizedConfirmDialogOptions;
  resolve: (confirmed: boolean) => void;
}

interface NormalizedInputDialogOptions {
  title: string;
  message: string;
  placeholder: string;
  initialValue: string;
  confirmText: string;
  cancelText: string;
  multiline: boolean;
  required: boolean;
  validate?: (value: string) => string | null;
}

interface PendingInputRequest {
  options: NormalizedInputDialogOptions;
  resolve: (value: string | null) => void;
}

const DEFAULT_MESSAGE_DURATION = 3500;
const DEFAULT_CONFIRM_TITLE = "请确认操作";
const DEFAULT_CONFIRM_MESSAGE = "确定继续吗？";
const DEFAULT_CONFIRM_TEXT = "确认";
const DEFAULT_CANCEL_TEXT = "取消";
const DEFAULT_INPUT_TITLE = "请输入";

const state = reactive<FeedbackState>({
  loadingCount: 0,
  message: {
    id: 0,
    text: "",
    type: "info",
    visible: false,
  },
  confirm: {
    title: DEFAULT_CONFIRM_TITLE,
    message: DEFAULT_CONFIRM_MESSAGE,
    confirmText: DEFAULT_CONFIRM_TEXT,
    cancelText: DEFAULT_CANCEL_TEXT,
    danger: false,
    visible: false,
  },
  input: {
    title: DEFAULT_INPUT_TITLE,
    message: "",
    placeholder: "",
    confirmText: DEFAULT_CONFIRM_TEXT,
    cancelText: DEFAULT_CANCEL_TEXT,
    multiline: false,
    required: true,
    value: "",
    error: "",
    visible: false,
  },
});

let messageHideTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
const confirmQueue: PendingConfirmRequest[] = [];
let activeConfirmRequest: PendingConfirmRequest | null = null;
const inputQueue: PendingInputRequest[] = [];
let activeInputRequest: PendingInputRequest | null = null;

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

function normalizeConfirmPayload(
  payload: ConfirmDialogPayload
): NormalizedConfirmDialogOptions {
  if (typeof payload === "string") {
    const message = payload.trim();
    return {
      title: DEFAULT_CONFIRM_TITLE,
      message: message || DEFAULT_CONFIRM_MESSAGE,
      confirmText: DEFAULT_CONFIRM_TEXT,
      cancelText: DEFAULT_CANCEL_TEXT,
      danger: false,
    };
  }

  return {
    title: payload.title?.trim() || DEFAULT_CONFIRM_TITLE,
    message: payload.message?.trim() || DEFAULT_CONFIRM_MESSAGE,
    confirmText: payload.confirmText?.trim() || DEFAULT_CONFIRM_TEXT,
    cancelText: payload.cancelText?.trim() || DEFAULT_CANCEL_TEXT,
    danger: Boolean(payload.danger),
  };
}

function openNextConfirmRequest(): void {
  if (activeConfirmRequest || confirmQueue.length === 0) {
    return;
  }

  const request = confirmQueue.shift();
  if (!request) {
    return;
  }

  activeConfirmRequest = request;
  state.confirm.title = request.options.title;
  state.confirm.message = request.options.message;
  state.confirm.confirmText = request.options.confirmText;
  state.confirm.cancelText = request.options.cancelText;
  state.confirm.danger = request.options.danger;
  state.confirm.visible = true;
}

function settleConfirmRequest(confirmed: boolean): void {
  if (!activeConfirmRequest) {
    return;
  }

  const request = activeConfirmRequest;
  activeConfirmRequest = null;
  state.confirm.visible = false;
  request.resolve(confirmed);

  globalThis.setTimeout(() => {
    openNextConfirmRequest();
  }, 0);
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

function askConfirm(payload: ConfirmDialogPayload): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmQueue.push({
      options: normalizeConfirmPayload(payload),
      resolve,
    });

    openNextConfirmRequest();
  });
}

function confirmCurrentDialog(): void {
  settleConfirmRequest(true);
}

function cancelCurrentDialog(): void {
  settleConfirmRequest(false);
}

function normalizeInputPayload(
  payload: InputDialogOptions
): NormalizedInputDialogOptions {
  return {
    title: payload.title?.trim() || DEFAULT_INPUT_TITLE,
    message: payload.message?.trim() || "",
    placeholder: payload.placeholder ?? "",
    initialValue: payload.initialValue ?? "",
    confirmText: payload.confirmText?.trim() || DEFAULT_CONFIRM_TEXT,
    cancelText: payload.cancelText?.trim() || DEFAULT_CANCEL_TEXT,
    multiline: Boolean(payload.multiline),
    required: payload.required !== false,
    validate: payload.validate,
  };
}

function openNextInputRequest(): void {
  if (activeInputRequest || inputQueue.length === 0) {
    return;
  }
  const request = inputQueue.shift();
  if (!request) return;

  activeInputRequest = request;
  state.input.title = request.options.title;
  state.input.message = request.options.message;
  state.input.placeholder = request.options.placeholder;
  state.input.confirmText = request.options.confirmText;
  state.input.cancelText = request.options.cancelText;
  state.input.multiline = request.options.multiline;
  state.input.required = request.options.required;
  state.input.value = request.options.initialValue;
  state.input.error = "";
  state.input.visible = true;
}

function settleInputRequest(value: string | null): void {
  if (!activeInputRequest) return;
  const request = activeInputRequest;
  activeInputRequest = null;
  state.input.visible = false;
  state.input.error = "";
  request.resolve(value);

  globalThis.setTimeout(() => {
    openNextInputRequest();
  }, 0);
}

function askInput(payload: InputDialogOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    inputQueue.push({
      options: normalizeInputPayload(payload),
      resolve,
    });
    openNextInputRequest();
  });
}

function submitInputDialog(): void {
  if (!activeInputRequest) return;
  const value = state.input.value;
  const trimmed = value.trim();
  if (activeInputRequest.options.required && !trimmed) {
    state.input.error = "请输入内容。";
    return;
  }
  const validator = activeInputRequest.options.validate;
  if (validator) {
    const err = validator(value);
    if (err) {
      state.input.error = err;
      return;
    }
  }
  settleInputRequest(value);
}

function cancelInputDialog(): void {
  settleInputRequest(null);
}

export const feedbackState = state;

export const isLoadingVisible = computed(() => state.loadingCount > 0);

export const confirmDialogState = computed(() => state.confirm);
export const inputDialogState = computed(() => state.input);

export {
  confirmCurrentDialog,
  cancelCurrentDialog,
  submitInputDialog,
  cancelInputDialog,
};

export const feedbackSink: FeedbackSink = {
  showLoading,
  showMessage,
  askConfirm,
  askInput,
};
