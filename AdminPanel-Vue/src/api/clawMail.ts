import { requestWithUi, type RequestUiOptions } from "./requestWithUi";

export interface ClawMailMailbox {
  user: string;
  mailbox: string;
  label: string;
  agentName: string | null;
  enabled: boolean;
  cachedCount: number;
}

export interface ClawMailSummary {
  user: string;
  id?: string;
  mailId?: string;
  subject?: string;
  from?: unknown;
  to?: unknown;
  date?: string;
  read?: boolean;
  unread?: boolean;
  hasAttachments?: boolean;
  attachSize?: unknown;
  preview?: string;
}

export interface ClawMailState {
  status: string;
  sdkLoaded: boolean;
  updatedAt: string | null;
  lastError: string | null;
  mailboxes: ClawMailMailbox[];
  users: Record<string, ClawMailSummary[]>;
  wsStates: Array<Record<string, unknown>>;
}

export interface ClawMailListResponse {
  status: string;
  meta: Record<string, unknown>;
  emails: ClawMailSummary[];
  markdown: string;
}

export interface ClawMailReadResponse {
  status: string;
  meta: Record<string, unknown>;
  markdown: string;
  content: Array<Record<string, unknown>>;
}

export interface ClawMailTrashResponse {
  status: string;
  meta: Record<string, unknown>;
  markdown: string;
}

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export const clawMailApi = {
  getState(
    refresh = false,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ClawMailState> {
    return requestWithUi<ClawMailState>(
      {
        url: "/admin_api/claw-mail/state",
        query: { refresh },
        timeoutMs: 60000,
      },
      uiOptions
    );
  },

  listMessages(
    params: {
      mailbox?: string;
      user?: string;
      limit?: number;
      unreadOnly?: boolean;
      fid?: string | number;
    },
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ClawMailListResponse> {
    return requestWithUi<ClawMailListResponse>(
      {
        url: "/admin_api/claw-mail/messages",
        query: params,
        timeoutMs: 60000,
      },
      uiOptions
    );
  },

  readMessage(
    mailId: string,
    params: {
      mailbox?: string;
      user?: string;
      markRead?: boolean;
      includeAttachmentContent?: boolean;
    },
    uiOptions: RequestUiOptions = {}
  ): Promise<ClawMailReadResponse> {
    return requestWithUi<ClawMailReadResponse>(
      {
        url: `/admin_api/claw-mail/messages/${encodeURIComponent(mailId)}`,
        query: params,
        timeoutMs: 120000,
      },
      uiOptions
    );
  },

  moveToTrash(
    mailId: string,
    body: {
      mailbox?: string;
      user?: string;
      sourceFolderId?: string | number;
      targetFolderId?: string | number;
    },
    uiOptions: RequestUiOptions = {}
  ): Promise<ClawMailTrashResponse> {
    return requestWithUi<ClawMailTrashResponse>(
      {
        url: `/admin_api/claw-mail/messages/${encodeURIComponent(mailId)}/trash`,
        method: "POST",
        body,
        timeoutMs: 120000,
      },
      uiOptions
    );
  },
};